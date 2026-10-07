import type { PartialKissopenTerminalConfig } from "./types.js";

/**
 * The startup notice shown when a project's config file asked for a machine-level setting the
 * merge refused. Only the permission mode is machine-level in this file's schema; everything
 * else it may set is an ordinary preference.
 */
export function createProjectConfigSecurityNotice(
    config: PartialKissopenTerminalConfig,
    configFileName = "kissopen.toml",
): { text: string; title: string } | undefined {
    if (config.defaults?.permissionMode === undefined) return undefined;
    return {
        text: `This project's ${configFileName} requested a permission mode. KISSOPEN Terminal applied the other project preferences but kept your user-level permission choice.`,
        title: "Project permission ignored",
    };
}
