import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const timestampSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const versionSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });
const mutationIdSchema = Type.String({ maxLength: 256, minLength: 1 });
export const KISSOPEN_CLOUD_CIPHERTEXT_MAX_LENGTH = 2 * 1024 * 1024;
const ciphertextSchema = Type.String({
    maxLength: KISSOPEN_CLOUD_CIPHERTEXT_MAX_LENGTH,
    minLength: 1,
    pattern: "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$",
});
export const kissopenCloudSessionIdSchema = Type.String({ maxLength: 256, minLength: 1 });

export const KISSOPEN_CLOUD_CONTRACT_VERSION = 1 as const;

export const kissopenCloudCapabilitySchema = Type.Union([
    Type.Literal("group_chats"),
    Type.Literal("remote_control"),
    Type.Literal("session_blob_persistence"),
    Type.Literal("kissopen_profile"),
]);
export type KissopenCloudCapability = Static<typeof kissopenCloudCapabilitySchema>;

export const kissopenCloudConsentSchema = Type.Union([
    Type.Literal("denied"),
    Type.Literal("granted"),
]);
export type KissopenCloudConsent = Static<typeof kissopenCloudConsentSchema>;

export const kissopenCloudCapabilityStatusSchema = Type.Object(
    {
        changedAt: timestampSchema,
        consent: kissopenCloudConsentSchema,
    },
    exact,
);
export type KissopenCloudCapabilityStatus = Static<typeof kissopenCloudCapabilityStatusSchema>;

export const kissopenCloudStatusSchema = Type.Object(
    {
        authority: Type.Literal("local_record_only"),
        capabilities: Type.Object(
            {
                group_chats: kissopenCloudCapabilityStatusSchema,
                kissopen_profile: kissopenCloudCapabilityStatusSchema,
                remote_control: kissopenCloudCapabilityStatusSchema,
                session_blob_persistence: kissopenCloudCapabilityStatusSchema,
            },
            exact,
        ),
        contractVersion: Type.Literal(KISSOPEN_CLOUD_CONTRACT_VERSION),
        enrollment: Type.Object(
            {
                changedAt: timestampSchema,
                state: Type.Union([Type.Literal("not_enrolled"), Type.Literal("enrolled")]),
            },
            exact,
        ),
        profile: Type.Object(
            {
                changedAt: timestampSchema,
                state: Type.Union([Type.Literal("not_created"), Type.Literal("created")]),
            },
            exact,
        ),
        updatedAt: timestampSchema,
        version: versionSchema,
    },
    exact,
);
export type KissopenCloudStatus = Static<typeof kissopenCloudStatusSchema>;

export const kissopenCloudChangedEventSchema = Type.Object(
    {
        createdAt: timestampSchema,
        data: Type.Object(
            {
                mutationId: mutationIdSchema,
                version: versionSchema,
            },
            exact,
        ),
        id: Type.String({ maxLength: 256, minLength: 1 }),
        type: Type.Literal("kissopen_cloud_changed"),
    },
    exact,
);
export type KissopenCloudChangedEvent = Static<typeof kissopenCloudChangedEventSchema>;

const commandBase = {
    contractVersion: Type.Literal(KISSOPEN_CLOUD_CONTRACT_VERSION),
    expectedVersion: versionSchema,
    mutationId: mutationIdSchema,
};

export const kissopenCloudCommandSchema = Type.Union([
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("set_enrollment"),
            state: Type.Union([Type.Literal("not_enrolled"), Type.Literal("enrolled")]),
        },
        exact,
    ),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("set_capability"),
            capability: kissopenCloudCapabilitySchema,
            consent: kissopenCloudConsentSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("put_profile"),
            ciphertext: ciphertextSchema,
        },
        exact,
    ),
    Type.Object({ ...commandBase, action: Type.Literal("delete_profile") }, exact),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("put_session_blob"),
            ciphertext: ciphertextSchema,
            sessionId: kissopenCloudSessionIdSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...commandBase,
            action: Type.Literal("delete_session_blob"),
            sessionId: kissopenCloudSessionIdSchema,
        },
        exact,
    ),
]);
export type KissopenCloudCommand = Static<typeof kissopenCloudCommandSchema>;

export const kissopenCloudCommandResponseSchema = Type.Object(
    { status: kissopenCloudStatusSchema },
    exact,
);
export type KissopenCloudCommandResponse = Static<typeof kissopenCloudCommandResponseSchema>;

export const kissopenCloudCommandErrorResponseSchema = Type.Object(
    {
        code: Type.Union([
            Type.Literal("capability_not_granted"),
            Type.Literal("mutation_reused"),
            Type.Literal("not_enrolled"),
            Type.Literal("version_conflict"),
        ]),
        error: Type.String({ minLength: 1 }),
        status: kissopenCloudStatusSchema,
    },
    exact,
);
export type KissopenCloudCommandErrorResponse = Static<typeof kissopenCloudCommandErrorResponseSchema>;

export const kissopenCloudProfileCiphertextResponseSchema = Type.Object(
    {
        ciphertext: ciphertextSchema,
        version: versionSchema,
    },
    exact,
);
export type KissopenCloudProfileCiphertextResponse = Static<
    typeof kissopenCloudProfileCiphertextResponseSchema
>;

export const kissopenCloudSessionBlobResponseSchema = Type.Object(
    {
        ciphertext: ciphertextSchema,
        sessionId: kissopenCloudSessionIdSchema,
        version: versionSchema,
    },
    exact,
);
export type KissopenCloudSessionBlobResponse = Static<typeof kissopenCloudSessionBlobResponseSchema>;
