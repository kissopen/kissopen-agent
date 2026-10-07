import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { kissopenComputeErrorCodeSchema } from "./computeTypes.js";

const kissopenComputeProviderErrorCodeSchema = Type.Exclude(
    kissopenComputeErrorCodeSchema,
    Type.Literal("preparing_compute"),
);

const kissopenComputeProviderErrorInputSchema = Type.Object(
    {
        code: kissopenComputeProviderErrorCodeSchema,
        message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
);
type KissopenComputeProviderErrorInput = Static<typeof kissopenComputeProviderErrorInputSchema>;

/**
 * A typed failure reported by a compute provider handler.
 *
 * Rig preserves the code, derives retryability itself, and attributes only provider-side codes to
 * provider health.
 */
export class KissopenComputeProviderError extends Error {
    readonly code: KissopenComputeProviderErrorInput["code"];

    constructor(
        code: KissopenComputeProviderErrorInput["code"],
        message: KissopenComputeProviderErrorInput["message"],
    ) {
        const input = Value.Decode(kissopenComputeProviderErrorInputSchema, { code, message });
        super(input.message);
        this.name = "KissopenComputeProviderError";
        this.code = input.code;
    }
}
