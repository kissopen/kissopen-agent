import { request as requestHttp } from "node:http";

import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { TypeGuard } from "@sinclair/typebox/type";
import { Value } from "@sinclair/typebox/value";

import type {
    KissopenMcpCallCompletion,
    KissopenMcpEvent,
    KissopenMcpServer,
    KissopenMcpServerStatus,
    KissopenMcpTool,
    StartKissopenMcpServerOptions,
} from "./types.js";
import {
    kissopenMcpEventSchema,
    kissopenMcpServerRegistrationSchema,
    kissopenMcpToolResultSchema,
    registerKissopenMcpServerResponseSchema,
} from "./types.js";

const MAXIMUM_EVENT_LINE_BYTES = 1024 * 1024;

export interface KissopenMcpTransport {
    request<TSchema_ extends TSchema>(
        method: "DELETE" | "GET" | "PATCH" | "POST",
        path: string,
        responseSchema: TSchema_,
        body?: unknown,
    ): Promise<Static<TSchema_>>;
    socketPath: string;
    token: string;
}

interface KissopenMcpEventStream {
    readonly closed: Promise<Error>;
    close(): void;
}

interface KissopenMcpGeneration {
    readonly registrationId: string;
    stream?: KissopenMcpEventStream;
}

export function defineMcpTool<const TInputSchema extends TSchema>(
    tool: KissopenMcpTool<TInputSchema>,
): KissopenMcpTool<TInputSchema> {
    if (!TypeGuard.IsSchema(tool.inputSchema) || tool.inputSchema.type !== "object") {
        throw new Error("A KISSOPEN MCP tool input schema must be a TypeBox object schema.");
    }
    Value.Assert(kissopenMcpServerRegistrationSchema.properties.tools.items, serializableTool(tool));
    return tool;
}

export async function startKissopenMcpServer(
    options: StartKissopenMcpServerOptions,
    transport: KissopenMcpTransport,
): Promise<KissopenMcpServer> {
    const tools = new Map<string, KissopenMcpTool>();
    for (const tool of options.tools) {
        defineMcpTool(tool);
        if (tools.has(tool.name)) {
            throw new Error(`The KISSOPEN MCP server has more than one tool named "${tool.name}".`);
        }
        tools.set(tool.name, tool);
    }
    const registration = {
        name: options.name,
        tools: options.tools.map(serializableTool),
        ...(options.version === undefined ? {} : { version: options.version }),
    };
    Value.Assert(kissopenMcpServerRegistrationSchema, registration);

    const calls = new Map<string, AbortController>();
    let closing = false;
    let closeTask: Promise<void> | undefined;
    let currentGeneration: KissopenMcpGeneration | undefined;
    let failure: string | undefined;
    let latestRegistrationId = "";
    let status: KissopenMcpServerStatus = "closed";

    const abortCalls = () => {
        for (const controller of calls.values()) controller.abort();
        calls.clear();
    };
    const unregister = (registrationId: string) =>
        transport
            .request(
                "DELETE",
                `/mcp/servers/${encodeURIComponent(registrationId)}`,
                emptyResponseSchema,
            )
            .catch(() => undefined);
    const unregisterUnattached = async (generation: KissopenMcpGeneration): Promise<void> => {
        if (currentGeneration !== generation || generation.stream !== undefined) return;
        currentGeneration = undefined;
        await unregister(generation.registrationId);
    };

    const registerAndOpen = async (): Promise<void> => {
        const response = await transport.request(
            "POST",
            "/mcp/servers",
            registerKissopenMcpServerResponseSchema,
            registration,
        );
        const registrationId = response.registrationId;
        const generation: KissopenMcpGeneration = { registrationId };
        currentGeneration = generation;
        latestRegistrationId = registrationId;
        if (closing) {
            await unregisterUnattached(generation);
            return;
        }
        let opened: KissopenMcpEventStream;
        try {
            opened = await openEventStream({
                onOpen(stream) {
                    generation.stream = stream;
                },
                onEvent(event) {
                    if (
                        closing ||
                        currentGeneration !== generation ||
                        generation.stream === undefined
                    ) {
                        return;
                    }
                    if (event.type === "cancel") {
                        calls.get(event.callId)?.abort();
                        return;
                    }
                    const controller = new AbortController();
                    calls.set(event.callId, controller);
                    void executeCall(event, tools, controller.signal)
                        .then((completion) => {
                            if (
                                closing ||
                                currentGeneration !== generation ||
                                generation.stream === undefined
                            ) {
                                return;
                            }
                            return transport.request(
                                "POST",
                                `/mcp/servers/${encodeURIComponent(registrationId)}/calls/${encodeURIComponent(event.callId)}`,
                                emptyResponseSchema,
                                completion,
                            );
                        })
                        .catch(() => undefined)
                        .finally(() => {
                            if (calls.get(event.callId) === controller) {
                                calls.delete(event.callId);
                            }
                        });
                },
                path: `/mcp/servers/${encodeURIComponent(registrationId)}/events`,
                socketPath: transport.socketPath,
                token: transport.token,
            });
        } catch (error) {
            await unregisterUnattached(generation);
            throw error;
        }
        if (closing) {
            if (currentGeneration === generation) currentGeneration = undefined;
            opened.close();
            return;
        }

        failure = undefined;
        status = "connected";
        void opened.closed.then((error) => {
            if (closing || currentGeneration !== generation || generation.stream !== opened) {
                return;
            }
            currentGeneration = undefined;
            abortCalls();
            failure = error.message;
            status = "closed";
        });
    };

    await registerAndOpen();

    return {
        get failure() {
            return failure;
        },
        name: options.name,
        get registrationId() {
            return latestRegistrationId;
        },
        get status() {
            return status;
        },
        close() {
            if (closeTask !== undefined) return closeTask;
            closing = true;
            status = "closed";
            const generation = currentGeneration;
            currentGeneration = undefined;
            const stream = generation?.stream;
            abortCalls();
            const task = (async () => {
                if (generation !== undefined) {
                    await unregister(generation.registrationId);
                }
                stream?.close();
                if (stream !== undefined) await stream.closed;
            })();
            closeTask = task;
            return task;
        },
    };
}

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

