import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    createKissopenComputeInputSchema,
    createKissopenComputeResponseSchema,
    emptyKissopenComputeResponseSchema,
    execKissopenComputeInputSchema,
    execKissopenComputeResponseSchema,
    kissopenComputeErrorSchema,
    type KissopenComputeError,
    type KissopenComputeErrorCode,
    type KissopenComputeInstanceState,
    kissopenComputeExecResultSchema,
    listKissopenComputeInstancesResponseSchema,
    listKissopenComputeProvidersResponseSchema,
    readKissopenComputeInputSchema,
    readKissopenComputeResponseSchema,
    stopKissopenComputeInputSchema,
    writeKissopenComputeInputSchema,
} from "./computeTypes.js";
import { startKissopenComputeProvider } from "./startKissopenComputeProvider.js";
import { subscribeKissopenComputePreparation } from "./subscribeKissopenComputePreparation.js";
import { subscribeKissopenWorkspaces } from "./subscribeKissopenWorkspaces.js";
import { startKissopenMcpServer } from "./startKissopenMcpServer.js";
import {
    startKissopenNetworkRequestHandler,
    startKissopenNetworkTunnelHandler,
} from "./startKissopenNetworkListener.js";
import { startKissopenSystemPromptHook } from "./startKissopenSystemPromptHook.js";
import { subscribeKissopenTracing } from "./subscribeKissopenTracing.js";
import type { CreateKissopenPluginClientOptions, KissopenPluginClient } from "./types.js";
import {
    agentMessageDeliverySchema,
    archiveWorkspaceInputSchema,
    createKissopenSlotEntryInputSchema,
    createKissopenPluginClientOptionsSchema,
    createSessionInputSchema,
    createWorkspaceInputSchema,
    executeWorkspaceCommandInputSchema,
    executeWorkspaceCommandResponseSchema,
    executeWorkspaceCommandResultSchema,
    listProjectsResponseSchema,
    listKissopenProviderUsageResponseSchema,
    listKissopenSlotEntriesInputSchema,
    listKissopenSlotEntriesResponseSchema,
    listPluginsResponseSchema,
    listSessionsResponseSchema,
    listWorkspacesInputSchema,
    listWorkspacesResponseSchema,
    readWorkspaceFileInputSchema,
    readWorkspaceFileResponseSchema,
    readWorkspaceFileResultSchema,
    renameWorkspaceInputSchema,
    sendAgentMessageInputSchema,
    sessionResponseSchema,
    kissopenSlotEntryResponseSchema,
    kissopenSlotEntryIdSchema,
    kissopenPluginStatusSchema,
    publishKissopenMediaInputSchema,
    publishedKissopenMediaSchema,
    updateKissopenSlotEntryInputSchema,
    workspaceResponseSchema,
    KISSOPEN_PLUGIN_MAX_FILE_BYTES,
    writeWorkspaceFileInputSchema,
    writeWorkspaceFileResultSchema,
} from "./types.js";

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const emptyResponseSchema = Type.Object({}, { additionalProperties: false });
const errorResponseSchema = Type.Object(
    {
        code: Type.Optional(Type.String({ minLength: 1 })),
        error: Type.String(),
    },
    { additionalProperties: true },
);
const requiredSettingSchema = Type.String({ minLength: 1, pattern: "\\S" });

/** An HTTP error returned by the owning Kissopen daemon for an otherwise valid SDK request. */
export class KissopenPluginApiError extends Error {
    readonly code: KissopenComputeErrorCode | (string & {}) | undefined;
    readonly elapsedMs: number | undefined;
    readonly lastProgressAt: number | undefined;
    readonly percent: number | undefined;
    readonly phase: string | undefined;
    readonly retryable: boolean;
    readonly startedAt: number | undefined;
    readonly state: KissopenComputeInstanceState | undefined;
    readonly status: number;

    constructor(
        status: number,
        message: string,
        code?: KissopenComputeErrorCode | (string & {}),
        retryable = false,
        state?: KissopenComputeInstanceState,
        preparation?: Extract<KissopenComputeError, { code: "preparing_compute" }>,
    ) {
        super(message);
        this.name = "KissopenPluginApiError";
        this.code = code;
        this.elapsedMs = preparation?.elapsedMs;
        this.lastProgressAt = preparation?.lastProgressAt;
        this.percent = preparation?.percent;
        this.phase = preparation?.phase;
        this.retryable = retryable;
        this.startedAt = preparation?.startedAt;
        this.state = state;
        this.status = status;
    }
}

/**
 * Creates a Kissopen plugin API client.
 *
 * Normal plugins should use the exported `kissopen` singleton. Supplying a socket path and token is
 * useful for tests and custom harnesses.
 */
