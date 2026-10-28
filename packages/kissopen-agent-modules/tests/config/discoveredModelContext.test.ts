import { describe, expect, it } from "vitest";
import { discoveredModelContext } from "../../sources/config/impl/discoveredModelContext.js";

describe("upstream context metadata", () => {
    it.each([
        [
            { context_window: 1_048_576, max_output_tokens: 393_216 },
            { contextWindow: 1_048_576, autoCompactWindow: 655_360 },
        ],
        [
            { context_length: 262_144, top_provider: { max_completion_tokens: 65_536 } },
            { contextWindow: 262_144, autoCompactWindow: 196_608 },
        ],
        [{ max_context_length: 131_072 }, { contextWindow: 131_072, autoCompactWindow: 98_304 }],
        [{ context_window: 1_000_000 }, { contextWindow: 1_000_000, autoCompactWindow: 850_000 }],
    ])("reserves output space in a valid capacity: %j", (input, expected) => {
        expect(discoveredModelContext(input)).toEqual(expected);
    });
    it.each([
        {},
        { context_window: "1M" },
        { context_window: 0 },
        { context_window: 7999 },
        { context_window: 10_000_001 },
        { context_window: 131_072.5 },
        { context_window: 131_072, max_output_tokens: 131_072 },
        { context_window: 131_072, max_output_tokens: 262_144 },
    ])("ignores an invalid or contradictory declaration: %j", (input) => {
        expect(discoveredModelContext(input)).toBeUndefined();
    });
});
