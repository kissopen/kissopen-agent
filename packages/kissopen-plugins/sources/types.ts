import { type Static, type TSchema, Type } from "@sinclair/typebox";

import type {
    CreateKissopenComputeInput,
    ExecKissopenComputeInput,
    KissopenComputeEventSubscription,
    KissopenComputeExecResult,
    KissopenComputeInstance,
    KissopenComputePreparationEvent,
    KissopenComputeProvider,
    KissopenComputeProviderHandlers,
    KissopenComputeRegistration,
    ReadKissopenComputeInput,
    RegisterKissopenComputeProviderInput,
    StopKissopenComputeInput,
    WriteKissopenComputeInput,
} from "./computeTypes.js";
import {
    kissopenComputeProviderContributionSchema,
    kissopenComputeProviderManifestSchema,
} from "./computeTypes.js";

const exact = { additionalProperties: false } as const;
const nonEmptyText = Type.String({ minLength: 1 });
const clientChosenIdSchema = Type.String({
    maxLength: 24,
    minLength: 24,
    pattern: "^[a-z0-9]{24}$",
});

// Must stay in sync with MAX_INSTALLED_PLUGINS in Rig's plugin discovery.
export const KISSOPEN_PLUGIN_MAX_LIST_ITEMS = 64;
export const KISSOPEN_PLUGIN_MAX_ICON_BYTES = 4 * 1024 * 1024;
export const KISSOPEN_PLUGIN_MAX_ICON_DIMENSION = 2_048;
export const KISSOPEN_PLUGIN_MAX_INTERCEPT_DOMAINS = 16;
export const KISSOPEN_PLUGIN_MAX_NETWORK_BODY_BYTES = 256 * 1024;
export const KISSOPEN_PLUGIN_MAX_NETWORK_EVENT_BYTES = 512 * 1024;
export const KISSOPEN_PLUGIN_MAX_NETWORK_HEADER_BYTES = 64 * 1024;
export const KISSOPEN_PLUGIN_MAX_NETWORK_HEADER_COUNT = 128;
export const KISSOPEN_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH = 8_192;
export const KISSOPEN_PLUGIN_MAX_NETWORK_METHOD_LENGTH = 64;
export const KISSOPEN_PLUGIN_MAX_NETWORK_URL_LENGTH = 8_192;

export const kissopenProjectSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type KissopenProject = Static<typeof kissopenProjectSchema>;

export const kissopenWorkspaceStatusSchema = Type.Union([
    Type.Literal("initializing"),
    Type.Literal("ready"),
    Type.Literal("failed"),
    Type.Literal("archiving"),
    Type.Literal("archived"),
]);
export type KissopenWorkspaceStatus = Static<typeof kissopenWorkspaceStatusSchema>;

export const kissopenWorkspaceSchema = Type.Object(
    {
        archivedAt: Type.Optional(Type.Number()),
        baseRef: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
        id: nonEmptyText,
        name: nonEmptyText,
        path: nonEmptyText,
        projectId: nonEmptyText,
        status: kissopenWorkspaceStatusSchema,
        version: Type.Integer({ minimum: 0 }),
    },
    exact,
);
export type KissopenWorkspace = Static<typeof kissopenWorkspaceSchema>;

export const kissopenWorkspaceEventSchema = Type.Union([
    Type.Object(
        {
            type: Type.Literal("workspace_created"),
            workspace: kissopenWorkspaceSchema,
        },
        exact,
    ),
    Type.Object(
        {
            type: Type.Literal("workspace_updated"),
            workspace: kissopenWorkspaceSchema,
        },
        exact,
    ),
]);
export type KissopenWorkspaceEvent = Static<typeof kissopenWorkspaceEventSchema>;

export interface KissopenWorkspaceSubscription {
    readonly failure: string | undefined;
    readonly status: KissopenPluginStreamStatus;
    close(): Promise<void>;
}

export const kissopenSessionSchema = Type.Object(
    {
        agentId: nonEmptyText,
        archived: Type.Boolean(),
        cwd: nonEmptyText,
        id: nonEmptyText,
        projectId: nonEmptyText,
        status: nonEmptyText,
        title: Type.Optional(Type.String()),
        workspaceId: Type.Optional(nonEmptyText),
    },
    exact,
);
export type KissopenSession = Static<typeof kissopenSessionSchema>;

export const createWorkspaceInputSchema = Type.Object(
    {
        baseRef: Type.Optional(Type.String()),
        /** Stable client identity used to reconcile retries with the original reservation. */
        id: Type.Optional(clientChosenIdSchema),
        name: nonEmptyText,
        projectId: nonEmptyText,
    },
    exact,
);
export type CreateWorkspaceInput = Static<typeof createWorkspaceInputSchema>;

export const createWorkspaceBodySchema = Type.Omit(createWorkspaceInputSchema, ["projectId"]);

export const renameWorkspaceInputSchema = Type.Object(
    {
        name: nonEmptyText,
        projectId: nonEmptyText,
        version: Type.Integer({ minimum: 0 }),
        workspaceId: nonEmptyText,
    },
    exact,
);
export type RenameWorkspaceInput = Static<typeof renameWorkspaceInputSchema>;

export const renameWorkspaceBodySchema = Type.Pick(renameWorkspaceInputSchema, ["name", "version"]);

export const archiveWorkspaceInputSchema = Type.Object(
    {
        projectId: nonEmptyText,
        version: Type.Integer({ minimum: 0 }),
        workspaceId: nonEmptyText,
    },
    exact,
);
export type ArchiveWorkspaceInput = Static<typeof archiveWorkspaceInputSchema>;

export const archiveWorkspaceBodySchema = Type.Pick(archiveWorkspaceInputSchema, ["version"]);

export const listWorkspacesInputSchema = Type.Object(
    { projectId: Type.Optional(nonEmptyText) },
    exact,
);
export type ListWorkspacesInput = Static<typeof listWorkspacesInputSchema>;

export const KISSOPEN_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
export const KISSOPEN_PLUGIN_MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;
export const KISSOPEN_PLUGIN_MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;
export const KISSOPEN_PLUGIN_MAX_FILE_BYTES = 1024 * 1024;

