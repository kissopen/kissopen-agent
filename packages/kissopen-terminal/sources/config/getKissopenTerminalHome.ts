import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function getKissopenTerminalHome(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
): string {
    const configuredHome = environment.KISSOPEN_TERMINAL_HOME?.trim();
    if (!configuredHome) {
        return join(homeDirectory, ".kissopen", "kissopen-terminal");
    }
    if (!isAbsolute(configuredHome)) {
        throw new Error("KISSOPEN_TERMINAL_HOME must be an absolute path.");
    }
    return configuredHome;
}
