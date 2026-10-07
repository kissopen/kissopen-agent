import { Type, type Static } from "@sinclair/typebox";
import {
    toolCallRequestBlockSchema,
    type MessageUsageLimit,
} from "@kissopen/kissopen-agent-client";
import type { TeamUser } from "../team/index.js";

/** Rich user input travels atomically with the text fallback older phones understand. */
export const kissopenInputContentSchema = Type.Array(
    Type.Union([
        Type.Object(
            { type: Type.Literal("text"), text: Type.String() },
            { additionalProperties: false },
        ),
        Type.Object(
            { type: Type.Literal("image"), mimeType: Type.String(), data: Type.String() },
            { additionalProperties: false },
        ),
        toolCallRequestBlockSchema,
    ]),
    // Send allows 64 rich blocks plus its required leading text block.
    { maxItems: 65, contains: toolCallRequestBlockSchema, minContains: 0, maxContains: 1 },
);
export type KissopenInputContent = Static<typeof kissopenInputContentSchema>;

/**
 * The shapes Kissopen speaks on the wire.
 *
 * Outbound envelopes are plain interfaces: Kissopen Agent builds them, so there is nothing
 * to validate. Anything arriving from the server or the phone carries a schema,
 * because it arrives as JSON that Kissopen Agent did not write.
 */

/** Token counts as Kissopen names them. */
export interface KissopenUsage {
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    context_window?: number;
    input_tokens: number;
    output_tokens: number;
    service_tier?: string;
}

/** One thing that happened, as the phone renders it. */
export type KissopenSessionEvent =
    | { t: "file"; ref: string; name: string; size: number; mimeType?: string }
    // A failure travels as a `service` line. The phone's vocabulary has no failure of its own and
    // silently drops any event it cannot name, so plain words about what went wrong reach a person
    // and a truer-looking event does not.
    | { t: "service"; text: string; usageLimit?: MessageUsageLimit }
    | {
          t: "text";
          text: string;
          thinking?: boolean;
          content?: KissopenInputContent;
          streamId?: string;
      }
    /** UTF-16 offset into one inference block; the final text snapshot is authoritative. */
    | { t: "text-delta"; streamId: string; offset: number; text: string; thinking?: boolean }
    | {
          t: "tool-call-end";
          call: string;
          result?: string;
          isError?: boolean;
          /** What the tool produced, typed, when it produced something a person looks at. */
          presentation?: KissopenToolPresentation;
      }
    | {
          t: "tool-call-start";
          args: Record<string, unknown>;
          call: string;
          description: string;
          name: string;
          title: string;
      }
    | {
          t: "turn-end";
          status: "cancelled" | "completed" | "failed";
          elapsedMs: number;
          reason?: "abort" | "completed" | "error" | "steering";
          turnElapsedMs: number;
      }
    | { t: "turn-start" }
    // A content-free receipt for a message the phone itself sent: `ref` is the server message ID
    // the phone already holds, and the receipt's own position in the stream is where acceptance
    // landed, so a client can align its copy with the run order instead of arrival order.
    | { t: "user-message-accepted"; id: string; ref: string; runId: string }
    | { t: "user-message-rejected"; ref: string; reason: string };

/**
 * Who wrote a user-role envelope. Travels inside the encrypted session payload like everything
 * else here, so the relay never learns who is in the room. `owner` says whether the author is the
 * team user whose Kissopen account this session is published through — the person reading it on the
 * phone — which lets a client tell its own messages from a teammate's without reconciling user-id
 * spaces. Absent when the daemon does not know the author, which a client renders as its own.
 */
export interface KissopenAuthor {
    id: string;
    name: string;
    owner: boolean;
}

/** The author a team user appears as, seen from the connection `owner` publishes through. */
export function kissopenAuthorOf(user: TeamUser, owner: TeamUser | undefined): KissopenAuthor {
    return {
        id: user.id,
        name: user.lastName === null ? user.firstName : `${user.firstName} ${user.lastName}`,
        owner: owner !== undefined && owner.id === user.id,
    };
}

/** One rendered moment, with the identity and the turn it belongs to. */
export interface KissopenSessionEnvelope {
    author?: KissopenAuthor;
    ev: KissopenSessionEvent;
    id: string;
    role: "agent" | "user";
    time: number;
    turn?: string;
    usage?: KissopenUsage;
}

/** An envelope wrapped for delivery, before encryption. */
export interface KissopenSessionProtocolMessage {
    content: KissopenSessionEnvelope;
    localId: string;
    /** `displayText` is the short label a person sees for a message the product composed. */
    meta: { sentFrom: "rig"; displayText?: string };
    role: "session";
}

/** A message read back from KISSOPEN's own stream. */
export const kissopenRemoteMessageSchema = Type.Object(
    {
        content: Type.Object(
            { c: Type.String(), t: Type.Literal("encrypted") },
            { additionalProperties: true },
        ),
        createdAt: Type.Number(),
        id: Type.String({ minLength: 1 }),
        localId: Type.Union([Type.String(), Type.Null()]),
        seq: Type.Integer({ minimum: 0 }),
        updatedAt: Type.Number(),
    },
    { additionalProperties: true },
);
export type KissopenRemoteMessage = Static<typeof kissopenRemoteMessageSchema>;

/** What the phone chose alongside the text it sent. */
export const kissopenRemoteSelectionSchema = Type.Object(
    {
        effort: Type.Optional(Type.String({ maxLength: 64 })),
        modelId: Type.Optional(Type.String({ maxLength: 256 })),
        permissionMode: Type.Optional(Type.String({ maxLength: 64 })),
        providerId: Type.Optional(Type.String({ maxLength: 128 })),
    },
    { additionalProperties: false },
);
export type KissopenRemoteSelection = Static<typeof kissopenRemoteSelectionSchema>;

/**
 * What one decrypted remote message turned out to be.
 *
 * `echo` is Kissopen Agent's own message coming back; it carries nothing new and must not
 * be replayed into the conversation.
 */
export type KissopenRemoteInput =
    | { kind: "echo" }
    | { kind: "attachment"; mimeType?: string; name: string; ref: string; size: number }
    | {
          kind: "text";
          selection: KissopenRemoteSelection;
          text: string;
          content?: KissopenInputContent;
          /** The short label a person sees for a message the product composed. */
          displayText?: string;
      };

/** Marks a message KISSOPEN Agent itself produced, so its echo can be recognized. */
export const KISSOPEN_SENT_FROM_RIG = "rig";

/** Namespaces the identity of a message that came from KISSOPEN. */
export function kissopenRemoteMessageId(remoteId: string): string {
    return `kissopen:${remoteId}`;
}

/** Recovers the KISSOPEN server's own message ID from a namespaced remote identity. */
export function kissopenServerMessageId(namespacedId: string): string {
    return namespacedId.startsWith("kissopen:")
        ? namespacedId.slice("kissopen:".length)
        : namespacedId;
}

/**
 * A typed rendering of what a tool produced, for the phone to draw without reading raw output.
 * Only the presentations a phone can draw travel; the rest of the history presentations stay
 * on this side.
 */
export type KissopenToolPresentation = {
    type: "image_generation";
    path: string;
    mediaType: string;
    bytes: number;
    width: number;
    height: number;
    /** Base64 WebP, at most 512 px on its longest side. */
    preview: string;
};
