import { assertGymRuntimeSupported } from "./assertGymRuntimeSupported.js";
import { startKissopenAgentDaemon, type KissopenAgentDaemon } from "../main.js";
import { syncKissopenAgentDocs } from "../documentation/syncKissopenAgentDocs.js";
import { removeDaemonPidSync } from "./daemonPid.js";
import { createGymInferenceFromEnvironment } from "./gymInference.js";
import { getDaemonIdentity } from "./getDaemonIdentity.js";
import { getKissopenDaemonPaths } from "./getKissopenDaemonPaths.js";
import { installDaemonDrainSignal } from "./installDaemonDrainSignal.js";

export interface RunAgentDaemonOptions {
    /** False only when a test embeds the daemon inside a process it must not kill. */
    readonly persistPid?: boolean;
    /** Hard-exit after graceful shutdown so unrelated dangling work cannot retain the process. */
    readonly hardExit?: boolean;
}

/**
 * Runs the daemon in the foreground of the current process: the complete Kissopen agent behind its
 * private Unix socket. The process stays alive while the socket serves and exits once the daemon
 * closes after a shutdown request or a termination signal.
 */
export async function runAgentDaemon(
    options: RunAgentDaemonOptions = {},
): Promise<KissopenAgentDaemon> {
    assertGymRuntimeSupported();
    const identity = getDaemonIdentity();
    const gymInference = createGymInferenceFromEnvironment();
    const paths = getKissopenDaemonPaths();
    await syncKissopenAgentDocs(paths.kissopenHome);
    const persistPid = options.persistPid ?? true;
    const hardExit = options.hardExit ?? persistPid;
    if (persistPid) {
        process.once("exit", () => removeDaemonPidSync(paths.pidPath, process.pid));
    }
    const daemon = await startKissopenAgentDaemon({
        kissopenHome: paths.kissopenHome,
        persistPid,
        version: identity.version,
        ...(gymInference === undefined ? {} : { inference: gymInference }),
    });
    const stop = (signal: "SIGINT" | "SIGTERM") => {
        const reason = signal === "SIGINT" ? "sigint" : "sigterm";
        void daemon.close(reason).catch((error: unknown) => {
            if (hardExit) return;
            process.stderr.write(
                `Daemon shutdown failed after ${signal}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
            );
            process.exitCode = 1;
        });
    };
    const onInterrupt = () => stop("SIGINT");
    const onTerminate = () => stop("SIGTERM");
    const removeStopSignals = () => {
        process.removeListener("SIGINT", onInterrupt);
        process.removeListener("SIGTERM", onTerminate);
    };
    // A published drain record must also mean a subsequent SIGTERM can shut down gracefully.
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    let disposeDrain: (() => Promise<void>) | undefined;
    try {
        if (persistPid) disposeDrain = await installDaemonDrainSignal(daemon, paths.directory);
    } catch (error) {
        removeStopSignals();
        await daemon.close();
        throw error;
    }
    const cleaned = daemon.closed.finally(async () => {
        try {
            await disposeDrain?.();
        } finally {
            removeStopSignals();
        }
    });
    if (hardExit) {
        void cleaned.then(
            () => process.exit(0),
            (error: unknown) => {
                process.stderr.write(
                    `Daemon shutdown failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
                );
                process.exit(1);
            },
        );
    } else {
        void cleaned.catch(() => undefined);
    }
    return daemon;
}