function serializableTool(tool: KissopenMcpTool) {
    const visibility = tool.visibility ?? ["model", "app"];
    return {
        _meta: { ui: { visibility } },
        description: tool.description,
        inputSchema: JSON.parse(JSON.stringify(tool.inputSchema)) as unknown,
        name: tool.name,
    };
}

async function executeCall(
    event: Extract<KissopenMcpEvent, { type: "call" }>,
    tools: ReadonlyMap<string, KissopenMcpTool>,
    signal: AbortSignal,
): Promise<KissopenMcpCallCompletion> {
    const tool = tools.get(event.tool);
    if (tool === undefined) return { error: `The plugin no longer provides tool "${event.tool}".` };
    try {
        const input = Value.Decode(tool.inputSchema, event.arguments);
        const result = await tool.execute(input, { signal });
        return { result: Value.Decode(kissopenMcpToolResultSchema, result) };
    } catch (error) {
        return { error: errorToMessage(error) };
    }
}

function openEventStream(options: {
    onOpen: (stream: KissopenMcpEventStream) => void;
    onEvent: (event: KissopenMcpEvent) => void;
    path: string;
    socketPath: string;
    token: string;
}): Promise<KissopenMcpEventStream> {
    return new Promise((resolve, reject) => {
        let opened = false;
        let settleClosed: (error: Error) => void = () => undefined;
        const request = requestHttp(
            {
                // Keep the stream independent from finite requests and daemon socket restarts.
                agent: false,
                headers: {
                    accept: "application/x-ndjson",
                    authorization: `Bearer ${options.token}`,
                },
                method: "GET",
                path: options.path,
                socketPath: options.socketPath,
            },
            (response) => {
                if ((response.statusCode ?? 500) !== 200) {
                    response.resume();
                    reject(
                        new Error(
                            `KISSOPEN could not open the MCP call stream (HTTP ${String(response.statusCode ?? 500)}).`,
                        ),
                    );
                    return;
                }
                opened = true;
                let pending = "";
                let settled = false;
                const closed = new Promise<Error>((resolveClosed) => {
                    settleClosed = (error) => {
                        if (settled) return;
                        settled = true;
                        resolveClosed(error);
                    };
                });
                const stream: KissopenMcpEventStream = {
                    closed,
                    close() {
                        request.destroy();
                    },
                };
                options.onOpen(stream);
                response.setEncoding("utf8");
                response.on("data", (chunk: string) => {
                    pending += chunk;
                    if (Buffer.byteLength(pending) > MAXIMUM_EVENT_LINE_BYTES) {
                        request.destroy(new Error("KISSOPEN sent an oversized MCP call event."));
                        return;
                    }
                    for (;;) {
                        const boundary = pending.indexOf("\n");
                        if (boundary < 0) break;
                        const line = pending.slice(0, boundary);
                        pending = pending.slice(boundary + 1);
                        if (line.length === 0) continue;
                        try {
                            options.onEvent(Value.Decode(kissopenMcpEventSchema, JSON.parse(line)));
                        } catch (error) {
                            request.destroy(
                                error instanceof Error ? error : new Error(String(error)),
                            );
                        }
                    }
                });
                response.once("aborted", () =>
                    settleClosed(new Error("The KISSOPEN MCP call stream was interrupted.")),
                );
                response.once("end", () =>
                    settleClosed(new Error("The KISSOPEN MCP call stream ended unexpectedly.")),
                );
                response.once("error", (error) => settleClosed(error));
                response.once("close", () =>
                    settleClosed(new Error("The KISSOPEN MCP call stream closed unexpectedly.")),
                );
                resolve(stream);
            },
        );
        request.once("error", (error) => {
            if (opened) settleClosed(error);
            else reject(error);
        });
        request.end();
    });
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
