import { createServer } from "node:http";
import { once } from "node:events";
import { createAgentGym, type AgentGym } from "@kissopen/kissopen-agent-gym";
import { expect, it } from "vitest";

// The API gym's emulated filesystem uses POSIX paths.
it.skipIf(process.platform === "win32")(
    "finishes Auto work on a custom provider saved after daemon startup",
    async () => {
        const requestedModels: string[] = [];
        let reviews = 0;
        let mainRequests = 0;
        const server = createServer(async (request, response) => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requestedModels.push(body.model);
            const lastMessage = body.messages.at(-1);
            const isReview = JSON.stringify(lastMessage).includes("<proposed_action>");
            let delta: unknown;
            let finishReason = "stop";
            if (isReview) {
                reviews += 1;
                delta = {
                    content:
                        "<review><risk_level>low</risk_level><user_authorization>high</user_authorization><outcome>allow</outcome><rationale>Write only the requested fixture files.</rationale></review>",
                };
            } else if (!body.tools?.length) {
                // Background title/metadata inference is separate from the task being tested.
                delta = { content: "Review fixture" };
            } else if (mainRequests++ === 0) {
                const commandTool = body.tools.find(
                    (tool: { function: { name: string } }) =>
                        tool.function.name === "exec_command" ||
                        tool.function.name.endsWith("__exec_command"),
                );
                if (!commandTool) {
                    response.writeHead(400).end("No command tool was offered.");
                    return;
                }
                finishReason = "tool_calls";
                delta = {
                    tool_calls: Array.from({ length: 4 }, (_, index) => ({
                        index,
                        id: `fixture-call-${index}`,
                        type: "function",
                        function: {
                            name: commandTool.function.name,
                            arguments: JSON.stringify({
                                cmd: `printf verified > reviewed-${index}.txt`,
                                sandbox_permissions: "require_escalated",
                                justification: "Exercise the requested fixture review.",
                            }),
                        },
                    })),
                };
            } else delta = { content: "All four reviewed writes completed." };
            const chunk = (delta: unknown, finish_reason: string | null) =>
                JSON.stringify({
                    id: "fixture-completion",
                    object: "chat.completion.chunk",
                    created: 1,
                    model: body.model,
                    choices: [{ index: 0, delta, finish_reason }],
                });
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
                `data: ${chunk(delta, null)}\n\ndata: ${chunk({}, finishReason)}\n\ndata: [DONE]\n\n`,
            );
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture address");
        let gym: AgentGym | undefined;
        try {
            gym = await createAgentGym({ permissionMode: "auto" });
            const saved = await gym.client.saveCustomProvider({
                mutationId: "live-custom-review",
                name: "Review fixture",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "fixture-key",
                models: [{ id: "deepseek-flash", name: "Flash" }],
            });
            const modelId = Object.keys(saved.config.models).find(
                (id) => id.startsWith("custom-") && id.endsWith("/deepseek-flash"),
            );
            if (!modelId) throw new Error("Missing custom model");
            const result = await gym.send(
                "Write reviewed-0.txt through reviewed-3.txt with verified.",
                {
                    modelId,
                    providerId: modelId.split("/")[0]!,
                    effort: saved.config.models[modelId]!.defaultEffort,
                    permissionMode: "auto",
                },
            );
            const history = await gym.client.getMessages(gym.defaultSessionId);
            expect(history.runs.find((run) => run.id === result.runId)).toMatchObject({
                status: "completed",
                reason: "completed",
            });
            for (let index = 0; index < 4; index++)
                expect(await gym.readFile(`reviewed-${index}.txt`)).toBe("verified");
            expect(reviews).toBe(4);
            expect(new Set(requestedModels)).toEqual(new Set(["deepseek-flash"]));
            expect(mainRequests).toBe(2);
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
