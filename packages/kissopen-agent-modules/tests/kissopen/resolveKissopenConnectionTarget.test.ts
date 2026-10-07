import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveKissopenConnectionTarget } from "../../sources/kissopen/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
});

describe("resolveKissopenConnectionTarget", () => {
    it("uses KISSOPEN CLI server settings before credentials exist", async () => {
        const root = await mkdtemp(join(tmpdir(), "kissopen-target-"));
        temporaryDirectories.push(root);
        const home = join(root, "home");
        const sourceHome = join(home, ".kissopen");
        const dataDirectory = join(home, ".kissopen-agent");
        await mkdir(sourceHome, { recursive: true });
        await writeFile(
            join(sourceHome, "settings.json"),
            JSON.stringify({ serverUrl: "https://kissopen.example/" }),
        );

        await expect(
            resolveKissopenConnectionTarget({ dataDirectory, environment: {}, homeDirectory: home }),
        ).resolves.toEqual({
            credentialsPath: join(dataDirectory, "kissopen", "access.key"),
            serverUrl: "https://kissopen.example",
            settingsPath: join(dataDirectory, "kissopen", "settings.json"),
        });
    });
});
