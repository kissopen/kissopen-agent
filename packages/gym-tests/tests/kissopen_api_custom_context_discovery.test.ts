import { createServer } from "node:http";
import { once } from "node:events";
import { createAgentGym, type AgentGym } from "@kissopen/kissopen-agent-gym";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
    "uses discovered context for existing-client saves, live usage and daemon reload",
    async () => {
        let discoveries = 0;
        const server = createServer(async (request, response) => {
            if (request.url === "/v1/models") {
                discoveries++;
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(
                    JSON.stringify({
                        data: [
                            {
                                id: "gateway-model",
                                context_window: 262_144,
                                max_output_tokens: 65_536,
                            },
                        ],
                    }),
                );
                return;
            }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const chunk = (content: string | null, finish_reason: string | null) =>
                JSON.stringify({
                    id: "context-fixture",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model,
                    choices: [
                        { index: 0, delta: content === null ? {} : { content }, finish_reason },
                    ],
                    ...(finish_reason === null
                        ? {}
                        : {
                              usage: {
                                  prompt_tokens: 60_000,
                                  completion_tokens: 5,
                                  total_tokens: 60_005,
                              },
                          }),
                });
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
                `data: ${chunk("Context is ready.", null)}\n\ndata: ${chunk(null, "stop")}\n\ndata: [DONE]\n\n`,
            );
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture address");
        let gym: AgentGym | undefined;
        try {
            gym = await createAgentGym();
            const connection = {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "context-fixture-key",
            };
            const discovered = await gym.client.discoverCustomProvider(connection);
            const saved = await gym.client.saveCustomProvider({
                ...connection,
                mutationId: "auto-context-save",
                models: discovered.models.map((model) => ({ id: model.id, name: model.name })),
            });
            const modelId = Object.keys(saved.config.models).find(
                (id) => id.startsWith("custom-") && id.endsWith("/gateway-model"),
            )!;
            const providerId = modelId.split("/")[0]!;
            expect(saved.config.models[modelId]).toMatchObject({
                contextWindow: 262_144,
                autoCompactWindow: 196_608,
            });
            expect(JSON.stringify(saved)).not.toContain("context-fixture-key");
            await gym.send("Check the active context.", {
                providerId,
                modelId,
                effort: "off",
                permissionMode: "full_access",
            });
            const usage = await gym.client.getAgentUsage(gym.defaultSessionId);
            expect(usage.context).toMatchObject({
                contextWindow: 262_144,
                contextTokens: 60_005,
                modelId,
                providerId,
            });
            await gym.restart();
            const restarted = await gym.client.getConfig();
            expect(restarted.config.models[modelId]).toMatchObject({
                contextWindow: 262_144,
                autoCompactWindow: 196_608,
            });
            expect(discoveries).toBe(1);
            expect(gym.errors).toEqual([]);
        } finally {
            await gym?.dispose();
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
        }
    },
    30_000,
);
