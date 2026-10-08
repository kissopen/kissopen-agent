import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";

const running = new Set<Gym>();
const agentVersion = JSON.parse(
    readFileSync(new URL("../../kissopen-agent/package.json", import.meta.url), "utf8"),
).version as string;
const EXPECTED_LOGO = [
    "██╗  ██╗ ██╗ ███████╗ ███████╗  ██████╗  ██████╗  ███████╗ ███╗   ██╗",
    "██║ ██╔╝ ██║ ██╔════╝ ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝ ████╗  ██║",
    "█████╔╝  ██║ ███████╗ ███████╗ ██║   ██║ ██████╔╝ █████╗   ██╔██╗ ██║",
    "██╔═██╗  ██║ ╚════██║ ╚════██║ ██║   ██║ ██╔═══╝  ██╔══╝   ██║╚██╗██║",
    "██║  ██╗ ██║ ███████║ ███████║ ╚██████╔╝ ██║      ███████╗ ██║ ╚████║",
    "╚═╝  ╚═╝ ╚═╝ ╚══════╝ ╚══════╝  ╚═════╝  ╚═╝      ╚══════╝ ╚═╝  ╚═══╝",
] as const;

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("terminal startup branding", () => {
    it("shows only the KISSOPEN logo with the host-supplied version", async () => {
        const gym = await createGym({
            mode: "docker",
            cols: 80,
            entrypoint: ["node", "/workspace/embedded.mjs"],
            files: {
                "embedded.mjs": [
                    'import { runKissopenTerminal } from "/app/packages/kissopen-terminal/dist/index.js";',
                    'await runKissopenTerminal({ cwd: process.cwd(), modelId: "openai/gym", permissionMode: "full_access", providerId: "gym", version: "1.2.3" });',
                ].join("\n"),
            },
            inference: [],
            rows: 32,
        });
        running.add(gym);

        const startup = await gym.terminal.snapshot();
        const logoCell = startup.cells.find((cell) => cell.text === "█");
        expect(logoCell?.foreground).toEqual({ kind: "rgb", red: 145, green: 132, blue: 217 });
        for (const line of EXPECTED_LOGO) expect(startup.text).toContain(line.trimEnd());
        const finalLogoRow = startup.rows.find((row) => row.includes(EXPECTED_LOGO[5].trimEnd()));
        expect(finalLogoRow?.trimEnd()).toMatch(/1\.2\.3$/u);
        expect(startup.text).not.toContain("TERMINAL");
        expect(startup.text).toContain(`Engine: ${agentVersion}`);
        expect(startup.text).not.toContain("GitHub:");
        expect(startup.text).not.toContain(">_ KISSOPEN Terminal 1.2.3");
        expect(startup.text).not.toContain("Agentic coding CLI");
        expect(startup.text).not.toContain("private local daemon");
        expect(startup.text).toContain("Ask KISSOPEN Terminal to do anything");
        expect(startup.scroll.atBottom).toBe(true);
    }, 60_000);
});
