import { messageDisplayText, type MessageUsageLimit } from "@kissopen/kissopen-agent-client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentEvent } from "../events/index.js";
import type { HistoryMessage, HistoryToolPresentation } from "../history/index.js";
import type {
    KissopenAuthor,
    KissopenSessionEnvelope,
    KissopenSessionEvent,
    KissopenSessionProtocolMessage,
    KissopenUsage,
    KissopenInputContent,
} from "./KissopenProtocol.js";
import { kissopenServerMessageId } from "./KissopenProtocol.js";
import {
    kissopenToolCallPresentation,
    normalizeKissopenToolCall,
} from "./normalizeKissopenToolCall.js";
import { MAX_KISSOPEN_OUTBOX_MESSAGE_CHARACTERS } from "./KissopenSync.js";
import { messageUsageLimit } from "../impl/messageUsageLimit.js";

/** How many event ids are remembered so a replayed event is not shown twice. */
const MAX_REMEMBERED_EVENTS = 16_384;

const acceptedMessageSchema = Type.Object(
    {
        id: Type.String({ minLength: 1 }),
        kind: Type.String({ minLength: 1 }),
        runId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true },
);

const providerEventSchema = Type.Object(
    {
        event: Type.Object(
            { type: Type.String(), providerError: Type.Optional(Type.Unknown()) },
            { additionalProperties: true },
        ),
        recovered: Type.Optional(Type.Boolean()),
        rigEvent: Type.Optional(
            Type.Object({ type: Type.String() }, { additionalProperties: true }),
        ),
        runId: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true },
);

const streamedTextSchema = Type.Object(
    { content: Type.Optional(Type.String()) },
    { additionalProperties: true },
);

const streamedBlockSchema = Type.Object(
    {
        messageId: Type.String({ minLength: 1 }),
        contentIndex: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: true },
);

const streamedDeltaSchema = Type.Intersect([
    streamedBlockSchema,
    Type.Object(
        {
            delta: Type.String(),
            partial: Type.Object(
                {
                    content: Type.Array(
                        Type.Union([
                            Type.Object(
                                { type: Type.Literal("text"), text: Type.String() },
                                { additionalProperties: true },
                            ),
                            Type.Object(
                                { type: Type.Literal("thinking"), thinking: Type.String() },
                                { additionalProperties: true },
                            ),
                            Type.Object(
                                { type: Type.Literal("toolCall") },
                                { additionalProperties: true },
                            ),
                        ]),
                    ),
                },
                { additionalProperties: true },
            ),
        },
        { additionalProperties: true },
    ),
]);

const retryingSchema = Type.Object(
    { attempt: Type.Number(), reason: Type.String() },
    { additionalProperties: true },
);

