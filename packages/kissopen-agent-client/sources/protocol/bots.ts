/** Bots: persistent single-conversation assistants with a dedicated workspace. */

import { type Static, Type } from "@sinclair/typebox";

import { agentSchema } from "./agents.js";
import {
    computeSchema,
    cuid2Schema,
    mutationIdSchema,
    Nullable,
    resourceVersionSchema,
    timestampSchema,
} from "./common.js";

/** A bot picture. Its bytes are served separately from the bot resource. */
export const botAvatarSchema = Type.Object({
    kind: Type.Literal("image"),
    source: Type.Union([Type.Literal("user"), Type.Literal("generated")]),
    thumbhash: Type.String(),
});
export type BotAvatar = Static<typeof botAvatarSchema>;

/** A human display name: nonblank, bounded, and free of ASCII control characters. */
export const botNameSchema = Type.String({
    maxLength: 256,
    minLength: 1,
    pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$",
});
export type BotName = Static<typeof botNameSchema>;

/** The immutable local folder name chosen when a bot is created. */
export const botUsernameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
});
export type BotUsername = Static<typeof botUsernameSchema>;

export const CHIEF_OF_STAFF_SYSTEM_KEY = "chief_of_staff";

/** A stable daemon-provided bot kind. Clients must tolerate keys added by newer daemons. */
export const botSystemKeySchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
});
export type BotSystemKey = Static<typeof botSystemKeySchema>;

/** Protocol 27: what the bot is for. Line breaks and tabs are allowed; other control characters are not. */
export const botDescriptionSchema = Type.String({
    maxLength: 2_000,
    pattern: "^[^\\x00-\\x08\\x0b-\\x1f\\x7f]*$",
});
export type BotDescription = Static<typeof botDescriptionSchema>;

/** Protocol 27: the styles a daemon offers. Clients must tolerate styles added later. */
export const BOT_STYLES = [
    "professional",
    "friendly",
    "creative",
    "concise",
    "casual",
    "expert",
] as const;

/** Protocol 27: the tone a bot answers in. A string so newer styles still parse. */
export const botStyleSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z][a-z0-9_]{0,63}$",
});
export type BotStyle = Static<typeof botStyleSchema>;

/** Protocol 27: the model a bot runs on when a message from another agent chooses none. */
export const botModelSchema = Type.Object({
    effort: Nullable(Type.String({ maxLength: 64, minLength: 1 })),
    modelId: Type.String({ maxLength: 256, minLength: 1 }),
    providerId: Type.String({ maxLength: 256, minLength: 1 }),
});
export type BotModel = Static<typeof botModelSchema>;

/** Protocol 27: what the bot knows about the person it serves; `""` when unknown. */
export const botUserSchema = Type.Object({
    background: Type.String({ maxLength: 2_000, pattern: "^[^\\x00-\\x08\\x0b-\\x1f\\x7f]*$" }),
    language: Type.String({ maxLength: 64, pattern: "^[^\\x00-\\x1f\\x7f]*$" }),
    name: Type.String({ maxLength: 64, pattern: "^[^\\x00-\\x1f\\x7f]*$" }),
    note: Type.String({ maxLength: 256, pattern: "^[^\\x00-\\x1f\\x7f]*$" }),
});
export type BotUser = Static<typeof botUserSchema>;

/** A bot and its one independently versioned agent. */
export const botSchema = Type.Object({
    /** The bot's one agent, embedded in full for list rendering. */
    agent: agentSchema,
    archivedAt: Nullable(timestampSchema),
    avatar: Nullable(botAvatarSchema),
    /** Mirrors the dedicated workspace's compute. */
    compute: computeSchema,
    createdAt: timestampSchema,
    /** Protocol 27: what the bot is for. Older compatible daemons omit it. */
    description: Type.Optional(botDescriptionSchema),
    id: cuid2Schema,
    /** Whether this bot has the `admin_bot` tool role. Older compatible daemons omit it. */
    isAdmin: Type.Optional(Type.Boolean()),
    /** Protocol 27: the bot's own model, or null for Auto. Older compatible daemons omit it. */
    model: Type.Optional(Nullable(botModelSchema)),
    name: botNameSchema,
    /** An opaque catalog sort key. */
    orderKey: Type.String(),
    status: Type.Union([Type.Literal("active"), Type.Literal("archived")]),
    /** Protocol 27: the tone it answers in, or null. Older compatible daemons omit it. */
    style: Type.Optional(Nullable(botStyleSchema)),
    /** Built-in bot kind, or null for an ordinary bot. Older compatible daemons omit it. */
    systemKey: Type.Optional(Nullable(botSystemKeySchema)),
    updatedAt: timestampSchema,
    /** Protocol 27: what the bot knows about its person. Older compatible daemons omit it. */
    user: Type.Optional(botUserSchema),
    /** Immutable local snake_case name and folder name. */
    username: botUsernameSchema,
    version: resourceVersionSchema,
    /** The bot's dedicated workspace, distinct from the bot and agent IDs. */
    workspaceId: cuid2Schema,
});
export type Bot = Static<typeof botSchema>;

/** `GET /v0/bots` */
export const botListResponseSchema = Type.Object({ bots: Type.Array(botSchema) });
export type BotListResponse = Static<typeof botListResponseSchema>;

/** Every single-bot JSON route answers with this. */
export const botResponseSchema = Type.Object({ bot: botSchema });
export type BotResponse = Static<typeof botResponseSchema>;

