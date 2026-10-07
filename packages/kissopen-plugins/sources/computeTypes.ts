import { type Static, Type } from "@sinclair/typebox";

export const KISSOPEN_COMPUTE_PROGRESS_MESSAGE_MAX_LENGTH = 4_096;

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({
    maxLength: KISSOPEN_COMPUTE_PROGRESS_MESSAGE_MAX_LENGTH,
    minLength: 1,
});
const instanceIdSchema = Type.String({ maxLength: 128, minLength: 1 });

export const KISSOPEN_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const KISSOPEN_COMPUTE_DEFAULT_PROVISIONING_TIMEOUT_MS = 5 * 60_000;
export const KISSOPEN_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS = 30 * 60_000;
export const KISSOPEN_COMPUTE_PROVISIONING_ACK_TIMEOUT_MS = 30_000;
export const KISSOPEN_COMPUTE_MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const KISSOPEN_COMPUTE_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const KISSOPEN_COMPUTE_MAX_FILE_BYTES = 1024 * 1024;

export const kissopenComputeInstanceStateSchema = Type.Union([
    Type.Literal("unprovisioned"),
    Type.Literal("provisioning"),
    Type.Literal("ready"),
    Type.Literal("unavailable"),
    Type.Literal("failed"),
    Type.Literal("stopped"),
]);
export type KissopenComputeInstanceState = Static<typeof kissopenComputeInstanceStateSchema>;

export const kissopenComputeProviderNameSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
});
export type KissopenComputeProviderName = Static<typeof kissopenComputeProviderNameSchema>;

export const kissopenComputeProviderManifestSchema = Type.Object(
    { name: kissopenComputeProviderNameSchema },
    exact,
);
export type KissopenComputeProviderManifest = Static<typeof kissopenComputeProviderManifestSchema>;

export const kissopenComputeProviderHealthSchema = Type.Union([
    Type.Literal("healthy"),
    Type.Literal("degraded"),
    Type.Literal("failed"),
]);
export type KissopenComputeProviderHealth = Static<typeof kissopenComputeProviderHealthSchema>;

export const kissopenComputeProviderContributionSchema = Type.Object(
    {
        health: kissopenComputeProviderHealthSchema,
        name: kissopenComputeProviderNameSchema,
        provisioningTimeoutMs: Type.Integer({
            maximum: KISSOPEN_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS,
            minimum: 1,
        }),
    },
    exact,
);
export type KissopenComputeProviderContribution = Static<
    typeof kissopenComputeProviderContributionSchema
>;

export const kissopenComputeProviderSchema = Type.Object(
    {
        health: kissopenComputeProviderHealthSchema,
        name: kissopenComputeProviderNameSchema,
        pluginFolder: Type.String({ maxLength: 255, minLength: 1 }),
        pluginName: nonEmptyText,
        provisioningTimeoutMs: Type.Integer({
            maximum: KISSOPEN_COMPUTE_MAX_PROVISIONING_TIMEOUT_MS,
            minimum: 1,
        }),
    },
    exact,
);
export type KissopenComputeProvider = Static<typeof kissopenComputeProviderSchema>;

export const kissopenComputeWorkspaceSourceSchema = Type.Union([
    Type.Object(
        {
            path: Type.String({ maxLength: 4_096, minLength: 1 }),
            type: Type.Literal("local_directory"),
        },
        exact,
    ),
]);
export type KissopenComputeWorkspaceSource = Static<typeof kissopenComputeWorkspaceSourceSchema>;

export const kissopenComputeRelativePathSchema = Type.String({
    maxLength: 4_096,
    minLength: 1,
    pattern: "^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))(?!.*\\\\).+$",
});

export const createKissopenComputeInputSchema = Type.Object(
    {
        provider: kissopenComputeProviderNameSchema,
        workspaceSource: kissopenComputeWorkspaceSourceSchema,
    },
    exact,
);
export type CreateKissopenComputeInput = Static<typeof createKissopenComputeInputSchema>;
export const startKissopenComputeHandlerInputSchema = Type.Object(
    { workspaceSource: kissopenComputeWorkspaceSourceSchema },
    exact,
);
export type StartKissopenComputeHandlerInput = Static<typeof startKissopenComputeHandlerInputSchema>;