const toolStartSchema = Type.Object(
    {
        rigEvent: Type.Object(
            {
                toolCall: Type.Object(
                    {
                        arguments: Type.Optional(Type.Unknown()),
                        id: Type.String({ minLength: 1 }),
                        name: Type.Optional(Type.String()),
                    },
                    { additionalProperties: true },
                ),
                type: Type.Literal("tool_execution_start"),
            },
            { additionalProperties: true },
        ),
        runId: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const toolEndSchema = Type.Object(
    {
        rigEvent: Type.Object(
            {
                result: Type.Object(
                    {
                        display: Type.Optional(Type.String()),
                        isError: Type.Optional(Type.Boolean()),
                        toolCallId: Type.String({ minLength: 1 }),
                    },
                    { additionalProperties: true },
                ),
                type: Type.Literal("tool_execution_end"),
            },
            { additionalProperties: true },
        ),
        runId: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const inferenceSchema = Type.Object(
    {
        errorMessage: Type.Optional(Type.String()),
        runId: Type.String({ minLength: 1 }),
        state: Type.Optional(Type.String()),
        tokens: Type.Optional(
            Type.Object(
                { input: Type.Number(), output: Type.Number() },
                { additionalProperties: true },
            ),
        ),
    },
    { additionalProperties: true },
);

const settlementSchema = Type.Object(
    {
        error: Type.Optional(Type.String()),
        errorMessage: Type.Optional(Type.String()),
        runId: Type.String({ minLength: 1 }),
        stopReason: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

const loopSchema = Type.Object(
    { runId: Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);

/** Text from old history is useful as a preview, but not at the cost of an unbounded outbox item. */
const MAX_HISTORY_TEXT = 4_000;

interface ActiveTurn {
    readonly id: string;
    readonly startedAt: number;
}

/**
 * Turns one agent's durable event journal into the flat stream of messages KISSOPEN shows.
 *
 * KISSOPEN renders a conversation as turns: a turn opens, things happen inside it,
 * and it ends with how it ended and how long it took. KISSOPEN Agent's journal says the
 * same thing in its own words, and this is the translation, one event at a time
 * and in order.
 *
 * One mapper belongs to one agent on one personal connection. It remembers what an in-flight turn
 * needs, so a restart resumes mid-conversation without replaying anything: the
 * outbox, not this, is what makes delivery durable.
 */
export class KissopenMessageMapper {
    readonly #connectionOwnerId: string | undefined;
    readonly #appliedEventIds = new Set<string>();
    readonly #runStartedAt = new Map<string, number>();
    /** The presentations of the run being mapped, handed in with each live event. */
    #presentations: ReadonlyMap<string, HistoryToolPresentation> | undefined;
    #activeTurn: ActiveTurn | undefined;
    #usage: KissopenUsage | undefined;
    readonly #usageLimits = new Map<string, MessageUsageLimit>();

    constructor(connectionOwnerId?: string) {
        this.#connectionOwnerId = connectionOwnerId;
    }

    /** Only this connection's phone already has the original message in its relay stream. */
    #isOwnMessage(message: HistoryMessage): boolean {
        return (
            this.#connectionOwnerId === undefined ||
            message.userId === undefined ||
            message.userId === this.#connectionOwnerId
        );
    }

    /**
     * Translates one journal event, or answers nothing when it says nothing to KISSOPEN.
     *
     * `author` names who wrote an accepted user message, when the caller knows; it rides on the
     * user-role envelope so a phone in a shared session can attribute a teammate's message.
     */
    map(
        event: AgentEvent,
        acceptedMessage?: HistoryMessage,
        author?: KissopenAuthor,
        /**
         * What the tools of this event's run produced, by call id, as History recorded it. A
         * live tool-end event names only its call; the picture it made is in History.
         */
        presentations?: ReadonlyMap<string, HistoryToolPresentation>,
    ): readonly KissopenSessionProtocolMessage[] {
        if (this.#appliedEventIds.has(event.id)) return [];
        this.#remember(event.id);
        this.#presentations = presentations;

        if (event.type === "message.accepted") {
            return this.#mapAccepted(event, acceptedMessage, author);
        }
        if (event.type === "loop.started") return this.#mapLoopStarted(event);
        if (event.type === "provider.event") return this.#mapProviderEvent(event);
        if (event.type === "tool.started" || event.type === "tool.completed") {
            return this.#mapTool(event);
        }
        if (event.type === "inference.completed") return this.#mapInference(event);
        if (event.type === "loop.settled") return this.#mapSettled(event);
        return [];
    }

    /**
     * Maps archived history through the same message vocabulary used by the live event stream.
     * `authorOf` names who wrote a user message, when the caller can tell; see {@link map}.
     */
    mapHistory(
        messages: readonly HistoryMessage[],
        maximumMessages?: number,
        authorOf?: (message: HistoryMessage) => KissopenAuthor | undefined,
    ): readonly KissopenSessionProtocolMessage[] {
        let latestTime = 0;
        const mapped = messages.flatMap((message) => {
            if (message.hideFromUser === true) return [];
            if (message.remoteMessageId !== undefined && this.#isOwnMessage(message)) return [];
            // Archive order is acceptance order, but a queued user's timestamp is
            // its earlier submission time. Keep projection time nondecreasing;
            // leave the source record unchanged.
            const time = Math.max(latestTime, message.at ?? 0);
            const projected = this.#mapHistoryMessage(
                message,
                `history:${message.recordId}`,
                time,
                authorOf?.(message),
            );
            if (projected.length > 0) latestTime = time;
            return projected;
        });
        if (maximumMessages === undefined) return mapped;
        if (maximumMessages <= 0) return [];
        return mapped.slice(-maximumMessages);
    }

    #mapAccepted(
        event: AgentEvent,
        message: HistoryMessage | undefined,
        author: KissopenAuthor | undefined,
    ): readonly KissopenSessionProtocolMessage[] {
        if (!Value.Check(acceptedMessageSchema, event.payload)) return [];
        const accepted = event.payload;
        this.#rememberRunStart(accepted.runId, event.occurredAt);
        if (message?.recordId !== accepted.id) return [];
        if (message.hideFromUser === true) return [];
        // Only the sending connection already has this message. Other participants use separate
        // relay streams: they need its text, not a receipt referring to a message they never got.
        if (message.remoteMessageId !== undefined && this.#isOwnMessage(message)) {
            if (message.role !== "user") return [];
            return [
                ...this.#closeTurn(event, accepted.runId, "completed", "steering"),
                this.#createMessage({
                    ev: {
                        id: accepted.id,
                        ref: kissopenServerMessageId(message.remoteMessageId),
                        runId: accepted.runId,
                        t: "user-message-accepted",
                    },
                    id: `accepted:${accepted.id}`,
                    role: "agent",
                    time: event.occurredAt,
                }),
            ];
        }
        const text = message.blocks
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
        const content = richUserInput(message);
        if (text.length === 0 && content === undefined) return [];
        // A message arriving mid-turn is the person interrupting; the turn ends here.
        const interrupted = this.#closeTurn(event, accepted.runId, "completed", "steering");
        if (message.role === "user") {
            return [
                ...interrupted,
                this.#createMessage(
                    {
                        ...(author === undefined ? {} : { author }),
                        ev: {
                            t: "text",
                            text: text || requestedToolText(content),
                            ...(content === undefined ? {} : { content }),
                        },
                        id: accepted.id,
                        role: "user",
                        time: event.occurredAt,
                    },
                    messageDisplayText(message.clientMetadata),
                ),
            ];
        }
        // Anything the runtime or another agent said belongs to the agent's side.
        return [...interrupted, this.#agentMessage(event, accepted.id, { t: "service", text })];
    }

    #mapHistoryMessage(
        message: HistoryMessage,
        idPrefix: string,
        time: number,
        author: KissopenAuthor | undefined,
    ): KissopenSessionProtocolMessage[] {
        const output: KissopenSessionProtocolMessage[] = [];
        const turn = `history:${message.runId ?? message.recordId}`;
        const userAuthor = message.role === "user" && author !== undefined ? { author } : {};
        const userDisplayText =
            message.role === "user" ? messageDisplayText(message.clientMetadata) : undefined;
        const content = richUserInput(message);
        if (content !== undefined) {
            const text = content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n")
                .trim();
            return [
                this.#createMessage(
                    {
                        ...userAuthor,
                        ev: { t: "text", text: text || requestedToolText(content), content },
                        id: idPrefix,
                        role: "user",
                        time,
                    },
                    userDisplayText,
                ),
            ];
        }
        // A composed message is one label however many text blocks carry it.
        if (userDisplayText !== undefined) {
            const text = message.blocks
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n")
                .trim();
            if (text.length === 0) return [];
            return [
                this.#createMessage(
                    {
                        ...userAuthor,
                        ev: {
                            t: "text",
                            text:
                                text.length > MAX_HISTORY_TEXT
                                    ? `${text.slice(0, MAX_HISTORY_TEXT)}…`
                                    : text,
                        },
                        id: idPrefix,
                        role: "user",
                        time,
                    },
                    userDisplayText,
                ),
            ];
        }
        for (const block of message.blocks) {
            const id = output.length === 0 ? idPrefix : `${idPrefix}:${String(output.length)}`;
            if (block.type === "text") {
                const text = block.text.trim();
                if (text.length === 0) continue;
                const bounded =
                    text.length > MAX_HISTORY_TEXT ? `${text.slice(0, MAX_HISTORY_TEXT)}…` : text;
                output.push(
                    this.#createMessage(
                        {
                            ...userAuthor,
                            ev:
                                message.role === "user" || message.role === "assistant"
                                    ? { t: "text", text: bounded }
                                    : {
                                          t: "service",
                                          text: bounded,
                                          ...(message.usageLimit
                                              ? { usageLimit: message.usageLimit }
                                              : {}),
                                      },
                            id,
                            role: message.role === "user" ? "user" : "agent",
                            time,
                            ...(message.role === "user" ? {} : { turn }),
                        },
                        userDisplayText,
                    ),
                );
                continue;
            }
            // Reasoning is private model state. Live sync does not reconstruct it from prose, and
            // a historical replay must not publish it merely because the archive retained it.
            if (block.type === "thinking") continue;
            if (block.type === "tool_call") {
                output.push(
                    this.#createMessage({
                        ev: this.#toolCallEvent({
                            arguments: block.arguments,
                            id: block.callId,
                            name: block.name,
                        }),
                        id,
                        role: "agent",
                        time,
                        turn,
                    }),
                );
                continue;
            }
            if (block.type === "tool_result") {
                output.push(
                    this.#createMessage({
                        ev: this.#toolResultEvent(
                            block.callId,
                            block.display,
                            block.isError,
                            block.presentation,
                        ),
                        id,
                        role: "agent",
                        time,
                        turn,
                    }),
                );
            }
        }
        return output;
    }

    #mapLoopStarted(event: AgentEvent): readonly KissopenSessionProtocolMessage[] {
        if (Value.Check(loopSchema, event.payload)) {
            this.#rememberRunStart(event.payload.runId, event.occurredAt);
        }
        return [];
    }

    #mapProviderEvent(event: AgentEvent): readonly KissopenSessionProtocolMessage[] {
        if (!Value.Check(providerEventSchema, event.payload)) return [];
        const payload = event.payload;
        // A recovered stream is Kissopen Agent repairing its own state, not the model speaking.
        if (payload.recovered === true) return [];
        const streamed = payload.event.type;
        if (streamed === "done") {
            const limit = messageUsageLimit(payload.event.providerError);
            if (limit !== undefined) {
                if (this.#usageLimits.size >= MAX_REMEMBERED_EVENTS) this.#usageLimits.clear();
                this.#usageLimits.set(payload.runId, limit);
            }
            return [];
        }
        if (streamed === "block_start") {
            return this.#openTurn(event, payload.runId);
        }
        if (streamed === "text_delta" || streamed === "reasoning_delta") {
            if (!Value.Check(streamedDeltaSchema, payload.rigEvent)) return [];
            const delta = payload.rigEvent;
            const block = delta.partial.content[delta.contentIndex];
            const text =
                block?.type === "text"
                    ? block.text
                    : block?.type === "thinking"
                      ? block.thinking
                      : undefined;
            if (text === undefined || !delta.delta.length || !text.endsWith(delta.delta)) return [];
            return [
                ...this.#openTurn(event, payload.runId),
                this.#agentMessage(event, `${event.id}:delta`, {
                    t: "text-delta",
                    streamId: `${payload.runId}:${delta.messageId}:${delta.contentIndex}`,
                    offset: text.length - delta.delta.length,
                    text: delta.delta,
                    ...(streamed === "reasoning_delta" ? { thinking: true } : {}),
                }),
            ];
        }
        if (streamed === "text_end" || streamed === "reasoning_end") {
            if (!Value.Check(streamedTextSchema, payload.rigEvent)) return [];
            const text = payload.rigEvent.content ?? "";
            const block = Value.Check(streamedBlockSchema, payload.rigEvent)
                ? payload.rigEvent
                : undefined;
            if (text.length === 0 && block === undefined) return [];
            return [
                ...this.#openTurn(event, payload.runId),
                this.#agentMessage(event, `${event.id}:text`, {
                    t: "text",
                    text,
                    ...(block
                        ? { streamId: `${payload.runId}:${block.messageId}:${block.contentIndex}` }
                        : {}),
                    ...(streamed === "reasoning_end" ? { thinking: true } : {}),
                }),
            ];
        }
        if (streamed === "retrying") {
            if (!Value.Check(retryingSchema, payload.event)) return [];
            return [
                this.#agentMessage(event, `${event.id}:retry`, {
                    t: "service",
                    text: `Retrying after an error (attempt ${payload.event.attempt}): ${payload.event.reason}`,
                }),
            ];
        }
        // A server tool settles inside the response, so its call arrives here.
        return this.#mapTool(event);
    }

    #mapTool(event: AgentEvent): readonly KissopenSessionProtocolMessage[] {
        if (Value.Check(toolStartSchema, event.payload)) {
            const call = event.payload.rigEvent.toolCall;
            return [
                ...(event.payload.runId === undefined
                    ? []
                    : this.#openTurn(event, event.payload.runId)),
                this.#agentMessage(
                    event,
                    `tool-call:${call.id}`,
                    this.#toolCallEvent({
                        arguments: call.arguments,
                        id: call.id,
                        name: call.name ?? "tool",
                    }),
                ),
            ];
        }
        if (Value.Check(toolEndSchema, event.payload)) {
            const result = event.payload.rigEvent.result;
            return [
                /*
                 * Every agent envelope must name a turn, and clients drop one that does not. The
                 * turn lives only in this mapper's memory, so a call that outlived the process
                 * that started it — a question answered after a restart — ended with no turn to
                 * name, and its row stayed "running" on every client for good. Such an end opens
                 * a turn of its own; clients pair a result with its call by the call's id.
                 */
                ...(this.#activeTurn === undefined
                    ? this.#openTurn(event, event.payload.runId ?? event.id)
                    : []),
                this.#agentMessage(
                    event,
                    `tool-result:${result.toolCallId}`,
                    this.#toolResultEvent(
                        result.toolCallId,
                        result.display,
                        result.isError,
                        this.#presentations?.get(result.toolCallId),
                    ),
                ),
            ];
        }
        return [];
    }

    #toolCallEvent(call: {
        arguments?: unknown;
        id: string;
        name: string;
    }): Extract<KissopenSessionEvent, { t: "tool-call-start" }> {
        const args = call.arguments === undefined ? {} : toRecord(call.arguments);
        const normalized = normalizeKissopenToolCall(call.name, args);
        const presentation = kissopenToolCallPresentation(call.name, normalized);
        return {
            args: normalized.args,
            call: call.id,
            description: presentation.description,
            name: normalized.name,
            t: "tool-call-start",
            title: presentation.title,
        };
    }

    #toolResultEvent(
        callId: string,
        result?: string,
        isError?: boolean,
        presentation?: HistoryToolPresentation,
    ): Extract<KissopenSessionEvent, { t: "tool-call-end" }> {
        return {
            call: callId,
            ...(result === undefined ? {} : { result }),
            ...(isError === true ? { isError: true } : {}),
            // A file diff is drawn from the phone's own diff reader; a picture has nothing
            // else to be drawn from, so it is the one presentation that travels.
            ...(presentation?.type === "image_generation" ? { presentation } : {}),
            t: "tool-call-end",
        };
    }

    #mapInference(event: AgentEvent): readonly KissopenSessionProtocolMessage[] {
        if (!Value.Check(inferenceSchema, event.payload)) return [];
        const inference = event.payload;
        if (inference.tokens !== undefined) {
            // One Kissopen turn covers a whole run, so its cost is every response in it.
            this.#usage = {
                input_tokens: (this.#usage?.input_tokens ?? 0) + inference.tokens.input,
                output_tokens: (this.#usage?.output_tokens ?? 0) + inference.tokens.output,
            };
        }
        return [];
    }

    #mapSettled(event: AgentEvent): readonly KissopenSessionProtocolMessage[] {
        if (!Value.Check(settlementSchema, event.payload)) return [];
        const settlement = event.payload;
        const failed = settlement.stopReason === "error";
        const failureText = settlement.error ?? settlement.errorMessage;
        const usageLimit = this.#usageLimits.get(settlement.runId);
        this.#usageLimits.delete(settlement.runId);
        const output: KissopenSessionProtocolMessage[] = [];
        if (failed) {
            if (usageLimit !== undefined) output.push(...this.#openTurn(event, settlement.runId));
            output.push(
                this.#agentMessage(event, `${event.id}:failure`, {
                    t: "service",
                    text:
                        usageLimit === undefined
                            ? `The run failed: ${failureText ?? "The model response failed."}`
                            : "Your usage allowance cannot cover this request. Open Usage to see your limits and options.",
                    ...(usageLimit === undefined ? {} : { usageLimit }),
                }),
            );
        }
        const status =
            settlement.stopReason === "aborted" ? "cancelled" : failed ? "failed" : "completed";
        output.push(
            ...this.#closeTurn(
                event,
                settlement.runId,
                status,
                status === "cancelled" ? "abort" : status === "failed" ? "error" : "completed",
            ),
        );
        this.#runStartedAt.delete(settlement.runId);
        return output;
    }

    #openTurn(event: AgentEvent, runId: string): readonly KissopenSessionProtocolMessage[] {
        if (this.#activeTurn !== undefined) return [];
        this.#rememberRunStart(runId, event.occurredAt);
        this.#activeTurn = { id: event.id, startedAt: event.occurredAt };
        return [this.#agentMessage(event, `turn:${event.id}:start`, { t: "turn-start" })];
    }

    #closeTurn(
        event: AgentEvent,
        runId: string,
        status: "cancelled" | "completed" | "failed",
        reason: "abort" | "completed" | "error" | "steering",
    ): KissopenSessionProtocolMessage[] {
        const turn = this.#activeTurn;
        if (turn === undefined) return [];
        this.#activeTurn = undefined;
        const usage = this.#usage;
        this.#usage = undefined;
        const runStartedAt = this.#runStartedAt.get(runId) ?? turn.startedAt;
        return [
            this.#createMessage({
                ev: {
                    elapsedMs: Math.max(0, event.occurredAt - turn.startedAt),
                    reason,
                    status,
                    t: "turn-end",
                    turnElapsedMs: Math.max(
                        0,
                        event.occurredAt - Math.min(runStartedAt, turn.startedAt),
                    ),
                },
                id: `turn:${turn.id}:end`,
                role: "agent",
                time: event.occurredAt,
                turn: turn.id,
                ...(usage === undefined ? {} : { usage }),
            }),
        ];
    }

    #agentMessage(
        event: AgentEvent,
        id: string,
        ev: KissopenSessionEvent,
    ): KissopenSessionProtocolMessage {
        return this.#createMessage({
            ev,
            id,
            role: "agent",
            time: event.occurredAt,
            ...(this.#activeTurn === undefined ? {} : { turn: this.#activeTurn.id }),
        });
    }

    #createMessage(
        content: KissopenSessionEnvelope,
        displayText?: string,
    ): KissopenSessionProtocolMessage {
        const message: KissopenSessionProtocolMessage = {
            content,
            localId: `rig:${content.id}`,
            // A message the product composed shows its short label, never its text.
            meta:
                displayText === undefined ? { sentFrom: "rig" } : { sentFrom: "rig", displayText },
            role: "session",
        };
        if (JSON.stringify(message).length <= MAX_KISSOPEN_OUTBOX_MESSAGE_CHARACTERS)
            return message;
        // This optional projection cannot strand every later event behind one large payload.
        // Preserve the complete message in local history and report this sync failure explicitly.
        return {
            ...message,
            content: {
                ...content,
                role: "agent",
                ev: {
                    t: "service",
                    text: "This message is too large to sync to KissOpen. Its complete content remains available in KissOpen Agent history.",
                },
            },
        };
    }

    #rememberRunStart(runId: string, startedAt: number): void {
        if (!this.#runStartedAt.has(runId)) this.#runStartedAt.set(runId, startedAt);
        while (this.#runStartedAt.size > 64) {
            const oldest = this.#runStartedAt.keys().next().value;
            if (oldest === undefined) break;
            this.#runStartedAt.delete(oldest);
        }
    }

    #remember(eventId: string): void {
        this.#appliedEventIds.add(eventId);
        while (this.#appliedEventIds.size > MAX_REMEMBERED_EVENTS) {
            const oldest = this.#appliedEventIds.values().next().value;
            if (oldest === undefined) break;
            this.#appliedEventIds.delete(oldest);
        }
    }
}

function toRecord(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };
}

function richUserInput(message: HistoryMessage): KissopenInputContent | undefined {
    if (
        message.role !== "user" ||
        !message.blocks.some((block) => block.type === "tool_call_request")
    )
        return undefined;
    return message.blocks.flatMap((block): KissopenInputContent => {
        if (block.type === "text" || block.type === "tool_call_request")
            return [structuredClone(block)];
        if (block.type === "image")
            return [{ type: "image", mimeType: block.mediaType, data: block.data ?? "" }];
        return [];
    });
}

function requestedToolText(content: KissopenInputContent | undefined): string {
    const request = content?.find((block) => block.type === "tool_call_request");
    return request === undefined ? "" : `Requested tool: ${request.name}`;
}

/**
 * The run a live tool-end event belongs to, when it is one.
 *
 * The connection reads that run's assistant message from History before mapping the event, so
 * the tool-call-end the phone receives can carry what the tool produced — a picture, say —
 * rather than only the one line its result displays as.
 */
export function kissopenToolEndRun(event: AgentEvent): { readonly runId: string } | undefined {
    if (!Value.Check(toolEndSchema, event.payload)) return undefined;
    return event.payload.runId === undefined ? undefined : { runId: event.payload.runId };
}
