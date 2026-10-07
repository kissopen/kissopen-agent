import { BaseSession, type SessionCompaction, type SessionCompactionOptions, type SessionEvent, type SessionRunRequest } from "@kissopen/kissopen-providers";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import { KissopenSession } from "../../sources/config/impl/KissopenProvider.js";
class Fixture extends BaseSession {
    destroyed = false;
    requests: SessionRunRequest[] = [];
    constructor(private readonly events: SessionEvent[]) { super("fixture"); }
    async *run(_ctx: Context, request: SessionRunRequest) { this.requests.push(request); yield* this.events; }
    async compact(_ctx: Context, _options: SessionCompactionOptions): Promise<SessionCompaction> { throw Error("Native compaction must not be used"); }
    destroy() { this.destroyed = true; }
}
const context = { instructions: "Do not modify files without permission.", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Read verification.txt" }] }] };
const usage = { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13 };
describe("KISSOPEN portable compaction", () => {
    it("can compact the non-reasoning pool model immediately after restoring a session", async () => {
        const summary = new Fixture([{ type: "text_delta", delta: "Restored context" }, { type: "done", state: "normal", tokens: { input: 10, output: 3 } }]);
        const session = new KissopenSession(new Fixture([]), async () => summary);
        expect(await session.compact(createRootContext(), { context, model: "openai/gpt-4o-mini-2024-07-18" })).toMatchObject({ status: "completed" });
        expect(summary.requests[0]?.effort).toBe("off");
    });
    it("reports a provider setup failure without losing the original history", async () => {
        const session = new KissopenSession(new Fixture([]), async () => { throw new Error("Provider unavailable"); });
        expect(await session.compact(createRootContext(), { context, model: "model" })).toMatchObject({ status: "failed", kind: "inference_error" });
        expect(context.messages).toHaveLength(1);
    });
    it("keeps normal tools on the original session and replaces only completed inference context", async () => {
        const ordinary = new Fixture([{ type: "done", state: "normal", tokens: { input: 1, output: 1 } }]);
        const summary = new Fixture([{ type: "text_delta", delta: "Read file; no files modified." }, { type: "token_usage", usage }, { type: "done", state: "normal", tokens: { input: 10, output: 3 } }]);
        const session = new KissopenSession(ordinary, async () => summary);
        const request = { context, model: "openai/gpt-4o-mini-2024-07-18", effort: "off" as const };
        for await (const _ of session.run(createRootContext(), request)) { /* consume */ }
        expect(ordinary.requests[0]).toBe(request);
        const result = await session.compact(createRootContext(), { context });
        expect(result).toMatchObject({ status: "completed", usage, summary: "Read file; no files modified.", context: { instructions: context.instructions, messages: [{ role: "compaction", content: "Read file; no files modified.", encryptedContent: null }] } });
        expect(context.messages).toHaveLength(1);
        expect(summary.destroyed).toBe(true);
        expect(ordinary.destroyed).toBe(false);
        if (result.status !== "completed") throw new Error("Expected completed compaction");
        for await (const _ of session.run(createRootContext(), { ...request, context: result.context })) { /* continue */ }
        expect(ordinary.requests[1]?.context.messages[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.stringContaining("Read file; no files modified.") }] });
        expect(result.context.messages[0]?.role).toBe("compaction");
    });
    it.each([
        [{ type: "text_delta", delta: "Incomplete" }],
        [{ type: "toolcall_start", name: "exec_command", callId: "unexpected" }],
        [{ type: "done", state: "error", kind: "billing_error", message: "Budget exhausted" }],
    ] satisfies SessionEvent[][])("does not replace history on incomplete output or tool execution", async (...events) => {
        const fixture = new Fixture(events);
        const session = new KissopenSession(new Fixture([]), async () => fixture);
        expect(await session.compact(createRootContext(), { context, model: "model" })).toMatchObject({ status: "failed" });
        expect(fixture.destroyed).toBe(true);
        expect(context.messages[0]?.content[0]?.text).toBe("Read verification.txt");
    });
});
