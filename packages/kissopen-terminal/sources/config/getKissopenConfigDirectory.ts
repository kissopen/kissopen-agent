import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function getKissopenConfigDirectory(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const configuredDirectory = environment.KISSOPEN_TERMINAL_CONFIGURATION_DIRECTORY?.trim();
    if (configuredDirectory) {
        if (!isAbsolute(configuredDirectory)) {
            throw new Error("KISSOPEN_TERMINAL_CONFIGURATION_DIRECTORY must be an absolute path.");
        }
        return resolve(configuredDirectory);
    }
    return platform === "darwin"
        ? join(homeDirectory, "KISSOPEN", "Config")
        : join(homeDirectory, "kissopen", "config");
}
