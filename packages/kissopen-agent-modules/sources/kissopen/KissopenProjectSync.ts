import { Type, type Static } from "@sinclair/typebox";
import type { KissopenEncryptionVariant } from "./KissopenCredentials.js";

const fingerprintSchema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });

/**
 * What a project record says about its project, encrypted so the server never reads it. Besides
 * the name it says where the project is — the computer that published it and the folder on that
 * computer — so the account's other devices can list a project nobody has talked in yet, and read
 * its board, without waiting for a conversation to reveal where it lives.
 */
export const kissopenProjectMetadataSchema = Type.Object(
    {
        kind: Type.Optional(Type.Union([Type.Literal("home"), Type.Literal("regular")])),
        name: Type.String({ minLength: 1, maxLength: 500 }),
        machineId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
);

export type KissopenProjectMetadata = Static<typeof kissopenProjectMetadataSchema>;

export const kissopenProjectAvatarPreviewSchema = Type.Object(
    {
        mimeType: Type.Literal("image/webp"),
        thumbhash: Type.String({ minLength: 4, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type KissopenProjectAvatarPreview = Static<typeof kissopenProjectAvatarPreviewSchema>;

export const kissopenProjectSyncStateSchema = Type.Object(
    {
        avatarFingerprint: Type.Optional(fingerprintSchema),
        avatarVersion: Type.Optional(Type.Integer({ minimum: 1 })),
        credentialFingerprint: Type.String({ minLength: 1, maxLength: 128 }),
        createdAt: Type.Integer({ minimum: 0 }),
        encryptionKeyBase64: Type.String({ minLength: 1 }),
        encryptionVariant: Type.Union([Type.Literal("legacy"), Type.Literal("dataKey")]),
        localProjectId: Type.String({ minLength: 1, maxLength: 96 }),
        metadataFingerprint: Type.Optional(fingerprintSchema),
        remoteProjectId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        updatedAt: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);

export type KissopenProjectSyncState = Static<typeof kissopenProjectSyncStateSchema>;

export interface KissopenProjectSyncInput {
    readonly credentialFingerprint: string;
    readonly encryptionKeyBase64: string;
    readonly encryptionVariant: KissopenEncryptionVariant;
    readonly localProjectId: string;
}
