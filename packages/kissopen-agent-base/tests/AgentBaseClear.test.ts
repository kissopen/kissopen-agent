import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase } from "../sources/index.js";
import { providersOf, textTurn, user, userRecord } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("kissopen-agent-base-clear-test");

describe("AgentBase clear", () => {
    it("empties the conversation, and the next turn starts a fresh context", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("after clear")]);
        let cleared = 0;
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                conversationClearedTransact: () => {
                    cleared += 1;
                },
            },
        });

        await agent.send(ctx, user("remember this"), { id: "old" });
        await agent.waitForIdle();
        expect(persistence.records.length).toBeGreaterThan(0);

        await agent.clear(ctx);
        expect(cleared).toBe(1);
        expect(persistence.records).toEqual([]);
        expect(persistence.pending.size).toBe(0);
        expect(persistence.values.has("context")).toBe(false);

        await agent.send(ctx, user("new start"), { id: "new" });
        await agent.waitForIdle();
        const sessions = provider.sessions;
        const last = sessions[sessions.length - 1]!.requests.at(-1)!;
        expect(last.context.messages).toEqual([user("new start")]);
        // A cleared message's identity is free again.
        await expect(agent.send(ctx, user("remember this"), { id: "old" })).resolves.toMatchObject({
            accepted: "created",
        });
        await agent.close();
    });

    it("clears an idle agent whose loop is still starting up after a load", async () => {
        const persistence = new InMemoryPersistence([
            userRecord("from before"),
            { type: "block", block: { type: "text", text: "answered before" } },
        ]);
        const provider = new ScriptedProvider([textTurn("never")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        agent.start();
        await agent.clear(ctx);
        expect(persistence.records).toEqual([]);
        expect(provider.sessions.flatMap((session) => session.requests)).toEqual([]);
        await agent.close();
    });

    it("refuses while the agent is working and leaves the conversation untouched", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("done")]);
        let agent: AgentBase;
        let refusal: unknown;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: async (_hookCtx, event) => {
                    if (event.type !== "text_delta" || refusal !== undefined) return;
                    await persistence.outsideTransaction(async () => {
                        refusal = await agent.clear(ctx).catch((error: unknown) => error);
                    });
                },
            },
        });

        await agent.send(ctx, user("busy"), { id: "busy" });
        await agent.waitForIdle();
        expect(String(refusal)).toContain("stop it before clearing");
        expect(persistence.records.length).toBeGreaterThan(0);
        await agent.close();
    });

    it("rolls the whole clear back when a feature cannot clear its part", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("kept")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                conversationClearedTransact: () => {
                    throw new Error("feature refused");
                },
            },
        });

        await agent.send(ctx, user("keep me"), { id: "kept" });
        await agent.waitForIdle();
        const before = [...persistence.records];

        await expect(agent.clear(ctx)).rejects.toThrow("feature refused");
        expect(persistence.records).toEqual(before);
        await agent.close();
    });
});
