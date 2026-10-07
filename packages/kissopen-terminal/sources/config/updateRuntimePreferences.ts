import { readConfigFile } from "./readConfigFile.js";
import type { PartialKissopenTerminalConfig } from "./types.js";
import { updateRuntimeConfig } from "./updateRuntimeConfig.js";

export function updateRuntimePreferences(
    path: string,
    preferences: PartialKissopenTerminalConfig,
): Promise<void> {
    return updateRuntimeConfig(path, async () => {
        const current = await readConfigFile(path);
        return { ...current.values, ...preferences };
    });
}
