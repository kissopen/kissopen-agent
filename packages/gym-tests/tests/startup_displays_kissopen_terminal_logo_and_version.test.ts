import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";

const running = new Set<Gym>();
const kissopenTerminalSourceUrl = pathToFileURL(
    fileURLToPath(new URL("../../kissopen-terminal/sources/index.ts", import.meta.url)),
).href;
const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const EXPECTED_LOGO = [
    "██╗  ██╗ █████╗ ██████╗ ██████╗ ██╗   ██╗",
    "██║  ██║██╔══██╗██╔══██╗██╔══██╗╚██╗ ██╔╝",
    "███████║███████║██████╔╝██████╔╝ ╚████╔╝ ",
    "██╔══██║██╔══██║██╔═══╝ ██╔═══╝   ╚██╔╝  ",
    "██║  ██║██║  ██║██║     ██║        ██║   ",
    "╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝        ╚═╝   ",
] as const;

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal startup branding", () => {
    it("shows only the KISSOPEN logo with the host-supplied version", async () => {
        const gym = await createGym({
            cols: 100,
            entrypoint: [process.execPath, "--import", tsxUrl, "embedded.mts"],
            files: {
                "embedded.mts": [
                    `import { runKissopenTerminal } from ${JSON.stringify(kissopenTerminalSourceUrl)};`,
                    'await runKissopenTerminal({ cwd: process.cwd(), modelId: "openai/gym", permissionMode: "full_access", providerId: "gym", version: "1.2.3" });',
                ].join("\n"),
            },
            inference: [],
            rows: 32,
        });
        running.add(gym);

        const startup = await gym.terminal.snapshot();
        for (const line of EXPECTED_LOGO) expect(startup.text).toContain(line.trimEnd());
        const finalLogoRow = startup.rows.find((row) => row.includes(EXPECTED_LOGO[5].trimEnd()));
        expect(finalLogoRow?.trimEnd()).toMatch(/1\.2\.3$/u);
        expect(startup.text).not.toContain("TERMINAL");
        expect(startup.text).toContain("Engine: 0.0.0");
        expect(startup.text).not.toContain("GitHub:");
        expect(startup.text).not.toContain(">_ KISSOPEN Terminal 1.2.3");
        expect(startup.text).not.toContain("Agentic coding CLI");
        expect(startup.text).not.toContain("private local daemon");
        expect(startup.text).toContain("Ask KISSOPEN Terminal to do anything");
        expect(startup.scroll.atBottom).toBe(true);
    }, 60_000);
});
