import type { SessionReasoningEffort } from "@/core/SessionRunRequest.js";
import type {
    SessionAssistantMessage,
    SessionContext,
    SessionInputBlock,
    SessionMessage,
    SessionOutputBlock,
} from "@/core/SessionContext.js";
import type { SessionStructuredOutput } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { toSessionAgentNotificationMessage } from "@/core/toSessionAgentNotificationMessage.js";
import { toSessionReminderMessage } from "@/core/toSessionReminderMessage.js";
import {
    ChatCompletionsToolNames,
    toChatCompletionsTools,
    type ChatCompletionsTool,
} from "@/protocol/chatCompletions/toChatCompletionsTools.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

type ChatCompletionsContentPart =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

export interface ChatCompletionsToolCall {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
}

export type ChatCompletionsMessage =
    | { readonly role: "system"; readonly content: string }
    | { readonly role: "user"; readonly content: string | readonly ChatCompletionsContentPart[] }
    | {
          readonly role: "assistant";
          readonly content: string;
          readonly reasoning_content?: string;
          readonly tool_calls?: readonly ChatCompletionsToolCall[];
      }
    | { readonly role: "tool"; readonly tool_call_id: string; readonly content: string };

type AssistantChatCompletionsMessage = Extract<ChatCompletionsMessage, { role: "assistant" }>;

export interface ChatCompletionsRequestBody {
    readonly model: string;
    readonly messages: readonly ChatCompletionsMessage[];
    readonly stream: true;
    readonly stream_options?: { readonly include_usage: true };
    readonly tools?: readonly ChatCompletionsTool[];
    readonly max_tokens?: number;
    readonly temperature?: number;
    readonly thinking?: { readonly type: "enabled" | "disabled" };
    readonly reasoning_effort?: string;
    readonly response_format?:
        | { readonly type: "json_object" }
        | {
              readonly type: "json_schema";
              readonly json_schema: {
                  readonly name: string;
                  readonly schema: Record<string, unknown>;
                  readonly strict: false;
              };
          };
}

/** What a vendor declares about one model it serves through Chat Completions. */
export interface ChatCompletionsModelProfile {
    /** The model ID sent on the wire, such as `deepseek-chat`. */
    readonly wireModel: string;
    /** The model accepts `image_url` parts. Without it, images become a short text note. */
    readonly vision?: boolean;
    /** Output budget to request. Omit it to take the endpoint's default. */
    readonly maxTokens?: number;
    /** Sampling temperature to request. Omit it to take the endpoint's default. */
    readonly temperature?: number;
    /**
     * How the model's thinking is switched and sized. `deepseek`: `thinking.type` turns it on
     * or off and `reasoning_effort` (low / high / max) sets how hard it thinks; an effort of
     * `off` switches it off. Absent, the endpoint's own default applies and effort is not sent.
     * `openai`: sends `reasoning_effort` directly, with `off` represented as `none`.
     */
    readonly thinkingControl?: "deepseek" | "openai";
    /**
     * Which assistant messages carry their `reasoning_content` back. `current_turn` (the
     * default): only tool-call messages after the last user message. `all`: every assistant
     * message whenever the request carries tools and thinking is on, an empty string where a
     * message has none — DeepSeek refuses a tool request that drops any earlier reasoning.
     */
    readonly reasoningReplay?: "current_turn" | "all";
}

/** How a structured-output request is expressed to this endpoint. */
export type ChatCompletionsStructuredOutputMode = "json_schema" | "json_object";

export interface CreateChatCompletionsRequestOptions {
    readonly context: SessionContext;
    readonly profile: ChatCompletionsModelProfile;
    readonly tools: readonly SessionTool[];
    readonly names: ChatCompletionsToolNames;
    readonly streamUsage: boolean;
    readonly structuredOutput?: SessionStructuredOutput;
    readonly structuredOutputMode: ChatCompletionsStructuredOutputMode;
    /** The effort the caller asked for, read only when the profile controls thinking. */
    readonly effort?: SessionReasoningEffort;
}

