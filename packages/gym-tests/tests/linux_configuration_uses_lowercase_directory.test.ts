import { expect, it } from "vitest";

import { createGym } from "@kissopen/kissopen-terminal-gym";

it("loads the fixed API token and initializes configuration in lowercase on Linux", async () => {
    const gym = await createGym({
        mode: "docker",
        homeFiles: {
            "kissopen/config/kissopen.toml": `[api]\ntoken = "${"t".repeat(43)}"\n`,
        },
        inference: [{ content: [{ text: "Linux configuration loaded.", type: "text" }] }],
    });
    try {
        gym.terminal.type("Confirm startup.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Linux configuration loaded.");
        const { stdout } = await gym.runInContainer("node", [
            "--input-type=module",
            "--eval",
            `import assert from "node:assert/strict";
             import { readFile, readdir } from "node:fs/promises";
             import { homedir } from "node:os";
             const home = homedir();
             assert.equal((await readFile(home + "/.kissopen/agent/token", "utf8")).trim(), "t".repeat(43));
             assert.deepEqual((await readdir(home + "/kissopen/config")).sort(), ["AGENTS.md", "SECURITY.md", "kissopen.toml", "mcp.toml"]);
             assert.equal((await readdir(home)).includes("KISSOPEN"), false);
             console.log("Lowercase configuration verified.");`,
        ]);
        expect(stdout).toBe("Lowercase configuration verified.\n");
    } finally {
        await gym.dispose();
    }
}, 60_000);
