import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    ChatCompletionsStreamError,
    ChatCompletionsTimeoutError,
    chatCompletionsHttpError,
} from "@/protocol/chatCompletions/chatCompletionsErrors.js";
import type { ChatCompletionsRequestBody } from "@/protocol/chatCompletions/createChatCompletionsRequest.js";

/** Defaults bound a stalled endpoint to minutes, not the platform's unbounded socket wait. */
export const DEFAULT_CHAT_COMPLETIONS_RESPONSE_TIMEOUT_MS = 150_000;
export const DEFAULT_CHAT_COMPLETIONS_STREAM_IDLE_TIMEOUT_MS = 180_000;

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const chatCompletionsUsageSchema = Type.Object({
    prompt_tokens: Type.Optional(nullable(Type.Number())),
    completion_tokens: Type.Optional(nullable(Type.Number())),
    total_tokens: Type.Optional(nullable(Type.Number())),
    /** DeepSeek's context-cache hits, already counted in `prompt_tokens`. */
    prompt_cache_hit_tokens: Type.Optional(nullable(Type.Number())),
    /** Moonshot's context-cache hits, already counted in `prompt_tokens`. */
    cached_tokens: Type.Optional(nullable(Type.Number())),
    prompt_tokens_details: Type.Optional(
        nullable(Type.Object({ cached_tokens: Type.Optional(nullable(Type.Number())) })),
    ),
});

export type ChatCompletionsUsage = Static<typeof chatCompletionsUsageSchema>;

const chatCompletionsToolCallDeltaSchema = Type.Object({
    index: Type.Optional(nullable(Type.Number())),
    id: Type.Optional(nullable(Type.String())),
    type: Type.Optional(nullable(Type.String())),
    function: Type.Optional(
        nullable(
            Type.Object({
                name: Type.Optional(nullable(Type.String())),
                arguments: Type.Optional(nullable(Type.String())),
            }),
        ),
    ),
});

export type ChatCompletionsToolCallDelta = Static<typeof chatCompletionsToolCallDeltaSchema>;

const chatCompletionsChunkSchema = Type.Object({
    id: Type.Optional(nullable(Type.String())),
    model: Type.Optional(nullable(Type.String())),
    choices: Type.Optional(
        nullable(
            Type.Array(
                Type.Object({
                    index: Type.Optional(nullable(Type.Number())),
                    delta: Type.Optional(
                        nullable(
                            Type.Object({
                                role: Type.Optional(nullable(Type.String())),
                                content: Type.Optional(nullable(Type.String())),
                                reasoning_content: Type.Optional(nullable(Type.String())),
                                tool_calls: Type.Optional(
                                    nullable(Type.Array(chatCompletionsToolCallDeltaSchema)),
                                ),
                            }),
                        ),
                    ),
                    finish_reason: Type.Optional(nullable(Type.String())),
                    /** Moonshot reports streamed usage on the finishing choice. */
                    usage: Type.Optional(nullable(chatCompletionsUsageSchema)),
                }),
            ),
        ),
    ),
    usage: Type.Optional(nullable(chatCompletionsUsageSchema)),
    error: Type.Optional(Type.Unknown()),
});

export type ChatCompletionsChunk = Static<typeof chatCompletionsChunkSchema>;

/** One decoded stream item: a chunk, or the `[DONE]` sentinel that ends the stream. */
export type ChatCompletionsStreamItem =
    | { readonly type: "chunk"; readonly chunk: ChatCompletionsChunk }
    | { readonly type: "done" };

export interface ChatCompletionsConnectionOptions {
    readonly apiKey: string;
    /** Base URL ending before `/chat/completions`, such as `https://api.deepseek.com`. */
    readonly baseUrl: string;
    readonly fetch?: typeof fetch;
    readonly headers?: Readonly<Record<string, string>>;
    readonly userAgent?: string;
    readonly responseTimeoutMs?: number;
    readonly streamIdleTimeoutMs?: number;
}

/**
 * One streamed `POST {baseUrl}/chat/completions` request.
 *
 * The whole network path lives here: the request, the response-start bound, the SSE framing, and
 * the idle bound between reads. It yields the decoded chunks and nothing else. An HTTP failure
 * throws the typed error with the parsed error body; a stall throws a timeout error; aborting
 * `signal` cancels the request and ends the stream with the platform's abort error.
 */
export class ChatCompletionsConnection {
    readonly url: string;
    readonly #options: ChatCompletionsConnectionOptions;
    readonly #responseTimeoutMs: number;
    readonly #streamIdleTimeoutMs: number;

