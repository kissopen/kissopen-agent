import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { extractProviderErrorDiagnostics } from "@/core/extractProviderErrorDiagnostics.js";
import { extractProviderRetryResetAt } from "@/core/extractProviderErrorDiagnostics.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionProviderError } from "@/core/SessionProviderError.js";

type ErrorDone = Extract<SessionEvent, { type: "done"; state: "error" }>;

/**
 * Failures of the OpenAI Chat Completions protocol, as DeepSeek, Moonshot, and other compatible
 * endpoints report them.
 *
 * An error response carries `{ "error": { "message", "type", "code" } }` (some servers flatten it to
 * `{ "message" }`). Only the status, the bounded error identifiers, the upstream message, and the
 * retry headers survive into diagnostics; the raw body never does.
 */
export class ChatCompletionsHttpError extends Error {
    readonly status: number;
    readonly headers: Headers;
    readonly code: string | undefined;
    readonly errorType: string | undefined;
    readonly upstreamMessage: string | undefined;

    constructor(options: {
        status: number;
        headers: Headers;
        code?: string;
        errorType?: string;
        upstreamMessage?: string;
    }) {
        super(
            options.upstreamMessage === undefined
                ? `The server answered with HTTP ${options.status}.`
                : `HTTP ${options.status}: ${options.upstreamMessage}`,
        );
        this.name = "ChatCompletionsHttpError";
        this.status = options.status;
        this.headers = options.headers;
        this.code = options.code;
        this.errorType = options.errorType;
        this.upstreamMessage = options.upstreamMessage;
    }
}

/** The stream broke, stalled, or carried something that is not a Chat Completions chunk. */
export class ChatCompletionsStreamError extends Error {
    readonly retryable: boolean;
    readonly code: string | undefined;
    readonly errorType: string | undefined;

    constructor(
        message: string,
        options: { retryable: boolean; code?: string; errorType?: string; cause?: unknown },
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "ChatCompletionsStreamError";
        this.retryable = options.retryable;
        this.code = options.code;
        this.errorType = options.errorType;
    }
}

/** The response did not start, or went silent, within the configured bound. */
export class ChatCompletionsTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TimeoutError";
    }
}

const scalarSchema = Type.Union([Type.String(), Type.Number()]);
const errorObjectSchema = Type.Object({
    message: Type.Optional(Type.String()),
    type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    code: Type.Optional(Type.Union([scalarSchema, Type.Null()])),
});
const errorBodySchema = Type.Union([
    Type.Object({ error: errorObjectSchema }),
    Type.Object({ error: Type.String(), code: Type.Optional(scalarSchema) }),
    errorObjectSchema,
]);

export interface ParsedChatCompletionsErrorBody {
    readonly message?: string;
    readonly type?: string;
    readonly code?: string;
}

/** Reads the error envelope of a failed response or of an `error` chunk inside a stream. */
export function parseChatCompletionsErrorBody(value: unknown): ParsedChatCompletionsErrorBody {
    if (!Value.Check(errorBodySchema, value)) return {};
    const record = "error" in value ? value.error : value;
    if (typeof record === "string") {
        const code = "code" in value && value.code != null ? String(value.code).trim() : undefined;
        return { ...(record.trim() ? { message: record.trim() } : {}), ...(code ? { code } : {}) };
    }
    const message = record.message?.trim();
    const type = typeof record.type === "string" ? record.type.trim() : undefined;
    const code =
        record.code === null || record.code === undefined ? undefined : String(record.code).trim();
    return {
        ...(message ? { message } : {}),
        ...(type ? { type } : {}),
        ...(code ? { code } : {}),
    };
}

