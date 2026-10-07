import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ maxLength: 4_096, minLength: 1 });

export type KissopenPluginCategory =
    | "automation"
    | "collaboration"
    | "data"
    | "developer-tools"
    | "media"
    | "productivity"
    | "utilities"
    | "other";

export interface KissopenPluginAppContribution {
    appId: string;
    generation: string;
    id: string;
    page: string;
    pluginFolder: string;
    resourceUri: string;
    resources: readonly {
        mimeType: string;
        path: string;
        size: number;
        uri: string;
    }[];
    sidebar: {
        icon?: string;
        label: string;
        order: number;
    };
    title: string;
    tools: readonly {
        _meta: {
            ui: {
                resourceUri: string;
                visibility: readonly ("model" | "app")[];
            };
        };
        description: string;
        name: string;
        server: string;
    }[];
}

export interface KissopenComputeProviderContribution {
    health: "healthy" | "degraded" | "failed";
    name: string;
    provisioningTimeoutMs: number;
}

export type KissopenComputePreparationPhase = string;

export const kissopenComputeInstanceStateSchema = Type.Union([
    Type.Literal("unprovisioned"),
    Type.Literal("provisioning"),
    Type.Literal("ready"),
    Type.Literal("unavailable"),
    Type.Literal("failed"),
    Type.Literal("stopped"),
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
const nonRetryableComputeErrorCodeSchema = Type.Union([
    Type.Literal("invalid_request"),
    Type.Literal("invalid_response"),
    Type.Literal("instance_failed"),
    Type.Literal("instance_not_found"),
    Type.Literal("provider_lost"),
    Type.Literal("provider_not_found"),
    Type.Literal("provider_unhealthy"),
]);

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

export interface KissopenComputePreparationEvent {
    createdAt: number;
    elapsedMs?: number;
    error?: KissopenComputeError;
    instanceId: string;
    lastProgressAt?: number;
    message: string;
    percent?: number;
    phase: KissopenComputePreparationPhase;
    provider: string;
    startedAt?: number;
    state: "provisioning" | "ready" | "unprovisioned" | "unavailable" | "failed" | "stopped";
    type: "compute_preparation";
}
