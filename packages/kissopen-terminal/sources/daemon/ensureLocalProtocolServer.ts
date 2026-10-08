import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    KissopenAgentClient,
    KISSOPEN_AGENT_MIN_PROTOCOL_VERSION,
    type HealthResponse,
} from "@kissopen/kissopen-agent-client";

import { KissopenTerminalUserError } from "../KissopenTerminalUserError.js";
import { createUnixSocketFetch } from "./createUnixSocketFetch.js";
import {
    ensureKissopenAgentBinary,
    type KissopenAgentBinary,
} from "./ensureKissopenAgentBinary.js";
import { selectedKissopenAgentBinary } from "./kissopenAgentBinaryConfig.js";
import { getKissopenDaemonPaths, type KissopenDaemonPaths } from "./getKissopenDaemonPaths.js";

const DAEMON_COMMAND_TIMEOUT_MS = 75_000;
const READY_TIMEOUT_MS = 60_000;
const commandSchema = Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), {
    maxItems: 32,
    minItems: 1,
});
type DaemonCommand = Static<typeof commandSchema>;

export interface LocalProtocolServerConnection {
    readonly client: KissopenAgentClient;
    readonly health: HealthResponse;
    readonly paths: KissopenDaemonPaths;
    readonly token: string;
}

export type ObservedLocalProtocolServer = LocalProtocolServerConnection;

export interface EnsureLocalProtocolServerOptions {
    onStatus?: (message: string) => void;
}

let inProcessDaemon: Promise<void> | undefined;
interface LocalKissopenAgentSources {
    cliPath: string;
    runModuleUrl: string;
}

/** Connects to the running daemon, or starts the selected or downloaded Agent when no socket responds. */
export async function ensureLocalProtocolServer(
    options: EnsureLocalProtocolServerOptions = {},
): Promise<LocalProtocolServerConnection> {
    const paths = getKissopenDaemonPaths();
    await mkdir(paths.agentDirectory, { mode: 0o700, recursive: true });
    const selectedRelease = await selectedKissopenAgentBinary(paths);

    const observed = await observeLocalProtocolServer(paths);
    if (observed !== undefined) return await connectWhenReady(observed);

    try {
        if (runDaemonInProcess()) {
            options.onStatus?.("Starting local KISSOPEN Agent sources.");
            await startLocalDaemonInProcess(paths);
        } else {
            const command = await resolveKissopenAgentCommand(
                paths,
                options.onStatus,
                selectedRelease,
            );
            options.onStatus?.(
                command.source === "release"
                    ? `Starting KISSOPEN Agent ${command.version}.`
                    : "Starting local KISSOPEN Agent sources.",
            );
            await runKissopenAgent(command.arguments, "start", paths);
        }
    } catch (error) {
        const raced = await observeLocalProtocolServer(paths);
        if (raced !== undefined) return await connectWhenReady(raced);
        throw new KissopenTerminalUserError(
            "The local KISSOPEN Agent daemon could not be started.",
            {
                cause: error,
                hint: error instanceof Error ? error.message : String(error),
            },
        );
    }

    const started = await waitForDaemon(paths);
    return await connectWhenReady(started);
}

export async function observeLocalProtocolServer(
    paths: KissopenDaemonPaths = getKissopenDaemonPaths(),
): Promise<ObservedLocalProtocolServer | undefined> {
    const token = await readTokenIfPresent(paths.tokenPath);
    if (token === undefined || token.length === 0) return undefined;
    const client = new KissopenAgentClient({
        endpoint: "http://kissopen",
        fetch: createUnixSocketFetch(paths.socketPath),
        token,
    });
    try {
        const health = await client.getHealth();
        assertCompatibleProtocol(health);
        return { client, health, paths, token };
    } catch (error) {
        if (error instanceof KissopenTerminalUserError) throw error;
        return undefined;
    }
}

export async function readTokenIfPresent(tokenPath: string): Promise<string | undefined> {
    try {
        return (await readFile(tokenPath, "utf8")).trim();
    } catch {
        return undefined;
    }
}

/** The local Gym keeps the daemon in the TUI process to make full-system scenarios inexpensive. */
export function runDaemonInProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
    return environment.KISSOPEN_TERMINAL_GYM_IN_PROCESS_DAEMON === "1";
}

/** Gym in-process daemon only. Production launch always uses the selected managed binary. */
export function resolveLocalKissopenAgentSources(
    moduleUrl: string = import.meta.url,
    exists: (path: URL) => boolean = existsSync,
): LocalKissopenAgentSources | undefined {
    for (const prefix of ["../../kissopen-agent/sources/", "../../../kissopen-agent/sources/"]) {
        const cli = new URL(`${prefix}cli.ts`, moduleUrl);
        const run = new URL(`${prefix}lifecycle/runAgentDaemon.ts`, moduleUrl);
        if (cli.protocol === "file:" && run.protocol === "file:" && exists(cli) && exists(run)) {
            return { cliPath: fileURLToPath(cli), runModuleUrl: run.href };
        }
    }
    return undefined;
}