/** Builds the typed HTTP error from a failed response, reading at most 64 KiB of its body. */
export async function chatCompletionsHttpError(
    response: Response,
): Promise<ChatCompletionsHttpError> {
    let parsed: ParsedChatCompletionsErrorBody = {};
    try {
        const text = (await response.text()).slice(0, 65_536);
        try {
            parsed = parseChatCompletionsErrorBody(JSON.parse(text));
        } catch {
            const trimmed = text.trim();
            if (trimmed.length > 0 && trimmed.length <= 2_048 && !trimmed.startsWith("<")) {
                parsed = { message: trimmed };
            }
        }
    } catch {
        // The status alone still classifies the failure.
    }
    return new ChatCompletionsHttpError({
        status: response.status,
        headers: response.headers,
        ...(parsed.code === undefined ? {} : { code: parsed.code }),
        ...(parsed.type === undefined ? {} : { errorType: parsed.type }),
        ...(parsed.message === undefined ? {} : { upstreamMessage: parsed.message }),
    });
}

const CONTEXT_OVERFLOW_PATTERN =
    /context[ _-]?length|context window|maximum context|token limit|too many tokens|prompt is too long|reduce the length/i;

/** Moonshot reports an exhausted balance as HTTP 429 with a quota error type. */
const BILLING_PATTERN =
    /insufficient[ _]balance|exceeded_current_quota|quota|billing|suspended|arrear/i;

function describe(error: ChatCompletionsHttpError): string {
    return [error.errorType, error.code, error.upstreamMessage].filter(Boolean).join(" ");
}

export function isChatCompletionsContextOverflow(error: unknown): boolean {
    if (error instanceof ChatCompletionsHttpError) {
        return (
            error.status === 413 ||
            ((error.status === 400 || error.status === 422) &&
                CONTEXT_OVERFLOW_PATTERN.test(describe(error)))
        );
    }
    if (error instanceof ChatCompletionsStreamError) {
        return CONTEXT_OVERFLOW_PATTERN.test(error.message);
    }
    return false;
}

function isBillingError(error: ChatCompletionsHttpError): boolean {
    return (
        error.code === "usage_limit" ||
        error.status === 402 ||
        (error.status === 429 && BILLING_PATTERN.test(describe(error)))
    );
}

/**
 * Whether another attempt can succeed. Only failures that happen before any output has streamed
 * are ever retried; the session enforces that boundary.
 */
export function isRetryableChatCompletionsError(error: unknown): boolean {
    if (error instanceof ChatCompletionsHttpError) {
        if (isBillingError(error)) return false;
        return (
            error.status === 408 ||
            error.status === 409 ||
            error.status === 429 ||
            error.status >= 500
        );
    }
    if (error instanceof ChatCompletionsStreamError) {
        return error.retryable && !isChatCompletionsContextOverflow(error);
    }
    if (error instanceof ChatCompletionsTimeoutError) return true;
    // `fetch` reports connection failures as a TypeError carrying the socket error as its cause;
    // a body read that breaks mid-stream surfaces as a generic network error. A TypeError without
    // either is a bug, and retrying it would only hide it.
    if (error instanceof TypeError) {
        return error.cause !== undefined || /fetch failed|network|terminated/i.test(error.message);
    }
    if (error instanceof Error) {
        const code = (error as { code?: unknown }).code;
        if (
            typeof code === "string" &&
            /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_\w+)$/.test(code)
        ) {
            return true;
        }
        return /network|socket|terminated|other side closed|fetch failed/i.test(error.message);
    }
    return false;
}

const MAX_SERVER_RETRY_DELAY_MS = 60_000;

/** The server's own retry instruction in milliseconds, when it gave a usable one. */
export function chatCompletionsRetryAfterMs(error: unknown): number | undefined {
    if (!(error instanceof ChatCompletionsHttpError)) return undefined;
    const milliseconds = Number(error.headers.get("retry-after-ms") ?? Number.NaN);
    if (Number.isFinite(milliseconds) && milliseconds >= 0) {
        return milliseconds <= MAX_SERVER_RETRY_DELAY_MS ? milliseconds : undefined;
    }
    const retryAfter = error.headers.get("retry-after");
    if (retryAfter === null || retryAfter.trim() === "") return undefined;
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1_000 <= MAX_SERVER_RETRY_DELAY_MS ? seconds * 1_000 : undefined;
    }
    const date = Date.parse(retryAfter) - Date.now();
    return Number.isFinite(date) && date >= 0 && date <= MAX_SERVER_RETRY_DELAY_MS
        ? date
        : undefined;
}

