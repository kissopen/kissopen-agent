import { createHash } from "node:crypto";
import { join } from "node:path";

export interface KissopenPaths {
    credentialsPath: string;
    directory: string;
    machinePath: string;
    settingsPath: string;
}

/**
 * Lays out this agent's copy of the Kissopen credentials inside its data directory.
 *
 * A machine scope gives each daemon its own machine identity, so two daemons on
 * one computer do not fight over a single registration.
 */
export function getKissopenPaths(dataDirectory: string, machineScope?: string): KissopenPaths {
    const directory = join(dataDirectory, "kissopen");
    const machinePath =
        machineScope === undefined
            ? join(directory, "machine.json")
            : join(
                  directory,
                  "machines",
                  `${createHash("sha256").update(machineScope).digest("hex")}.json`,
              );
    return {
        credentialsPath: join(directory, "access.key"),
        directory,
        machinePath,
        settingsPath: join(directory, "settings.json"),
    };
}
