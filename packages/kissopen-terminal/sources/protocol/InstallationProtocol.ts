import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const schemaVersionSchema = Type.Integer({ minimum: 0 });
const messageSchema = Type.String({ minLength: 1 });

export const kissopenAgentDataEpochSchema = Type.String({ maxLength: 128, minLength: 1 });

export const kissopenAgentInitializedDataSchema = Type.Object(
    {
        epoch: kissopenAgentDataEpochSchema,
        schemaCompatibility: Type.Union([
            Type.Literal("current"),
            Type.Literal("upgrade_required"),
        ]),
        schemaVersion: schemaVersionSchema,
        status: Type.Literal("initialized"),
    },
    exact,
);
export type KissopenAgentInitializedData = Static<typeof kissopenAgentInitializedDataSchema>;

export const kissopenAgentInstallationDataSchema = Type.Union([
    Type.Object({ status: Type.Literal("absent") }, exact),
    Type.Object({ status: Type.Literal("uninitialized") }, exact),
    Type.Object(
        {
            message: messageSchema,
            reason: Type.Literal("pre_identity"),
            schemaVersion: schemaVersionSchema,
            status: Type.Literal("upgrade_required"),
        },
        exact,
    ),
    kissopenAgentInitializedDataSchema,
    Type.Object(
        {
            epoch: Type.Optional(kissopenAgentDataEpochSchema),
            message: messageSchema,
            reason: Type.Literal("newer_schema"),
            schemaVersion: schemaVersionSchema,
            status: Type.Literal("incompatible"),
        },
        exact,
    ),
    Type.Object(
        {
            message: messageSchema,
            reason: Type.Union([
                Type.Literal("busy"),
                Type.Literal("unreadable"),
                Type.Literal("io_error"),
            ]),
            status: Type.Literal("unavailable"),
        },
        exact,
    ),
]);
export type KissopenAgentInstallationData = Static<typeof kissopenAgentInstallationDataSchema>;

export const kissopenTerminalCliInstallationInspectionSchema = Type.Object(
    {
        cliProtocolVersion: Type.Integer({ minimum: 1 }),
        cliVersion: Type.String({ minLength: 1 }),
        data: kissopenAgentInstallationDataSchema,
        formatVersion: Type.Literal(1),
        source: Type.Literal("cli"),
    },
    exact,
);
export type KissopenTerminalCliInstallationInspection = Static<
    typeof kissopenTerminalCliInstallationInspectionSchema
>;

export const kissopenAgentDaemonInstallationDiscoverySchema = Type.Object(
    {
        daemonProtocolVersion: Type.Integer({ minimum: 1 }),
        daemonVersion: Type.String({ minLength: 1 }),
        data: Type.Object(
            {
                epoch: kissopenAgentDataEpochSchema,
                schemaCompatibility: Type.Literal("current"),
                schemaVersion: schemaVersionSchema,
                status: Type.Literal("initialized"),
            },
            exact,
        ),
        formatVersion: Type.Literal(1),
        source: Type.Literal("daemon"),
    },
    exact,
);
export type KissopenAgentDaemonInstallationDiscovery = Static<
    typeof kissopenAgentDaemonInstallationDiscoverySchema
>;
