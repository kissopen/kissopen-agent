import { createRootContext } from "@steve.kite/stdlib";
import type { BaseSession } from "@kissopen/kissopen-providers";
import { describe, expect, it } from "vitest";

import { createScriptedInference, GYM_MODEL_ID, GYM_PROVIDER_ID } from "../sources/index.js";

const ctx = createRootContext().named("scripted-inference-test");

describe("scripted inference", () => {
    it("gives each daemon its own registry while preserving script progress", async () => {
        const scripted = createScriptedInference({
            inference: [
                { content: [{ text: "before restart", type: "text" }] },
                { content: [{ text: "after restart", type: "text" }] },
            ],
        });
        const first = scripted.createProviders();
        const provider = await first.resolve(GYM_PROVIDER_ID, GYM_MODEL_ID);
        if (provider === null) throw new Error("The gym provider is missing.");
        first.add("custom-fixture", provider, "gym");
        const before = await provider.session("before", { instructions: "Answer.", tools: [] });
        expect(await runText(before, "First message.")).toBe("before restart");
        await before.destroy();

        const second = scripted.createProviders();
        expect(second.ids).toEqual([GYM_PROVIDER_ID]);
        const nextProvider = await second.resolve(GYM_PROVIDER_ID, GYM_MODEL_ID);
        if (nextProvider === null) throw new Error("The restarted gym provider is missing.");
        const after = await nextProvider.session("after", { instructions: "Answer.", tools: [] });
        expect(await runText(after, "Second message.")).toBe("after restart");
        expect(scripted.log.requests.map((request) => request.callIndex)).toEqual([0, 1]);
        await after.destroy();
    });

    it("keeps detached naming requests out of fixed agent-turn scripts", async () => {
        const scripted = createScriptedInference({
            inference: [{ content: [{ text: "agent answer", type: "text" }] }],
        });
        const provider = await scripted.providers.resolve(GYM_PROVIDER_ID, GYM_MODEL_ID);
        expect(provider).not.toBeNull();
        if (provider === null) return;

        const naming = await provider.session("naming:test", {
            instructions: "Name it.",
            tools: [],
        });
        const agent = await provider.session("agent-test", { instructions: "Answer.", tools: [] });

        expect(await runText(naming, "Suggest a title.")).toContain("<title>Gym session</title>");
        expect(await runText(agent, "Answer the user.")).toBe("agent answer");
        expect(
            scripted.log.requests.map(({ callIndex, sessionId }) => ({ callIndex, sessionId })),
        ).toEqual([{ callIndex: 0, sessionId: "agent-test" }]);
        expect(scripted.log.unscripted).toEqual([]);

        await naming.destroy();
        await agent.destroy();
    });
});

async function runText(session: BaseSession, prompt: string): Promise<string> {
    let text = "";
    for await (const event of session.run(ctx, {
        context: {
            instructions: "",
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        },
        model: GYM_MODEL_ID,
    })) {
        if (event.type === "text_delta") text += event.delta;
    }
    return text;
}