const workspaceIdSchema = nonEmptyText;
const workspaceRelativePathSchema = Type.String({ maxLength: 4_096, minLength: 1 });
const fileBytesBase64Schema = Type.String({
    maxLength: Math.ceil(KISSOPEN_PLUGIN_MAX_FILE_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});
const commandOutputBytesBase64Schema = Type.String({
    maxLength: Math.ceil(KISSOPEN_PLUGIN_MAX_COMMAND_OUTPUT_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const executeWorkspaceCommandInputSchema = Type.Object(
    {
        command: Type.String({ maxLength: 64 * 1024, minLength: 1 }),
        timeoutMs: Type.Optional(
            Type.Integer({
                default: KISSOPEN_PLUGIN_DEFAULT_COMMAND_TIMEOUT_MS,
                maximum: KISSOPEN_PLUGIN_MAX_COMMAND_TIMEOUT_MS,
                minimum: 1,
            }),
        ),
        workspaceId: workspaceIdSchema,
    },
    exact,
);
export type ExecuteWorkspaceCommandInput = Static<typeof executeWorkspaceCommandInputSchema>;

export const executeWorkspaceCommandBodySchema = Type.Omit(executeWorkspaceCommandInputSchema, [
    "workspaceId",
]);

export const executeWorkspaceCommandResultSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderr: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_COMMAND_OUTPUT_BYTES }),
        stderrTruncated: Type.Boolean(),
        stdout: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_COMMAND_OUTPUT_BYTES }),
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export type ExecuteWorkspaceCommandResult = Static<typeof executeWorkspaceCommandResultSchema>;

export const executeWorkspaceCommandResponseSchema = Type.Object(
    {
        exitCode: Type.Union([Type.Integer(), Type.Null()]),
        stderrBase64: commandOutputBytesBase64Schema,
        stderrTruncated: Type.Boolean(),
        stdoutBase64: commandOutputBytesBase64Schema,
        stdoutTruncated: Type.Boolean(),
        timedOut: Type.Boolean(),
    },
    exact,
);
export type ExecuteWorkspaceCommandResponse = Static<typeof executeWorkspaceCommandResponseSchema>;

export const readWorkspaceFileInputSchema = Type.Object(
    {
        path: workspaceRelativePathSchema,
        workspaceId: workspaceIdSchema,
    },
    exact,
);
export type ReadWorkspaceFileInput = Static<typeof readWorkspaceFileInputSchema>;

export const readWorkspaceFileBodySchema = Type.Omit(readWorkspaceFileInputSchema, ["workspaceId"]);

export const readWorkspaceFileResultSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: KISSOPEN_PLUGIN_MAX_FILE_BYTES, minimum: 0 }),
        content: Type.String(),
    },
    exact,
);
export type ReadWorkspaceFileResult = Static<typeof readWorkspaceFileResultSchema>;

export const readWorkspaceFileResponseSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: KISSOPEN_PLUGIN_MAX_FILE_BYTES, minimum: 0 }),
        contentBase64: fileBytesBase64Schema,
    },
    exact,
);
export type ReadWorkspaceFileResponse = Static<typeof readWorkspaceFileResponseSchema>;

export const writeWorkspaceFileInputSchema = Type.Object(
    {
        content: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_FILE_BYTES }),
        path: workspaceRelativePathSchema,
        workspaceId: workspaceIdSchema,
    },
    exact,
);
export type WriteWorkspaceFileInput = Static<typeof writeWorkspaceFileInputSchema>;

export const writeWorkspaceFileBodySchema = Type.Object(
    {
        contentBase64: fileBytesBase64Schema,
        path: workspaceRelativePathSchema,
    },
    exact,
);

export const writeWorkspaceFileResultSchema = Type.Object(
    {
        bytesWritten: Type.Integer({ maximum: KISSOPEN_PLUGIN_MAX_FILE_BYTES, minimum: 0 }),
    },
    exact,
);
export type WriteWorkspaceFileResult = Static<typeof writeWorkspaceFileResultSchema>;

