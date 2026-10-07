import { randomUUID } from "node:crypto";

import type { SessionEvent } from "@/core/SessionEvent.js";
import { EMPTY_SESSION_USAGE, type SessionUsage } from "@/core/SessionUsage.js";
import type {
    ChatCompletionsStreamItem,
    ChatCompletionsToolCallDelta,
    ChatCompletionsUsage,
} from "@/protocol/chatCompletions/ChatCompletionsConnection.js";
import {
    ChatCompletionsStreamError,
    parseChatCompletionsErrorBody,
} from "@/protocol/chatCompletions/chatCompletionsErrors.js";
import { CHAT_COMPLETIONS_FREEFORM_VENDOR } from "@/protocol/chatCompletions/createChatCompletionsRequest.js";
import {
    unwrapFreeformArguments,
    type ChatCompletionsToolNames,
} from "@/protocol/chatCompletions/toChatCompletionsTools.js";

export interface ChatCompletionsRunResult {
    /** The finish reason the endpoint reported. */
    readonly finishReason: string;
    readonly text: string;
    readonly toolCalls: number;
    readonly usage: SessionUsage;
    /** The endpoint reported an output-token count, so zero output means an empty response. */
    readonly outputTokensReported: boolean;
}

interface ActiveToolCall {
    index: number;
    callId: string | undefined;
    wireName: string | undefined;
    name: string | undefined;
    namespace: string | undefined;
    freeform: boolean;
    arguments: string;
    started: boolean;
}

/**
 * Maps one Chat Completions stream onto session events.
 *
 * Text and reasoning never interleave: whichever block is open closes before the other opens, and
 * both close before a tool call starts, because the transcript appends a delta only to the block
 * that is last. Streamed tool calls are keyed by their `index`; the ID and name arrive first and
 * the arguments follow in fragments, possibly interleaved with other indexes. A call starts once
 * its name is known and every call ends, in index order, when the response finishes. A freeform
 * call's JSON envelope is unwrapped then, so it streams no fragments of its own.
 *
 * Usage may arrive after the finish reason (OpenAI's `include_usage` chunk) or on the finishing
 * choice itself (Moonshot), so the stream is read until `[DONE]` or its end.
 */