async function resolveKissopenAgentCommand(
    paths: KissopenDaemonPaths,
    onStatus: ((message: string) => void) | undefined,
    selectedRelease: KissopenAgentBinary | undefined,
): Promise<
    | { arguments: DaemonCommand; source: "development" }
    | { arguments: DaemonCommand; source: "release"; version: string }
> {
    const override = process.env.KISSOPEN_TERMINAL_GYM_KISSOPEN_AGENT_COMMAND?.trim();
    if (override !== undefined && override.length > 0) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(override);
        } catch (error) {
            throw new Error("KISSOPEN_TERMINAL_GYM_KISSOPEN_AGENT_COMMAND is not valid JSON.", {
                cause: error,
            });
        }
        if (!Value.Check(commandSchema, parsed)) {
            throw new Error(
                "KISSOPEN_TERMINAL_GYM_KISSOPEN_AGENT_COMMAND must be a non-empty command array.",
            );
        }
        return { arguments: parsed, source: "development" };
    }

    if (selectedRelease !== undefined) {
        return {
            arguments: [selectedRelease.path],
            source: "release",
            version: selectedRelease.version,
        };
    }

    const release = await ensureKissopenAgentBinary({
        ...(onStatus === undefined ? {} : { onStatus }),
        paths,
    });
    return { arguments: [release.path], source: "release", version: release.version };
}

async function startLocalDaemonInProcess(paths: KissopenDaemonPaths): Promise<void> {
    if (!process.env.KISSOPEN_HOME_DIR?.trim()) {
        throw new Error(
            "The in-process Gym daemon requires an explicit isolated KISSOPEN_HOME_DIR.",
        );
    }
    const localSources = resolveLocalKissopenAgentSources();
    if (localSources === undefined) {
        throw new Error("The in-process Gym daemon requires a KISSOPEN Agent source checkout.");
    }
    inProcessDaemon ??= import(localSources.runModuleUrl).then(async (module: unknown) => {
        if (
            typeof module !== "object" ||
            module === null ||
            !("runAgentDaemon" in module) ||
            typeof module.runAgentDaemon !== "function"
        ) {
            throw new Error("The local KISSOPEN Agent source entrypoint is invalid.");
        }
        await module.runAgentDaemon({ persistPid: false });
    });
    await inProcessDaemon;
    const observed = await waitForDaemon(paths);
    await connectWhenReady(observed);
}

function runKissopenAgent(
    command: DaemonCommand,
    action: "start",
    paths: KissopenDaemonPaths,
): Promise<void> {
    const [executable, ...arguments_] = command;
    if (executable === undefined) throw new Error("The KISSOPEN Agent command is empty.");
    return new Promise((resolve, reject) => {
        execFile(
            executable,
            [...arguments_, action],
            {
                env: { ...process.env, KISSOPEN_HOME_DIR: paths.kissopenHome },
                maxBuffer: 1024 * 1024,
                timeout: DAEMON_COMMAND_TIMEOUT_MS,
            },
            (error, _stdout, stderr) => {
                if (error === null) {
                    resolve();
                    return;
                }
                const detail = stderr.trim();
                reject(detail.length === 0 ? error : new Error(detail, { cause: error }));
            },
        );
    });
}

async function waitForDaemon(paths: KissopenDaemonPaths): Promise<ObservedLocalProtocolServer> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const observed = await observeLocalProtocolServer(paths);
        if (observed !== undefined) return observed;
        await delay(50);
    }
    throw new Error("Timed out while waiting for the local KISSOPEN Agent daemon.");
}

async function connectWhenReady(
    observed: ObservedLocalProtocolServer,
): Promise<LocalProtocolServerConnection> {
    let health = observed.health;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!health.ready && Date.now() < deadline) {
        await delay(50);
        health = await observed.client.getHealth();
        assertCompatibleProtocol(health);
    }
    if (!health.ready) throw new Error("The local KISSOPEN Agent daemon did not finish starting.");
    return { client: observed.client, health, paths: observed.paths, token: observed.token };
}

function assertCompatibleProtocol(health: HealthResponse): void {
    if (health.version.protocol >= KISSOPEN_AGENT_MIN_PROTOCOL_VERSION) return;
    throw new KissopenTerminalUserError(
        `This KISSOPEN Terminal supports protocol ${String(KISSOPEN_AGENT_MIN_PROTOCOL_VERSION)} and newer, but the running KISSOPEN Agent uses protocol ${String(health.version.protocol)}.`,
        { hint: "Upgrade KISSOPEN Agent before trying again." },
    );
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
