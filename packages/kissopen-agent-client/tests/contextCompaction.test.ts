import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { configPatchSchema, daemonConfigSchema } from "../sources/index.js";

describe("context compaction preferences", () => {
    it("accepts older config snapshots and the additive preferences", () => {
        const config = Value.Create(daemonConfigSchema);
        expect(Value.Check(daemonConfigSchema, config)).toBe(true);
        expect(
            Value.Check(daemonConfigSchema, {
                ...config,
                contextCompaction: {
                    defaultPercent: null,
                    modelPercents: { "deepseek/deepseek-flash": 70 },
                },
            }),
        ).toBe(true);
    });

    it("accepts partial updates and explicit inheritance", () => {
        for (const contextCompaction of [
            {},
            { defaultPercent: 70 },
            { defaultPercent: null },
            { modelPercents: { "custom-account/deepseek-flash": 80 } },
            { modelPercents: { "custom-account/deepseek-flash": null } },
        ])
            expect(Value.Check(configPatchSchema, { contextCompaction })).toBe(true);
    });

    it.each([9, 91, 70.5, "70", false])("rejects invalid percentages %s", (percent) => {
        expect(
            Value.Check(configPatchSchema, { contextCompaction: { defaultPercent: percent } }),
        ).toBe(false);
        expect(
            Value.Check(configPatchSchema, {
                contextCompaction: { modelPercents: { model: percent } },
            }),
        ).toBe(false);
    });

    it("rejects malformed IDs, oversized maps and unexpected fields", () => {
        for (const modelPercents of [
            { "": 70 },
            { "bad\nmodel": 70 },
            { ["m".repeat(321)]: 70 },
            Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`model-${index}`, 70])),
        ])
            expect(Value.Check(configPatchSchema, { contextCompaction: { modelPercents } })).toBe(
                false,
            );
        expect(Value.Check(configPatchSchema, { contextCompaction: { typo: 70 } })).toBe(false);
    });
});
