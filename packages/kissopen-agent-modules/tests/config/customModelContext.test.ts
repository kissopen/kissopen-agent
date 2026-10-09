import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModuleScope } from "@kissopen/kissopen-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigModule, parseKissopenAgentConfigToml } from "../../sources/config/index.js";
import { CustomProviders } from "../../sources/config/impl/customProviders.js";
import { ContextWindowModule } from "../../sources/contextWindow/index.js";

const roots: string[] = [];
const ctx = createRootContext().named("custom-model-context-test");

afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "kissopen-custom-context-"));
    roots.push(root);
    const home = join(root, ".kissopen");
    const baseline = await ConfigModule.load(home);
    const providers = new CustomProviders(join(home, "agent", "custom-providers.json"));
    const providerId = await providers.save({
        mutationId: "fixture",
        baseUrl: "https://context-test.invalid/v1",
        apiKey: "test-only-key",
        models: [
            { id: "deepseek-flash", name: "Flash" },
            { id: "deepseek-v4-pro", name: "Pro" },
        ],
    });
    await mkdir(baseline.configuration.paths.configHome, { recursive: true });
    return { home, providerId, paths: baseline.configuration.paths };
}

describe("file-configured custom model context", () => {
    it("keeps the conservative local budget when no limit is declared", async () => {
        const { home, providerId } = await fixture();
        const config = await ConfigModule.load(home);
        expect(config.modelContext(providerId, `${providerId}/deepseek-flash`)).toEqual({
            contextWindow: 32_768,
            autoCompactWindow: 24_576,
        });
        expect(
            config.catalog.find((model) => model.id === `${providerId}/deepseek-flash`)
                ?.contextWindow,
        ).toBeNull();
    });

    it("uses the configured default in both the catalog and inference compaction", async () => {
        const { home, providerId, paths } = await fixture();
        await writeFile(
            paths.globalConfigPath,
            "[custom_model_context.default]\ncontext_window = 131072\nauto_compact_window = 98304\n",
        );
        const config = await ConfigModule.load(home);
        const modelId = `${providerId}/deepseek-flash`;
        expect(config.modelContext(providerId, modelId)).toEqual({
            contextWindow: 131_072,
            autoCompactWindow: 98_304,
        });
        expect(config.catalog.find((model) => model.id === modelId)).toMatchObject({
            contextWindow: 131_072,
            autoCompactWindow: 98_304,
        });
        const hooks = new ContextWindowModule(config).beforeStart();
        const scope = {
            agent: { id: "agent-1", provider: providerId, model: modelId },
        } as AgentModuleScope;
        const preparation = { loopId: "loop-1", turnId: "turn-1" };
        expect(
            await hooks.prepareInference?.(ctx, scope, { ...preparation, contextTokens: 98_303 }),
        ).toBeUndefined();
        expect(
            await hooks.prepareInference?.(ctx, scope, { ...preparation, contextTokens: 98_304 }),
        ).toEqual([{ type: "compact" }]);
        expect(config.modelContext(providerId, `${providerId}/not-selected`)).toBeUndefined();
    });

    it("overrides one exact model without changing other models or built-in limits", async () => {
        const { home, providerId, paths } = await fixture();
        await writeFile(
            paths.globalConfigPath,
            `[custom_model_context.models."${providerId}/deepseek-flash"]\ncontext_window = 131072\nauto_compact_window = 98304\n[providers.codex]\nenabled = true\n`,
        );
        const config = await ConfigModule.load(home);
        expect(config.modelContext(providerId, `${providerId}/deepseek-flash`)?.contextWindow).toBe(
            131_072,
        );
        expect(
            config.modelContext(providerId, `${providerId}/deepseek-v4-pro`)?.contextWindow,
        ).toBe(32_768);
        expect(
            config.catalog.find((model) => model.id === `${providerId}/deepseek-v4-pro`)
                ?.contextWindow,
        ).toBeNull();
        expect(config.modelContext("codex", "openai/gpt-5.6-sol")?.contextWindow).toBe(272_000);
    });

    it("merges machine layers, ignores project limits and keeps overrides across reload", async () => {
        const { home, providerId, paths } = await fixture();
        await writeFile(
            paths.globalConfigPath,
            `[custom_model_context.default]\ncontext_window = 65536\nauto_compact_window = 49152\n[custom_model_context.models."${providerId}/deepseek-flash"]\ncontext_window = 131072\nauto_compact_window = 98304\n`,
        );
        const projectConfig =
            "[custom_model_context.default]\ncontext_window = 1000000\nauto_compact_window = 800000\n";
        const global = parseKissopenAgentConfigToml(await readFile(paths.globalConfigPath, "utf8"));
        expect(global.unknownSettings).not.toContain("custom_model_context");
        await writeFile(
            paths.runtimeConfigPath,
            "[custom_model_context.default]\ncontext_window = 262144\nauto_compact_window = 196608\n",
        );
        const config = await ConfigModule.load(home);
        expect(config.modelContext(providerId, `${providerId}/deepseek-flash`)?.contextWindow).toBe(
            131_072,
        );
        expect(
            config.modelContext(providerId, `${providerId}/deepseek-v4-pro`)?.contextWindow,
        ).toBe(262_144);
        const project = join(paths.publicHome, "kissopen.toml");
        await mkdir(paths.publicHome, { recursive: true });
        await writeFile(project, projectConfig);
        vi.spyOn(process, "cwd").mockReturnValue(paths.publicHome);
        const reloaded = await ConfigModule.load(home);
        expect(reloaded.configuration.sources.local.exists).toBe(true);
        expect(
            reloaded.modelContext(providerId, `${providerId}/deepseek-v4-pro`)?.contextWindow,
        ).toBe(262_144);
        expect(
            reloaded.modelContext(providerId, `${providerId}/deepseek-flash`)?.contextWindow,
        ).toBe(131_072);
    });

    it.each([
        [0, 1],
        [7999, 5000],
        [10_000_001, 24576],
        [32768, 0],
        [32768, 32768],
        [32768, 40000],
        [32768.5, 24576],
        [32768, 24576.5],
    ])("rejects an invalid budget/threshold pair: %s/%s", (window, threshold) => {
        expect(() =>
            parseKissopenAgentConfigToml(
                `[custom_model_context.default]\ncontext_window = ${window}\nauto_compact_window = ${threshold}\n`,
            ),
        ).toThrow();
    });

    it("rejects incomplete overrides and unqualified model names", () => {
        expect(() =>
            parseKissopenAgentConfigToml(
                "[custom_model_context.default]\ncontext_window = 131072\n",
            ),
        ).toThrow();
        expect(() =>
            parseKissopenAgentConfigToml(
                '[custom_model_context.models."deepseek-flash"]\ncontext_window = 131072\nauto_compact_window = 98304\n',
            ),
        ).toThrow();
    });
});
