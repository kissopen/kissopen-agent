import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    KISSOPEN_PRODUCT_INSTRUCTIONS,
    KissopenProductModule,
} from "../../sources/kissopenProduct/index.js";

function instructionsFor(provider: string): unknown {
    const module = new KissopenProductModule();
    const hooks = module.beforeStart(createRootContext(), {} as never);
    return hooks.instructions?.(createRootContext(), { agent: { provider } } as never);
}

describe("KISSOPEN product instructions", () => {
    it("reach agents on a KISSOPEN account", () => {
        expect(instructionsFor("kissopen")).toBe(KISSOPEN_PRODUCT_INSTRUCTIONS);
        expect(KISSOPEN_PRODUCT_INSTRUCTIONS).toContain("request_user_input");
    });

    it("leave agents on the person's own providers alone", () => {
        expect(instructionsFor("codex")).toBe("");
        expect(instructionsFor("claude")).toBe("");
    });
});
