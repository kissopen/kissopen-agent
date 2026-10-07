import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function kissopenConfig(extra: readonly string[] = []): Promise<ConfigModule> {
    const root = await mkdtemp(join(tmpdir(), "kissopen-served-catalog-"));
    temporaryDirectories.push(root);
    const folder = join(root, process.platform === "darwin" ? "KISSOPEN/Config" : "kissopen/config");
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "kissopen.toml"),
        [
            "[providers.kissopen]",
            'type = "codex"',
            "enabled = true",
            'api_key = "device-key"',
            'base_url = "https://api.example.test/api/agent/v1"',
            // Written when the device connected, before the console added any upstream.
            'include_models = ["openai/gpt-5.6-sol"]',
            ...extra,
        ].join("\n"),
    );
    return ConfigModule.load(join(root, ".kissopen"));
}

const served = [
    {
        id: "zen/glm-5",
        name: "GLM 5 · Zen",
        protocol: "chat" as const,
        context_window: 200_000,
        max_output_tokens: 32_768,
    },
];

describe("models the KISSOPEN server serves from console upstreams", () => {
    it("are offered on the server's word, with its window, and kept for the next start", async () => {
        const config = await kissopenConfig();
        let changes = 0;
        config.onKissopenServedModelsChange(() => {
            changes++;
        });
        await config.kissopenServedModelsUpdate(served);
        await config.kissopenServedModelsUpdate(served);
        expect(changes).toBe(1);

        const entry = config.catalog.find((model) => model.id === "zen/glm-5");
        expect(entry).toMatchObject({ providerId: "kissopen", enabled: true, contextWindow: 200_000 });
        expect(config.models.some((model) => model.id === "zen/glm-5")).toBe(true);
        expect(config.modelContext("kissopen", "zen/glm-5")?.contextWindow).toBe(200_000);

        const saved = join(
            dirname(config.configuration.paths.runtimeConfigPath),
            "kissopen-served-models.json",
        );
        expect(JSON.parse(await readFile(saved, "utf8"))).toEqual(served);
    });

    it("still leave when the configuration excludes one", async () => {
        const config = await kissopenConfig(['exclude_models = ["zen/glm-5"]']);
        await config.kissopenServedModelsUpdate(served);
        expect(config.catalog.find((model) => model.id === "zen/glm-5")?.enabled).toBe(false);
    });
});
