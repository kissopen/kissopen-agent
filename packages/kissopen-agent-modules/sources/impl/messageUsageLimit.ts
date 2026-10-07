import type { MessageUsageLimit } from "@kissopen/kissopen-agent-client";
import { sessionProviderErrorSchema } from "@kissopen/kissopen-providers";
import { Value } from "@sinclair/typebox/value";

/** Only the hosted allowance code offers account-usage navigation; BYOK errors do not. */
export function messageUsageLimit(error: unknown): MessageUsageLimit | undefined {
    if (
        !Value.Check(sessionProviderErrorSchema, error) ||
        error.type !== "out_of_tokens" ||
        error.diagnostics?.code !== "usage_limit"
    )
        return undefined;
    const resetAt = error.resetAt;
    return {
        code: "usage_limit",
        ...(resetAt !== undefined && Number.isSafeInteger(resetAt) ? { resetAt } : {}),
    };
}
