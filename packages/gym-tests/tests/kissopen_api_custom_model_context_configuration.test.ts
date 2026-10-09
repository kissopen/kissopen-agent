import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, type AgentGym } from "@kissopen/kissopen-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

// AgentGym's JustBash workspaces require POSIX paths; this scenario runs in the Linux API lane.
it.skipIf(process.platform === "win32")(
    "advertises custom model budgets from machine files and reloads exact overrides",
    async () => {
        const gym = await createAgentGym({
            config: "[custom_model_context.default]\ncontext_window = 131072\nauto_compact_window = 98304\n",
        });
        running.add(gym);
        const saved = await gym.client.saveCustomProvider({
            mutationId: "context-fixture",
            name: "Context fixture",
            baseUrl: "https://context-test.invalid/v1",
            apiKey: "private-fixture-key",
            models: [
                { id: "deepseek-flash", name: "Flash" },
                { id: "deepseek-v4-pro", name: "Pro" },
            ],
        });
        const flash = Object.keys(saved.config.models).find((id) => id.endsWith("/deepseek-flash"));
        const pro = Object.keys(saved.config.models).find((id) => id.endsWith("/deepseek-v4-pro"));
        if (!flash || !pro) throw new Error("The saved custom model catalog is incomplete.");
        expect(saved.config.models[flash]?.contextWindow).toBe(131_072);
        expect(saved.config.models[flash]?.autoCompactWindow).toBe(98_304);
        expect(JSON.stringify(saved)).not.toContain("private-fixture-key");
        const configPath = join(
            gym.publicHomePath,
            process.platform === "darwin" ? "Config" : "config",
            "kissopen.toml",
        );
        await appendFile(
            configPath,
            `\n[custom_model_context.models."${flash}"]\ncontext_window = 262144\nauto_compact_window = 196608\n`,
        );
        await gym.restart();
        const reloaded = await gym.client.getConfig();
        expect(reloaded.config.models[flash]?.contextWindow).toBe(262_144);
        expect(reloaded.config.models[flash]?.autoCompactWindow).toBe(196_608);
        expect(reloaded.config.models[pro]?.contextWindow).toBe(131_072);
        expect(JSON.stringify(reloaded)).not.toContain("private-fixture-key");
        expect(gym.errors).toEqual([]);
    },
    30_000,
);
