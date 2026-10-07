import type { HealthResponse } from "@kissopen/kissopen-agent-client";
import type { Context } from "@steve.kite/stdlib";

import { ensureLocalProtocolServer } from "../client/index.js";
import { readPackageVersion } from "../readPackageVersion.js";

export interface KissopenTerminalCliInspection {
    cliVersion: string;
    formatVersion: 2;
    health: HealthResponse;
    source: "cli";
}

export interface RunKissopenTerminalInspectionOptions {
    json?: boolean;
    log?: (line: string) => void;
    rigVersion?: string;
}

/** Reports only facts available through the public Kissopen Agent API. */
export async function runKissopenTerminalInspection(
    _ctx: Context,
    options: RunKissopenTerminalInspectionOptions = {},
): Promise<KissopenTerminalCliInspection> {
    const health = await (await ensureLocalProtocolServer()).client.getHealth();
    const inspection: KissopenTerminalCliInspection = {
        cliVersion: options.rigVersion ?? readPackageVersion(),
        formatVersion: 2,
        health,
        source: "cli",
    };
    const log = options.log ?? console.log;
    if (options.json === true) log(JSON.stringify(inspection));
    else for (const line of formatKissopenTerminalInspection(inspection)) log(line);
    return inspection;
}

export function formatKissopenTerminalInspection(
    inspection: KissopenTerminalCliInspection,
): readonly string[] {
    return [
        `Installed KISSOPEN Terminal CLI version: ${inspection.cliVersion}`,
        `KISSOPEN Agent daemon version: ${inspection.health.version.daemon}`,
        `KISSOPEN Agent protocol version: ${String(inspection.health.version.protocol)}`,
        inspection.health.ready ? "KISSOPEN Agent is ready." : "KISSOPEN Agent is starting.",
    ];
}

export function kissopenTerminalInspectionExitCode(_inspection: KissopenTerminalCliInspection): 0 {
    return 0;
}
