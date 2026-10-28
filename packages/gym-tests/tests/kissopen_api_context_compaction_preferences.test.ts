import { createAgentGym } from "@kissopen/kissopen-agent-gym";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
    "saves live compaction preferences, restores inheritance and retains them after restart",
    async () => {
        const gym = await createAgentGym();
        try {
            const initial = (await gym.client.getConfig()).config;
            expect(initial.contextCompaction).toEqual({ defaultPercent: null, modelPercents: {} });
            const modelId = Object.keys(initial.models).find(
                (id) => initial.models[id]!.contextWindow !== null,
            )!;
            const window = initial.models[modelId]!.contextWindow!;
            const automatic = initial.models[modelId]!.autoCompactWindow;
            const global = await gym.client.patchConfig({
                contextCompaction: { defaultPercent: 70 },
            });
            expect(global.config.models[modelId]!.autoCompactWindow).toBe(Math.floor(window * 0.7));
            const changed = await gym.client.patchConfig({
                contextCompaction: { modelPercents: { [modelId]: 80 } },
            });
            expect(changed.config.models[modelId]!.autoCompactWindow).toBe(
                Math.floor(window * 0.8),
            );
            await expect(
                gym.client.patchConfig({ contextCompaction: { modelPercents: { missing: 90 } } }),
            ).rejects.toMatchObject({ status: 400 });
            expect((await gym.client.getConfig()).config.contextCompaction).toEqual(
                changed.config.contextCompaction,
            );
            await expect(
                gym.client.patchConfig({
                    contextCompaction: { defaultPercent: 60 },
                    node: { name: "Should not change" },
                }),
            ).rejects.toMatchObject({ status: 400 });
            const unchanged = (await gym.client.getConfig()).config;
            expect(unchanged.contextCompaction).toEqual(changed.config.contextCompaction);
            expect(unchanged.node?.name).toBe(initial.node?.name);
            await expect(
                gym.client.patchConfig({ contextCompaction: { defaultPercent: 91 } }),
            ).rejects.toMatchObject({ status: 400 });
            await gym.restart();
            const restarted = (await gym.client.getConfig()).config;
            expect(restarted.contextCompaction).toEqual(changed.config.contextCompaction);
            expect(restarted.models[modelId]!.autoCompactWindow).toBe(Math.floor(window * 0.8));
            const inherited = await gym.client.patchConfig({
                contextCompaction: { modelPercents: { [modelId]: null } },
            });
            expect(inherited.config.models[modelId]!.autoCompactWindow).toBe(
                Math.floor(window * 0.7),
            );
            const reset = await gym.client.patchConfig({
                contextCompaction: { defaultPercent: null },
            });
            expect(reset.config.models[modelId]!.autoCompactWindow).toBe(automatic);
            expect(gym.errors).toEqual([]);
        } finally {
            await gym.dispose();
        }
    },
    30_000,
);
