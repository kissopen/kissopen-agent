import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigModule } from "../../sources/config/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

async function kissopenConfig(extra: readonly string[] = []): Promise<ConfigModule> {
    const root = await mkdtemp(join(tmpdir(), "kissopen-suggested-default-"));
    temporaryDirectories.push(root);
    const folder = join(
        root,
        process.platform === "darwin" ? "KISSOPEN/Config" : "kissopen/config",
    );
    await mkdir(folder, { recursive: true });
    await writeFile(
        join(folder, "kissopen.toml"),
        [
            ...extra,
            "[providers.kissopen]",
            'type = "codex"',
            "enabled = true",
            'api_key = "device-key"',
            'base_url = "https://api.example.test/api/agent/v1"',
            'include_models = ["openai/gpt-5.6-sol", "deepseek/deepseek-flash"]',
        ].join("\n"),
    );
    return ConfigModule.load(join(root, ".kissopen"));
}

describe("a default a service suggests", () => {
    it("is what a session starts on while no file names a default model", async () => {
        const config = await kissopenConfig();
        config.suggestDefault({
            providerId: "kissopen",
            modelId: "deepseek/deepseek-flash",
            effort: "high",
        });
        expect(config.models[0]).toMatchObject({
            providerId: "kissopen",
            id: "deepseek/deepseek-flash",
            defaultEffort: "high",
        });
        config.suggestDefault(undefined);
        expect(config.models[0]?.id).not.toBe("deepseek/deepseek-flash");
    });

    it("never overrides a default the person configured", async () => {
        const config = await kissopenConfig(["[defaults]", 'model = "openai/gpt-5.6-sol"', ""]);
        config.suggestDefault({ providerId: "kissopen", modelId: "deepseek/deepseek-flash" });
        expect(config.models[0]?.id).toBe("openai/gpt-5.6-sol");
    });

    it("changes nothing when no enabled provider serves it", async () => {
        const config = await kissopenConfig();
        const before = config.models.map((model) => model.id);
        config.suggestDefault({ providerId: "kissopen", modelId: "deepseek/not-served" });
        expect(config.models.map((model) => model.id)).toEqual(before);
    });
});