const kissopenComputeInstanceBaseSchema = Type.Object(
    {
        createdAt: Type.Integer({ minimum: 0 }),
        instanceId: instanceIdSchema,
        provider: kissopenComputeProviderNameSchema,
    },
    exact,
);
export const kissopenComputeInstanceSchema = Type.Union([
    Type.Composite(
        [
            kissopenComputeInstanceBaseSchema,
            Type.Object(
                {
                    reason: Type.Optional(nonEmptyText),
                    state: Type.Literal("unprovisioned"),
                },
                exact,
            ),
        ],
        exact,
    ),
    Type.Composite(
        [
            kissopenComputeInstanceBaseSchema,
            Type.Object(
                {
                    state: Type.Union([Type.Literal("provisioning"), Type.Literal("ready")]),
                },
                exact,
            ),
        ],
        exact,
    ),
    Type.Composite(
        [
            kissopenComputeInstanceBaseSchema,
            Type.Object(
                {
                    reason: nonEmptyText,
                    state: Type.Literal("unavailable"),
                },
                exact,
            ),
        ],
        exact,
    ),
    Type.Composite(
        [
            kissopenComputeInstanceBaseSchema,
            Type.Object(
                {
                    diedAt: Type.Integer({ minimum: 0 }),
                    reason: nonEmptyText,
                    state: Type.Union([Type.Literal("failed"), Type.Literal("stopped")]),
                },
                exact,
            ),
        ],
        exact,
    ),
]);
export type KissopenComputeInstance = Static<typeof kissopenComputeInstanceSchema>;

export const readKissopenComputeInputSchema = Type.Object(
    {
        instanceId: instanceIdSchema,
        path: kissopenComputeRelativePathSchema,
    },
    exact,
);
export type ReadKissopenComputeInput = Static<typeof readKissopenComputeInputSchema>;

export const writeKissopenComputeInputSchema = Type.Object(
    {
        bytes: Type.Uint8Array({ maxByteLength: KISSOPEN_COMPUTE_MAX_FILE_BYTES }),
        instanceId: instanceIdSchema,
        path: kissopenComputeRelativePathSchema,
    },
    exact,
);
export type WriteKissopenComputeInput = Static<typeof writeKissopenComputeInputSchema>;

export const execKissopenComputeInputSchema = Type.Object(
    {
        command: Type.String({ maxLength: 64 * 1024, minLength: 1 }),
        instanceId: instanceIdSchema,
        timeoutMs: Type.Optional(
            Type.Integer({
                default: KISSOPEN_COMPUTE_DEFAULT_COMMAND_TIMEOUT_MS,
                maximum: KISSOPEN_COMPUTE_MAX_COMMAND_TIMEOUT_MS,
                minimum: 1,
            }),
        ),
    },
    exact,
);
export type ExecKissopenComputeInput = Static<typeof execKissopenComputeInputSchema>;
export const execKissopenComputeHandlerInputSchema = Type.Required(execKissopenComputeInputSchema);
export type ExecKissopenComputeHandlerInput = Static<typeof execKissopenComputeHandlerInputSchema>;

export const stopKissopenComputeInputSchema = Type.Object({ instanceId: instanceIdSchema }, exact);
export type StopKissopenComputeInput = Static<typeof stopKissopenComputeInputSchema>;

export const kissopenComputeExecResultSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderr: Type.String({ maxLength: KISSOPEN_COMPUTE_MAX_COMMAND_OUTPUT_BYTES }),
        stderrTruncated: Type.Boolean(),
        stdout: Type.String({ maxLength: KISSOPEN_COMPUTE_MAX_COMMAND_OUTPUT_BYTES }),
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export type KissopenComputeExecResult = Static<typeof kissopenComputeExecResultSchema>;

const fileBytesBase64Schema = Type.String({
    maxLength: Math.ceil(KISSOPEN_COMPUTE_MAX_FILE_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});
const outputBytesBase64Schema = Type.String({
    maxLength: Math.ceil(KISSOPEN_COMPUTE_MAX_COMMAND_OUTPUT_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const listKissopenComputeProvidersResponseSchema = Type.Object(
    { providers: Type.Array(kissopenComputeProviderSchema, { maxItems: 64 }) },
    exact,
);
export const listKissopenComputeInstancesResponseSchema = Type.Object(
    { instances: Type.Array(kissopenComputeInstanceSchema, { maxItems: 512 }) },
    exact,
);
export const createKissopenComputeBodySchema = createKissopenComputeInputSchema;
export const createKissopenComputeResponseSchema = kissopenComputeInstanceSchema;
export const readKissopenComputeBodySchema = Type.Pick(readKissopenComputeInputSchema, ["path"]);
export const readKissopenComputeResponseSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: KISSOPEN_COMPUTE_MAX_FILE_BYTES, minimum: 0 }),
        contentBase64: fileBytesBase64Schema,
    },
    exact,
);
export const writeKissopenComputeBodySchema = Type.Object(
    { contentBase64: fileBytesBase64Schema, path: kissopenComputeRelativePathSchema },
    exact,
);
export const execKissopenComputeBodySchema = Type.Omit(execKissopenComputeInputSchema, ["instanceId"]);
export const execKissopenComputeResponseSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderrBase64: outputBytesBase64Schema,
        stderrTruncated: Type.Boolean(),
        stdoutBase64: outputBytesBase64Schema,
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export const emptyKissopenComputeResponseSchema = Type.Object({}, exact);

