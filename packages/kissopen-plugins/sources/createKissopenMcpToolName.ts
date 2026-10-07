/** Converts a display name into the stable identifier form used by Kissopen MCP tools. */
export function normalizeKissopenMcpName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Returns the exact tool name ordinary agents receive for a plugin contribution. */
export function createKissopenMcpToolName(
    pluginName: string,
    serverName: string,
    toolName: string,
): string {
    return `mcp__${normalizeKissopenMcpName(`${pluginName} · ${serverName}`)}__${normalizeKissopenMcpName(toolName)}`;
}
