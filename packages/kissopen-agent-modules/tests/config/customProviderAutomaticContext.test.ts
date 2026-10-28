import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import { CustomProviders } from "../../sources/config/impl/customProviders.js";
import { ContextWindowModule } from "../../sources/contextWindow/index.js";
import type { AgentModuleScope } from "@kissopen/kissopen-agent-base";

describe("automatic custom model context", () => {
    it("recognizes existing exact models without network discovery or display-name guesses", async () => {
        const root = await mkdtemp(join(tmpdir(), "custom-auto-context-"));
        try {
            const path = join(root, ".kissopen", "agent", "custom-providers.json");
            const saved = new CustomProviders(path);
            const id = await saved.save({
                mutationId: "save",
                baseUrl: "https://example.invalid/v1",
                apiKey: "fixture-key",
                models: [
                    { id: "deepseek-flash", name: "Flash" },
                    { id: "deepseek-v4-pro", name: "Pro" },
                    { id: "deepseek-flash-unlisted", name: "DeepSeek-V4.1-Flash" },
                ],
            });
            const config = await ConfigModule.load(join(root, ".kissopen"));
            expect(config.modelContext(id, `${id}/deepseek-flash`)).toEqual({
                contextWindow: 1_000_000,
                autoCompactWindow: 400_000,
            });
            expect(config.catalog.find((m) => m.id === `${id}/deepseek-v4-pro`)).toMatchObject({
                contextWindow: 1_000_000,
                autoCompactWindow: 400_000,
            });
            expect(config.modelContext(id, `${id}/deepseek-flash-unlisted`)).toEqual({
                contextWindow: 32_768,
                autoCompactWindow: 24_576,
            });
            expect(
                config.catalog.find((m) => m.id === `${id}/deepseek-flash-unlisted`)?.contextWindow,
            ).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("remembers discovered limits through existing client payloads and reloads without a request", async () => {
        const root = await mkdtemp(join(tmpdir(), "custom-discovered-context-"));
        let calls = 0;
        const server = createServer((_request, response) => {
            calls++;
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
                JSON.stringify({
                    data: [
                        {
                            id: "million-model",
                            context_window: 1_048_576,
                            max_output_tokens: 393_216,
                        },
                        {
                            id: "deepseek-flash",
                            context_window: 131_072,
                            max_output_tokens: 32_768,
                        },
                        { id: "invalid-window", context_window: -1 },
                        { id: "not-selected", context_window: 262_144 },
                        {
                            id: "constructor",
                            context_length: 262_144,
                            max_completion_tokens: 65_536,
                        },
                        { id: "__proto__", context_window: 8_000, max_output_tokens: 2_000 },
                    ],
                }),
            );
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test address");
        try {
            const home = join(root, ".kissopen");
            const config = await ConfigModule.load(home);
            const connection = {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "fixture-key",
            };
            const discovered = await config.discoverCustomProvider(connection);
            // Existing Desktop versions submit only selected IDs, labels and reasoning metadata.
            const models = discovered.models
                .filter((m) => m.id !== "not-selected")
                .map((m) => ({ id: m.id, name: m.name }));
            const ctx = createRootContext();
            await config.saveCustomProvider(ctx, { ...connection, mutationId: "save", models });
            const provider = config.providerIds.find((id) => id.startsWith("custom-"))!;
            const modelId = `${provider}/million-model`;
            expect(config.modelContext(provider, modelId)).toEqual({
                contextWindow: 1_048_576,
                autoCompactWindow: 655_360,
            });
            expect(config.modelContext(provider, `${provider}/deepseek-flash`)).toEqual({
                contextWindow: 131_072,
                autoCompactWindow: 98_304,
            });
            expect(config.modelContext(provider, `${provider}/invalid-window`)).toEqual({
                contextWindow: 32_768,
                autoCompactWindow: 24_576,
            });
            expect(config.modelContext(provider, `${provider}/not-selected`)).toBeUndefined();
            expect(config.modelContext(provider, `${provider}/constructor`)).toEqual({
                contextWindow: 262_144,
                autoCompactWindow: 196_608,
            });
            expect(config.modelContext(provider, `${provider}/__proto__`)).toEqual({
                contextWindow: 8_000,
                autoCompactWindow: 6_000,
            });
            const hooks = new ContextWindowModule(config).beforeStart();
            const scope = {
                agent: { id: "model-agent", provider, model: modelId },
            } as AgentModuleScope;
            expect(
                await hooks.prepareInference?.(ctx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: 655_359,
                }),
            ).toBeUndefined();
            expect(
                await hooks.prepareInference?.(ctx, scope, {
                    loopId: "loop",
                    turnId: "turn",
                    contextTokens: 655_360,
                }),
            ).toEqual([{ type: "compact" }]);
            const reloaded = await ConfigModule.load(home);
            expect(reloaded.modelContext(provider, modelId)).toEqual({
                contextWindow: 1_048_576,
                autoCompactWindow: 655_360,
            });
            expect(reloaded.catalog.find((m) => m.id === modelId)).toMatchObject({
                contextWindow: 1_048_576,
                autoCompactWindow: 655_360,
            });
            expect(calls).toBe(1);
            expect(JSON.stringify(reloaded.customProviderDetails(provider))).not.toContain(
                "fixture-key",
            );
            const persisted = JSON.parse(
                await readFile(join(home, "agent", "custom-providers.json"), "utf8"),
            );
            expect(Object.hasOwn(persisted[provider].contexts, "not-selected")).toBe(false);
            await mkdir(config.configuration.paths.configHome, { recursive: true });
            await writeFile(
                config.configuration.paths.globalConfigPath,
                `[custom_model_context.default]\ncontext_window = 262144\nauto_compact_window = 196608\n[custom_model_context.models."${provider}/million-model"]\ncontext_window = 524288\nauto_compact_window = 393216\n`,
            );
            const overridden = await ConfigModule.load(home);
            expect(overridden.modelContext(provider, modelId)).toEqual({
                contextWindow: 524_288,
                autoCompactWindow: 393_216,
            });
            expect(overridden.modelContext(provider, `${provider}/deepseek-flash`)).toEqual({
                contextWindow: 262_144,
                autoCompactWindow: 196_608,
            });
            await reloaded.updateCustomProvider(ctx, provider, {
                mutationId: "rotate",
                apiKey: "new-fixture-key",
            });
            expect(reloaded.modelContext(provider, modelId)).toEqual({
                contextWindow: 32_768,
                autoCompactWindow: 24_576,
            });
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve())),
            );
            await rm(root, { recursive: true, force: true });
        }
    });
});
