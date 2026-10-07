import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer, type Server } from "node:http";
import { AgentProviders } from "@kissopen/kissopen-agent-base";
import { KissopenAgentClient } from "@kissopen/kissopen-agent-client";
import { expect, it } from "vitest";
import { startKissopenAgentRuntime } from "../../sources/runtime/startKissopenAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { ConfigModule } from "../../sources/config/index.js";

it("runs the classified expert before the everyday model's first inference", async () => {
    const root = await mkdtemp(join(tmpdir(), "expert-routing-"));
    const bootstrap = await ConfigModule.load(root);
    const configPath = bootstrap.configuration.paths.globalConfigPath;
    bootstrap.closeProviders();
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, "[feature.codemode]\nenabled = false\n");
    const provider = new ScriptedProvider([
        [
            { type: "text_start" },
            { type: "text_delta", delta: "Plan ready.\nFiles: none\nOpen: none" },
            { type: "text_end" },
            { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
        ],
        [
            { type: "text_start" },
            { type: "text_delta", delta: "Here is the plan." },
            { type: "text_end" },
            { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
        ],
    ]);
    const providers = new AgentProviders();
    providers.add("kissopen", provider, "codex");
    let server: Server | undefined;
    let endpoint = "";
    const runtime = await startKissopenAgentRuntime({
        kissopenHome: root,
        onPrepared: async (prepared) => {
            server = createServer((request, response) => {
                void prepared.api.handleRequest(
                    prepared.context("routing-test.http"),
                    request,
                    response,
                );
            });
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("No test address");
            endpoint = `http://127.0.0.1:${address.port}`;
        },
        inference: {
            providers,
            models: [
                {
                    providerId: "kissopen",
                    id: "deepseek/deepseek-flash",
                    name: "Flash",
                    effortLevels: ["high"],
                    defaultEffort: "high",
                },
                {
                    providerId: "kissopen",
                    id: "openai/gpt-5.6-sol",
                    name: "Sol",
                    effortLevels: ["medium"],
                    defaultEffort: "medium",
                },
            ],
        },
    });
    try {
        const client = new KissopenAgentClient({ endpoint, token: runtime.api.token()! });
        const { project } = await client.registerProject({ path: root });
        const { agent: resource } = await client.createAgent({
            workspaceId: project.id,
            title: "Routing test",
        });
        const agent = await runtime.system.resolve(runtime.ctx, resource.id);
        const result = await client.sendMessage(agent.id, {
            id: "routingrequest",
            text: "制定产品发布计划",
            mode: {
                providerId: "kissopen",
                modelId: "openai/gpt-6-astra",
                effort: "high",
                serviceTier: "fast",
                permissionMode: "full_access",
            },
        });
        expect(result.message.mode).toMatchObject({
            modelId: "deepseek/deepseek-flash",
            serviceTier: null,
        });
        await agent.waitForIdle();
        expect(
            provider.sessions.some((s) => s.requests.some((r) => r.model === "openai/gpt-5.6-sol")),
        ).toBe(true);
        const rootRequests = provider.sessions
            .flatMap((s) => s.requests)
            .filter((r) =>
                r.context.messages.some(
                    (m) =>
                        m.role === "user" &&
                        m.content.some((b) => b.type === "text" && b.text === "制定产品发布计划"),
                ),
            );
        expect(rootRequests.length).toBeGreaterThan(0);
        expect(rootRequests[0]!.model).toBe("deepseek/deepseek-flash");
        expect(rootRequests[0]!.context.messages.some((m) => m.role === "tool")).toBe(true);
        // Idempotent retries preserve the original model even after changing the live default.
        runtime.modules.config.suggestDefault({
            providerId: "kissopen",
            modelId: "openai/gpt-5.6-sol",
            effort: "medium",
        });
        const retry = await client.sendMessage(agent.id, {
            id: "routingrequest",
            text: "ping",
            mode: {
                providerId: "kissopen",
                modelId: "retired",
                effort: "high",
                serviceTier: null,
                permissionMode: "full_access",
            },
        });
        expect(retry.message.mode?.modelId).toBe("deepseek/deepseek-flash");
        runtime.modules.config.suggestDefault({
            providerId: "kissopen",
            modelId: "deepseek/deepseek-flash",
            effort: "high",
        });
        const expertsBefore = provider.sessions
            .flatMap((s) => s.requests)
            .filter((r) => r.model === "openai/gpt-5.6-sol").length;
        const ping = await client.sendMessage(agent.id, {
            id: "routingping",
            text: "ping",
            mode: {
                providerId: "kissopen",
                modelId: "openai/gpt-6-astra",
                effort: "high",
                serviceTier: null,
                permissionMode: "full_access",
            },
        });
        expect(ping.message.mode?.modelId).toBe("deepseek/deepseek-flash");
        await agent.waitForIdle();
        expect(
            provider.sessions
                .flatMap((s) => s.requests)
                .filter((r) => r.model === "openai/gpt-5.6-sol"),
        ).toHaveLength(expertsBefore);
    } finally {
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await runtime.close();
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
