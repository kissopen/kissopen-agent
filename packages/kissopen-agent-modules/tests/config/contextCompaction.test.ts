import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import { CustomProviders } from "../../sources/config/impl/customProviders.js";
import { ContextWindowModule } from "../../sources/contextWindow/index.js";
import type { AgentModuleScope } from "@kissopen/kissopen-agent-base";

const roots: string[] = [];
const ctx = createRootContext().named("compaction-preferences-test");
afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "kissopen-compaction-"));
    roots.push(root);
    const home = join(root, ".kissopen");
    const initial = await ConfigModule.load(home);
    const providers = new CustomProviders(join(home, "agent", "custom-providers.json"));
    const provider = await providers.save({
        mutationId: "fixture",
        baseUrl: "https://compaction.invalid/v1",
        apiKey: "test-key",
        models: [
            { id: "deepseek-flash", name: "Flash" },
            { id: "unknown", name: "Unknown" },
        ],
    });
    const config = await ConfigModule.load(home);
    return {
        home,
        config,
        provider,
        model: `${provider}/deepseek-flash`,
        paths: initial.configuration.paths,
    };
}

it("uses model defaults, a global preference, and exact model overrides in that order", async () => {
    const { config, provider, model } = await fixture();
    expect(config.contextCompaction).toEqual({ defaultPercent: null, modelPercents: {} });
    expect(config.modelContext(provider, model)?.autoCompactWindow).toBe(400_000);
    await config.contextCompactionUpdate(ctx, { defaultPercent: 70 });
    expect(config.modelContext(provider, model)?.autoCompactWindow).toBe(700_000);
    const hooks = new ContextWindowModule(config).beforeStart();
    const scope = { agent: { id: "agent-1", provider, model } } as AgentModuleScope;
    const preparation = { loopId: "loop", turnId: "turn", contextTokens: 750_000 };
    expect(await hooks.prepareInference?.(ctx, scope, preparation)).toEqual([{ type: "compact" }]);
    await config.contextCompactionUpdate(ctx, { modelPercents: { [model]: 80 } });
    expect(config.catalog.find((entry) => entry.id === model)?.autoCompactWindow).toBe(800_000);
    expect(await hooks.prepareInference?.(ctx, scope, preparation)).toBeUndefined();
    await config.contextCompactionUpdate(ctx, { modelPercents: { [model]: null } });
    expect(config.modelContext(provider, model)?.autoCompactWindow).toBe(700_000);
    await config.contextCompactionUpdate(ctx, { defaultPercent: null });
    expect(config.modelContext(provider, model)?.autoCompactWindow).toBe(400_000);
});

it("merges concurrent model changes durably and restores them after restart", async () => {
    const { home, config, provider, model } = await fixture();
    const unknown = `${provider}/unknown`;
    await Promise.all([
        config.contextCompactionUpdate(ctx, { modelPercents: { [model]: 70 } }),
        config.contextCompactionUpdate(ctx, { modelPercents: { [unknown]: 80 } }),
    ]);
    const restarted = await ConfigModule.load(home);
    expect(restarted.contextCompaction.modelPercents).toEqual({ [model]: 70, [unknown]: 80 });
    expect(restarted.modelContext(provider, model)?.autoCompactWindow).toBe(700_000);
    expect(restarted.modelContext(provider, unknown)?.autoCompactWindow).toBe(
        Math.floor(32_768 * 0.8),
    );
    expect(restarted.catalog.find((entry) => entry.id === unknown)?.contextWindow).toBeNull();
    await restarted.contextCompactionUpdate(ctx, { modelPercents: { "removed/model": null } });
});

it("rejects invalid and unknown changes without changing saved preferences", async () => {
    const { config, model, paths } = await fixture();
    await config.contextCompactionUpdate(ctx, { modelPercents: { [model]: 70 } });
    const before = await readFile(paths.runtimeConfigPath, "utf8");
    await expect(config.contextCompactionUpdate(ctx, { defaultPercent: 91 })).rejects.toThrow();
    await expect(
        config.contextCompactionUpdate(ctx, { modelPercents: { "not-configured": 80 } }),
    ).rejects.toThrow();
    expect(await readFile(paths.runtimeConfigPath, "utf8")).toBe(before);
});

it("ignores project attempts to change machine compaction preferences", async () => {
    const { home, paths } = await fixture();
    const project = join(paths.configHome, "project");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "kissopen.toml"), "[context_compaction]\ndefault_percent = 90\n");
    vi.spyOn(process, "cwd").mockReturnValue(project);
    const config = await ConfigModule.load(home);
    expect(config.contextCompaction.defaultPercent).toBeNull();
});
