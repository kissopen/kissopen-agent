import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, win32 } from "node:path";
import { getKissopenHome } from "./getKissopenHome.js";

/** Filesystem locations shared by Kissopen Terminal and the Kissopen Agent daemon. */
export interface KissopenDaemonPaths {
    readonly agentDirectory: string;
    readonly binaryConfigPath: string;
    readonly distDirectory: string;
    readonly kissopenHome: string;
    readonly installLockPath: string;
    readonly logPath: string;
    readonly observationLogPath: string;
    readonly pidPath: string;
    readonly socketPath: string;
    readonly tokenPath: string;
    readonly updateCachePath: string;
    readonly versionsDirectory: string;
}

export function getKissopenDaemonPaths(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): KissopenDaemonPaths {
    const kissopenHome = getKissopenHome(environment, homeDirectory);
    const agentDirectory = join(kissopenHome, "agent");
    const distDirectory = join(kissopenHome, "dist");
    return {
        agentDirectory,
        binaryConfigPath: join(distDirectory, "config.json"),
        distDirectory,
        kissopenHome,
        installLockPath: join(distDirectory, "install.lock"),
        logPath: join(agentDirectory, "daemon.log"),
        observationLogPath: join(agentDirectory, "observation", "agent.log"),
        pidPath: join(agentDirectory, "daemon.pid"),
        socketPath: localAgentSocketPath(agentDirectory),
        tokenPath: join(agentDirectory, "token"),
        updateCachePath: join(distDirectory, "latest.json"),
        versionsDirectory: join(distDirectory, "version"),
    };
}

export function kissopenAgentBinaryPath(paths: KissopenDaemonPaths, version: string): string {
    return join(
        paths.versionsDirectory,
        version,
        process.platform === "win32" ? "kissopen-agent.exe" : "kissopen-agent",
    );
}

/** Matches the daemon endpoint without coupling the terminal client to its runtime. */
function localAgentSocketPath(agentDirectory: string): string {
    if (process.platform !== "win32") return join(agentDirectory, "server.sock");
    const identity = createHash("sha256")
        .update(win32.resolve(agentDirectory).toLowerCase())
        .digest("hex");
    return `\\\\.\\pipe\\kissopen-agent-${identity}`;
}