export const createSessionInputSchema = Type.Object(
    {
        appendSystemPrompt: Type.Optional(Type.String()),
        cwd: nonEmptyText,
        effort: Type.Optional(Type.String()),
        modelId: Type.Optional(Type.String()),
        providerId: Type.Optional(Type.String()),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateSessionInput = Static<typeof createSessionInputSchema>;

export const sendAgentMessageInputSchema = Type.Object(
    {
        agentId: nonEmptyText,
        message: nonEmptyText,
    },
    exact,
);
export type SendAgentMessageInput = Static<typeof sendAgentMessageInputSchema>;

export const sendAgentMessageBodySchema = Type.Pick(sendAgentMessageInputSchema, ["message"]);

export const agentMessageDeliverySchema = Type.Object(
    {
        delivered: Type.Literal(true),
        runId: nonEmptyText,
        sessionId: nonEmptyText,
    },
    exact,
);
export type AgentMessageDelivery = Static<typeof agentMessageDeliverySchema>;

export const kissopenSlotNameSchema = Type.Union([
    Type.Literal("status-line"),
    Type.Literal("above-composer"),
    Type.Literal("title"),
    Type.Literal("sidebar"),
]);
export type KissopenSlotName = Static<typeof kissopenSlotNameSchema>;

export const kissopenSlotScopeSchema = Type.Union([
    Type.Literal("everywhere"),
    Type.Literal("project"),
    Type.Literal("workspace"),
    Type.Literal("session"),
]);
export type KissopenSlotScope = Static<typeof kissopenSlotScopeSchema>;

export const kissopenSlotActionSchema = Type.Union([
    Type.Object({ message: Type.String(), type: Type.Literal("send-current-chat") }, exact),
    Type.Object(
        {
            path: Type.Optional(Type.String()),
            query: Type.Optional(Type.Record(Type.String(), Type.String())),
            type: Type.Literal("open-applet"),
            applet: Type.String(),
        },
        exact,
    ),
    Type.Object(
        {
            message: Type.String(),
            sessionId: Type.String(),
            type: Type.Literal("send-chat"),
        },
        exact,
    ),
    Type.Object(
        {
            message: Type.String(),
            sessionId: Type.String(),
            type: Type.Literal("draft-chat"),
        },
        exact,
    ),
    Type.Object(
        {
            effort: Type.Optional(Type.String()),
            model: Type.Optional(Type.String()),
            projectId: Type.Optional(Type.String()),
            prompt: Type.Optional(Type.String()),
            provider: Type.Optional(Type.String()),
            readOnly: Type.Optional(Type.Boolean()),
            serviceTier: Type.Optional(Type.Literal("fast")),
            title: Type.Optional(Type.String()),
            type: Type.Literal("new-chat"),
            workspaceId: Type.Optional(Type.String()),
        },
        exact,
    ),
]);
export type KissopenSlotAction = Static<typeof kissopenSlotActionSchema>;

export const kissopenSlotContentSchema = Type.Union([
    Type.Object({ markdown: Type.String(), type: Type.Literal("text") }, exact),
    Type.Object(
        {
            action: kissopenSlotActionSchema,
            label: Type.String(),
            type: Type.Literal("button"),
        },
        exact,
    ),
]);
export type KissopenSlotContent = Static<typeof kissopenSlotContentSchema>;

export const kissopenSlotEntryAuthorSchema = Type.Union([
    Type.Object({ sessionId: Type.String(), type: Type.Literal("agent") }, exact),
    Type.Object(
        {
            folder: Type.String(),
            name: Type.String(),
            type: Type.Literal("plugin"),
        },
        exact,
    ),
]);
export type KissopenSlotEntryAuthor = Static<typeof kissopenSlotEntryAuthorSchema>;

export const kissopenSlotEntrySchema = Type.Object(
    {
        author: kissopenSlotEntryAuthorSchema,
        content: kissopenSlotContentSchema,
        createdAt: Type.Number(),
        description: Type.String(),
        id: Type.String(),
        projectId: Type.Optional(Type.String()),
        purpose: Type.String(),
        scope: kissopenSlotScopeSchema,
        sessionId: Type.Optional(Type.String()),
        slot: kissopenSlotNameSchema,
        updatedAt: Type.Number(),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type KissopenSlotEntry = Static<typeof kissopenSlotEntrySchema>;

export const kissopenSlotEntryIdSchema = Type.String({ minLength: 1 });

export const createKissopenSlotEntryInputSchema = Type.Object(
    {
        content: kissopenSlotContentSchema,
        description: Type.String(),
        projectId: Type.Optional(Type.String()),
        purpose: Type.String(),
        scope: kissopenSlotScopeSchema,
        sessionId: Type.Optional(Type.String()),
        slot: kissopenSlotNameSchema,
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateKissopenSlotEntryInput = Static<typeof createKissopenSlotEntryInputSchema>;

export const listKissopenSlotEntriesInputSchema = Type.Object(
    {
        projectId: Type.Optional(Type.String()),
        sessionId: Type.Optional(Type.String()),
        slot: Type.Optional(kissopenSlotNameSchema),
        workspaceId: Type.Optional(Type.String()),
    },
    exact,
);
export type ListKissopenSlotEntriesInput = Static<typeof listKissopenSlotEntriesInputSchema>;

export const updateKissopenSlotEntryInputSchema = Type.Object(
    {
        content: Type.Optional(kissopenSlotContentSchema),
        description: Type.Optional(Type.String()),
        purpose: Type.Optional(Type.String()),
        slot: Type.Optional(kissopenSlotNameSchema),
    },
    exact,
);
export type UpdateKissopenSlotEntryInput = Static<typeof updateKissopenSlotEntryInputSchema>;

export const kissopenSlotEntryResponseSchema = Type.Object({ entry: kissopenSlotEntrySchema }, exact);
export const listKissopenSlotEntriesResponseSchema = Type.Object(
    { entries: Type.Array(kissopenSlotEntrySchema) },
    exact,
);

export const KISSOPEN_PLUGIN_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const kissopenPublishedMediaNameSchema = Type.String({
    maxLength: 255,
    minLength: 3,
    pattern: "^[^/\\\\]+\\.[A-Za-z0-9]{1,10}$",
});
const kissopenPublishedMediaPathSchema = Type.String({
    maxLength: 4_096,
    minLength: 3,
    pattern: "^.+\\.[A-Za-z0-9]{1,10}$",
});
const kissopenPublishedMediaBytesBase64Schema = Type.String({
    maxLength: Math.ceil(KISSOPEN_PLUGIN_MAX_MEDIA_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const publishKissopenMediaInputSchema = Type.Union([
    Type.Object(
        {
            bytes: Type.Uint8Array({ maxByteLength: KISSOPEN_PLUGIN_MAX_MEDIA_BYTES }),
            name: kissopenPublishedMediaNameSchema,
        },
        exact,
    ),
    Type.Object(
        {
            name: Type.Optional(kissopenPublishedMediaNameSchema),
            path: kissopenPublishedMediaPathSchema,
        },
        exact,
    ),
]);
export type PublishKissopenMediaInput = Static<typeof publishKissopenMediaInputSchema>;

export const publishKissopenMediaBodySchema = Type.Union([
    Type.Object(
        {
            contentBase64: kissopenPublishedMediaBytesBase64Schema,
            name: kissopenPublishedMediaNameSchema,
        },
        exact,
    ),
    Type.Object(
        {
            name: Type.Optional(kissopenPublishedMediaNameSchema),
            path: kissopenPublishedMediaPathSchema,
        },
        exact,
    ),
]);

export const publishedKissopenMediaSchema = Type.Object(
    {
        bytes: Type.Integer({ maximum: KISSOPEN_PLUGIN_MAX_MEDIA_BYTES, minimum: 0 }),
        location: Type.String({ pattern: "^generated/[A-Za-z0-9][A-Za-z0-9._-]*$" }),
        name: kissopenPublishedMediaNameSchema,
    },
    exact,
);
export type PublishedKissopenMedia = Static<typeof publishedKissopenMediaSchema>;

export const listProjectsResponseSchema = Type.Object(
    { projects: Type.Array(kissopenProjectSchema) },
    exact,
);
export const listWorkspacesResponseSchema = Type.Object(
    { workspaces: Type.Array(kissopenWorkspaceSchema) },
    exact,
);
export const workspaceResponseSchema = Type.Object({ workspace: kissopenWorkspaceSchema }, exact);
export const listSessionsResponseSchema = Type.Object(
    { sessions: Type.Array(kissopenSessionSchema) },
    exact,
);
export const sessionResponseSchema = Type.Object({ session: kissopenSessionSchema }, exact);

export const kissopenMcpTextContentSchema = Type.Object(
    { text: Type.String(), type: Type.Literal("text") },
    exact,
);
export const kissopenMcpImageContentSchema = Type.Object(
    {
        data: Type.String(),
        mimeType: Type.String({ pattern: "^image/" }),
        type: Type.Literal("image"),
    },
    exact,
);
export const kissopenMcpContentSchema = Type.Union([
    kissopenMcpTextContentSchema,
    kissopenMcpImageContentSchema,
]);
export type KissopenMcpContent = Static<typeof kissopenMcpContentSchema>;

export const kissopenMcpToolResultSchema = Type.Object(
    {
        content: Type.Array(kissopenMcpContentSchema, { maxItems: 128 }),
        isError: Type.Optional(Type.Boolean()),
        structuredContent: Type.Optional(Type.Unknown()),
    },
    exact,
);
export type KissopenMcpToolResult = Static<typeof kissopenMcpToolResultSchema>;

/**
 * The JSON Schema subset accepted at the plugin socket boundary.
 *
 * `defineMcpTool` additionally checks the complete in-process value with TypeBox's schema guard
 * before this serializable form crosses the socket.
 */
export const kissopenMcpInputSchemaSchema = Type.Object(
    {
        additionalProperties: Type.Optional(Type.Union([Type.Boolean(), Type.Unknown()])),
        properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        required: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
        type: Type.Literal("object"),
    },
    { additionalProperties: true },
);
export type KissopenMcpInputSchema = Static<typeof kissopenMcpInputSchemaSchema>;

export const kissopenMcpToolRegistrationSchema = Type.Object(
    {
        _meta: Type.Optional(
            Type.Object(
                {
                    ui: Type.Object(
                        {
                            visibility: Type.Array(
                                Type.Union([Type.Literal("model"), Type.Literal("app")]),
                                { maxItems: 2, minItems: 1, uniqueItems: true },
                            ),
                        },
                        exact,
                    ),
                },
                exact,
            ),
        ),
        description: Type.String({ minLength: 1 }),
        inputSchema: kissopenMcpInputSchemaSchema,
        name: nonEmptyText,
    },
    exact,
);
export type KissopenMcpToolRegistration = Static<typeof kissopenMcpToolRegistrationSchema>;

export const kissopenMcpServerRegistrationSchema = Type.Object(
    {
        name: nonEmptyText,
        tools: Type.Array(kissopenMcpToolRegistrationSchema, { maxItems: 64, minItems: 1 }),
        version: Type.Optional(nonEmptyText),
    },
    exact,
);
export type KissopenMcpServerRegistration = Static<typeof kissopenMcpServerRegistrationSchema>;

export const registerKissopenMcpServerResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);
export type RegisterKissopenMcpServerResponse = Static<typeof registerKissopenMcpServerResponseSchema>;

export const kissopenMcpCallEventSchema = Type.Object(
    {
        arguments: Type.Unknown(),
        callId: nonEmptyText,
        tool: nonEmptyText,
        type: Type.Literal("call"),
    },
    exact,
);
export const kissopenMcpCancelEventSchema = Type.Object(
    { callId: nonEmptyText, type: Type.Literal("cancel") },
    exact,
);
export const kissopenMcpEventSchema = Type.Union([kissopenMcpCallEventSchema, kissopenMcpCancelEventSchema]);
export type KissopenMcpEvent = Static<typeof kissopenMcpEventSchema>;

export const kissopenMcpCallCompletionSchema = Type.Union([
    Type.Object({ result: kissopenMcpToolResultSchema }, exact),
    Type.Object({ error: nonEmptyText }, exact),
]);
export type KissopenMcpCallCompletion = Static<typeof kissopenMcpCallCompletionSchema>;

export interface KissopenMcpToolContext {
    /** Aborted when Rig cancels the model call, times it out, or retires this plugin generation. */
    readonly signal: AbortSignal;
}

export interface KissopenMcpTool<TInputSchema extends TSchema = TSchema> {
    readonly description: string;
    readonly inputSchema: TInputSchema;
    readonly name: string;
    /**
     * Official MCP Apps visibility. Omit it to make the tool available to both models and apps.
     */
    readonly visibility?: readonly ("app" | "model")[];
    execute(
        input: Static<TInputSchema>,
        context: KissopenMcpToolContext,
    ): KissopenMcpToolResult | Promise<KissopenMcpToolResult>;
}

export interface StartKissopenMcpServerOptions {
    name: string;
    tools: readonly KissopenMcpTool[];
    version?: string;
}

export interface KissopenMcpServer {
    /** The connection failure that closed this server, when one occurred. */
    readonly failure: string | undefined;
    readonly name: string;
    /** This server's registration for the current plugin process generation. */
    readonly registrationId: string;
    readonly status: KissopenMcpServerStatus;
    close(): Promise<void>;
}
export type KissopenMcpServerStatus = "closed" | "connected";

export const KISSOPEN_PLUGIN_MAX_APPS = 8;
export const KISSOPEN_PLUGIN_MAX_APP_RESOURCES = 64;
export const KISSOPEN_PLUGIN_MAX_RESOURCE_BYTES = 256 * 1024;
export const KISSOPEN_PLUGIN_MAX_APP_BYTES = 1024 * 1024;
export const KISSOPEN_PLUGIN_MAX_SYSTEM_PROMPT_BYTES = 256 * 1024;
export const KISSOPEN_PLUGIN_TRACING_QUEUE_SIZE = 128;
export const KISSOPEN_PLUGIN_MAX_STORAGE_KEYS = 1_024;
export const KISSOPEN_PLUGIN_MAX_STORAGE_VALUE_BYTES = 64 * 1024;
export const KISSOPEN_PLUGIN_MAX_STORAGE_BYTES = 5 * 1024 * 1024;

export const kissopenPluginAppIdSchema = Type.String({
    maxLength: 64,
    minLength: 1,
    pattern: "^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$",
});
export const kissopenPluginResourcePathSchema = Type.String({
    maxLength: 160,
    minLength: 1,
    pattern: "^(?!/)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*\\\\)[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
export const kissopenPluginResourceUriSchema = Type.String({
    pattern: "^ui://[^/?#]+/[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?/[A-Za-z0-9][A-Za-z0-9._/-]*$",
});
export const kissopenPluginResourceMediaTypeSchema = Type.Union([
    Type.Literal("application/json"),
    Type.Literal("font/woff2"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/png"),
    Type.Literal("image/svg+xml"),
    Type.Literal("image/webp"),
    Type.Literal("text/css"),
    Type.Literal("text/html"),
    Type.Literal("text/javascript"),
]);
export type KissopenPluginResourceMediaType = Static<typeof kissopenPluginResourceMediaTypeSchema>;

export const kissopenPluginAppSidebarSchema = Type.Object(
    {
        icon: Type.Optional(kissopenPluginResourcePathSchema),
        label: Type.String({ maxLength: 64, minLength: 1 }),
        order: Type.Integer({ maximum: 1_000, minimum: -1_000 }),
    },
    exact,
);
export type KissopenPluginAppSidebar = Static<typeof kissopenPluginAppSidebarSchema>;

export const kissopenPluginAppManifestSchema = Type.Object(
    {
        id: kissopenPluginAppIdSchema,
        page: kissopenPluginResourcePathSchema,
        root: kissopenPluginResourcePathSchema,
        sidebar: kissopenPluginAppSidebarSchema,
        title: Type.String({ maxLength: 128, minLength: 1 }),
    },
    exact,
);
export type KissopenPluginAppManifest = Static<typeof kissopenPluginAppManifestSchema>;

export const kissopenPluginVersionSchema = Type.String({
    default: "0.0.0",
    pattern:
        "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
});
export type KissopenPluginVersion = Static<typeof kissopenPluginVersionSchema>;

export const kissopenPluginSystemPromptContributionSchema = Type.Union([
    Type.Object(
        {
            text: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_SYSTEM_PROMPT_BYTES, minLength: 1 }),
        },
        exact,
    ),
    Type.Object(
        {
            path: Type.String({ maxLength: 4_096, minLength: 1 }),
        },
        exact,
    ),
]);
export type KissopenPluginSystemPromptContribution = Static<
    typeof kissopenPluginSystemPromptContributionSchema
>;

export const kissopenPluginDockerSchema = Type.Union([
    Type.Literal(true),
    Type.Object(
        {
            image: Type.String({
                maxLength: 512,
                minLength: 1,
                pattern: "^\\S+$",
            }),
        },
        exact,
    ),
]);
export type KissopenPluginDocker = Static<typeof kissopenPluginDockerSchema>;

export const kissopenPluginCategorySchema = Type.Union([
    Type.Literal("automation"),
    Type.Literal("collaboration"),
    Type.Literal("data"),
    Type.Literal("developer-tools"),
    Type.Literal("media"),
    Type.Literal("productivity"),
    Type.Literal("utilities"),
    Type.Literal("other"),
]);
export type KissopenPluginCategory = Static<typeof kissopenPluginCategorySchema>;

export const kissopenPluginManifestSchema = Type.Object(
    {
        apps: Type.Optional(
            Type.Array(kissopenPluginAppManifestSchema, {
                maxItems: KISSOPEN_PLUGIN_MAX_APPS,
                uniqueItems: true,
            }),
        ),
        author: Type.String({
            maxLength: 80,
            minLength: 1,
            pattern:
                "^(?!\\s)(?!.*\\s$)[^\\x00-\\x1F\\x7F-\\x9F\\u061C\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]+$",
        }),
        category: kissopenPluginCategorySchema,
        compute: Type.Optional(kissopenComputeProviderManifestSchema),
        description: Type.String({ maxLength: 512, minLength: 1 }),
        docker: Type.Optional(kissopenPluginDockerSchema),
        icon: Type.String({ maxLength: 4_096, pattern: "^.+\\.[pP][nN][gG]$" }),
        interceptDomains: Type.Optional(
            Type.Array(
                Type.String({
                    maxLength: 253,
                    minLength: 1,
                    pattern:
                        "^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$",
                }),
                {
                    maxItems: KISSOPEN_PLUGIN_MAX_INTERCEPT_DOMAINS,
                    uniqueItems: true,
                },
            ),
        ),
        main: Type.Optional(
            Type.String({
                pattern:
                    "^(?!.*\\.[dD]\\.[cCmM]?[tT][sS]$).+\\.(?:[cCmM]?[jJ][sS]|[cCmM]?[tT][sS])$",
            }),
        ),
        name: Type.String({ maxLength: 128, minLength: 1 }),
        skills: Type.Optional(Type.String({ minLength: 1 })),
        systemPrompt: Type.Optional(kissopenPluginSystemPromptContributionSchema),
        version: Type.Optional(kissopenPluginVersionSchema),
    },
    exact,
);
export type KissopenPluginManifest = Static<typeof kissopenPluginManifestSchema>;

const kissopenNetworkHeaderValueSchema = Type.Union([
    Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH }),
    Type.Array(Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_HEADER_VALUE_LENGTH }), {
        maxItems: 32,
    }),
]);
export const kissopenNetworkHeadersSchema = Type.Record(
    Type.String({ maxLength: 256, minLength: 1 }),
    kissopenNetworkHeaderValueSchema,
    { maxProperties: KISSOPEN_PLUGIN_MAX_NETWORK_HEADER_COUNT },
);
export type KissopenNetworkHeaders = Static<typeof kissopenNetworkHeadersSchema>;

const kissopenNetworkBodyBase64Schema = Type.String({
    maxLength: Math.ceil(KISSOPEN_PLUGIN_MAX_NETWORK_BODY_BYTES / 3) * 4,
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
});

export const kissopenNetworkRequestSchema = Type.Object(
    {
        body: Type.Uint8Array({ maxByteLength: KISSOPEN_PLUGIN_MAX_NETWORK_BODY_BYTES }),
        headers: kissopenNetworkHeadersSchema,
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        method: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
        mode: Type.Union([Type.Literal("handle"), Type.Literal("observe")]),
        url: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
    },
    exact,
);
export type KissopenNetworkRequest = Static<typeof kissopenNetworkRequestSchema>;

export const kissopenNetworkRequestEventSchema = Type.Object(
    {
        bodyBase64: kissopenNetworkBodyBase64Schema,
        callId: nonEmptyText,
        headers: kissopenNetworkHeadersSchema,
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        method: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
        mode: Type.Union([Type.Literal("handle"), Type.Literal("observe")]),
        type: Type.Literal("request"),
        url: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
    },
    exact,
);
export type KissopenNetworkRequestEvent = Static<typeof kissopenNetworkRequestEventSchema>;

export const kissopenNetworkTunnelEventSchema = Type.Object(
    {
        bytesFromClient: Type.Integer({ minimum: 0 }),
        bytesFromServer: Type.Integer({ minimum: 0 }),
        hostname: Type.String({ maxLength: 253, minLength: 1 }),
        port: Type.Integer({ maximum: 65_535, minimum: 1 }),
        type: Type.Literal("tunnel"),
    },
    exact,
);
export type KissopenNetworkTunnel = Static<typeof kissopenNetworkTunnelEventSchema>;

export const kissopenNetworkEventSchema = Type.Union([
    kissopenNetworkRequestEventSchema,
    kissopenNetworkTunnelEventSchema,
]);
export type KissopenNetworkEvent = Static<typeof kissopenNetworkEventSchema>;

export const kissopenNetworkPassThroughSchema = Type.Object(
    { type: Type.Literal("pass_through") },
    exact,
);
export const kissopenNetworkModifiedRequestSchema = Type.Object(
    {
        body: Type.Optional(
            Type.Uint8Array({ maxByteLength: KISSOPEN_PLUGIN_MAX_NETWORK_BODY_BYTES }),
        ),
        headers: Type.Optional(kissopenNetworkHeadersSchema),
        method: Type.Optional(
            Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
        ),
        type: Type.Literal("request"),
        url: Type.Optional(
            Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
        ),
    },
    exact,
);
export const kissopenNetworkSyntheticResponseSchema = Type.Object(
    {
        body: Type.Optional(
            Type.Uint8Array({ maxByteLength: KISSOPEN_PLUGIN_MAX_NETWORK_BODY_BYTES }),
        ),
        headers: Type.Optional(kissopenNetworkHeadersSchema),
        status: Type.Integer({ maximum: 599, minimum: 200 }),
        type: Type.Literal("response"),
    },
    exact,
);
export const kissopenNetworkRequestResultSchema = Type.Union([
    kissopenNetworkPassThroughSchema,
    kissopenNetworkModifiedRequestSchema,
    kissopenNetworkSyntheticResponseSchema,
]);
export type KissopenNetworkRequestResult = Static<typeof kissopenNetworkRequestResultSchema>;

export const kissopenNetworkRequestCompletionSchema = Type.Union([
    kissopenNetworkPassThroughSchema,
    Type.Object({ error: nonEmptyText, type: Type.Literal("error") }, exact),
    Type.Object(
        {
            bodyBase64: Type.Optional(kissopenNetworkBodyBase64Schema),
            headers: Type.Optional(kissopenNetworkHeadersSchema),
            method: Type.Optional(
                Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_METHOD_LENGTH, minLength: 1 }),
            ),
            type: Type.Literal("request"),
            url: Type.Optional(
                Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_NETWORK_URL_LENGTH, minLength: 1 }),
            ),
        },
        exact,
    ),
    Type.Object(
        {
            bodyBase64: Type.Optional(kissopenNetworkBodyBase64Schema),
            headers: Type.Optional(kissopenNetworkHeadersSchema),
            status: Type.Integer({ maximum: 599, minimum: 200 }),
            type: Type.Literal("response"),
        },
        exact,
    ),
]);
export type KissopenNetworkRequestCompletion = Static<typeof kissopenNetworkRequestCompletionSchema>;

export const registerKissopenNetworkListenerResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export interface KissopenNetworkSubscription {
    close(): Promise<void>;
}

export type KissopenNetworkRequestHandler = (
    request: KissopenNetworkRequest,
) => KissopenNetworkRequestResult | Promise<KissopenNetworkRequestResult>;

export type KissopenNetworkTunnelHandler = (tunnel: KissopenNetworkTunnel) => void | Promise<void>;

export const kissopenPluginStateSchema = Type.Union([
    Type.Literal("failed"),
    Type.Literal("running"),
    Type.Literal("stopped"),
]);
export type KissopenPluginState = Static<typeof kissopenPluginStateSchema>;

export const kissopenPluginStatusSchema = Type.String({
    maxLength: 512,
    minLength: 1,
    pattern: "\\S",
});
export type KissopenPluginStatus = Static<typeof kissopenPluginStatusSchema>;

export const kissopenPluginSchema = Type.Object(
    {
        compute: Type.Optional(kissopenComputeProviderContributionSchema),
        folder: Type.String({ maxLength: 255, minLength: 1 }),
        isSelf: Type.Boolean(),
        name: nonEmptyText,
        state: kissopenPluginStateSchema,
        status: Type.Optional(kissopenPluginStatusSchema),
        version: kissopenPluginVersionSchema,
    },
    exact,
);
export type KissopenPlugin = Static<typeof kissopenPluginSchema>;

export const kissopenSystemPromptHookInputSchema = Type.Object(
    {
        systemPrompt: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_SYSTEM_PROMPT_BYTES }),
        userPrompt: Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_SYSTEM_PROMPT_BYTES }),
    },
    exact,
);
export type KissopenSystemPromptHookInput = Static<typeof kissopenSystemPromptHookInputSchema>;

