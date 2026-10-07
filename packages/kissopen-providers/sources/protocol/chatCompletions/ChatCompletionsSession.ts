import { BaseSession } from "@/core/BaseSession.js";
import {
    EmptyResponseError,
    emptyResponseDoneEvent,
    isEmptyResponseError,
} from "@/core/EmptyResponseError.js";
import {
    createInferenceMaxRetriesResolver,
    type InferenceRetryOptions,
} from "@/core/inferenceRetrySettings.js";
import type { SessionCompaction, SessionCompactionOptions } from "@/core/SessionCompaction.js";
import type { SessionContext, SessionMessage } from "@/core/SessionContext.js";
import type { SessionEvent, SessionStream } from "@/core/SessionEvent.js";
import type { SessionModelConfiguration } from "@/core/SessionModelConfiguration.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { EMPTY_SESSION_USAGE, type SessionUsage } from "@/core/SessionUsage.js";
import { waitForInferenceRetry } from "@/core/waitForInferenceRetry.js";
import {
    ChatCompletionsConnection,
    type ChatCompletionsConnectionOptions,
} from "@/protocol/chatCompletions/ChatCompletionsConnection.js";
import {
    chatCompletionsRetryAfterMs,
    classifyChatCompletionsError,
    isRetryableChatCompletionsError,
} from "@/protocol/chatCompletions/chatCompletionsErrors.js";
import {
    createChatCompletionsRequest,
    type ChatCompletionsModelProfile,
    type ChatCompletionsRequestBody,
    type ChatCompletionsStructuredOutputMode,
} from "@/protocol/chatCompletions/createChatCompletionsRequest.js";
import {
    mapChatCompletionsStream,
    type ChatCompletionsRunResult,
} from "@/protocol/chatCompletions/mapChatCompletionsStream.js";
import { ChatCompletionsToolNames } from "@/protocol/chatCompletions/toChatCompletionsTools.js";
import type { Context } from "@steve.kite/stdlib";
import { coalesceSessionDeltas } from "@/core/coalesceSessionDeltas.js";

/** Endpoint, credential, and behavior shared by a Chat Completions provider and its sessions. */
export interface ChatCompletionsEndpointOptions
    extends ChatCompletionsConnectionOptions, InferenceRetryOptions {
    /** Human-readable service name used in error messages, such as `DeepSeek`. */
    readonly service?: string;
    /** Default model, used when a run names none. */
    readonly model?: string;
    /** Maps a caller model ID onto the wire model and its capabilities. */
    readonly resolveModel?: (model: string) => ChatCompletionsModelProfile;
    /** Ask for a trailing usage chunk with `stream_options.include_usage`. Defaults to true. */
    readonly streamUsage?: boolean;
    /** How structured output is requested. Defaults to `json_schema`. */
    readonly structuredOutputMode?: ChatCompletionsStructuredOutputMode;
}

export interface ChatCompletionsSessionOptions
    extends SessionOptions, ChatCompletionsEndpointOptions {}

/**
 * The checkpoint a Chat Completions model writes when asked to compact.
 *
 * These endpoints have no native compaction, so the portable plaintext checkpoint contract is
 * used: the summary becomes a compaction message whose text continues the conversation.
 */
const CHECKPOINT_PROMPT = `Produce a concise continuation checkpoint of the conversation above.
Retain the user's goal, accepted requirements, permissions and restrictions, completed work,
exact relevant paths and identifiers, observed tool results, unresolved errors, and the next
necessary actions. Distinguish verified results from assumptions and unfinished work.
Do not execute tools or continue the task. Do not invent facts or expose credentials.
Write only the checkpoint, in the user's language, within 1500 words.`;

const MAX_CHECKPOINT_CHARACTERS = 100_000;

/**
 * A session over an OpenAI-compatible `POST /chat/completions` endpoint.
 *
 * The protocol is stateless on the server, so the session keeps only the active model; each run
 * sends the caller's complete history. Each attempt is one event block. A failure before any
 * output streamed is retried within the inference retry budget, with a `retrying` event, after
 * the attempt's block is reset; a failure after output began is terminal, so replay can never
 * duplicate visible output or tool calls.
 */
export class ChatCompletionsSession extends BaseSession {
    readonly service: string;
    readonly model: string | undefined;
    readonly tools: readonly SessionTool[];

    #activeModel: string | undefined;
    readonly #connection: ChatCompletionsConnection;
    readonly #modelConfigurations: Readonly<Record<string, SessionModelConfiguration>> | undefined;
    readonly #resolveModel: (model: string) => ChatCompletionsModelProfile;
    readonly #resolveInferenceMaxRetries: () => number;
    readonly #retryWait: InferenceRetryOptions["waitForInferenceRetry"];
    readonly #streamUsage: boolean;
    readonly #structuredOutputMode: ChatCompletionsStructuredOutputMode;

