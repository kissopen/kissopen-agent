import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";

const running = new Set<Gym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("the shared Desktop and CLI Agent", () => {
    it("starts the Agent in the shared Desktop home when Desktop is not running", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["node", "/workspace/start-shared-agent.mjs"],
            files: {
                "package.json": '{"type":"module"}',
                "dist/index.js": readFileSync(
                    new URL("../../kissopen-terminal/dist/index.js", import.meta.url),
                    "utf8",
                ),
                "start-shared-agent.mjs": [
                    'import { access, symlink } from "node:fs/promises";',
                    'import { existsSync } from "node:fs";',
                    'import { join } from "node:path";',
                    "delete process.env.KISSOPEN_HOME_DIR;",
                    "delete process.env.XDG_CONFIG_HOME;",
                    'await symlink("/app/packages/kissopen-terminal/node_modules", "/workspace/node_modules");',
                    'const { runKissopenTerminal } = await import("./dist/index.js");',
                    'await runKissopenTerminal({ cwd: process.cwd(), modelId: "openai/gym", providerId: "gym", version: "1.2.3" });',
                    'await access(join(process.env.HOME, ".config/kissopen-oss/runtime/.kissopen/agent/token"));',
                    'if (existsSync(join(process.env.HOME, ".kissopen/agent/token"))) throw new Error("A second independent Agent was created");',
                    'process.stdout.write("\\nSHARED AGENT READY\\n");',
                ].join("\n"),
            },
            inference: [],
            timeoutMs: 40_000,
        });
        running.add(gym);
        gym.terminal.press("ctrlC");
        expect((await gym.terminal.waitForText("SHARED AGENT READY")).text).toContain(
            "SHARED AGENT READY",
        );
    }, 60_000);

    it("lists Desktop custom models without a home environment override", async () => {
        const gym = await createGym({
            mode: "docker",
            rows: 40,
            entrypoint: ["node", "/workspace/shared-agent.mjs"],
            files: {
                "package.json": '{"type":"module"}',
                // Exercise the current built client against the real, isolated daemon runtime.
                "dist/index.js": readFileSync(
                    new URL("../../kissopen-terminal/dist/index.js", import.meta.url),
                    "utf8",
                ),
                "shared-agent.mjs": [
                    'import { execFileSync } from "node:child_process";',
                    'import { readFile, symlink } from "node:fs/promises";',
                    'import { createRequire } from "node:module";',
                    'import { join } from "node:path";',
                    'import { createUnixSocketFetch } from "/app/kissopen-agent/dist/index.js";',
                    'const require = createRequire("/app/kissopen-agent/package.json");',
                    'const { KissopenAgentClient } = await import(require.resolve("@kissopen/kissopen-agent-client"));',
                    "delete process.env.XDG_CONFIG_HOME;",
                    'const desktopHome = join(process.env.HOME, ".config/kissopen-oss/runtime/.kissopen");',
                    'execFileSync(process.execPath, ["/app/kissopen-agent/dist/cli.js", "start"], { env: { ...process.env, KISSOPEN_HOME_DIR: desktopHome } });',
                    'const client = new KissopenAgentClient({ endpoint: "http://kissopen", token: (await readFile(join(desktopHome, "agent/token"), "utf8")).trim(), fetch: createUnixSocketFetch(join(desktopHome, "agent/server.sock")) });',
                    'await client.saveCustomProvider({ mutationId: "gym-desktop-provider", name: "ShareCC", baseUrl: "http://127.0.0.1:9/v1", apiKey: "unused-fixture-key", models: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" }, { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro" }] });',
                    "delete process.env.KISSOPEN_HOME_DIR;",
                    'await symlink("/app/packages/kissopen-terminal/node_modules", "/workspace/node_modules");',
                    'const { runKissopenTerminal } = await import("./dist/index.js");',
                    'await runKissopenTerminal({ cwd: process.cwd(), modelId: "openai/gym", providerId: "gym", version: "1.2.3" });',
                ].join("\n"),
            },
            inference: [],
            timeoutMs: 40_000,
        });
        running.add(gym);
        gym.terminal.type("/model");
        gym.terminal.press("enter");
        const models = await gym.terminal.waitForText("DeepSeek-V4.1-Flash");
        expect(models.text).toContain("DeepSeek-V4-Pro");
    }, 60_000);
});
