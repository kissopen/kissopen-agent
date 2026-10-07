import type { SessionEvent } from "@/core/SessionEvent.js";

type Delta = Extract<SessionEvent, { type: "text_delta" | "reasoning_delta" | "toolcall_delta" }>;

function isDelta(event: SessionEvent): event is Delta {
    return (
        event.type === "text_delta" ||
        event.type === "reasoning_delta" ||
        event.type === "toolcall_delta"
    );
}

function sameStream(a: Delta, b: Delta): boolean {
    if (a.type !== b.type) return false;
    return a.type !== "toolcall_delta" || a.callId === (b as typeof a).callId;
}

/**
 * Joins a stream's small deltas into fewer, larger ones.
 *
 * Some endpoints (DeepSeek's thinking above all) stream a delta every token or two, and every
 * event a provider yields is kept by the agent: a long thinking stream became tens of thousands of
 * stored events, enough that restoring one unfinished run exhausted a cloud container's memory.
 * Consecutive deltas of the same kind — text, reasoning, or one tool call's arguments — are joined
 * until `maxChars` characters or `maxMs` have gathered, and anything else flushes them first, so
 * the order of events and the text they carry are exactly what the source said. A delta is held
 * at most `maxMs`, even when the stream pauses.
 */
export async function* coalesceSessionDeltas<Result>(
    source: AsyncGenerator<SessionEvent, Result>,
    options: {
        readonly maxChars?: number;
        readonly maxMs?: number;
        readonly now?: () => number;
    } = {},
): AsyncGenerator<SessionEvent, Result> {
    const maxChars = options.maxChars ?? 400;
    const maxMs = options.maxMs ?? 150;
    const now = options.now ?? Date.now;
    let pending: Delta | undefined;
    let since = 0;
    let finished = false;
    // The source's next event, asked for once and kept while a held delta waits on a timer.
    let upcoming: Promise<IteratorResult<SessionEvent, Result>> | undefined;
    try {
        for (;;) {
            upcoming ??= source.next();
            let next: IteratorResult<SessionEvent, Result> | undefined;
            // A stream that breaks still delivers what it said before breaking.
            upcoming.catch(() => undefined);
            if (pending === undefined) {
                next = await upcoming;
            } else {
                // A held delta is shown within `maxMs` even if the stream pauses: a model that
                // stops to think, or a run about to be cancelled, must not hide what it said.
                const wait = Math.max(0, maxMs - (now() - since));
                let timer: ReturnType<typeof setTimeout> | undefined;
                const expired = new Promise<undefined>((resolve) => {
                    timer = setTimeout(() => resolve(undefined), wait);
                });
                try {
                    next = await Promise.race([upcoming, expired]);
                } catch (error) {
                    clearTimeout(timer);
                    const held = pending;
                    pending = undefined;
                    finished = true;
                    yield held;
                    throw error;
                }
                clearTimeout(timer);
                if (next === undefined) {
                    const held = pending;
                    pending = undefined;
                    yield held;
                    continue;
                }
            }
            upcoming = undefined;
            if (next.done) {
                finished = true;
                if (pending !== undefined) yield pending;
                return next.value;
            }
            const event = next.value;
            if (pending !== undefined && isDelta(event) && sameStream(pending, event)) {
                pending = { ...pending, delta: pending.delta + event.delta };
                if (pending.delta.length >= maxChars || now() - since >= maxMs) {
                    const full = pending;
                    pending = undefined;
                    yield full;
                }
                continue;
            }
            if (pending !== undefined) {
                const held = pending;
                pending = undefined;
                yield held;
            }
            if (isDelta(event)) {
                pending = event;
                since = now();
                continue;
            }
            yield event;
        }
    } finally {
        // Stopped early (the run was cancelled): let the source release its stream too.
        if (!finished) await source.return(undefined as Result);
    }
}
