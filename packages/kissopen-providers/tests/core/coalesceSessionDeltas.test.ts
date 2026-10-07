import { describe, expect, it } from "vitest";

import { coalesceSessionDeltas } from "@/core/coalesceSessionDeltas.js";
import type { SessionEvent } from "@/core/SessionEvent.js";

async function* stream(events: SessionEvent[]): AsyncGenerator<SessionEvent, string> {
    for (const event of events) yield event;
    return "result";
}

async function collect(source: AsyncGenerator<SessionEvent, string>) {
    const out: SessionEvent[] = [];
    for (;;) {
        const next = await source.next();
        if (next.done) return { out, result: next.value };
        out.push(next.value);
    }
}

describe("coalescing small deltas", () => {
    it("joins runs of the same kind and keeps order, text and the result", async () => {
        const events: SessionEvent[] = [
            { type: "reasoning_delta", delta: "想" },
            { type: "reasoning_delta", delta: "一" },
            { type: "reasoning_delta", delta: "下" },
            { type: "reasoning_end" },
            { type: "text_delta", delta: "你" },
            { type: "text_delta", delta: "好" },
            { type: "toolcall_start", callId: "a", name: "read" },
            { type: "toolcall_delta", callId: "a", delta: '{"p' },
            { type: "toolcall_delta", callId: "a", delta: '":1}' },
        ];
        const { out, result } = await collect(
            coalesceSessionDeltas(stream(events), { now: () => 0 }),
        );
        expect(result).toBe("result");
        expect(out).toEqual([
            { type: "reasoning_delta", delta: "想一下" },
            { type: "reasoning_end" },
            { type: "text_delta", delta: "你好" },
            { type: "toolcall_start", callId: "a", name: "read" },
            { type: "toolcall_delta", callId: "a", delta: '{"p":1}' },
        ]);
    });

    it("flushes at the size limit so a long stream still arrives in pieces", async () => {
        const events: SessionEvent[] = Array.from({ length: 10 }, () => ({
            type: "text_delta" as const,
            delta: "abcde",
        }));
        const { out } = await collect(
            coalesceSessionDeltas(stream(events), { maxChars: 20, now: () => 0 }),
        );
        expect(out.map((event) => (event as { delta: string }).delta)).toEqual([
            "abcdeabcdeabcdeabcde",
            "abcdeabcdeabcdeabcde",
            "abcdeabcde",
        ]);
    });

    it("never joins two different tool calls", async () => {
        const events: SessionEvent[] = [
            { type: "toolcall_delta", callId: "a", delta: "1" },
            { type: "toolcall_delta", callId: "b", delta: "2" },
        ];
        const { out } = await collect(coalesceSessionDeltas(stream(events), { now: () => 0 }));
        expect(out).toHaveLength(2);
    });

    it("delivers a held delta before a stream that breaks", async () => {
        async function* broken(): AsyncGenerator<SessionEvent, string> {
            yield { type: "text_delta", delta: "partial" };
            throw new Error("cut");
        }
        const out: SessionEvent[] = [];
        await expect(async () => {
            for await (const event of coalesceSessionDeltas(broken())) out.push(event);
        }).rejects.toThrow("cut");
        expect(out).toEqual([{ type: "text_delta", delta: "partial" }]);
    });

    it("shows a held delta while the stream pauses", async () => {
        async function* paused(): AsyncGenerator<SessionEvent, string> {
            yield { type: "text_delta", delta: "hello" };
            await new Promise((resolve) => setTimeout(resolve, 200));
            yield { type: "text_end" };
            return "done";
        }
        const source = coalesceSessionDeltas(paused(), { maxMs: 20 });
        const first = await source.next();
        expect(first.value).toEqual({ type: "text_delta", delta: "hello" });
        await source.return("stopped");
    });
});
