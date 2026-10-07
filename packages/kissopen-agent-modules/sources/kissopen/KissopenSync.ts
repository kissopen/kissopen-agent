import { Type, type Static } from "@sinclair/typebox";

import { kissopenEncryptionVariantSchema } from "./KissopenCredentials.js";

const exact = { additionalProperties: false } as const;

/** How many messages may wait for delivery for one session before projection defers. */
export const MAX_KISSOPEN_OUTBOX_MESSAGES = 10_000;

/** How large one encoded message may be. A larger one can never be delivered, so it is refused. */
export const MAX_KISSOPEN_OUTBOX_MESSAGE_CHARACTERS = 4_000_000;

/** How many messages one event may produce. */
export const MAX_KISSOPEN_MESSAGES_PER_EVENT = 512;

export const kissopenProjectionStatusSchema = Type.Union([
    Type.Literal("active"),
    Type.Literal("stalled"),
]);
export type KissopenProjectionStatus = Static<typeof kissopenProjectionStatusSchema>;

/**
 * Why projection stopped advancing.
 *
 * `capacity` clears itself once the phone catches up. `event_too_large` does
 * not: that message can never be delivered as it stands.
 */
export const kissopenProjectionStallCauseSchema = Type.Union([
    Type.Literal("capacity"),
    Type.Literal("event_too_large"),
]);
export type KissopenProjectionStallCause = Static<typeof kissopenProjectionStallCauseSchema>;

const kissopenAgentIdSchema = Type.String({ maxLength: 128, minLength: 1 });
const kissopenSessionIdSchema = Type.String({ maxLength: 128, minLength: 1 });
const kissopenLocalIdSchema = Type.String({ maxLength: 256, minLength: 1 });
const kissopenTimestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

/** One message waiting to be delivered to Kissopen, before encryption. */
export const kissopenOutboxMessageSchema = Type.Object(
    {
        localId: kissopenLocalIdSchema,
        payload: Type.Unknown(),
    },
    exact,
);
export type KissopenOutboxMessage = Static<typeof kissopenOutboxMessageSchema>;

/** A queued message read back for delivery, in the order it was enqueued. */
export const kissopenOutboxEntrySchema = Type.Object(
    {
        localId: kissopenLocalIdSchema,
        payload: Type.Unknown(),
        position: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type KissopenOutboxEntry = Static<typeof kissopenOutboxEntrySchema>;

/** What this agent's Kissopen synchronization knows about itself. */
export const kissopenSyncSessionSchema = Type.Object(
    {
        agentId: kissopenAgentIdSchema,
        createdAt: kissopenTimestampSchema,
        /** Identifies the account and server these rows belong to; a change resets them. */
        credentialFingerprint: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionKeyBase64: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionVariant: kissopenEncryptionVariantSchema,
        /** Whether the history that existed before Kissopen connected has been queued. */
        historyBackfilled: Type.Boolean(),
        /** The newest message sequence received from Kissopen. */
        lastRemoteSeq: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        /** The newest event projected into the outbox, if any. */
        projectedEventId: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
        projectionError: Type.Optional(Type.String({ maxLength: 1_024, minLength: 1 })),
        projectionStallCause: Type.Optional(kissopenProjectionStallCauseSchema),
        projectionStatus: kissopenProjectionStatusSchema,
        remoteSessionId: Type.Optional(Type.String({ maxLength: 256, minLength: 1 })),
        sessionId: kissopenSessionIdSchema,
        /** Makes remote session creation idempotent across restarts. */
        tag: Type.String({ maxLength: 256, minLength: 1 }),
        updatedAt: kissopenTimestampSchema,
    },
    exact,
);
export type KissopenSyncSession = Static<typeof kissopenSyncSessionSchema>;

/** What the sync service supplies when it attaches an agent to Kissopen. */
export const kissopenSyncSessionInputSchema = Type.Object(
    {
        agentId: kissopenAgentIdSchema,
        credentialFingerprint: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionKeyBase64: Type.String({ maxLength: 128, minLength: 1 }),
        encryptionVariant: kissopenEncryptionVariantSchema,
        sessionId: kissopenSessionIdSchema,
    },
    exact,
);
export type KissopenSyncSessionInput = Static<typeof kissopenSyncSessionInputSchema>;

/** What projecting one event did. */
export const kissopenProjectionOutcomeSchema = Type.Union([
    Type.Object({ kind: Type.Literal("projected"), deferred: Type.Boolean() }, exact),
    Type.Object({ kind: Type.Literal("already_projected") }, exact),
    Type.Object({ kind: Type.Literal("not_attached") }, exact),
    Type.Object(
        { kind: Type.Literal("stalled"), cause: kissopenProjectionStallCauseSchema },
        exact,
    ),
]);
export type KissopenProjectionOutcome = Static<typeof kissopenProjectionOutcomeSchema>;

/** Builds the tag that makes remote session creation idempotent. */
export function kissopenSessionTag(sessionId: string): string {
    return `rig:${sessionId}`;
}