export function createChatCompletionsRequest(
    options: CreateChatCompletionsRequestOptions,
): ChatCompletionsRequestBody {
    const tools = toChatCompletionsTools(options.tools, options.names);
    const structured = options.structuredOutput;
    const thinking = thinkingFields(options.profile, options.effort);
    const thinkingOn = thinking?.thinking?.type !== "disabled";
    const system: ChatCompletionsMessage[] = [];
    if (options.context.instructions.length > 0) {
        system.push({ role: "system", content: options.context.instructions });
    }
    if (structured !== undefined && options.structuredOutputMode === "json_object") {
        // JSON mode takes no schema, so the shape is stated in words, which JSON mode also
        // requires: these endpoints refuse JSON mode unless the prompt asks for JSON.
        system.push({
            role: "system",
            content: `Respond with a single JSON object named "${structured.name}" that conforms to this JSON Schema, and nothing else:\n${JSON.stringify(toLlmParametersSchema(structured.schema))}`,
        });
    }
    return {
        model: options.profile.wireModel,
        messages: [
            ...system,
            ...toChatCompletionsMessages(options.context.messages, {
                names: options.names,
                vision: options.profile.vision === true,
                replayAllReasoning:
                    options.profile.reasoningReplay === "all" && tools.length > 0 && thinkingOn,
            }),
        ],
        ...(thinking ?? {}),
        stream: true,
        ...(options.streamUsage ? { stream_options: { include_usage: true } } : {}),
        ...(tools.length === 0 ? {} : { tools }),
        ...(options.profile.maxTokens === undefined
            ? {}
            : { max_tokens: options.profile.maxTokens }),
        ...(options.profile.temperature === undefined
            ? {}
            : { temperature: options.profile.temperature }),
        ...(structured === undefined
            ? {}
            : options.structuredOutputMode === "json_object"
              ? { response_format: { type: "json_object" as const } }
              : {
                    response_format: {
                        type: "json_schema" as const,
                        json_schema: {
                            name: structured.name,
                            schema: toLlmParametersSchema(structured.schema),
                            strict: false as const,
                        },
                    },
                }),
    };
}

/**
 * The thinking switch and effort for a model whose endpoint exposes them. DeepSeek maps any effort
 * onto low / high / max itself; they are sent in its own words so what reaches it is plain.
 */
function thinkingFields(
    profile: ChatCompletionsModelProfile,
    effort: SessionReasoningEffort | undefined,
): Pick<ChatCompletionsRequestBody, "thinking" | "reasoning_effort"> | undefined {
    if (profile.thinkingControl === "openai" && effort !== undefined)
        return { reasoning_effort: effort === "off" ? "none" : effort };
    if (profile.thinkingControl !== "deepseek" || effort === undefined) return undefined;
    if (effort === "off") return { thinking: { type: "disabled" } };
    const level =
        effort === "minimal" || effort === "low" ? "low" : effort === "max" ? "max" : "high";
    return { thinking: { type: "enabled" }, reasoning_effort: level };
}

/** Vendor metadata stamped on a freeform call so its raw text is wrapped again on replay. */
export const CHAT_COMPLETIONS_FREEFORM_VENDOR = { type: "chat_completions_freeform" } as const;

/** Placeholder for a tool call the history never answered; the endpoint requires an answer. */
const MISSING_TOOL_RESULT = "The tool call did not return a result.";

/**
 * Serializes caller history for one request.
 *
 * The projection is ephemeral and the smallest one the protocol accepts:
 *
 * - system and agent notices become `<system-reminder>` user turns, keeping the position the
 *   caller chose, exactly as the Anthropic protocol delivers them;
 * - a plaintext compaction checkpoint becomes the continuation user message; an opaque one that
 *   carries no text cannot be read by these models and is left out;
 * - `reasoning_content` is replayed only on assistant tool-call messages after the last user
 *   message. DeepSeek and Kimi thinking modes require the current tool-use turn's reasoning back
 *   and do not want earlier turns' reasoning;
 * - every assistant `tool_calls` entry is answered by a following `tool` message, and nothing else
 *   sits between them, because the endpoints reject any other shape. An answer the history lacks
 *   becomes a short placeholder and an answer without its call is dropped.
 */