export const kissopenSystemPromptHookResultSchema = Type.Object(
    {
        systemPrompt: Type.Optional(
            Type.String({ maxLength: KISSOPEN_PLUGIN_MAX_SYSTEM_PROMPT_BYTES }),
        ),
    },
    exact,
);
export type KissopenSystemPromptHookResult = Static<typeof kissopenSystemPromptHookResultSchema>;

export const kissopenSystemPromptHookEventSchema = Type.Object(
    {
        callId: nonEmptyText,
        input: kissopenSystemPromptHookInputSchema,
        type: Type.Literal("system_prompt"),
    },
    exact,
);
export type KissopenSystemPromptHookEvent = Static<typeof kissopenSystemPromptHookEventSchema>;

export const kissopenSystemPromptHookCompletionSchema = Type.Object(
    {
        result: kissopenSystemPromptHookResultSchema,
    },
    exact,
);
export type KissopenSystemPromptHookCompletion = Static<typeof kissopenSystemPromptHookCompletionSchema>;

export const kissopenTracingUsageSchema = Type.Object(
    {
        cacheRead: Type.Number({ minimum: 0 }),
        cacheWrite: Type.Number({ minimum: 0 }),
        input: Type.Number({ minimum: 0 }),
        output: Type.Number({ minimum: 0 }),
        reasoning: Type.Optional(Type.Number({ minimum: 0 })),
        totalTokens: Type.Number({ minimum: 0 }),
    },
    exact,
);
export type KissopenTracingUsage = Static<typeof kissopenTracingUsageSchema>;

