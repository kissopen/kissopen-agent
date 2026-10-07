import type { Context } from "@steve.kite/stdlib";

import { KissopenTerminalUserError } from "../KissopenTerminalUserError.js";
import {
    getKissopenDaemonPaths,
    observeLocalProtocolServer,
    runDaemonCommand,
    upgradeKissopenAgentBinary,
    type KissopenAgentBinary,
    type KissopenDaemonPaths,
    type UpgradeKissopenAgentBinaryOptions,
} from "../daemon/index.js";
import { selectedKissopenAgentBinary } from "../daemon/kissopenAgentBinaryConfig.js";

export interface RunUpgradeCommandOptions {
    ctx?: Context;
    log?: (line: string) => void;
    paths?: KissopenDaemonPaths;
    reloadDaemon?: (log: (line: string) => void, ctx: Context | undefined) => Promise<void>;
    runningVersion?: (paths: KissopenDaemonPaths) => Promise<string | undefined>;
    selectedBinary?: (paths: KissopenDaemonPaths) => Promise<KissopenAgentBinary | undefined>;
    upgradeBinary?: (options: UpgradeKissopenAgentBinaryOptions) => Promise<KissopenAgentBinary>;
}

export interface UpgradeKissopenAgentOptions {
    log?: (line: string) => void;
}

/** Public embedding boundary for the same upgrade performed by `kissopen-terminal upgrade`. */
export async function upgradeKissopenAgent(options: UpgradeKissopenAgentOptions = {}): Promise<void> {
    await runUpgradeCommand(options);
}

/** Downloads the latest managed Kissopen Agent release and reloads the daemon onto it. */
export async function runUpgradeCommand(options: RunUpgradeCommandOptions = {}): Promise<void> {
    const log = options.log ?? console.log;
    const paths = options.paths ?? getKissopenDaemonPaths();
    const selectBinary = options.selectedBinary ?? selectedKissopenAgentBinary;
    const installBinary = options.upgradeBinary ?? upgradeKissopenAgentBinary;
    const readRunningVersion =
        options.runningVersion ??
        (async (daemonPaths: KissopenDaemonPaths) =>
            (await observeLocalProtocolServer(daemonPaths))?.health.version.daemon);
    const reloadDaemon =
        options.reloadDaemon ??
        (async (report: (line: string) => void, ctx: Context | undefined) => {
            if (ctx === undefined) await runDaemonCommand("reload", report);
            else await runDaemonCommand("reload", report, ctx);
        });

    try {
        const [current, runningVersion] = await Promise.all([
            selectBinary(paths),
            readRunningVersion(paths),
        ]);
        const installed = await installBinary({ onStatus: log, paths });
        const selectionChanged = current?.version !== installed.version;
        const shouldReload =
            runningVersion === undefined ? selectionChanged : runningVersion !== installed.version;
        if (!shouldReload) {
            log(`KISSOPEN Agent ${installed.version} is already up to date.`);
            return;
        }

        log(
            runningVersion === undefined
                ? `Starting KISSOPEN Agent ${installed.version}.`
                : `Restarting with KISSOPEN Agent ${installed.version}.`,
        );
        await reloadDaemon(log, options.ctx);
    } catch (error) {
        if (error instanceof KissopenTerminalUserError) throw error;
        throw new KissopenTerminalUserError("KISSOPEN Agent could not be upgraded.", {
            cause: error,
            hint: error instanceof Error ? error.message : String(error),
        });
    }
}