export function createKissopenPluginClient(
    options: CreateKissopenPluginClientOptions = {},
): KissopenPluginClient {
    Value.Assert(createKissopenPluginClientOptionsSchema, options);
    const socketPath = () =>
        requiredSetting(
            options.socketPath ?? process.env.KISSOPEN_PLUGIN_SOCKET_PATH,
            "KISSOPEN_PLUGIN_SOCKET_PATH",
        );
    const token = () =>
        requiredSetting(options.token ?? process.env.KISSOPEN_PLUGIN_TOKEN, "KISSOPEN_PLUGIN_TOKEN");
    const request = <TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>> =>
        requestJson({
            body,
            method,
            path,
            responseSchema,
            socketPath: socketPath(),
            token: token(),
        });
    const streamTransport = {
        request,
        get socketPath() {
            return socketPath();
        },
        get token() {
            return token();
        },
    };

    return {
        ready: async (status) => {
            Value.Assert(kissopenPluginStatusSchema, status);
            await request("POST", "/ready", emptyResponseSchema, { status });
        },
        agents: {
            sendMessage: (input) => {
                Value.Assert(sendAgentMessageInputSchema, input);
                return request(
                    "POST",
                    `/agents/${encodeURIComponent(input.agentId)}/messages`,
                    agentMessageDeliverySchema,
                    { message: input.message },
                );
            },
        },
        compute: {
            create: (input) => {
                Value.Assert(createKissopenComputeInputSchema, input);
                return request(
                    "POST",
                    "/compute/instances",
                    createKissopenComputeResponseSchema,
                    input,
                );
            },
            events: {
                subscribe: (handler) => subscribeKissopenComputePreparation(handler, streamTransport),
            },
            exec: async (input) => {
                Value.Assert(execKissopenComputeInputSchema, input);
                const response = await request(
                    "POST",
                    `/compute/instances/${encodeURIComponent(input.instanceId)}/exec`,
                    execKissopenComputeResponseSchema,
                    {
                        command: input.command,
                        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                    },
                );
                return Value.Decode(kissopenComputeExecResultSchema, {
                    exitCode: response.exitCode,
                    stderr: Buffer.from(response.stderrBase64, "base64").toString("utf8"),
                    stderrTruncated: response.stderrTruncated,
                    stdout: Buffer.from(response.stdoutBase64, "base64").toString("utf8"),
                    stdoutTruncated: response.stdoutTruncated,
                    timedOut: response.timedOut,
                });
            },
            files: {
                read: async (input) => {
                    Value.Assert(readKissopenComputeInputSchema, input);
                    const response = await request(
                        "POST",
                        `/compute/instances/${encodeURIComponent(input.instanceId)}/files/read`,
                        readKissopenComputeResponseSchema,
                        { path: input.path },
                    );
                    return Buffer.from(response.contentBase64, "base64");
                },
                write: async (input) => {
                    Value.Assert(writeKissopenComputeInputSchema, input);
                    await request(
                        "POST",
                        `/compute/instances/${encodeURIComponent(input.instanceId)}/files/write`,
                        emptyKissopenComputeResponseSchema,
                        {
                            contentBase64: Buffer.from(input.bytes).toString("base64"),
                            path: input.path,
                        },
                    );
                },
            },
            instances: {
                list: async () =>
                    (
                        await request(
                            "GET",
                            "/compute/instances",
                            listKissopenComputeInstancesResponseSchema,
                        )
                    ).instances,
            },
            list: async () =>
                (
                    await request(
                        "GET",
                        "/compute/providers",
                        listKissopenComputeProvidersResponseSchema,
                    )
                ).providers,
            register: (handlers, registrationOptions) =>
                startKissopenComputeProvider(handlers, streamTransport, registrationOptions),
            stop: async (input) => {
                Value.Assert(stopKissopenComputeInputSchema, input);
                await request(
                    "POST",
                    `/compute/instances/${encodeURIComponent(input.instanceId)}/stop`,
                    emptyKissopenComputeResponseSchema,
                );
            },
        },
        hooks: {
            onSystemPrompt: (handler) => startKissopenSystemPromptHook(handler, streamTransport),
        },
        projects: {
            list: async () =>
                (await request("GET", "/projects", listProjectsResponseSchema)).projects,
        },
        mcp: {
            startServer: (serverOptions) => startKissopenMcpServer(serverOptions, streamTransport),
        },
        media: {
            publish: (input) => {
                Value.Assert(publishKissopenMediaInputSchema, input);
                return request(
                    "POST",
                    "/media",
                    publishedKissopenMediaSchema,
                    "bytes" in input
                        ? {
                              contentBase64: Buffer.from(input.bytes).toString("base64"),
                              name: input.name,
                          }
                        : {
                              ...(input.name === undefined ? {} : { name: input.name }),
                              path: input.path,
                          },
                );
            },
        },
        network: {
            onRequest: (handler) =>
                startKissopenNetworkRequestHandler(handler, {
                    request,
                    get socketPath() {
                        return socketPath();
                    },
                    get token() {
                        return token();
                    },
                }),
            onTunnel: (handler) =>
                startKissopenNetworkTunnelHandler(handler, {
                    request,
                    get socketPath() {
                        return socketPath();
                    },
                    get token() {
                        return token();
                    },
                }),
        },
        plugins: {
            list: async () => (await request("GET", "/plugins", listPluginsResponseSchema)).plugins,
        },
        providers: {
            usage: async () =>
                (await request("GET", "/provider-usage", listKissopenProviderUsageResponseSchema))
                    .providers,
        },
        sessions: {
            create: async (input) => {
                Value.Assert(createSessionInputSchema, input);
                return (await request("POST", "/sessions", sessionResponseSchema, input)).session;
            },
            list: async () =>
                (await request("GET", "/sessions", listSessionsResponseSchema)).sessions,
        },
        slots: {
            create: async (input) => {
                Value.Assert(createKissopenSlotEntryInputSchema, input);
                return (await request("POST", "/slots", kissopenSlotEntryResponseSchema, input)).entry;
            },
            list: async (input = {}) => {
                Value.Assert(listKissopenSlotEntriesInputSchema, input);
                const query = new URLSearchParams();
                if (input.slot !== undefined) query.set("slot", input.slot);
                if (input.projectId !== undefined) query.set("projectId", input.projectId);
                if (input.workspaceId !== undefined) query.set("workspaceId", input.workspaceId);
                if (input.sessionId !== undefined) query.set("sessionId", input.sessionId);
                const suffix = query.size === 0 ? "" : `?${query.toString()}`;
                return (await request("GET", `/slots${suffix}`, listKissopenSlotEntriesResponseSchema))
                    .entries;
            },
            remove: async (id) => {
                Value.Assert(kissopenSlotEntryIdSchema, id);
                return (
                    await request(
                        "DELETE",
                        `/slots/${encodeURIComponent(id)}`,
                        kissopenSlotEntryResponseSchema,
                    )
                ).entry;
            },
            update: async (id, input) => {
                Value.Assert(kissopenSlotEntryIdSchema, id);
                Value.Assert(updateKissopenSlotEntryInputSchema, input);
                return (
                    await request(
                        "PATCH",
                        `/slots/${encodeURIComponent(id)}`,
                        kissopenSlotEntryResponseSchema,
                        input,
                    )
                ).entry;
            },
        },
        tracing: {
            subscribe: (handler) => subscribeKissopenTracing(handler, streamTransport),
        },
        status: {
            set: async (status) => {
                Value.Assert(kissopenPluginStatusSchema, status);
                await request("POST", "/status", emptyResponseSchema, { status });
            },
        },
        workspaces: {
            archive: async (input) => {
                Value.Assert(archiveWorkspaceInputSchema, input);
                return (
                    await request(
                        "POST",
                        `/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(input.workspaceId)}/archive`,
                        workspaceResponseSchema,
                        { version: input.version },
                    )
                ).workspace;
            },
            create: async (input) => {
                Value.Assert(createWorkspaceInputSchema, input);
                return (
                    await request(
                        "POST",
                        `/projects/${encodeURIComponent(input.projectId)}/workspaces`,
                        workspaceResponseSchema,
                        {
                            ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
                            ...(input.id === undefined ? {} : { id: input.id }),
                            name: input.name,
                        },
                    )
                ).workspace;
            },
            exec: async (input) => {
                Value.Assert(executeWorkspaceCommandInputSchema, input);
                const response = await request(
                    "POST",
                    `/workspaces/${encodeURIComponent(input.workspaceId)}/exec`,
                    executeWorkspaceCommandResponseSchema,
                    {
                        command: input.command,
                        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
                    },
                );
                return Value.Decode(executeWorkspaceCommandResultSchema, {
                    exitCode: response.exitCode,
                    stderr: Buffer.from(response.stderrBase64, "base64").toString("utf8"),
                    stderrTruncated: response.stderrTruncated,
                    stdout: Buffer.from(response.stdoutBase64, "base64").toString("utf8"),
                    stdoutTruncated: response.stdoutTruncated,
                    timedOut: response.timedOut,
                });
            },
            files: {
                read: async (input) => {
                    Value.Assert(readWorkspaceFileInputSchema, input);
                    const response = await request(
                        "POST",
                        `/workspaces/${encodeURIComponent(input.workspaceId)}/files/read`,
                        readWorkspaceFileResponseSchema,
                        { path: input.path },
                    );
                    return Value.Decode(readWorkspaceFileResultSchema, {
                        bytes: response.bytes,
                        content: Buffer.from(response.contentBase64, "base64").toString("utf8"),
                    });
                },
                write: async (input) => {
                    Value.Assert(writeWorkspaceFileInputSchema, input);
                    const contentBytes = Buffer.byteLength(input.content, "utf8");
                    if (contentBytes > KISSOPEN_PLUGIN_MAX_FILE_BYTES) {
                        throw new Error(
                            `Workspace file content cannot exceed ${String(KISSOPEN_PLUGIN_MAX_FILE_BYTES)} UTF-8 bytes.`,
                        );
                    }
                    return request(
                        "POST",
                        `/workspaces/${encodeURIComponent(input.workspaceId)}/files/write`,
                        writeWorkspaceFileResultSchema,
                        {
                            contentBase64: Buffer.from(input.content, "utf8").toString("base64"),
                            path: input.path,
                        },
                    );
                },
            },
            list: async (input = {}) => {
                Value.Assert(listWorkspacesInputSchema, input);
                const query =
                    input.projectId === undefined
                        ? ""
                        : `?projectId=${encodeURIComponent(input.projectId)}`;
                return (await request("GET", `/workspaces${query}`, listWorkspacesResponseSchema))
                    .workspaces;
            },
            rename: async (input) => {
                Value.Assert(renameWorkspaceInputSchema, input);
                return (
                    await request(
                        "PATCH",
                        `/projects/${encodeURIComponent(input.projectId)}/workspaces/${encodeURIComponent(input.workspaceId)}`,
                        workspaceResponseSchema,
                        { name: input.name, version: input.version },
                    )
                ).workspace;
            },
            subscribe: (handler) => subscribeKissopenWorkspaces(handler, streamTransport),
        },
    };
}

