import type { KissopenMcpTransport } from "./startKissopenMcpServer.js";
import { startKissopenPluginEventRegistration } from "./startKissopenPluginEventRegistration.js";
import {
    kissopenTracingEventSchema,
    type KissopenTracingEvent,
    type KissopenTracingSubscription,
} from "./types.js";

export async function subscribeKissopenTracing(
    handler: (event: KissopenTracingEvent) => void | Promise<void>,
    transport: KissopenMcpTransport,
): Promise<KissopenTracingSubscription> {
    const registration = await startKissopenPluginEventRegistration({
        deletePath: (registrationId) =>
            `/tracing/subscriptions/${encodeURIComponent(registrationId)}`,
        eventPath: (registrationId) =>
            `/tracing/subscriptions/${encodeURIComponent(registrationId)}/events`,
        eventSchema: kissopenTracingEventSchema,
        label: "tracing",
        onEvent(event) {
            // Serial handling lets a slow subscriber apply socket backpressure, where Rig's
            // bounded drop-oldest queue owns overload instead of accumulating plugin promises.
            return Promise.resolve()
                .then(() => handler(event))
                .catch((error: unknown) => {
                    warn(`The KISSOPEN tracing subscriber failed. ${errorToMessage(error)}`);
                });
        },
        registerPath: "/tracing/subscriptions",
        transport,
    });
    return {
        get failure() {
            return registration.failure;
        },
        get registrationId() {
            return registration.registrationId;
        },
        get status() {
            return registration.status;
        },
        close: () => registration.close(),
    };
}

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function warn(message: string): void {
    try {
        console.warn(message);
    } catch {
        // Plugin logging is diagnostic and cannot fail tracing.
    }
}
