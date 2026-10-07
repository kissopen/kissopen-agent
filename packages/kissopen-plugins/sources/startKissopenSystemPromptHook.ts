import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import {
    kissopenSystemPromptHookCompletionSchema,
    kissopenSystemPromptHookEventSchema,
    kissopenSystemPromptHookResultSchema,
    type KissopenSystemPromptHook,
    type KissopenSystemPromptHookInput,
    type KissopenSystemPromptHookResult,
} from "./types.js";
import type { KissopenMcpTransport } from "./startKissopenMcpServer.js";
import { startKissopenPluginEventRegistration } from "./startKissopenPluginEventRegistration.js";

const emptyResponseSchema = Type.Object({}, { additionalProperties: false });

export async function startKissopenSystemPromptHook(
    handler: (
        input: KissopenSystemPromptHookInput,
    ) => KissopenSystemPromptHookResult | Promise<KissopenSystemPromptHookResult>,
    transport: KissopenMcpTransport,
): Promise<KissopenSystemPromptHook> {
    const registration = await startKissopenPluginEventRegistration({
        deletePath: (registrationId) =>
            `/hooks/system-prompt/${encodeURIComponent(registrationId)}`,
        eventPath: (registrationId) =>
            `/hooks/system-prompt/${encodeURIComponent(registrationId)}/events`,
        eventSchema: kissopenSystemPromptHookEventSchema,
        label: "system-prompt hook",
        onEvent(event, registrationId) {
            return Promise.resolve()
                .then(() => handler(event.input))
                .then((result) => Value.Decode(kissopenSystemPromptHookResultSchema, result))
                .then((result) =>
                    transport.request(
                        "POST",
                        `/hooks/system-prompt/${encodeURIComponent(registrationId)}/calls/${encodeURIComponent(event.callId)}`,
                        emptyResponseSchema,
                        Value.Decode(kissopenSystemPromptHookCompletionSchema, { result }),
                    ),
                )
                .then(() => undefined)
                .catch((error: unknown) => {
                    warn(`The KISSOPEN system-prompt hook failed. ${errorToMessage(error)}`);
                });
        },
        registerPath: "/hooks/system-prompt",
        recover: false,
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
        // Plugin logging is diagnostic and cannot fail a hook.
    }
}
