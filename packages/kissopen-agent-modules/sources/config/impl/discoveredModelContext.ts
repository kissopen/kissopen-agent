import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentModelContext } from "./agentCatalog.js";

const capacity = Type.Integer({ minimum: 8_000, maximum: 10_000_000 });
const outputCapacity = Type.Integer({ minimum: 1, maximum: 10_000_000 });
export const discoveredModelContextSchema = Type.Object(
    {
        contextWindow: capacity,
        autoCompactWindow: outputCapacity,
    },
    { additionalProperties: false },
);

/** Optional metadata is validated separately so one bad declaration cannot hide a model. */
export const upstreamContextProperties = {
    context_window: Type.Optional(Type.Unknown()),
    context_length: Type.Optional(Type.Unknown()),
    max_context_length: Type.Optional(Type.Unknown()),
    max_output_tokens: Type.Optional(Type.Unknown()),
    max_completion_tokens: Type.Optional(Type.Unknown()),
    top_provider: Type.Optional(Type.Unknown()),
};
const upstreamSchema = Type.Object(upstreamContextProperties);
const topProviderSchema = Type.Object({ max_completion_tokens: Type.Optional(Type.Unknown()) });

export function discoveredModelContext(
    model: Static<typeof upstreamSchema>,
): AgentModelContext | undefined {
    const window = [model.context_window, model.context_length, model.max_context_length].find(
        (value) => Value.Check(capacity, value),
    );
    if (!Value.Check(capacity, window)) return undefined;
    const nestedOutput = Value.Check(topProviderSchema, model.top_provider)
        ? model.top_provider.max_completion_tokens
        : undefined;
    const output = [model.max_output_tokens, model.max_completion_tokens, nestedOutput].find(
        (value) => Value.Check(outputCapacity, value),
    );
    if (Value.Check(outputCapacity, output) && output >= window) return undefined;
    const reserved = Value.Check(outputCapacity, output)
        ? output
        : Math.min(32_768, Math.ceil(window / 4));
    return {
        contextWindow: window,
        autoCompactWindow: Math.min(Math.floor(window * 0.85), window - reserved),
    };
}
