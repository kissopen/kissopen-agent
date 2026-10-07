import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";
import { libsqlCommonJsScript } from "./libsqlScript.js";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("KISSOPEN configuration", () => {
    it("keeps synchronization disabled when the global config turns it off", async () => {
        const gym = await createGym({
            homeFiles: {
                ".kissopen/access.key": JSON.stringify({
                    secret: Buffer.alloc(32, 7).toString("base64"),
                    token: "kissopen-gym-token",
                }),
                "kissopen/config/kissopen.toml": "[settings]\nkissopen_integration = false\n",
            },
            inference: [
                {
                    content: [{ text: "Local-only session completed.", type: "text" }],
                },
            ],
        });
        running.add(gym);

        gym.terminal.type("Work without KISSOPEN synchronization.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("Local-only session completed.", 30_000);

        const inspection = await gym.runInContainer("node", [
            "-e",
            libsqlCommonJsScript(`
const fs = require("node:fs");
const database = await openDatabase("/home/kissopen-terminal/.kissopen/agent/agent.sqlite", true);
let sessions = 0;
try {
    sessions = (
        await database.execute("select count(*) as count from kissopen_agent_kissopen_sessions")
    ).rows[0].count;
} catch {
    // Synchronization that never started leaves no kissopen tables at all.
} finally {
    await database.close();
}
const copied = fs.existsSync("/home/kissopen-terminal/.kissopen/agent/kissopen/access.key");
process.stdout.write(JSON.stringify({ copied, sessions }));
`),
        ]);

        expect(JSON.parse(inspection.stdout)).toEqual({ copied: false, sessions: 0 });
    }, 120_000);
});
