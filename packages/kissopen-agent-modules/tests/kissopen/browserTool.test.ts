import { Value } from "@sinclair/typebox/value";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it, vi } from "vitest";
import { browserTool } from "../../sources/kissopen/browserTool.js";
import { isObjectRooted } from "../../sources/runtime/checkModuleToolParameters.js";

describe("visible browser tool schema", () => {
    it("reviews every batched write without making batches replayable", () => {
        const tool = browserTool(async () => ({ ok: true, text: "Observed" }));
        const operation = {
            action: "batch" as const,
            steps: [
                { action: "fill" as const, ref: "r1", text: "fixture" },
                { action: "click" as const, ref: "r2" },
            ],
        };
        expect(tool.shouldReviewInAutoMode?.({ operation }, {} as never)).toBe(true);
        const review = tool.describeAutoPermissionAction?.({ operation }, {} as never);
        expect(review).toContain('ref "r1"');
        expect(review).toContain('ref "r2"');
        expect(review).toContain("Review every click and fill");
        expect(tool.durable).toBe(false);
        expect(tool.reloadable).toBe(false);
    });
    it("uses a provider-compatible object root and retains strict operation validation", () => {
        const tool = browserTool(async () => ({ ok: true, text: "read" }));
        if (!tool.parameters) throw new Error("Browser tool parameters are required");
        expect(isObjectRooted(tool.parameters)).toBe(true);
        expect(Value.Check(tool.parameters, { operation: { action: "read" } })).toBe(true);
        expect(
            Value.Check(tool.parameters, {
                operation: { action: "fill", ref: "a", text: "hello" },
            }),
        ).toBe(true);
        expect(Value.Check(tool.parameters, { operation: { action: "fill", ref: "a" } })).toBe(
            false,
        );
        expect(
            Value.Check(tool.parameters, { operation: { action: "read", text: "unexpected" } }),
        ).toBe(false);
        expect(Value.Check(tool.parameters, { action: "read" })).toBe(false);
    });

    it("unwraps the operation without losing write review or replay protection", async () => {
        const execute = vi.fn(async () => ({ ok: true, text: "filled" }));
        const tool = browserTool(execute);
        const ctx = createRootContext();
        const operation = { action: "fill" as const, ref: "a", text: "hello" };
        await tool.execute(ctx, { operation }, { id: "test" } as never);
        expect(execute).toHaveBeenCalledWith(ctx, operation);
        expect(tool.shouldReviewInAutoMode?.({ operation }, {} as never)).toBe(true);
        expect(tool.shouldReviewInAutoMode?.({ operation: { action: "read" } }, {} as never)).toBe(
            false,
        );
        expect(tool.durable).toBe(false);
        expect(tool.reloadable).toBe(false);
    });

    it("carries registration and verification authorization to the model and exact-action reviewer", () => {
        const tool = browserTool(async () => ({ ok: true, text: "read" }));
        const policy =
            "A user-authorized registration task includes acknowledging the intended site's registration terms and privacy policy and submitting that registration. These routine steps do not require a separate final-step confirmation or browser handoff.";
        const verification = "Human-verification controls are not an automatic handoff boundary.";
        const guidance = [
            tool.description,
            tool.autoPermissionInstructions,
            tool.describeAutoPermissionAction?.(
                { operation: { action: "click", ref: "r1" } },
                {} as never,
            ),
            tool.describeAutoPermissionAction?.(
                { operation: { action: "fill", ref: "r2", text: "test" } },
                {} as never,
            ),
        ];
        for (const text of guidance) {
            expect(text).toContain(policy);
            expect(text).toContain(verification);
            expect(text).not.toContain("blanket earlier approval is insufficient");
            expect(text).not.toContain("require explicit user confirmation at that step");
        }
        expect(
            tool.shouldReviewInAutoMode?.(
                { operation: { action: "click", ref: "r1" } },
                {} as never,
            ),
        ).toBe(true);
        expect(tool.requiresAutoOrFullAccess).toBe(true);
    });
});
