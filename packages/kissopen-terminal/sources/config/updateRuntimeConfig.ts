import type { PartialKissopenTerminalConfig } from "./types.js";
import { runWithRuntimeConfigLock } from "./runtimeConfigLock.js";
import { writeRuntimeConfigInsideLock } from "./writeRuntimeConfig.js";

export function updateRuntimeConfig(
    path: string,
    update: () => Promise<PartialKissopenTerminalConfig>,
): Promise<void> {
    return runWithRuntimeConfigLock(async () => {
        await writeRuntimeConfigInsideLock(path, await update());
    });
}