const computeCallBase = {
    callId: nonEmptyText,
    type: Type.Literal("call"),
};
export const kissopenComputeCallEventSchema = Type.Union([
    Type.Object(
        {
            ...computeCallBase,
            operation: Type.Literal("start"),
            workspaceSource: kissopenComputeWorkspaceSourceSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            instanceId: instanceIdSchema,
            operation: Type.Literal("read"),
            path: kissopenComputeRelativePathSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            contentBase64: fileBytesBase64Schema,
            instanceId: instanceIdSchema,
            operation: Type.Literal("write"),
            path: kissopenComputeRelativePathSchema,
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            command: Type.String({ maxLength: 64 * 1024, minLength: 1 }),
            instanceId: instanceIdSchema,
            operation: Type.Literal("exec"),
            timeoutMs: Type.Integer({
                maximum: KISSOPEN_COMPUTE_MAX_COMMAND_TIMEOUT_MS,
                minimum: 1,
            }),
        },
        exact,
    ),
    Type.Object(
        {
            ...computeCallBase,
            instanceId: instanceIdSchema,
            operation: Type.Literal("stop"),
        },
        exact,
    ),
]);
export type KissopenComputeCallEvent = Static<typeof kissopenComputeCallEventSchema>;

export const kissopenComputeCancelEventSchema = Type.Object(
    { callId: nonEmptyText, type: Type.Literal("cancel") },
    exact,
);
export const kissopenComputeEventSchema = Type.Union([
    kissopenComputeCallEventSchema,
    kissopenComputeCancelEventSchema,
]);
export type KissopenComputeEvent = Static<typeof kissopenComputeEventSchema>;

export const kissopenComputeErrorCodeSchema = Type.Union([
    Type.Literal("capacity_exhausted"),
    Type.Literal("deadline_exceeded"),
    Type.Literal("invalid_request"),
    Type.Literal("invalid_response"),
    Type.Literal("instance_failed"),
    Type.Literal("instance_not_found"),
    Type.Literal("preparing_compute"),
    Type.Literal("provider_lost"),
    Type.Literal("provider_not_found"),
    Type.Literal("provider_unhealthy"),
]);
export type KissopenComputeErrorCode = Static<typeof kissopenComputeErrorCodeSchema>;

const nonRetryableComputeErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("invalid_response"),
    Type.Literal("instance_failed"),
    Type.Literal("instance_not_found"),
    Type.Literal("provider_lost"),
    Type.Literal("provider_not_found"),
    Type.Literal("provider_unhealthy"),
]);
const computeErrorState = {
    state: Type.Optional(kissopenComputeInstanceStateSchema),
};
const computePreparationDetails = {
    elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
    lastProgressAt: Type.Optional(Type.Integer({ minimum: 0 })),
    percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
    phase: Type.Optional(Type.String({ maxLength: 128, minLength: 1 })),
    startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
};
export const kissopenComputeErrorSchema = Type.Union([
    Type.Object(
        {
            ...computeErrorState,
            code: Type.Literal("capacity_exhausted"),
            message: nonEmptyText,
            retryable: Type.Literal(true),
        },
        exact,
    ),
    Type.Object(
        {
            ...computeErrorState,
            code: Type.Literal("deadline_exceeded"),
            message: nonEmptyText,
            retryable: Type.Literal(true),
        },
        exact,
    ),
    Type.Object(
        {
            ...computePreparationDetails,
            code: Type.Literal("preparing_compute"),
            message: nonEmptyText,
            retryable: Type.Literal(true),
            state: Type.Union([
                Type.Literal("unprovisioned"),
                Type.Literal("provisioning"),
                Type.Literal("unavailable"),
            ]),
        },
        exact,
    ),
    Type.Object(
        {
            ...computeErrorState,
            code: nonRetryableComputeErrorCodeSchema,
            message: nonEmptyText,
            retryable: Type.Literal(false),
        },
        exact,
    ),
]);
export type KissopenComputeError = Static<typeof kissopenComputeErrorSchema>;

