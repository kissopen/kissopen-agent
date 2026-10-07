import { APIError } from "openai";
import { describe, expect, it } from "vitest";

import { classifyResponsesError } from "@/protocol/responses/classifyResponsesError.js";

describe("classifyResponsesError", () => {
    it("distinguishes hosted allowance exhaustion from transient rate limiting", () => {
        const error = new APIError(
            429,
            {},
            "已达到本周用量上限",
            new Headers({
                "x-worpar-error-code": "usage_limit",
                "retry-after": "3600",
            }),
        );
        expect(classifyResponsesError(error)).toMatchObject({
            kind: "billing_error",
            providerError: {
                type: "out_of_tokens",
                resetAt: expect.any(Number),
                diagnostics: { code: "usage_limit" },
            },
        });
    });
    it.each([
        [401, "authentication"],
        [402, "out_of_tokens"],
        [403, "authentication"],
        [429, "rate_limit"],
        [503, "server_overloaded"],
        [500, "internal_server_error"],
    ] as const)("classifies HTTP %s", (status, type) => {
        const error = new APIError(
            status,
            { error: { message: "failure" } },
            "failure",
            new Headers(),
        );

        expect(classifyResponsesError(error).providerError).toMatchObject({
            type,
            diagnostics: {
                attempts: 1,
                status,
                upstreamMessage: expect.stringContaining("failure"),
            },
        });
    });

    it("recognizes context overflow diagnostics", () => {
        expect(
            classifyResponsesError(
                new APIError(
                    400,
                    { error: { message: "Maximum context_length exceeded" } },
                    "Maximum context_length exceeded",
                    new Headers(),
                ),
            ),
        ).toMatchObject({
            state: "error",
            kind: "context_overflow",
        });
    });
});
