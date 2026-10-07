import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, copyFile, link, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    isExecutableFile,
    writeKissopenAgentBinaryConfig,
} from "../sources/daemon/kissopenAgentBinaryConfig.js";
import { acquireKissopenAgentInstallLock } from "../sources/daemon/ensureKissopenAgentBinary.js";
import {
    getKissopenDaemonPaths,
    kissopenAgentBinaryPath,
} from "../sources/daemon/getKissopenDaemonPaths.js";

const LOCAL_AGENT_VERSION = "0.0.0";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = dirname(dirname(packageRoot));
const target = `${process.platform}-${process.arch}`;
const sourcePath = join(
    workspaceRoot,
    "packages",
    "kissopen-agent",
    "dist",
    "bin",
    `kissopen-agent-${target}`,
);
if (!(await isExecutableFile(sourcePath))) {
    throw new Error(`The local KISSOPEN Agent binary is missing or not executable: ${sourcePath}`);
}

const paths = getKissopenDaemonPaths(process.env);
const versionDirectory = join(paths.versionsDirectory, LOCAL_AGENT_VERSION);
const targetPath = kissopenAgentBinaryPath(paths, LOCAL_AGENT_VERSION);
const temporaryPath = join(versionDirectory, `.kissopen-agent.${process.pid}.${randomUUID()}.tmp`);

await mkdir(paths.distDirectory, { mode: 0o700, recursive: true });
await chmod(paths.distDirectory, 0o700);
await mkdir(paths.versionsDirectory, { mode: 0o700, recursive: true });
await chmod(paths.versionsDirectory, 0o700);
await mkdir(versionDirectory, { mode: 0o700, recursive: true });
await chmod(versionDirectory, 0o700);
await rm(temporaryPath, { force: true });

const installLock = await acquireKissopenAgentInstallLock(paths.installLockPath, (message) =>
    console.log(message),
);
try {
    try {
        // A hard link avoids duplicating a roughly 400 MB local binary while
        // remaining a regular file to Kissopen Terminal and Kissopen Desktop. Their managed
        // binary checks intentionally reject symlinks.
        await link(sourcePath, temporaryPath);
    } catch (error) {
        if (!errorCodeIs(error, "EXDEV")) throw error;
        await copyFile(sourcePath, temporaryPath);
    }
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, targetPath);
    await writeKissopenAgentBinaryConfig(paths, LOCAL_AGENT_VERSION);
} finally {
    await rm(temporaryPath, { force: true });
    await installLock.release();
}

console.log(`Installed local KISSOPEN Agent ${LOCAL_AGENT_VERSION} at ${targetPath}`);
console.log(`KISSOPEN Agent socket: ${paths.socketPath}`);

if (process.argv.includes("--reload")) {
    await runBinary(targetPath, paths.kissopenHome);
    console.log(`Reloaded the daemon from ${targetPath}`);
}

function errorCodeIs(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

function runBinary(path: string, kissopenHome: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(
            path,
            ["reload"],
            { env: { ...process.env, KISSOPEN_HOME_DIR: kissopenHome } },
            (error) => {
                if (error === null) resolve();
                else reject(error);
            },
        );
    });
}