export async function* mapChatCompletionsStream(
    stream: AsyncIterable<ChatCompletionsStreamItem>,
    options: { readonly names: ChatCompletionsToolNames },
): AsyncGenerator<SessionEvent, ChatCompletionsRunResult> {
    let open: "text" | "reasoning" | undefined;
    let text = "";
    let finishReason: string | undefined;
    let usage: SessionUsage | undefined;
    let outputTokensReported = false;
    const calls = new Map<number, ActiveToolCall>();

    function* close(): Generator<SessionEvent> {
        if (open === "text") yield { type: "text_end" };
        if (open === "reasoning") yield { type: "reasoning_end" };
        open = undefined;
    }

    function* startCall(call: ActiveToolCall): Generator<SessionEvent> {
        if (call.started || call.wireName === undefined) return;
        yield* close();
        call.started = true;
        call.callId ??= `call_${randomUUID()}`;
        yield {
            type: "toolcall_start",
            callId: call.callId,
            name: call.name ?? call.wireName,
            ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
            ...(call.freeform ? { vendor: { ...CHAT_COMPLETIONS_FREEFORM_VENDOR } } : {}),
        };
        if (!call.freeform && call.arguments.length > 0) {
            yield { type: "toolcall_delta", callId: call.callId, delta: call.arguments };
        }
    }

    function* toolCallDelta(delta: ChatCompletionsToolCallDelta): Generator<SessionEvent> {
        const index =
            typeof delta.index === "number"
                ? delta.index
                : ([...calls.values()].find((call) => call.callId === delta.id)?.index ??
                  (calls.size === 0 ? 0 : Math.max(...calls.keys())));
        let call = calls.get(index);
        if (call === undefined) {
            call = {
                index,
                callId: undefined,
                wireName: undefined,
                name: undefined,
                namespace: undefined,
                freeform: false,
                arguments: "",
                started: false,
            };
            calls.set(index, call);
        }
        if (!call.started && typeof delta.id === "string" && delta.id.length > 0) {
            call.callId = delta.id;
        }
        const name = delta.function?.name;
        if (call.wireName === undefined && typeof name === "string" && name.length > 0) {
            call.wireName = name;
            const identity = options.names.resolve(name);
            call.name = identity?.name ?? name;
            call.namespace = identity?.namespace;
            call.freeform = identity?.freeform === true;
        }
        const fragment = delta.function?.arguments;
        const started = call.started;
        if (typeof fragment === "string" && fragment.length > 0) call.arguments += fragment;
        yield* startCall(call);
        if (
            started &&
            !call.freeform &&
            call.callId !== undefined &&
            typeof fragment === "string" &&
            fragment.length > 0
        ) {
            yield { type: "toolcall_delta", callId: call.callId, delta: fragment };
        }
    }

    for await (const item of stream) {
        if (item.type === "done") break;
        const chunk = item.chunk;
        if (chunk.error !== undefined && chunk.error !== null) {
            const parsed = parseChatCompletionsErrorBody({ error: chunk.error });
            throw new ChatCompletionsStreamError(
                parsed.message ?? "The stream reported an error.",
                {
                    retryable: true,
                    ...(parsed.code === undefined ? {} : { code: parsed.code }),
                    ...(parsed.type === undefined ? {} : { errorType: parsed.type }),
                },
            );
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
            usage = toSessionUsage(chunk.usage);
            outputTokensReported ||= typeof chunk.usage.completion_tokens === "number";
        }
        const choice = chunk.choices?.find((candidate) => (candidate.index ?? 0) === 0);
        if (choice === undefined) continue;
        if (choice.usage !== undefined && choice.usage !== null) {
            usage = toSessionUsage(choice.usage);
            outputTokensReported ||= typeof choice.usage.completion_tokens === "number";
        }
        const delta = choice.delta;
        const reasoning = delta?.reasoning_content;
        if (typeof reasoning === "string" && reasoning.length > 0) {
            if (open !== "reasoning") {
                yield* close();
                open = "reasoning";
                yield { type: "reasoning_start" };
            }
            yield { type: "reasoning_delta", delta: reasoning };
        }
        const content = delta?.content;
        if (typeof content === "string" && content.length > 0) {
            if (open !== "text") {
                yield* close();
                open = "text";
                yield { type: "text_start" };
            }
            text += content;
            yield { type: "text_delta", delta: content };
        }
        for (const call of delta?.tool_calls ?? []) yield* toolCallDelta(call);
        if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
            finishReason = choice.finish_reason;
        }
    }

    if (finishReason === undefined) {
        throw new ChatCompletionsStreamError("The stream closed before the response finished.", {
            retryable: true,
        });
    }
    if (finishReason === "content_filter") {
        throw new ChatCompletionsStreamError("The response was stopped by a content filter.", {
            retryable: false,
            code: "content_filter",
        });
    }
    if (finishReason === "insufficient_system_resource") {
        throw new ChatCompletionsStreamError(
            "The response was interrupted because the service ran out of capacity.",
            { retryable: true, code: finishReason },
        );
    }

    yield* close();
    const truncated = finishReason === "length";
    const ordered = [...calls.values()].sort((left, right) => left.index - right.index);
    let toolCalls = 0;
    for (const call of ordered) {
        if (!call.started) {
            // A fragment without a name cannot become a call anyone could answer.
            if (call.wireName === undefined) continue;
            yield* startCall(call);
        }
        const callId = call.callId!;
        const argumentsText = call.freeform
            ? unwrapFreeformArguments(call.arguments)
            : call.arguments;
        if (call.freeform && argumentsText.length > 0) {
            yield { type: "toolcall_delta", callId, delta: argumentsText };
        }
        toolCalls += 1;
        yield {
            type: "toolcall_end",
            callId,
            arguments: argumentsText,
            ...(truncated ? { incomplete: true } : {}),
        };
    }

    const reported = usage ?? { ...EMPTY_SESSION_USAGE };
    const tokens = { input: reported.input, output: reported.output };
    if (usage !== undefined) yield { type: "token_usage", usage };
    if (truncated) {
        yield { type: "done", state: "length", tokens };
    } else if (toolCalls > 0) {
        yield { type: "done", state: "tool_call", tokens };
    } else {
        yield { type: "done", state: "normal", tokens, endTurn: true };
    }
    return {
        finishReason,
        text,
        toolCalls,
        usage: reported,
        outputTokensReported,
    };
}

/** Maps DeepSeek's and Moonshot's usage fields onto session usage; cache hits are inside input. */
export function toSessionUsage(usage: ChatCompletionsUsage): SessionUsage {
    const input = count(usage.prompt_tokens);
    const output = count(usage.completion_tokens);
    const cacheRead = Math.min(
        input,
        count(
            usage.prompt_cache_hit_tokens ??
                usage.prompt_tokens_details?.cached_tokens ??
                usage.cached_tokens,
        ),
    );
    return {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        totalTokens: count(usage.total_tokens) || input + output,
    };
}

function count(value: number | null | undefined): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
