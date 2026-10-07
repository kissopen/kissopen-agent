import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { acquireKissopenAgentStorageLock } from "../../sources/runtime/KissopenAgentStorageLock.js";

const createdDirectories = new Set<string>();

afterEach(async () => {
    await Promise.all(
        [...createdDirectories].map(async (directory) => {
            await rm(directory, { force: true, recursive: true });
        }),
    );
    createdDirectories.clear();
});

describe("acquireKissopenAgentStorageLock", () => {
    it("enforces one live owner and permits the next owner after release", async () => {
        const directory = await createTestDirectory();
        const path = join(directory, "agent.lock");
        const first = await acquireKissopenAgentStorageLock(path);

        await expect(acquireKissopenAgentStorageLock(path)).rejects.toThrow(
            /already owned by process/u,
        );

        await first.release(createRootContext());
        const second = await acquireKissopenAgentStorageLock(path);
        await second.release(createRootContext());
    });
});

async function createTestDirectory(): Promise<string> {
    const scratch = resolve(import.meta.dirname, "../../../.context");
    await mkdir(scratch, { recursive: true });
    const directory = await mkdtemp(join(scratch, "kissopen-agent-lock-"));
    createdDirectories.add(directory);
    return directory;
}