    constructor(id: string, options: ChatCompletionsSessionOptions) {
        super(id);
        this.service = options.service ?? "The model provider";
        this.model = options.model;
        this.#activeModel = options.model;
        this.tools = options.tools ?? [];
        this.#modelConfigurations = options.modelConfigurations;
        this.#resolveModel = options.resolveModel ?? ((model) => ({ wireModel: model }));
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
        this.#retryWait = options.waitForInferenceRetry;
        this.#streamUsage = options.streamUsage ?? true;
        this.#structuredOutputMode = options.structuredOutputMode ?? "json_schema";
        this.#connection = new ChatCompletionsConnection(options);
    }

    run(ctx: Context, request: SessionRunRequest): SessionStream {
        if (ctx.lifetime?.aborted) return emptySessionStream();
        return this.#streamRun(ctx, request);
    }

    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        const signal = ctx.lifetime;
        const original: SessionContext = {
            instructions: options.context.instructions,
            messages: [...options.context.messages],
        };
        if (signal?.aborted) return { status: "cancelled", context: original };
        const model = options.model ?? this.#activeModel;
        if (model === undefined) {
            return {
                status: "failed",
                kind: "inference_error",
                message: "Choose a model before compacting the conversation.",
            };
        }
        const instructions = `${options.context.instructions}\n\n${CHECKPOINT_PROMPT}`;
        const request: SessionContext = {
            instructions,
            messages: [
                ...options.context.messages,
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text:
                                options.instructions === undefined
                                    ? CHECKPOINT_PROMPT
                                    : `${CHECKPOINT_PROMPT}\n${options.instructions}`,
                        },
                    ],
                },
            ],
        };
        let summary = "";
        let usage: SessionUsage = { ...EMPTY_SESSION_USAGE };
        let completed = false;
        try {
            for await (const event of this.#runAttempts(ctx, {
                context: request,
                model,
                tools: [],
            })) {
                if (signal?.aborted) return { status: "cancelled", context: original };
                if (event.type === "block_reset") summary = "";
                if (event.type === "text_delta") summary += event.delta;
                if (summary.length > MAX_CHECKPOINT_CHARACTERS) {
                    return {
                        status: "failed",
                        kind: "invalid_summary",
                        message: "The conversation checkpoint was too long to use.",
                    };
                }
                if (event.type === "token_usage") usage = event.usage;
                if (event.type === "toolcall_start") {
                    return {
                        status: "failed",
                        kind: "tool_call",
                        message: "The model tried to call a tool while writing the checkpoint.",
                    };
                }
                if (event.type === "done") {
                    if (event.state === "cancelled")
                        return { status: "cancelled", context: original };
                    if (event.state !== "normal") {
                        return {
                            status: "failed",
                            kind: "inference_error",
                            message:
                                event.state === "error"
                                    ? event.message
                                    : "The model did not finish the conversation checkpoint.",
                        };
                    }
                    completed = true;
                }
            }
        } catch (error) {
            if (signal?.aborted) return { status: "cancelled", context: original };
            return {
                status: "failed",
                kind: "inference_error",
                message: error instanceof Error ? error.message : "Compaction failed.",
            };
        }
        if (signal?.aborted) return { status: "cancelled", context: original };
        if (!completed || summary.trim().length === 0) {
            return {
                status: "failed",
                kind: "invalid_summary",
                message: "The model returned no conversation checkpoint.",
            };
        }
        const checkpoint: SessionMessage = {
            role: "compaction",
            content: summary,
            encryptedContent: null,
        };
        return {
            status: "completed",
            summary,
            preservedMessages: [],
            usage,
            context: { instructions: options.context.instructions, messages: [checkpoint] },
        };
    }

    destroy(): void {}

    async *#streamRun(ctx: Context, request: SessionRunRequest): AsyncGenerator<SessionEvent> {
        const model = request.model ?? this.#activeModel;
        if (model === undefined) {
            yield {
                type: "done",
                state: "error",
                kind: "unknown",
                message: `A model is required for ${this.service} inference.`,
            };
            return;
        }
        const configuration = this.#modelConfigurations?.[model];
        yield* this.#runAttempts(ctx, {
            context: {
                instructions: configuration?.instructions ?? request.context.instructions,
                messages: request.context.messages,
            },
            model,
            tools: configuration?.tools ?? this.tools,
            ...(request.effort === undefined ? {} : { effort: request.effort }),
            ...(request.structuredOutput === undefined
                ? {}
                : { structuredOutput: request.structuredOutput }),
        });
    }

    async *#runAttempts(
        ctx: Context,
        options: {
            readonly context: SessionContext;
            readonly model: string;
            readonly tools: readonly SessionTool[];
            readonly structuredOutput?: SessionRunRequest["structuredOutput"];
            readonly effort?: SessionRunRequest["effort"];
        },
    ): AsyncGenerator<SessionEvent> {
        const abort = ctx.lifetime;
        this.#activeModel = options.model;
        const names = new ChatCompletionsToolNames(options.tools);
        let body: ChatCompletionsRequestBody;
        try {
            body = createChatCompletionsRequest({
                context: options.context,
                profile: this.#resolveModel(options.model),
                tools: options.tools,
                names,
                streamUsage: this.#streamUsage,
                structuredOutputMode: this.#structuredOutputMode,
                ...(options.effort === undefined ? {} : { effort: options.effort }),
                ...(options.structuredOutput === undefined
                    ? {}
                    : { structuredOutput: options.structuredOutput }),
            });
        } catch (error) {
            yield classifyChatCompletionsError(error, this.service, 1);
            return;
        }

        let retries = 0;
        for (;;) {
            const attemptUsage: Extract<SessionEvent, { type: "token_usage" }>[] = [];
            let outputBegun = false;
            yield { type: "block_start" };
            // One stored event per token or two would swamp the agent's history; see
            // coalesceSessionDeltas.
            const inference = coalesceSessionDeltas(
                mapChatCompletionsStream(this.#connection.stream(body, abort), { names }),
            );
            try {
                let result: ChatCompletionsRunResult;
                let terminal: Extract<SessionEvent, { type: "done" }> | undefined;
                for (;;) {
                    const next = await inference.next();
                    if (next.done) {
                        result = next.value;
                        break;
                    }
                    const event = next.value;
                    if (event.type === "done") terminal = event;
                    else if (event.type === "token_usage") attemptUsage.push(event);
                    else {
                        outputBegun = true;
                        yield event;
                    }
                }
                if (
                    result.finishReason !== "length" &&
                    result.toolCalls === 0 &&
                    result.text.trim().length === 0 &&
                    (!result.outputTokensReported || result.usage.output === 0)
                ) {
                    throw new EmptyResponseError(this.service, result.usage);
                }
                for (const event of attemptUsage) yield event;
                yield { type: "block_stop" };
                if (terminal !== undefined) yield terminal;
                return;
            } catch (error) {
                yield { type: "block_reset" };
                for (const event of attemptUsage) yield event;
                if (abort?.aborted) {
                    yield { type: "done", state: "cancelled" };
                    return;
                }
                const emptyResponse = isEmptyResponseError(error);
                if (
                    (emptyResponse || (!outputBegun && isRetryableChatCompletionsError(error))) &&
                    retries < this.#resolveInferenceMaxRetries()
                ) {
                    retries += 1;
                    yield {
                        type: "retrying",
                        attempt: retries,
                        reason: error instanceof Error ? error.message : String(error),
                    };
                    try {
                        await this.#waitBeforeRetry(retries, error, abort);
                    } catch (delayError) {
                        if (abort?.aborted) {
                            yield { type: "done", state: "cancelled" };
                            return;
                        }
                        throw delayError;
                    }
                    continue;
                }
                yield emptyResponse
                    ? emptyResponseDoneEvent(error, retries + 1)
                    : classifyChatCompletionsError(error, this.service, retries + 1);
                return;
            } finally {
                // A caller that stops reading early must not leave the request streaming.
                await inference.return(undefined as never).catch(() => undefined);
            }
        }
    }

    async #waitBeforeRetry(attempt: number, error: unknown, signal?: AbortSignal): Promise<void> {
        if (this.#retryWait !== undefined) return await this.#retryWait(attempt, signal);
        const serverDelay = chatCompletionsRetryAfterMs(error);
        if (serverDelay === undefined) return await waitForInferenceRetry(attempt, signal);
        if (signal?.aborted) throw new DOMException("Request was aborted", "AbortError");
        await new Promise<void>((resolve, reject) => {
            const abort = (): void => {
                clearTimeout(timeout);
                reject(new DOMException("Request was aborted", "AbortError"));
            };
            const timeout = setTimeout(() => {
                signal?.removeEventListener("abort", abort);
                resolve();
            }, serverDelay);
            signal?.addEventListener("abort", abort, { once: true });
        });
    }
}

function emptySessionStream(): SessionStream {
    async function* generator(): AsyncGenerator<SessionEvent> {}
    return generator();
}
