import { Type, type Static } from "@sinclair/typebox";
import { p2pInstanceIdSchema } from "./P2pIdentityProtocol.js";

const exact = { additionalProperties: false } as const;

export const kissopenAgentProfileIdSchema = Type.String({
    maxLength: 32,
    minLength: 2,
    pattern: "^[a-z][a-z0-9]+$",
});
export type KissopenAgentProfileId = Static<typeof kissopenAgentProfileIdSchema>;
export const kissopenAgentProfileIdentitySchema = Type.Union([kissopenAgentProfileIdSchema, Type.Null()]);
export type KissopenAgentProfileIdentity = Static<typeof kissopenAgentProfileIdentitySchema>;

export const kissopenAgentProfileNameSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern:
        "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200b\\u200e\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f]+$",
});
export const kissopenAgentProfileEmailSchema = Type.String({
    maxLength: 254,
    minLength: 3,
    pattern: "^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$",
});

export const kissopenAgentProfilePhotoInputSchema = Type.Object(
    {
        data: Type.String({
            maxLength: 32 * 1024 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9+/]*={0,2}$",
        }),
        mediaType: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type KissopenAgentProfilePhotoInput = Static<typeof kissopenAgentProfilePhotoInputSchema>;

export const kissopenAgentProfilePhotoSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: 96 * 1024, minimum: 1 }),
        data: Type.String({
            maxLength: 128 * 1024,
            minLength: 1,
            pattern: "^[A-Za-z0-9+/]*={0,2}$",
        }),
        height: Type.Integer({ maximum: 16_384, minimum: 1 }),
        mediaType: Type.Literal("image/webp"),
        thumbhash: Type.String({ maxLength: 1_024, minLength: 1 }),
        width: Type.Integer({ maximum: 16_384, minimum: 1 }),
    },
    exact,
);
export type KissopenAgentProfilePhoto = Static<typeof kissopenAgentProfilePhotoSchema>;

export const kissopenAgentProfileSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        email: kissopenAgentProfileEmailSchema,
        id: kissopenAgentProfileIdSchema,
        name: kissopenAgentProfileNameSchema,
        parentInstanceId: p2pInstanceIdSchema,
        photo: Type.Optional(kissopenAgentProfilePhotoSchema),
        updatedAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
    },
    exact,
);
export type KissopenAgentProfile = Static<typeof kissopenAgentProfileSchema>;

export const createKissopenAgentProfileRequestSchema = Type.Object(
    {
        email: kissopenAgentProfileEmailSchema,
        name: kissopenAgentProfileNameSchema,
        photo: Type.Optional(kissopenAgentProfilePhotoInputSchema),
    },
    exact,
);
export type CreateKissopenAgentProfileRequest = Static<typeof createKissopenAgentProfileRequestSchema>;

export const updateKissopenAgentProfileRequestSchema = Type.Object(
    {
        email: Type.Optional(kissopenAgentProfileEmailSchema),
        name: Type.Optional(kissopenAgentProfileNameSchema),
        photo: Type.Optional(Type.Union([kissopenAgentProfilePhotoInputSchema, Type.Null()])),
    },
    { ...exact, minProperties: 1 },
);
export type UpdateKissopenAgentProfileRequest = Static<typeof updateKissopenAgentProfileRequestSchema>;

export const replicateKissopenAgentProfileRequestSchema = Type.Object(
    { profile: kissopenAgentProfileSchema },
    exact,
);
export type ReplicateKissopenAgentProfileRequest = Static<
    typeof replicateKissopenAgentProfileRequestSchema
>;

export const listKissopenAgentProfilesResponseSchema = Type.Object(
    { profiles: Type.Array(kissopenAgentProfileSchema, { maxItems: 128 }) },
    exact,
);
export type ListKissopenAgentProfilesResponse = Static<typeof listKissopenAgentProfilesResponseSchema>;

export const kissopenAgentProfileResponseSchema = Type.Object(
    { profile: kissopenAgentProfileSchema },
    exact,
);
export type KissopenAgentProfileResponse = Static<typeof kissopenAgentProfileResponseSchema>;

export const kissopenAgentProfileChangedEventSchema = Type.Object(
    {
        createdAt: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 }),
        data: Type.Object(
            {
                profileId: kissopenAgentProfileIdSchema,
                version: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
            },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("profile_changed"),
    },
    exact,
);
export type KissopenAgentProfileChangedEvent = Static<typeof kissopenAgentProfileChangedEventSchema>;
