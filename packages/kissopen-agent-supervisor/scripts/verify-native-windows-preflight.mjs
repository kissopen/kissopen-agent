import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("Native Windows verification requires Windows.");
const binary = fileURLToPath(
    new URL("../native/target/release/kissopen-agent-supervisor.exe", import.meta.url),
);
const root = await mkdtemp(join(tmpdir(), "kissopen-sandbox-preflight-"));
const missing = join(root, ".bash_history");
const sentinel = join(root, "command-ran.txt");

// These failures occur before provisioning or ACL changes, and never run a workload.
for (const mode of ["auto", "workspace_write"]) {
    const result = spawnSync(
        binary,
        [
            "--no-provision",
            "--cwd",
            root,
            "--policy",
            JSON.stringify({
                mode,
                deniedReadPaths: [missing],
                network: { egress: false, localBinding: false },
            }),
            "--",
            process.execPath,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
    );
    if (result.error) throw result.error;
    assert.equal(result.status, 125, result.stderr);
    assert.match(result.stderr, /^KISSOPEN Windows sandbox:/u);
    assert.match(result.stderr, /project subdirectory/u);
    assert.match(result.stderr, /Read only/u);
    assert.doesNotMatch(result.stderr, /Happy Windows sandbox/u);
    assert.equal(existsSync(missing), false, "A missing protected path must remain absent");
    assert.equal(
        existsSync(sentinel),
        false,
        "An unenforceable policy must not execute the command",
    );
}
console.log(
    "PASS KISSOPEN branding and actionable missing-sensitive-path denial; no workload, placeholders, or provisioning.",
);
await rmdir(root);
