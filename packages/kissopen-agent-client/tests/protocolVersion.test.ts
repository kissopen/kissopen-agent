import { describe, expect, it } from "vitest";

import {
    KISSOPEN_AGENT_MIN_PROTOCOL_VERSION,
    KISSOPEN_AGENT_PROTOCOL_VERSION,
} from "../sources/protocol/daemon.js";

describe("KISSOPEN Agent protocol version", () => {
    it("advertises protocol 27, which adds bot assistant settings and core files", () => {
        expect(KISSOPEN_AGENT_PROTOCOL_VERSION).toBe(27);
    });

    it("keeps the additive compatibility range rooted at protocol 22", () => {
        expect(KISSOPEN_AGENT_MIN_PROTOCOL_VERSION).toBe(22);
    });
});
