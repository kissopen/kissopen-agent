import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { saveKissopenPairingCredentials } from "../../sources/kissopen/credentials/saveKissopenPairingCredentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(async (directory) => await rm(directory, { force: true, recursive: true })),
    );
});

describe("saveKissopenPairingCredentials", () => {
    it("preserves settings, records the issuing server, and protects both files", async () => {
        const directory = await mkdtemp(join(tmpdir(), "kissopen-pairing-save-"));
        temporaryDirectories.push(directory);
        const settingsPath = join(directory, "settings.json");
        const credentialsPath = join(directory, "access.key");
        await mkdir(directory, { recursive: true });
        await writeFile(settingsPath, JSON.stringify({ machineId: "phone-machine" }));
        const machinePath = join(directory, "machine.json");
        await writeFile(machinePath, JSON.stringify({ id: "previous-account-machine" }));

        await saveKissopenPairingCredentials(
            {
                credentialsPath,
                serverUrl: "https://kissopen.example",
                settingsPath,
            },
            { secret: Buffer.alloc(32, 7).toString("base64"), token: "kissopen-token" },
        );

        await expect(readJson(settingsPath)).resolves.toEqual({
            machineId: "phone-machine",
            serverUrl: "https://kissopen.example",
        });
        await expect(readJson(credentialsPath)).resolves.toEqual({
            secret: Buffer.alloc(32, 7).toString("base64"),
            token: "kissopen-token",
        });
        const machine = (await readJson(machinePath)) as { id: string };
        expect(machine.id).not.toBe("previous-account-machine");
        expect(machine.id).toMatch(/^[a-f0-9-]{36}$/u);
        expect((await stat(machinePath)).mode & 0o777).toBe(0o600);
        expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
        expect((await stat(credentialsPath)).mode & 0o777).toBe(0o600);
    });
});

describe("pairing the same account again", () => {
    const token = (sub: string) =>
        `h.${Buffer.from(JSON.stringify({ sub, session: "s" })).toString("base64url")}.sig`;

    it("keeps this computer's machine id, and gives another account a new one", async () => {
        const directory = await mkdtemp(join(tmpdir(), "kissopen-pairing-again-"));
        temporaryDirectories.push(directory);
        const target = {
            credentialsPath: join(directory, "access.key"),
            serverUrl: "https://kissopen.example",
            settingsPath: join(directory, "settings.json"),
        };
        const machinePath = join(directory, "machine.json");
        const secret = Buffer.alloc(32, 7).toString("base64");

        await saveKissopenPairingCredentials(target, { secret, token: token("account-a") });
        const first = (await readJson(machinePath)) as { id: string; account: string };
        expect(first.account).toBe("account-a");

        await saveKissopenPairingCredentials(target, { secret, token: token("account-a") });
        expect(((await readJson(machinePath)) as { id: string }).id).toBe(first.id);

        await saveKissopenPairingCredentials(target, { secret, token: token("account-b") });
        const other = (await readJson(machinePath)) as { id: string; account: string };
        expect(other.id).not.toBe(first.id);
        expect(other.account).toBe("account-b");
    });

    it("gives a new id when the machine file does not say whose it is", async () => {
        const directory = await mkdtemp(join(tmpdir(), "kissopen-pairing-unknown-"));
        temporaryDirectories.push(directory);
        const machinePath = join(directory, "machine.json");
        await writeFile(machinePath, JSON.stringify({ id: "older-machine" }));
        await saveKissopenPairingCredentials(
            {
                credentialsPath: join(directory, "access.key"),
                serverUrl: "https://kissopen.example",
                settingsPath: join(directory, "settings.json"),
            },
            { secret: Buffer.alloc(32, 7).toString("base64"), token: token("account-a") },
        );
        expect(((await readJson(machinePath)) as { id: string }).id).not.toBe("older-machine");
    });
});

async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
}
