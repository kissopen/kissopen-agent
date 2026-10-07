import type { Context, Logger } from "@steve.kite/stdlib";

import { formatCliFailure } from "./formatCliFailure.js";
import { initializeDaemonContext, withProcessContext } from "./observability/index.js";
import { writeStderrSync } from "./writeStderrSync.js";
import { runApp, type RunAppOptions } from "./app/runApp.js";

export type RunKissopenTerminalOptions = RunAppOptions;

/** Runs Kissopen Terminal on the current process's stdin and stdout until the user exits it. */
export async function runKissopenTerminal(options: RunKissopenTerminalOptions = {}): Promise<void> {
    initializeDaemonContext(quietLogger());
    await withProcessContext("embedded-terminal", (ctx) =>
        runKissopenTerminalWithContext(ctx, {
            ...options,
            commandName: options.commandName ?? "kissopen",
            onError: options.onError ?? reportEmbeddedFailure,
        }),
    );
}

export async function runKissopenTerminalWithContext(
    ctx: Context,
    options: RunKissopenTerminalOptions = {},
): Promise<void> {
    let runOptions = options;
    for (;;) {
        const result = await runApp(ctx, runOptions);
        if (result.action === "exit") return;
        const { sessionSelection: _, ...reloadOptions } = runOptions;
        runOptions = { ...reloadOptions, resumeSessionId: result.sessionId };
    }
}

function reportEmbeddedFailure(error: unknown): void {
    writeStderrSync(`${formatCliFailure(error, { color: process.stderr.isTTY === true })}\n`);
}

function quietLogger(): Logger {
    const write = () => undefined;
    return { debug: write, error: write, fatal: write, info: write, trace: write, warn: write };
}