export const kissopenComputeCallCompletionSchema = Type.Union([
    Type.Object({ error: kissopenComputeErrorSchema }, exact),
    Type.Object(
        {
            operation: Type.Literal("start"),
            result: Type.Object({ instanceId: instanceIdSchema }, exact),
        },
        exact,
    ),
    Type.Object(
        {
            operation: Type.Literal("read"),
            result: Type.Object(
                {
                    bytes: Type.Integer({
                        maximum: KISSOPEN_COMPUTE_MAX_FILE_BYTES,
                        minimum: 0,
                    }),
                    contentBase64: fileBytesBase64Schema,
                },
                exact,
            ),
        },
        exact,
    ),
    Type.Object({ operation: Type.Literal("write"), result: Type.Object({}, exact) }, exact),
    Type.Object(
        {
            operation: Type.Literal("exec"),
            result: execKissopenComputeResponseSchema,
        },
        exact,
    ),
    Type.Object({ operation: Type.Literal("stop"), result: Type.Object({}, exact) }, exact),
]);
export type KissopenComputeCallCompletion = Static<typeof kissopenComputeCallCompletionSchema>;

export const kissopenComputeProvisioningPhaseSchema = Type.String({
    maxLength: 128,
    minLength: 1,
    pattern: "^(?!(?:preparing_compute|verifying_compute|ready|failed|stopped)$).+",
});
export type KissopenComputeProvisioningPhase = Static<typeof kissopenComputeProvisioningPhaseSchema>;

export const kissopenComputeProvisioningProgressSchema = Type.Object(
    {
        message: Type.String({
            maxLength: KISSOPEN_COMPUTE_PROGRESS_MESSAGE_MAX_LENGTH,
            minLength: 1,
        }),
        phase: kissopenComputeProvisioningPhaseSchema,
        percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
    },
    exact,
);
export type KissopenComputeProvisioningProgress = Static<
    typeof kissopenComputeProvisioningProgressSchema
>;

export const kissopenComputePreparationPhaseSchema = Type.String({
    maxLength: 128,
    minLength: 1,
});
export type KissopenComputePreparationPhase = Static<typeof kissopenComputePreparationPhaseSchema>;

export const kissopenComputePreparationEventSchema = Type.Object(
    {
        createdAt: Type.Integer({ minimum: 0 }),
        elapsedMs: Type.Optional(Type.Integer({ minimum: 0 })),
        error: Type.Optional(kissopenComputeErrorSchema),
        instanceId: instanceIdSchema,
        lastProgressAt: Type.Optional(Type.Integer({ minimum: 0 })),
        message: Type.String({
            maxLength: KISSOPEN_COMPUTE_PROGRESS_MESSAGE_MAX_LENGTH,
            minLength: 1,
        }),
        percent: Type.Optional(Type.Number({ maximum: 100, minimum: 0 })),
        phase: kissopenComputePreparationPhaseSchema,
        provider: kissopenComputeProviderNameSchema,
        startedAt: Type.Optional(Type.Integer({ minimum: 0 })),
        state: Type.Union([
            Type.Literal("provisioning"),
            Type.Literal("ready"),
            Type.Literal("unprovisioned"),
            Type.Literal("unavailable"),
            Type.Literal("failed"),
            Type.Literal("stopped"),
        ]),
        type: Type.Literal("compute_preparation"),
    },
    exact,
);
export type KissopenComputePreparationEvent = Static<typeof kissopenComputePreparationEventSchema>;

export const registerKissopenComputeProviderInputSchema = Type.Object(
    {
        provisioningTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    exact,
);
export type RegisterKissopenComputeProviderInput = Static<
    typeof registerKissopenComputeProviderInputSchema
>;

export const registerKissopenComputeProviderResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export interface KissopenComputeHandlerContext {
    /** Aborted when the caller deadline expires or the provider generation is retired. */
    readonly signal: AbortSignal;
}

export interface KissopenComputeStartHandlerContext extends KissopenComputeHandlerContext {
    /** Aborted when the overall provisioning budget expires or the provider generation retires. */
    readonly signal: AbortSignal;
    /** Publishes human-readable materialization progress through Rig's compute event stream. */
    reportProgress(progress: KissopenComputeProvisioningProgress): Promise<void>;
}

export interface KissopenComputeProviderHandlers {
    exec(
        input: ExecKissopenComputeHandlerInput,
        context: KissopenComputeHandlerContext,
    ): KissopenComputeExecResult | Promise<KissopenComputeExecResult>;
    read(
        input: ReadKissopenComputeInput,
        context: KissopenComputeHandlerContext,
    ): Uint8Array | Promise<Uint8Array>;
    start(
        input: StartKissopenComputeHandlerInput,
        context: KissopenComputeStartHandlerContext,
    ): string | Promise<string>;
    stop(input: StopKissopenComputeInput, context: KissopenComputeHandlerContext): void | Promise<void>;
    write(input: WriteKissopenComputeInput, context: KissopenComputeHandlerContext): void | Promise<void>;
}

export interface KissopenComputeRegistration {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: "closed" | "connected";
    close(): Promise<void>;
}

export interface KissopenComputeEventSubscription {
    readonly failure: string | undefined;
    readonly status: "closed" | "connected";
    close(): Promise<void>;
}
