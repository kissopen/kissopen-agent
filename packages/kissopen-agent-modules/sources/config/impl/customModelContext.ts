import { Type, type Static } from "@sinclair/typebox";
import type { AgentModelContext } from "./agentCatalog.js";

const windowSchema = Type.Integer({ minimum: 8_000, maximum: 10_000_000 });
const thresholdSchema = Type.Integer({ minimum: 1, maximum: 10_000_000 });
const modelIdSchema = Type.String({
    minLength: 1,
    maxLength: 1_024,
    pattern: "^custom-[a-f0-9]{24}/[^\\u0000\\r\\n]+$",
});
const inputPairSchema = Type.Object(
    { context_window: windowSchema, auto_compact_window: thresholdSchema },
    { additionalProperties: false },
);
const resolvedPairSchema = Type.Object(
    { contextWindow: windowSchema, autoCompactWindow: thresholdSchema },
    { additionalProperties: false },
);

export const customModelContextInputSchema = Type.Object(
    {
        default: Type.Optional(inputPairSchema),
        models: Type.Optional(
            Type.Record(modelIdSchema, inputPairSchema, {
                maxProperties: 512,
                additionalProperties: false,
            }),
        ),
    },
    { additionalProperties: false },
);
export const customModelContextSchema = Type.Object(
    {
        default: Type.Optional(resolvedPairSchema),
        models: Type.Record(modelIdSchema, resolvedPairSchema, {
            maxProperties: 512,
            additionalProperties: false,
        }),
    },
    { additionalProperties: false },
);

type Input = Static<typeof customModelContextInputSchema>;
type Resolved = Static<typeof customModelContextSchema>;

/** Unknown custom models retain a local safety budget, not a claimed vendor maximum. */
export const DEFAULT_CUSTOM_MODEL_CONTEXT: AgentModelContext = Object.freeze({
    contextWindow: 32_768,
    autoCompactWindow: 24_576,
});

export function validateCustomModelContext(value: Input): void {
    for (const [id, pair] of [
        ...(value.default === undefined ? [] : [["default", value.default] as const]),
        ...Object.entries(value.models ?? {}),
    ]) {
        if (pair.auto_compact_window >= pair.context_window) {
            throw new Error(
                `custom_model_context.${id}: auto_compact_window must be smaller than context_window.`,
            );
        }
    }
}

/** Each layer replaces complete pairs, so a new window cannot inherit an unsafe threshold. */
export function mergeCustomModelContext(current: Resolved, input: Input): Resolved {
    return {
        ...(current.default === undefined ? {} : { default: current.default }),
        ...(input.default === undefined ? {} : { default: normalize(input.default) }),
        models: {
            ...current.models,
            ...Object.fromEntries(
                Object.entries(input.models ?? {}).map(([id, pair]) => [id, normalize(pair)]),
            ),
        },
    };
}

/** Only explicitly configured limits are advertised as known in the model catalog. */
export function configuredCustomModelContext(
    configuration: Resolved,
    modelId: string,
): AgentModelContext | undefined {
    return configuration.models[modelId] ?? configuration.default;
}

function normalize(pair: Static<typeof inputPairSchema>): AgentModelContext {
    return { contextWindow: pair.context_window, autoCompactWindow: pair.auto_compact_window };
}
