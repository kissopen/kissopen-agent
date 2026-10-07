import { localAgentSocketPath } from "@kissopen/kissopen-agent-compute";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Filesystem locations of the local Kissopen agent daemon. */
export interface KissopenDaemonPaths {
    /** The daemon's private state directory, `<kissopenHome>/agent`. */
    readonly directory: string;
    /** KISSOPEN's private root, usually `~/.kissopen`. */
    readonly kissopenHome: string;
    /** Where the launcher captures the spawned daemon's stdout and stderr. */
    readonly logPath: string;
    /** Structured runtime and shutdown-step records. */
    readonly observationLogPath: string;
    /** The exact daemon process ID, persisted for status and forced termination. */
    readonly pidPath: string;
    readonly socketPath: string;
    readonly tokenPath: string;
}

export function getKissopenDaemonPaths(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): KissopenDaemonPaths {
    const kissopenHome = resolveKissopenHome(environment, homeDirectory);
    const directory = join(kissopenHome, "agent");
    return {
        directory,
        kissopenHome,
        logPath: join(directory, "daemon.log"),
        observationLogPath: join(directory, "observation", "agent.log"),
        pidPath: join(directory, "daemon.pid"),
        socketPath: localAgentSocketPath(directory),
        tokenPath: join(directory, "token"),
    };
}

function resolveKissopenHome(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
    const configured = environment.KISSOPEN_HOME_DIR?.trim();
    if (configured === undefined || configured.length === 0) {
        return join(homeDirectory, ".kissopen");
    }
    const expanded = configured.startsWith("~")
        ? join(homeDirectory, configured.slice(1))
        : configured;
    return isAbsolute(expanded) ? expanded : join(homeDirectory, expanded);
}