const kissopenTracingBase = {
    sessionId: nonEmptyText,
    timestamp: Type.Number(),
};
export const kissopenTracingEventSchema = Type.Union([
    Type.Object(
        {
            ...kissopenTracingBase,
            model: nonEmptyText,
            provider: nonEmptyText,
            type: Type.Literal("turn_started"),
        },
        exact,
    ),
    Type.Object(
        {
            ...kissopenTracingBase,
            iteration: Type.Integer({ minimum: 1 }),
            model: nonEmptyText,
            provider: nonEmptyText,
            type: Type.Literal("inference_request_started"),
        },
        exact,
    ),
    Type.Object(
        {
            ...kissopenTracingBase,
            durationMs: Type.Number({ minimum: 0 }),
            iteration: Type.Integer({ minimum: 1 }),
            model: nonEmptyText,
            provider: nonEmptyText,
            success: Type.Boolean(),
            type: Type.Literal("inference_request_finished"),
            usage: Type.Optional(kissopenTracingUsageSchema),
        },
        exact,
    ),
    Type.Object(
        {
            ...kissopenTracingBase,
            name: nonEmptyText,
            toolCallId: nonEmptyText,
            type: Type.Literal("tool_call_started"),
        },
        exact,
    ),
    Type.Object(
        {
            ...kissopenTracingBase,
            durationMs: Type.Number({ minimum: 0 }),
            name: nonEmptyText,
            success: Type.Boolean(),
            toolCallId: nonEmptyText,
            type: Type.Literal("tool_call_finished"),
        },
        exact,
    ),
    Type.Object(
        {
            ...kissopenTracingBase,
            durationMs: Type.Number({ minimum: 0 }),
            model: nonEmptyText,
            provider: nonEmptyText,
            stopReason: Type.String(),
            success: Type.Boolean(),
            type: Type.Literal("turn_finished"),
        },
        exact,
    ),
]);
export type KissopenTracingEvent = Static<typeof kissopenTracingEventSchema>;

