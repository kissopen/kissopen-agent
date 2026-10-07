import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { loadOrCreateKissopenMachineId } from "../../sources/kissopen/credentials/loadOrCreateKissopenMachineId.js";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
});

it("keeps one persistent machine identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kissopen-machine-"));
    directories.push(directory);
    const path = join(directory, "kissopen", "machine.json");

    expect(await loadOrCreateKissopenMachineId(path, () => "machine-1")).toBe("machine-1");
    expect(await loadOrCreateKissopenMachineId(path, () => "machine-2")).toBe("machine-1");
});

it("returns the persisted winner when daemons create the identity concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kissopen-machine-race-"));
    directories.push(directory);
    const path = join(directory, "kissopen", "machine.json");

    const identities = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
            loadOrCreateKissopenMachineId(path, () => `machine-${String(index)}`),
        ),
    );

    expect(new Set(identities).size).toBe(1);
    expect(identities[0]).toMatch(/^machine-/u);
});