/** `POST /v0/bots` — client-chosen child IDs require protocol 25+. */
export const createBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    id: Type.Optional(cuid2Schema),
    workspaceId: Type.Optional(cuid2Schema),
    agentId: Type.Optional(cuid2Schema),
    /** Protocol 24+: omitted, the bot takes its display name from the first user message. */
    name: Type.Optional(botNameSchema),
    /** Omitted, the daemon derives a unique username from `name`, or from `bot` without a name. */
    username: Type.Optional(botUsernameSchema),
    /** Grants the new bot the `admin_bot` tool role. Omitted means non-admin. */
    isAdmin: Type.Optional(Type.Boolean()),
});
export type CreateBotRequest = Static<typeof createBotRequestSchema>;

/** `PATCH /v0/bots/:botId` — the immutable username is deliberately absent. */
export const renameBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
    name: botNameSchema,
    /** Explicitly forbidden even though request objects tolerate future additive fields. */
    username: Type.Optional(Type.Never()),
});
export type RenameBotRequest = Static<typeof renameBotRequestSchema>;

/** `PATCH /v0/bots/:botId` from protocol 27 — any of the fields, at least one of them. */
export const updateBotRequestSchema = Type.Object({
    description: Type.Optional(botDescriptionSchema),
    model: Type.Optional(Nullable(botModelSchema)),
    mutationId: Type.Optional(mutationIdSchema),
    name: Type.Optional(botNameSchema),
    style: Type.Optional(Nullable(botStyleSchema)),
    user: Type.Optional(botUserSchema),
    /** Explicitly forbidden even though request objects tolerate future additive fields. */
    username: Type.Optional(Type.Never()),
});
export type UpdateBotRequest = Static<typeof updateBotRequestSchema>;

/** `POST /v0/bots/:botId/copy` — protocol 27. */
export const copyBotRequestSchema = Type.Object({
    id: Type.Optional(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
    name: Type.Optional(botNameSchema),
});
export type CopyBotRequest = Static<typeof copyBotRequestSchema>;

/** Protocol 27: the five core files at the root of a bot's folder, in their listing order. */
export const BOT_CORE_FILE_NAMES = [
    "SOUL.md",
    "IDENTITY.md",
    "AGENTS.md",
    "MEMORY.md",
    "USER.md",
] as const;

export const botCoreFileNameSchema = Type.Union(BOT_CORE_FILE_NAMES.map((name) => Type.Literal(name)));
export type BotCoreFileName = Static<typeof botCoreFileNameSchema>;

/** The largest core file the routes write, in UTF-8 bytes. */
export const BOT_CORE_FILE_MAX_BYTES = 32 * 1024;

const sha256Schema = Type.String({ maxLength: 64, minLength: 64, pattern: "^[a-f0-9]{64}$" });

/** One core file, present or not. */
export const botCoreFileSchema = Type.Object({
    content: Type.String(),
    locked: Type.Boolean(),
    name: botCoreFileNameSchema,
    sha256: Nullable(sha256Schema),
    size: Type.Integer({ minimum: 0 }),
    updatedAt: Nullable(timestampSchema),
});
export type BotCoreFile = Static<typeof botCoreFileSchema>;

/** `GET /v0/bots/:botId/files` */
export const botCoreFilesResponseSchema = Type.Object({ files: Type.Array(botCoreFileSchema) });
export type BotCoreFilesResponse = Static<typeof botCoreFilesResponseSchema>;

/** `PUT /v0/bots/:botId/files/:name` */
export const writeBotCoreFileRequestSchema = Type.Object({
    baseSha256: Nullable(sha256Schema),
    content: Type.String(),
});
export type WriteBotCoreFileRequest = Static<typeof writeBotCoreFileRequestSchema>;

/** Every single-file route answers with this. */
export const botCoreFileResponseSchema = Type.Object({ file: botCoreFileSchema });
export type BotCoreFileResponse = Static<typeof botCoreFileResponseSchema>;

/** One recorded revision of a core file. */
export const botCoreFileRevisionSchema = Type.Object({
    createdAt: timestampSchema,
    id: cuid2Schema,
    sha256: sha256Schema,
    size: Type.Integer({ minimum: 0 }),
    source: Type.Union([Type.Literal("user"), Type.Literal("external")]),
});
export type BotCoreFileRevision = Static<typeof botCoreFileRevisionSchema>;

/** `GET /v0/bots/:botId/files/:name/revisions` */
export const botCoreFileRevisionsResponseSchema = Type.Object({
    revisions: Type.Array(botCoreFileRevisionSchema),
});
export type BotCoreFileRevisionsResponse = Static<typeof botCoreFileRevisionsResponseSchema>;

/** `GET /v0/bots/:botId/files/:name/revisions/:revisionId` */
export const botCoreFileRevisionResponseSchema = Type.Object({
    revision: Type.Composite([botCoreFileRevisionSchema, Type.Object({ content: Type.String() })]),
});
export type BotCoreFileRevisionResponse = Static<typeof botCoreFileRevisionResponseSchema>;

/** `POST /v0/bots/:botId/archive` */
export const archiveBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type ArchiveBotRequest = Static<typeof archiveBotRequestSchema>;

/** `POST /v0/bots/:botId/unarchive` */
export const unarchiveBotRequestSchema = Type.Object({
    mutationId: Type.Optional(mutationIdSchema),
});
export type UnarchiveBotRequest = Static<typeof unarchiveBotRequestSchema>;

/** `POST /v0/bots/:botId/reorder` */
export const reorderBotRequestSchema = Type.Object({
    /** The bot to place this one after, or `null` to move it first. */
    afterId: Nullable(cuid2Schema),
    mutationId: Type.Optional(mutationIdSchema),
});
export type ReorderBotRequest = Static<typeof reorderBotRequestSchema>;