export const registerKissopenPluginStreamResponseSchema = Type.Object(
    { registrationId: nonEmptyText },
    exact,
);

export const kissopenPluginStreamStatusSchema = Type.Union([
    Type.Literal("closed"),
    Type.Literal("connected"),
    Type.Literal("reconnecting"),
]);
export type KissopenPluginStreamStatus = Static<typeof kissopenPluginStreamStatusSchema>;

export interface KissopenSystemPromptHook {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: KissopenPluginStreamStatus;
    close(): Promise<void>;
}

export interface KissopenTracingSubscription {
    readonly failure: string | undefined;
    readonly registrationId: string;
    readonly status: KissopenPluginStreamStatus;
    close(): Promise<void>;
}

export const listPluginsResponseSchema = Type.Object(
    {
        plugins: Type.Array(kissopenPluginSchema, { maxItems: KISSOPEN_PLUGIN_MAX_LIST_ITEMS }),
    },
    exact,
);

export const kissopenPluginAppResourceSummarySchema = Type.Object(
    {
        mimeType: Type.String(),
        path: kissopenPluginResourcePathSchema,
        size: Type.Integer({ maximum: KISSOPEN_PLUGIN_MAX_RESOURCE_BYTES, minimum: 0 }),
        uri: kissopenPluginResourceUriSchema,
    },
    exact,
);
export type KissopenPluginAppResourceSummary = Static<typeof kissopenPluginAppResourceSummarySchema>;

