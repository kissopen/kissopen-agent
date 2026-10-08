import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertWindowsSandboxAccounts } from "../assertWindowsSandboxAccounts.mjs";

test("the actual Windows patch uses account names accepted by NetUserAdd", () => {
    const patch = readFileSync(
        new URL("../../native/windows/kissopen.patch", import.meta.url),
        "utf8",
    );
    assertWindowsSandboxAccounts(patch);
});

test("rejects the former 22-character offline account before compilation", () => {
    assert.throws(
        () =>
            assertWindowsSandboxAccounts(
                'pub const OFFLINE_USERNAME: &str = "KissopenSandboxOffline";\n' +
                    'pub const ONLINE_USERNAME: &str = "KissopenSandboxOnline";',
            ),
        /20 characters/u,
    );
});

test("accepts the 20-character boundary", () => {
    assertWindowsSandboxAccounts(
        'pub const OFFLINE_USERNAME: &str = "KissopenSandboxOffli";\n' +
            'pub const ONLINE_USERNAME: &str = "KissopenSandboxOnlin";',
    );
});
