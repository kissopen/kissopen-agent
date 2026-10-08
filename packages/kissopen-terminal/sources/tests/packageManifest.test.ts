import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("the published KISSOPEN Terminal package", () => {
    it("installs the canonical command", async () => {
        const manifest = JSON.parse(
            await readFile(new URL("../../package.json", import.meta.url), "utf8"),
        ) as { bin?: Record<string, string>; name?: string };

        expect(manifest.name).toBe("@kissopen/kissopen-terminal");
        expect(manifest.bin).toEqual({
            kissopen: "./dist/main.js",
        });
    });
});
