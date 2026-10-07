import type { KissopenAgentUpdate } from "../daemon/index.js";

export interface KissopenAgentUpdateNotice {
    readonly text: string;
    readonly title: string;
}

export function formatKissopenAgentUpdateNotice(
    update: KissopenAgentUpdate,
    commandName: string,
): KissopenAgentUpdateNotice {
    return {
        text: `KISSOPEN Agent ${update.latestVersion} is available; this terminal is using ${update.currentVersion}. Run '${commandName} upgrade' to download it and restart KISSOPEN Agent.`,
        title: "KISSOPEN Agent update available",
    };
}
