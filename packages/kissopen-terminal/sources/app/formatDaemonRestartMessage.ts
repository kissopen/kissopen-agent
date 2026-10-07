import type { DaemonRestartRequest } from "../client/index.js";

export function formatDaemonRestartMessage(request: DaemonRestartRequest): string {
    return `The running daemon uses KISSOPEN Terminal ${request.runningIdentity.version}, but this CLI is KISSOPEN Terminal ${request.currentIdentity.version}. Restart the daemon to use this CLI.`;
}