    constructor(options: ChatCompletionsConnectionOptions) {
        this.#options = options;
        this.url = chatCompletionsUrl(options.baseUrl);
        this.#responseTimeoutMs = positiveInteger(
            options.responseTimeoutMs,
            DEFAULT_CHAT_COMPLETIONS_RESPONSE_TIMEOUT_MS,
            "responseTimeoutMs",
        );
        this.#streamIdleTimeoutMs = positiveInteger(
            options.streamIdleTimeoutMs,
            DEFAULT_CHAT_COMPLETIONS_STREAM_IDLE_TIMEOUT_MS,
            "streamIdleTimeoutMs",
        );
    }

    async *stream(
        body: ChatCompletionsRequestBody,
        signal?: AbortSignal,
    ): AsyncGenerator<ChatCompletionsStreamItem> {
        const controller = new AbortController();
        const forwardAbort = (): void => controller.abort(signal?.reason);
        if (signal?.aborted) forwardAbort();
        else signal?.addEventListener("abort", forwardAbort, { once: true });
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        try {
            const response = await this.#open(body, controller);
            if (!response.ok) throw await chatCompletionsHttpError(response);
            if (response.body === null) {
                throw new ChatCompletionsStreamError("The response carried no body.", {
                    retryable: true,
                });
            }
            reader = response.body.getReader();
            const decoder = new TextDecoder();
            const parser = new ServerSentEventParser();
            for (;;) {
                const read = await this.#readWithIdleBound(reader, controller);
                const text = read.done
                    ? decoder.decode()
                    : decoder.decode(read.value, { stream: true });
                const events = parser.push(text);
                if (read.done) events.push(...parser.finish());
                for (const data of events) {
                    const item = decodeStreamData(data);
                    if (item === undefined) continue;
                    yield item;
                    if (item.type === "done") return;
                }
                if (read.done) return;
            }
        } finally {
            signal?.removeEventListener("abort", forwardAbort);
            if (reader !== undefined) {
                void reader.cancel().catch(() => undefined);
            }
            controller.abort();
        }
    }

    async #open(body: ChatCompletionsRequestBody, controller: AbortController): Promise<Response> {
        const fetchImpl = this.#options.fetch ?? fetch;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                const error = new ChatCompletionsTimeoutError(
                    `No response started within ${formatSeconds(this.#responseTimeoutMs)}.`,
                );
                controller.abort(error);
                reject(error);
            }, this.#responseTimeoutMs);
        });
        const aborted = whenAborted(controller.signal);
        try {
            return await Promise.race([
                aborted.promise,
                fetchImpl(this.url, {
                    method: "POST",
                    headers: {
                        ...this.#options.headers,
                        Accept: "text/event-stream",
                        Authorization: `Bearer ${this.#options.apiKey}`,
                        "Content-Type": "application/json",
                        ...(this.#options.userAgent === undefined
                            ? {}
                            : { "User-Agent": this.#options.userAgent }),
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                }),
                timedOut,
            ]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            aborted.dispose();
        }
    }

    async #readWithIdleBound(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        controller: AbortController,
    ): Promise<ReadResult> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const idle = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
                const error = new ChatCompletionsTimeoutError(
                    `The stream was silent for ${formatSeconds(this.#streamIdleTimeoutMs)}.`,
                );
                controller.abort(error);
                reject(error);
            }, this.#streamIdleTimeoutMs);
        });
        // A body that ignores the abort signal must still stop being read once it fires.
        const aborted = whenAborted(controller.signal);
        try {
            return await Promise.race([reader.read(), idle, aborted.promise]);
        } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            aborted.dispose();
        }
    }
}

function whenAborted(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
    let listener: (() => void) | undefined;
    const promise = new Promise<never>((_resolve, reject) => {
        const fail = (): void =>
            reject(
                signal.reason instanceof Error
                    ? signal.reason
                    : new DOMException("Request was aborted", "AbortError"),
            );
        if (signal.aborted) {
            fail();
            return;
        }
        listener = fail;
        signal.addEventListener("abort", fail, { once: true });
    });
    return {
        promise,
        dispose: () => {
            if (listener !== undefined) signal.removeEventListener("abort", listener);
        },
    };
}

export function chatCompletionsUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.length === 0) throw new TypeError("A Chat Completions base URL is required.");
    return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function decodeStreamData(data: string): ChatCompletionsStreamItem | undefined {
    const trimmed = data.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed === "[DONE]") return { type: "done" };
    let value: unknown;
    try {
        value = JSON.parse(trimmed);
    } catch (error) {
        throw new ChatCompletionsStreamError("The stream carried a chunk that is not JSON.", {
            retryable: true,
            cause: error,
        });
    }
    if (!Value.Check(chatCompletionsChunkSchema, value)) {
        throw new ChatCompletionsStreamError(
            "The stream carried a chunk that is not a Chat Completions chunk.",
            { retryable: true },
        );
    }
    return { type: "chunk", chunk: value };
}

/**
 * Minimal SSE framing: `data:` lines join with newlines until a blank line dispatches them.
 * Comment lines (DeepSeek's `: keep-alive`) and other fields carry nothing for this protocol.
 */
class ServerSentEventParser {
    #buffer = "";
    #data: string[] = [];

    push(text: string): string[] {
        this.#buffer += text;
        const events: string[] = [];
        for (;;) {
            const newline = this.#buffer.search(/\r\n|\r|\n/);
            if (newline < 0) break;
            const line = this.#buffer.slice(0, newline);
            const separatorLength =
                this.#buffer[newline] === "\r" && this.#buffer[newline + 1] === "\n" ? 2 : 1;
            this.#buffer = this.#buffer.slice(newline + separatorLength);
            this.#line(line, events);
        }
        return events;
    }

    finish(): string[] {
        const events: string[] = [];
        if (this.#buffer.length > 0) {
            this.#line(this.#buffer, events);
            this.#buffer = "";
        }
        this.#line("", events);
        return events;
    }

    #line(line: string, events: string[]): void {
        if (line.length === 0) {
            if (this.#data.length > 0) events.push(this.#data.join("\n"));
            this.#data = [];
            return;
        }
        if (line.startsWith(":")) return;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        if (field !== "data") return;
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        this.#data.push(value);
    }
}

type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a finite positive integer.`);
    }
    return value;
}

function formatSeconds(milliseconds: number): string {
    const seconds = milliseconds / 1_000;
    return Number.isInteger(seconds) ? `${seconds} s` : `${seconds.toFixed(1)} s`;
}