export const kissopenPluginAppToolSummarySchema = Type.Object(
    {
        _meta: Type.Object(
            {
                ui: Type.Object(
                    {
                        resourceUri: Type.String({ pattern: "^ui://" }),
                        visibility: Type.Array(
                            Type.Union([Type.Literal("model"), Type.Literal("app")]),
                            { maxItems: 2, minItems: 1, uniqueItems: true },
                        ),
                    },
                    exact,
                ),
            },
            exact,
        ),
        description: nonEmptyText,
        name: nonEmptyText,
        server: nonEmptyText,
    },
    exact,
);
export type KissopenPluginAppToolSummary = Static<typeof kissopenPluginAppToolSummarySchema>;

/**
 * One host-visible application.
 *
 * `id` is stable across restarts and replacements. `generation` is deliberately not: every plugin
 * process receives a new opaque value so an old renderer cannot address replacement code.
 */
export const kissopenPluginAppContributionSchema = Type.Object(
    {
        appId: kissopenPluginAppIdSchema,
        generation: nonEmptyText,
        id: nonEmptyText,
        page: kissopenPluginResourcePathSchema,
        pluginFolder: nonEmptyText,
        resourceUri: kissopenPluginResourceUriSchema,
        resources: Type.Array(kissopenPluginAppResourceSummarySchema, {
            maxItems: KISSOPEN_PLUGIN_MAX_APP_RESOURCES,
            minItems: 1,
        }),
        sidebar: kissopenPluginAppSidebarSchema,
        title: Type.String({ maxLength: 128, minLength: 1 }),
        tools: Type.Array(kissopenPluginAppToolSummarySchema),
    },
    exact,
);
export type KissopenPluginAppContribution = Static<typeof kissopenPluginAppContributionSchema>;

export const kissopenProviderUsageWindowSchema = Type.Object(
    {
        durationMs: Type.Union([Type.Number(), Type.Null()]),
        resetsAt: Type.Union([Type.Number(), Type.Null()]),
        startsAt: Type.Union([Type.Number(), Type.Null()]),
        usedPercent: Type.Number(),
    },
    exact,
);
export type KissopenProviderUsageWindow = Static<typeof kissopenProviderUsageWindowSchema>;

export const kissopenProviderUsageCreditsSchema = Type.Object(
    {
        available: Type.Boolean(),
        remainingCents: Type.Union([Type.Number(), Type.Null()]),
        unlimited: Type.Boolean(),
        usedPercent: Type.Union([Type.Number(), Type.Null()]),
    },
    exact,
);
export type KissopenProviderUsageCredits = Static<typeof kissopenProviderUsageCreditsSchema>;

export const kissopenProviderUsageSchema = Type.Object(
    {
        capturedAt: Type.Number(),
        credits: Type.Union([kissopenProviderUsageCreditsSchema, Type.Null()]),
        exhausted: Type.Boolean(),
        planName: Type.Union([Type.String(), Type.Null()]),
        providerId: nonEmptyText,
        vendor: Type.Union([Type.Literal("claude"), Type.Literal("codex"), Type.Literal("grok")]),
        windows: Type.Object(
            {
                fiveHour: Type.Union([kissopenProviderUsageWindowSchema, Type.Null()]),
                monthly: Type.Union([kissopenProviderUsageWindowSchema, Type.Null()]),
                weekly: Type.Union([kissopenProviderUsageWindowSchema, Type.Null()]),
                fableWeekly: Type.Optional(
                    Type.Union([kissopenProviderUsageWindowSchema, Type.Null()]),
                ),
            },
            exact,
        ),
    },
    exact,
);
export type KissopenProviderUsage = Static<typeof kissopenProviderUsageSchema>;

export const kissopenProviderUsageTokensSchema = Type.Object(
    {
        inferences: Type.Integer({ minimum: 0 }),
        input: Type.Integer({ minimum: 0 }),
        output: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
        turns: Type.Integer({ minimum: 0 }),
    },
    exact,
);
export type KissopenProviderUsageTokens = Static<typeof kissopenProviderUsageTokensSchema>;

export const kissopenProviderUsageEntrySchema = Type.Object(
    {
        checkedAt: Type.Union([Type.Number(), Type.Null()]),
        error: Type.Union([Type.String(), Type.Null()]),
        providerId: nonEmptyText,
        tokens: kissopenProviderUsageTokensSchema,
        usage: Type.Union([kissopenProviderUsageSchema, Type.Null()]),
    },
    exact,
);
export type KissopenProviderUsageEntry = Static<typeof kissopenProviderUsageEntrySchema>;

export const listKissopenProviderUsageResponseSchema = Type.Object(
    {
        providers: Type.Array(kissopenProviderUsageEntrySchema),
    },
    exact,
);

