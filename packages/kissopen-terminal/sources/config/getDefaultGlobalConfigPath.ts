import { join } from "node:path";

import { getKissopenConfigDirectory } from "./getKissopenConfigDirectory.js";

export function getDefaultGlobalConfigPath(
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory?: string,
): string {
    return join(getKissopenConfigDirectory(env, homeDirectory), "kissopen.toml");
}
