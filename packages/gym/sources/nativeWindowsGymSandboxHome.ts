import { readFile } from "node:fs/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { join, win32 } from "node:path";
import sandboxSource from "../../kissopen-agent-supervisor/native/windows/source.json" with { type: "json" };

const markerSchema = Type.Object({
    version: Type.Integer({ minimum: 1 }),
    offline_username: Type.Literal("KissopenSandboxOffline"),
    online_username: Type.Literal("KissopenSandboxOnline"),
});
const usersSchema = Type.Object({ version: Type.Integer({ minimum: 1 }) });

/** Validate test-owned native state without launching helpers or triggering setup. */
export async function nativeWindowsGymSandboxHome(
    environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
    const home = environment.KISSOPEN_WINDOWS_SANDBOX_HOME?.trim();
    if (!home || !win32.isAbsolute(home)) {
        throw new Error(
            "Native Windows gyms require an absolute KISSOPEN_WINDOWS_SANDBOX_HOME pointing to an explicitly provisioned KISSOPEN sandbox.",
        );
    }
    const incomplete = () =>
        new Error(
            "The native Windows gym sandbox is incomplete or outdated. Complete KISSOPEN sandbox setup explicitly before running this gym; tests never provision it.",
        );
    try {
        const marker: unknown = JSON.parse(
            await readFile(join(home, ".sandbox", "setup_marker.json"), "utf8"),
        );
        const users: unknown = JSON.parse(
            await readFile(join(home, ".sandbox-secrets", "sandbox_users.json"), "utf8"),
        );
        if (
            !Value.Check(markerSchema, marker) ||
            !Value.Check(usersSchema, users) ||
            marker.version !== sandboxSource.setupVersion ||
            users.version !== sandboxSource.setupVersion
        ) {
            throw incomplete();
        }
    } catch {
        // Do not attach parse errors or state contents: account state contains credentials.
        throw incomplete();
    }
    return home;
}