/** Turns a terminal failure into the `done` event a person can read. */
export function classifyChatCompletionsError(
    error: unknown,
    service: string,
    attempts: number,
): ErrorDone {
    const fallbackMessage = error instanceof Error ? error.message : `${service} request failed.`;
    const upstreamMessage =
        error instanceof ChatCompletionsHttpError
            ? (error.upstreamMessage ?? fallbackMessage)
            : fallbackMessage;
    const diagnostics = extractProviderErrorDiagnostics(error, {
        attempts: Math.max(1, attempts),
        upstreamMessage,
    });
    if (isChatCompletionsContextOverflow(error)) {
        return {
            type: "done",
            state: "error",
            kind: "context_overflow",
            message: `The conversation exceeds the ${service} model's context window.`,
            providerError: withDiagnostics("unclassified", diagnostics),
        };
    }
    if (error instanceof ChatCompletionsHttpError) {
        if (error.status === 401 || error.status === 403) {
            return {
                type: "done",
                state: "error",
                kind: "unknown",
                message: `${service} rejected the API key. Check the key configured for this provider.`,
                providerError: withDiagnostics("authentication", diagnostics),
            };
        }
        if (isBillingError(error)) {
            return {
                type: "done",
                state: "error",
                kind: "billing_error",
                message:
                    error.code === "usage_limit"
                        ? "Your usage allowance cannot cover this request. Open Usage to see your limits and options."
                        : `The ${service} account has no remaining balance or quota.`,
                providerError: withResetAt(
                    "out_of_tokens",
                    diagnostics,
                    extractProviderRetryResetAt(error),
                ),
            };
        }
        if (error.status === 429) {
            return {
                type: "done",
                state: "error",
                kind: "unknown",
                message: `The ${service} rate limit was reached.`,
                providerError: withResetAt(
                    "rate_limit",
                    diagnostics,
                    extractProviderRetryResetAt(error),
                ),
            };
        }
        if (error.status === 503 || /overload|busy|capacity/i.test(describe(error))) {
            return {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: `${service} is temporarily overloaded.`,
                providerError: withDiagnostics("server_overloaded", diagnostics),
            };
        }
        if (error.status >= 500) {
            return {
                type: "done",
                state: "error",
                kind: "internal_error",
                message: `${service} returned an internal server error.`,
                providerError: withDiagnostics("internal_server_error", diagnostics),
            };
        }
        return {
            type: "done",
            state: "error",
            kind: "unknown",
            message:
                error.upstreamMessage === undefined
                    ? `${service} rejected the request with HTTP ${error.status}.`
                    : `${service} rejected the request: ${error.upstreamMessage}`,
            providerError: withDiagnostics("unclassified", diagnostics),
        };
    }
    if (error instanceof ChatCompletionsTimeoutError) {
        return {
            type: "done",
            state: "error",
            kind: "internal_error",
            message: `${service} stopped responding. ${error.message}`,
            providerError: withDiagnostics("server_overloaded", diagnostics),
        };
    }
    return {
        type: "done",
        state: "error",
        kind: "unknown",
        message: error instanceof Error ? `${service}: ${error.message}` : fallbackMessage,
        providerError: withDiagnostics("unclassified", diagnostics),
    };
}

function withDiagnostics(
    type: SessionProviderError["type"],
    diagnostics: SessionProviderError["diagnostics"],
): SessionProviderError {
    return { type, ...(diagnostics === undefined ? {} : { diagnostics }) };
}

function withResetAt(
    type: "out_of_tokens" | "rate_limit",
    diagnostics: SessionProviderError["diagnostics"],
    resetAt: number | undefined,
): SessionProviderError {
    return {
        type,
        ...(resetAt === undefined ? {} : { resetAt }),
        ...(diagnostics === undefined ? {} : { diagnostics }),
    };
}
