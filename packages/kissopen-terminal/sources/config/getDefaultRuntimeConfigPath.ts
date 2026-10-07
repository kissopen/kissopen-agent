import { join } from "node:path";

import { getKissopenTerminalHome } from "./getKissopenTerminalHome.js";

export function getDefaultRuntimeConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getKissopenTerminalHome(env, homeDirectory), "runtime.toml");
}
