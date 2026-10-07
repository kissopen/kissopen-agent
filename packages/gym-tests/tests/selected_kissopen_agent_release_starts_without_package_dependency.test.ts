import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("starting a selected KISSOPEN Agent release", () => {
    it("runs the installed binary without a KISSOPEN Agent package dependency", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: { KISSOPEN_TERMINAL_GYM_KISSOPEN_AGENT_COMMAND: "" },
            homeFiles: {
                ".kissopen/dist/config.json": `${JSON.stringify(
                    { downloadedVersions: ["1.2.3"], selectedVersion: "1.2.3" },
                    null,
                    2,
                )}\n`,
                ".kissopen/dist/version/1.2.3/kissopen-agent": {
                    content: [
                        "#!/usr/bin/env bash",
                        'printf "%s\\n" "$*" > /home/kissopen-terminal/.kissopen/dist/selected-binary-command',
                        'exec node /app/kissopen-agent/dist/cli.js "$@"',
                        "",
                    ].join("\n"),
                    mode: 0o755,
                },
            },
            inference: [],
            timeoutMs: 30_000,
        });
        running.add(gym);

        const invoked = await gym.runInContainer("cat", [
            "/home/kissopen-terminal/.kissopen/dist/selected-binary-command",
        ]);
        expect(invoked.stdout.trim()).toBe("start");
        const screen = await gym.terminal.snapshot();
        expect(screen.text).toContain("Ask KISSOPEN Terminal to do anything");
    }, 120_000);
});
