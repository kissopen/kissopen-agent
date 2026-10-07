import {
    kissopenComputePreparationEventSchema,
    type KissopenComputeEventSubscription,
    type KissopenComputePreparationEvent,
} from "./computeTypes.js";
import { openKissopenPluginEventStream } from "./openKissopenPluginEventStream.js";
import type { KissopenMcpTransport } from "./startKissopenMcpServer.js";

export async function subscribeKissopenComputePreparation(
    handler: (event: KissopenComputePreparationEvent) => void | Promise<void>,
    transport: KissopenMcpTransport,
): Promise<KissopenComputeEventSubscription> {
    let closing = false;
    let failure: string | undefined;
    let status: KissopenComputeEventSubscription["status"] = "connected";
    const stream = await openKissopenPluginEventStream({
        eventSchema: kissopenComputePreparationEventSchema,
        label: "compute preparation",
        onEvent: (event) =>
            Promise.resolve()
                .then(() => handler(event))
                .catch((error: unknown) => {
                    warn(`The KISSOPEN compute event subscriber failed. ${errorToMessage(error)}`);
                }),
        path: "/compute/events",
        socketPath: transport.socketPath,
        token: transport.token,
    });
    void stream.closed.then((error) => {
        status = "closed";
        if (closing) return;
        failure = error.message;
        warn(`The KISSOPEN compute preparation stream closed. ${error.message}`);
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
        // Plugin logging is diagnostic and cannot fail compute event delivery.
    }
}
