import { cuid2Schema } from "@kissopen/kissopen-agent-base";
import {
    type BotCoreFile,
    botAvatarSchema,
    botDescriptionSchema,
    botModelSchema,
    botNameSchema,
    botStyleSchema,
    botUserSchema,
    botUsernameSchema,
} from "@kissopen/kissopen-agent-client";
import { Type, type Static } from "@sinclair/typebox";

import { botSystemKeySchema } from "./BotSystemKey.js";

export const botStatusSchema = Type.Union([Type.Literal("active"), Type.Literal("archived")]);
export const botOrderKeySchema = Type.String({
    minLength: 1,
    maxLength: 64,
    pattern: "^[0-9]+$",
});
export const botVersionSchema = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const botTimestampSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const botPathSchema = Type.String({ minLength: 1, maxLength: 4_096 });

/** Durable state owned by the bot catalog. The agent remains independently owned by Agent Base. */
export const botRecordSchema = Type.Object(
    {
        id: cuid2Schema,
        isAdmin: Type.Boolean(),
        systemKey: Type.Optional(botSystemKeySchema),
        name: botNameSchema,
        nameConfigured: Type.Boolean(),
        username: botUsernameSchema,
        workspaceId: cuid2Schema,
        workspaceVersion: botVersionSchema,
        workspaceUpdatedAt: botTimestampSchema,
        agentId: cuid2Schema,
        path: botPathSchema,
        status: botStatusSchema,
        avatar: Type.Optional(botAvatarSchema),
        description: botDescriptionSchema,
        style: Type.Optional(botStyleSchema),
        model: Type.Optional(botModelSchema),
        user: botUserSchema,
        orderKey: botOrderKeySchema,
        version: botVersionSchema,
        createdAt: botTimestampSchema,
        updatedAt: botTimestampSchema,
        archivedAt: Type.Optional(botTimestampSchema),
    },
    { additionalProperties: false },
);

export const createBotInputSchema = Type.Object(
    {
        id: Type.Optional(cuid2Schema),
        workspaceId: Type.Optional(cuid2Schema),
        agentId: Type.Optional(cuid2Schema),
        isAdmin: Type.Optional(Type.Boolean()),
        name: Type.Optional(botNameSchema),
        username: Type.Optional(botUsernameSchema),
    },
    { additionalProperties: false },
);

/** The validated image asset this module persists beside public avatar metadata. Always WebP. */
export const botAvatarAssetSchema = Type.Object(
    {
        bytes: Type.Uint8Array({ minByteLength: 1, maxByteLength: 8 * 1024 * 1024 }),
        contentHash: Type.String({
            minLength: 64,
            maxLength: 64,
            pattern: "^[a-f0-9]{64}$",
        }),
        etag: Type.String({ minLength: 66, maxLength: 66, pattern: '^"[a-f0-9]{64}"$' }),
        height: Type.Integer({ minimum: 1, maximum: 16_384 }),
        thumbhash: Type.String({ minLength: 4, maxLength: 128 }),
        width: Type.Integer({ minimum: 1, maximum: 16_384 }),
    },
    { additionalProperties: false },
);

export type BotRecord = Static<typeof botRecordSchema>;

/** The assistant settings a person changes together; each one absent is left as it is. */
export const botSettingsChangeSchema = Type.Object(
    {
        name: Type.Optional(botNameSchema),
        description: Type.Optional(botDescriptionSchema),
        style: Type.Optional(Type.Union([botStyleSchema, Type.Null()])),
        model: Type.Optional(Type.Union([botModelSchema, Type.Null()])),
        user: Type.Optional(botUserSchema),
    },
    { additionalProperties: false },
);
export type BotSettingsChange = Static<typeof botSettingsChangeSchema>;

/** No settings at all: what a new bot, and every bot from before settings existed, starts with. */
export const EMPTY_BOT_USER = { name: "", language: "", note: "", background: "" } as const;
export type BotStatus = Static<typeof botStatusSchema>;
export type CreateBotInput = Static<typeof createBotInputSchema>;
export const botCreationSchema = Type.Object({ bot: botRecordSchema, created: Type.Boolean() });
export type BotCreation = Static<typeof botCreationSchema>;
export type BotAvatarAsset = Static<typeof botAvatarAssetSchema>;

export class BotInputError extends Error {
    constructor() {
        super("The bot creation request is invalid.");
        this.name = "BotInputError";
    }
}

export class BotConflictError extends Error {
    readonly bot: BotRecord | undefined;

    constructor(message: string, bot?: BotRecord) {
        super(message);
        this.name = "BotConflictError";
        this.bot = bot === undefined ? undefined : structuredClone(bot);
    }
}

/** A core file write that cannot go ahead; `file` is the file as it is now, when there is one. */
export class BotFileConflictError extends Error {
    readonly file: BotCoreFile | undefined;

    constructor(message: string, file?: BotCoreFile) {
        super(message);
        this.name = "BotFileConflictError";
        this.file = file === undefined ? undefined : structuredClone(file);
    }
}

export class BotFileTooLargeError extends Error {
    constructor() {
        super("A core file can hold at most 32 KB of text.");
        this.name = "BotFileTooLargeError";
    }
}

export class BotNotFoundError extends Error {
    constructor(message = "The bot was not found.") {
        super(message);
        this.name = "BotNotFoundError";
    }
}