export const kissopenPluginTestSeedSchema = Type.Object(
    {
        computeProvider: Type.Optional(kissopenComputeProviderManifestSchema),
        plugins: Type.Optional(
            Type.Array(kissopenPluginSchema, { maxItems: KISSOPEN_PLUGIN_MAX_LIST_ITEMS }),
        ),
        providerUsage: Type.Optional(Type.Array(kissopenProviderUsageEntrySchema)),
        projects: Type.Optional(Type.Array(kissopenProjectSchema)),
        sessions: Type.Optional(Type.Array(kissopenSessionSchema)),
        workspaces: Type.Optional(Type.Array(kissopenWorkspaceSchema)),
    },
    exact,
);
export type KissopenPluginTestSeed = Static<typeof kissopenPluginTestSeedSchema>;

export const kissopenPluginTestRequestSchema = Type.Object(
    {
        body: Type.Optional(Type.Unknown()),
        method: nonEmptyText,
        path: nonEmptyText,
    },
    exact,
);
export type KissopenPluginTestRequest = Static<typeof kissopenPluginTestRequestSchema>;

export const createKissopenPluginClientOptionsSchema = Type.Object(
    {
        socketPath: Type.Optional(Type.String()),
        token: Type.Optional(Type.String()),
    },
    exact,
);
export type CreateKissopenPluginClientOptions = Static<typeof createKissopenPluginClientOptionsSchema>;

export const kissopenPluginReadyBodySchema = Type.Object({ status: kissopenPluginStatusSchema }, exact);
export const updateKissopenPluginStatusBodySchema = kissopenPluginReadyBodySchema;

/**
 * The public API available to a running KISSOPEN plugin.
 *
 * Use the exported {@link kissopen} singleton in normal plugin code. KISSOPEN injects and authenticates
 * its transport when the plugin process starts.
 */
export interface KissopenPluginClient {
    /**
     * Declares startup complete after every MCP server and other contribution has registered.
     *
     * KISSOPEN rejects registrations made after this call.
     */
    ready(status: KissopenPluginStatus): Promise<void>;
    /** Send a durable notification to an agent identified by a session's stable Agent ID. */
    readonly agents: {
        sendMessage(input: SendAgentMessageInput): Promise<AgentMessageDelivery>;
    };
    /** Register or consume generation-scoped filesystem-and-command compute providers. */
    readonly compute: {
        create(input: CreateKissopenComputeInput): Promise<KissopenComputeInstance>;
        readonly events: {
            subscribe(
                handler: (event: KissopenComputePreparationEvent) => void | Promise<void>,
            ): Promise<KissopenComputeEventSubscription>;
        };
        exec(input: ExecKissopenComputeInput): Promise<KissopenComputeExecResult>;
        readonly files: {
            read(input: ReadKissopenComputeInput): Promise<Uint8Array>;
            write(input: WriteKissopenComputeInput): Promise<void>;
        };
        readonly instances: {
            list(): Promise<readonly KissopenComputeInstance[]>;
        };
        list(): Promise<readonly KissopenComputeProvider[]>;
        register(
            handlers: KissopenComputeProviderHandlers,
            options?: RegisterKissopenComputeProviderInput,
        ): Promise<KissopenComputeRegistration>;
        stop(input: StopKissopenComputeInput): Promise<void>;
    };
    /** Register middleware that may replace the composed system prompt before an agent turn. */
    readonly hooks: {
        onSystemPrompt(
            handler: (
                input: KissopenSystemPromptHookInput,
            ) => KissopenSystemPromptHookResult | Promise<KissopenSystemPromptHookResult>,
        ): Promise<KissopenSystemPromptHook>;
    };
    /** Inspect projects known to the local Kissopen daemon. */
    readonly projects: {
        list(): Promise<readonly KissopenProject[]>;
    };
    /** Contribute MCP tools to ordinary Kissopen agent sessions. */
    readonly mcp: {
        startServer(options: StartKissopenMcpServerOptions): Promise<KissopenMcpServer>;
    };
    /** Publish a bounded file into Kissopen's shared generated-media folder. */
    readonly media: {
        publish(input: PublishKissopenMediaInput): Promise<PublishedKissopenMedia>;
    };
    /**
     * Observe or handle manifest-declared network destinations reached through KISSOPEN's managed
     * proxy. The sandbox network allowlist remains authoritative.
     */
    readonly network: {
        onRequest(handler: KissopenNetworkRequestHandler): Promise<KissopenNetworkSubscription>;
        onTunnel(handler: KissopenNetworkTunnelHandler): Promise<KissopenNetworkSubscription>;
    };
    /** Inspect plugins registered with the owning Kissopen daemon. */
    readonly plugins: {
        list(): Promise<readonly KissopenPlugin[]>;
    };
    /** Inspect provider-neutral account usage held by the local daemon. */
    readonly providers: {
        usage(): Promise<readonly KissopenProviderUsageEntry[]>;
    };
    /** Inspect existing sessions or create a new agent session. */
    readonly sessions: {
        create(input: CreateSessionInput): Promise<KissopenSession>;
        list(): Promise<readonly KissopenSession[]>;
    };
    /** Add and manage persistent entries in Kissopen's fixed UI slots. */
    readonly slots: {
        create(input: CreateKissopenSlotEntryInput): Promise<KissopenSlotEntry>;
        list(input?: ListKissopenSlotEntriesInput): Promise<readonly KissopenSlotEntry[]>;
        remove(id: string): Promise<KissopenSlotEntry>;
        update(id: string, input: UpdateKissopenSlotEntryInput): Promise<KissopenSlotEntry>;
    };
    /** Observe bounded, non-blocking agent lifecycle events. */
    readonly tracing: {
        subscribe(
            handler: (event: KissopenTracingEvent) => void | Promise<void>,
        ): Promise<KissopenTracingSubscription>;
    };
    /** Update the plugin-authored human-readable status shown by KISSOPEN. */
    readonly status: {
        set(status: KissopenPluginStatus): Promise<void>;
    };
    /** Inspect and mutate KISSOPEN-managed Git workspaces. */
    readonly workspaces: {
        archive(input: ArchiveWorkspaceInput): Promise<KissopenWorkspace>;
        create(input: CreateWorkspaceInput): Promise<KissopenWorkspace>;
        exec(input: ExecuteWorkspaceCommandInput): Promise<ExecuteWorkspaceCommandResult>;
        readonly files: {
            read(input: ReadWorkspaceFileInput): Promise<ReadWorkspaceFileResult>;
            write(input: WriteWorkspaceFileInput): Promise<WriteWorkspaceFileResult>;
        };
        list(input?: ListWorkspacesInput): Promise<readonly KissopenWorkspace[]>;
        rename(input: RenameWorkspaceInput): Promise<KissopenWorkspace>;
        /** Observe workspace reservations and readiness changes through Rig's live event stream. */
        subscribe(
            handler: (event: KissopenWorkspaceEvent) => void | Promise<void>,
        ): Promise<KissopenWorkspaceSubscription>;
    };
}