export function toChatCompletionsMessages(
    messages: readonly SessionMessage[],
    options: {
        readonly names: ChatCompletionsToolNames;
        readonly vision: boolean;
        readonly replayAllReasoning?: boolean;
    },
): ChatCompletionsMessage[] {
    let lastUserIndex = -1;
    messages.forEach((message, index) => {
        if (message.role === "user") lastUserIndex = index;
    });

    const output: ChatCompletionsMessage[] = [];
    let pending = new Set<string>();
    let pendingOrder: string[] = [];
    let deferred: ChatCompletionsMessage[] = [];
    const settle = (): void => {
        for (const callId of pendingOrder) {
            if (!pending.has(callId)) continue;
            output.push({ role: "tool", tool_call_id: callId, content: MISSING_TOOL_RESULT });
        }
        pending = new Set();
        pendingOrder = [];
        output.push(...deferred);
        deferred = [];
    };
    const pushOrdinary = (message: ChatCompletionsMessage): void => {
        if (pending.size > 0) deferred.push(message);
        else output.push(message);
    };

    messages.forEach((original, index) => {
        const message =
            original.role === "agent" ? toSessionAgentNotificationMessage(original) : original;
        switch (message.role) {
            case "system": {
                const reminder = toSessionReminderMessage(message);
                pushOrdinary({
                    role: "user",
                    content: toUserContent(reminder.content, options.vision),
                });
                return;
            }
            case "user":
                pushOrdinary({
                    role: "user",
                    content: toUserContent(message.content, options.vision),
                });
                return;
            case "compaction": {
                const text = message.content?.trim();
                if (text === undefined || text.length === 0) return;
                pushOrdinary({
                    role: "user",
                    content: `Conversation continuation checkpoint (historical context):\n${message.content}`,
                });
                return;
            }
            case "tool": {
                if (!pending.has(message.callId)) return;
                pending.delete(message.callId);
                output.push({
                    role: "tool",
                    tool_call_id: message.callId,
                    content: toToolResultText(message.content),
                });
                if (pending.size === 0) settle();
                return;
            }
            case "assistant": {
                settle();
                const converted = toAssistantMessage(message, {
                    names: options.names,
                    replayReasoning:
                        options.replayAllReasoning === true
                            ? "all"
                            : index > lastUserIndex
                              ? "tool_calls"
                              : "none",
                });
                if (converted === undefined) return;
                output.push(converted);
                for (const call of converted.tool_calls ?? []) {
                    pending.add(call.id);
                    pendingOrder.push(call.id);
                }
                return;
            }
        }
    });
    settle();
    return output;
}

function toAssistantMessage(
    message: SessionAssistantMessage,
    options: {
        readonly names: ChatCompletionsToolNames;
        readonly replayReasoning: "all" | "tool_calls" | "none";
    },
): AssistantChatCompletionsMessage | undefined {
    let text = "";
    let reasoning = "";
    const toolCalls: ChatCompletionsToolCall[] = [];
    const seen = new Set<string>();
    for (const block of message.content) {
        if (block.type === "text") text += block.text;
        else if (block.type === "reasoning") reasoning += block.text ?? "";
        else if (block.type === "tool_call") {
            // Server calls settle inside the vendor's own response; this protocol has none.
            if (block.server === true || seen.has(block.callId)) continue;
            seen.add(block.callId);
            const freeform = isFreeformCall(block.vendor) || options.names.isFreeform(block);
            toolCalls.push({
                id: block.callId,
                type: "function",
                function: {
                    name: options.names.wireName(block),
                    arguments: freeform
                        ? JSON.stringify({ input: block.arguments })
                        : validJsonArguments(block.arguments),
                },
            });
        }
    }
    if (text.length === 0 && toolCalls.length === 0) return undefined;
    return {
        role: "assistant",
        content: text,
        ...(options.replayReasoning === "all"
            ? { reasoning_content: reasoning }
            : options.replayReasoning === "tool_calls" &&
                toolCalls.length > 0 &&
                reasoning.length > 0
              ? { reasoning_content: reasoning }
              : {}),
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
    };
}

function isFreeformCall(vendor: unknown): boolean {
    return (
        typeof vendor === "object" &&
        vendor !== null &&
        "type" in vendor &&
        vendor.type === CHAT_COMPLETIONS_FREEFORM_VENDOR.type
    );
}

/** A truncated call's arguments are replaced on the wire only, since endpoints parse them. */
function validJsonArguments(argumentsJson: string): string {
    if (argumentsJson.trim().length === 0) return "{}";
    try {
        const value: unknown = JSON.parse(argumentsJson);
        return typeof value === "object" && value !== null && !Array.isArray(value)
            ? argumentsJson
            : "{}";
    } catch {
        return "{}";
    }
}

function imageNote(mimeType: string): string {
    return `[An image (${mimeType}) was omitted because this model cannot view images.]`;
}

function toUserContent(
    content: readonly SessionInputBlock[],
    vision: boolean,
): string | ChatCompletionsContentPart[] {
    for (const block of content) {
        if (block.type === "tool_call_request") {
            throw new Error("Tool requests must be executed by the agent before inference.");
        }
    }
    const blocks = content as readonly SessionOutputBlock[];
    if (!vision || !blocks.some((block) => block.type === "image")) {
        return blocks
            .map((block) => (block.type === "text" ? block.text : imageNote(block.mimeType)))
            .join("\n\n");
    }
    return blocks.map((block) =>
        block.type === "text"
            ? { type: "text" as const, text: block.text }
            : {
                  type: "image_url" as const,
                  image_url: { url: `data:${block.mimeType};base64,${block.data}` },
              },
    );
}

function toToolResultText(content: readonly SessionOutputBlock[]): string {
    const text = content
        .map((block) => (block.type === "text" ? block.text : imageNote(block.mimeType)))
        .join("\n\n");
    // Several endpoints reject an empty tool message outright.
    return text.length === 0 ? "(no output)" : text;
}
