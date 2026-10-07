import { isAbsolute, join } from "node:path";

/** Locates the Kissopen CLI's own home directory, which is where credentials are imported from. */
export function resolveKissopenHome(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
    const configured = environment.KISSOPEN_HOME_DIR?.trim();
    if (!configured) return join(homeDirectory, ".kissopen");
    const expanded = configured.startsWith("~")
        ? join(homeDirectory, configured.slice(1))
        : configured;
    return isAbsolute(expanded) ? expanded : join(homeDirectory, expanded);
}
