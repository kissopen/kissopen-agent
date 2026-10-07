import { openKissopenPluginEventStream } from "./openKissopenPluginEventStream.js";
import type { KissopenMcpTransport } from "./startKissopenMcpServer.js";
import {
    kissopenWorkspaceEventSchema,
    type KissopenWorkspaceEvent,
    type KissopenWorkspaceSubscription,
} from "./types.js";

export async function subscribeKissopenWorkspaces(
    handler: (event: KissopenWorkspaceEvent) => void | Promise<void>,
    transport: KissopenMcpTransport,
): Promise<KissopenWorkspaceSubscription> {
    let closing = false;
    let failure: string | undefined;
    let status: KissopenWorkspaceSubscription["status"] = "connected";
    const stream = await openKissopenPluginEventStream({
        eventSchema: kissopenWorkspaceEventSchema,
        label: "workspace",
        onEvent: (event) =>
            Promise.resolve()
                .then(() => handler(event))
                .catch((error: unknown) => {
                    warn(`The KISSOPEN workspace subscriber failed. ${errorToMessage(error)}`);
                }),
        path: "/workspaces/events",
        socketPath: transport.socketPath,
        token: transport.token,
    });
    void stream.closed.then((error) => {
        status = "closed";
        if (closing) return;
        failure = error.message;
        warn(`The KISSOPEN workspace stream closed. ${error.message}`);
    });
    return {
        get failure() {
            return failure;
        },
        get status() {
            return status;
        },
        async close() {
            if (closing) return;
            closing = true;
            status = "closed";
            stream.close();
            await stream.closed;
        },
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Plugin logging is diagnostic and cannot fail workspace event delivery.
    }
}
