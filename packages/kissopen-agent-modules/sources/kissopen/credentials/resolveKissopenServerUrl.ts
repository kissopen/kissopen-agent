const DEFAULT_KISSOPEN_SERVER_URL = "https://api.firstcache.cc";

/**
 * Chooses which Kissopen server to talk to.
 *
 * The environment wins, then this agent's own settings, then the settings of
 * the Kissopen CLI the credentials came from, then the public server.
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
