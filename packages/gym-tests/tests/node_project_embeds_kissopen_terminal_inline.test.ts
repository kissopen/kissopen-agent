import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("embedding KISSOPEN Terminal in a Node.js project", () => {
    it("returns control to the host process after the inline terminal exits", async () => {
        const gym = await createGym({
            mode: "docker",
            entrypoint: ["node", "/workspace/embedded.mjs"],
            files: {
                "embedded.mjs": [
                    'import { runKissopenTerminal } from "/app/packages/kissopen-terminal/dist/index.js";',
                    'await runKissopenTerminal({ cwd: process.cwd(), modelId: "openai/gym", permissionMode: "full_access", providerId: "gym" });',
                    'process.stdout.write("\\nHOST PROCESS CONTINUED\\n");',
                ].join("\n"),
            },
            inference: [],
        });
        running.add(gym);

        expect((await gym.terminal.snapshot()).text).toContain(
            "Ask KISSOPEN Terminal to do anything",
        );

        gym.terminal.press("ctrlC");

        const finished = await gym.terminal.waitForText("HOST PROCESS CONTINUED", 30_000);
        expect(finished.text).toContain("HOST PROCESS CONTINUED");
    }, 60_000);
});