function requiredSetting(value: string | undefined, name: string): string {
    if (Value.Check(requiredSettingSchema, value)) return value;
    throw new Error(`KISSOPEN did not provide ${name} to this plugin.`);
}

function requestJson<TSchema_ extends TSchema>(options: {
    body?: unknown;
    method: "DELETE" | "GET" | "PATCH" | "POST";
    path: string;
    responseSchema: TSchema_;
    socketPath: string;
    token: string;
}): Promise<Static<TSchema_>> {
    return new Promise<Static<TSchema_>>((resolve, reject) => {
        const body = options.body === undefined ? undefined : JSON.stringify(options.body);
        const request = requestHttp(
            {
                // A plugin client has no Agent lifecycle to destroy, so never pool its sockets.
                agent: false,
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${options.token}`,
                    ...(body === undefined
                        ? {}
                        : {
                              "content-length": Buffer.byteLength(body).toString(),
                              "content-type": "application/json",
                          }),
                },
                method: options.method,
                path: options.path,
                socketPath: options.socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                let length = 0;
                response.on("data", (chunk: Buffer) => {
                    length += chunk.length;
                    if (length > MAX_RESPONSE_BYTES) {
                        request.destroy(
                            new Error("KISSOPEN returned more plugin data than the SDK can accept."),
                        );
                        return;
                    }
                    chunks.push(chunk);
                });
                response.once("end", () => {
                    try {
                        const text = Buffer.concat(chunks).toString("utf8");
                        const payload = text.length === 0 ? {} : (JSON.parse(text) as unknown);
                        const status = response.statusCode ?? 500;
                        if (status < 200 || status >= 300) {
                            if (Value.Check(kissopenComputeErrorSchema, payload)) {
                                reject(
                                    new KissopenPluginApiError(
                                        status,
                                        payload.message,
                                        payload.code,
                                        payload.retryable,
                                        payload.state,
                                        payload.code === "preparing_compute" ? payload : undefined,
                                    ),
                                );
                                return;
                            }
                            const message = Value.Check(errorResponseSchema, payload)
                                ? payload.error
                                : `KISSOPEN rejected the plugin request with HTTP ${String(status)}.`;
                            reject(
                                new KissopenPluginApiError(
                                    status,
                                    message,
                                    Value.Check(errorResponseSchema, payload)
                                        ? payload.code
                                        : undefined,
                                ),
                            );
                            return;
                        }
                        resolve(Value.Decode(options.responseSchema, payload));
                    } catch (error) {
                        reject(error);
                    }
                });
            },
        );
        request.once("error", reject);
        request.end(body);
    });
}
