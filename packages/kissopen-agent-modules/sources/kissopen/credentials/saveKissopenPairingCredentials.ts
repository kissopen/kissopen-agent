import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { StoredKissopenCredentials } from "../KissopenCredentials.js";
import type { KissopenConnectionTarget } from "./resolveKissopenConnectionTarget.js";
import { writeKissopenJsonFile } from "./writeKissopenJsonFile.js";

const kissopenSettingsSchema = Type.Record(Type.String(), Type.Unknown());

/** Persists the authorized credentials with the Kissopen server that issued them. */
export async function saveKissopenPairingCredentials(
    target: KissopenConnectionTarget,
    credentials: StoredKissopenCredentials,
): Promise<void> {
    const settings = await readSettings(target.settingsPath);
    await writeKissopenJsonFile(target.settingsPath, { ...settings, serverUrl: target.serverUrl });
    // A relay machine ID is globally unique and remains owned by the previous
    // account after unlinking, so a pairing for another account must not reuse
    // it, even on the same computer. The same account pairing again keeps it:
    // a new ID there made this computer a new machine every time, and the old
    // registration stayed on the account's list beside it with half the
    // conversations. Written before the credentials are published, so a
    // restarted daemon cannot register the new account with an old ID.
    const machinePath = join(dirname(target.credentialsPath), "machine.json");
    const account = kissopenCredentialsAccount(credentials);
    const kept = await readMachine(machinePath);
    const id = account !== undefined && kept?.account === account ? kept.id : randomUUID();
    await writeKissopenJsonFile(machinePath, account === undefined ? { id } : { id, account });
    await writeKissopenJsonFile(target.credentialsPath, credentials);
}

const storedMachineSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    account: Type.Optional(Type.String({ minLength: 1 })),
});

async function readMachine(path: string): Promise<Static<typeof storedMachineSchema> | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Value.Check(storedMachineSchema, parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

const tokenClaimsSchema = Type.Object({ sub: Type.String({ minLength: 1 }) });

/**
 * The account a pairing is for: the `sub` of the relay token it carries, which
 * names the account rather than the session. Undefined when the token does not
 * say, and then the pairing is treated as a new account.
 */
export function kissopenCredentialsAccount(
    credentials: StoredKissopenCredentials,
): string | undefined {
    const payload = credentials.token.split(".")[1];
    if (payload === undefined) return undefined;
    try {
        const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        return Value.Check(tokenClaimsSchema, claims) ? claims.sub : undefined;
    } catch {
        return undefined;
    }
}

async function readSettings(path: string): Promise<Record<string, unknown>> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return Value.Check(kissopenSettingsSchema, parsed) ? parsed : {};
    } catch {
        return {};
    }
}
