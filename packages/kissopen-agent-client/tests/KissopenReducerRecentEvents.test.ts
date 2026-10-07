import { describe, expect, it } from "vitest";

import { KissopenReducerRecentEvents } from "../sources/KissopenReducerRecentEvents.js";
import type { KissopenAgentEvent } from "../sources/protocol/events.js";

const EVENT: KissopenAgentEvent = {
    cursor: "01900000-0000-7000-8000-000000000001",
    occurredAt: 1,
    payload: {},
    type: "config.updated",
};

describe("KissopenReducerRecentEvents", () => {
    it("retains exactly the bounded 60-second snapshot race window", () => {
        const recent = new KissopenReducerRecentEvents();
        const epoch = recent.epoch;
        const checkpoint = recent.checkpoint();
        recent.remember(EVENT, 1);

        expect(recent.since(checkpoint, 60_001)).toEqual([EVENT]);
        expect(recent.isCompleteSince(epoch, 1, 60_001)).toBe(true);

        expect(recent.since(checkpoint, 60_002)).toEqual([]);
        expect(recent.isCompleteSince(epoch, 1, 60_002)).toBe(false);
    });

    it("invalidates an in-flight snapshot window after SSE state loss", () => {
        const recent = new KissopenReducerRecentEvents();
        const epoch = recent.epoch;
        recent.remember(EVENT, 1);
        recent.invalidate();

        expect(recent.since(0, 2)).toEqual([]);
        expect(recent.isCompleteSince(epoch, 1, 2)).toBe(false);
    });
});
