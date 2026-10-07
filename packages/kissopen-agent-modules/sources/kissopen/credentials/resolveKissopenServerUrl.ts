/**
 * The self-hosted KissOpen server on this machine. Open-source builds never fall back to a hosted
 * commercial service; any other server must be configured explicitly.
 */
export const DEFAULT_KISSOPEN_SERVER_URL = "http://127.0.0.1:3005";

/**
 * Chooses which Kissopen server to talk to.
 *
 * The environment wins, then this agent's own settings, then the settings of
 * the Kissopen CLI the credentials came from, then the local self-hosted server.
 */
export function resolveKissopenServerUrl(options: {
    environment: NodeJS.ProcessEnv;
    sourceServerUrl?: string;
    targetServerUrl?: string;
}): string {
    const configured =
        options.environment.KISSOPEN_AGENT_KISSOPEN_SERVER_URL?.trim() ||
        options.environment.KISSOPEN_SERVER_URL?.trim();
    return (
        configured ||
        options.targetServerUrl ||
        options.sourceServerUrl ||
        DEFAULT_KISSOPEN_SERVER_URL
    ).replace(/\/+$/u, "");
}
