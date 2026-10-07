import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import {
    browserOperationSchema,
    browserControlRequestSchema,
    browserResultSchema,
} from "../sources/index.js";

describe("additive visible browser capabilities", () => {
    it("preserves old attachments and negotiates only unique bounded known capabilities", () => {
        const attach = { action: "attach", leaseId: "a".repeat(32), tabId: "b".repeat(32) };
        expect(Value.Check(browserControlRequestSchema, attach)).toBe(true);
        expect(
            Value.Check(browserControlRequestSchema, {
                ...attach,
                capabilities: ["batch", "wait"],
            }),
        ).toBe(true);
        for (const capabilities of [["batch", "batch"], ["script"], ["cookies"]])
            expect(Value.Check(browserControlRequestSchema, { ...attach, capabilities })).toBe(
                false,
            );
    });
    it("bounds batches and forbids nested batches, navigation, scripts and invented refs", () => {
        const step = { action: "fill", ref: "r1_f1_0", text: "fixture" };
        expect(
            Value.Check(browserOperationSchema, {
                action: "batch",
                steps: [step, { action: "click", ref: "r1_f1_1" }],
            }),
        ).toBe(true);
        for (const steps of [
            [],
            Array(7).fill(step),
            [{ action: "navigate", url: "https://example.com" }],
            [{ action: "batch", steps: [step] }],
            [{ action: "click", ref: "bad ref" }],
            [{ action: "script", code: "x" }],
        ])
            expect(Value.Check(browserOperationSchema, { action: "batch", steps })).toBe(false);
    });
    it("requires refs only for control waits and bounds timeout and progress", () => {
        for (const condition of ["visible", "hidden", "enabled"])
            expect(
                Value.Check(browserOperationSchema, {
                    action: "wait",
                    condition,
                    ref: "r1",
                    timeoutMs: 10000,
                }),
            ).toBe(true);
        expect(Value.Check(browserOperationSchema, { action: "wait", condition: "load" })).toBe(
            true,
        );
        for (const operation of [
            { action: "wait", condition: "visible" },
            { action: "wait", condition: "load", ref: "r1" },
            { action: "wait", condition: "load", timeoutMs: 10001 },
            { action: "wait", condition: "load", timeoutMs: 0 },
        ])
            expect(Value.Check(browserOperationSchema, operation)).toBe(false);
        expect(
            Value.Check(browserResultSchema, {
                ok: false,
                text: "Observed",
                batch: { completedSteps: 1, totalSteps: 3, reason: "page_changed" },
            }),
        ).toBe(true);
        expect(
            Value.Check(browserResultSchema, {
                ok: false,
                text: "Observed",
                batch: { completedSteps: 7, totalSteps: 3, reason: "page_changed" },
            }),
        ).toBe(false);
    });
});
