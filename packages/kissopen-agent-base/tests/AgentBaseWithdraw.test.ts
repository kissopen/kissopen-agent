import type { Context } from "@steve.kite/stdlib";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase } from "../sources/index.js";
import { providersOf, textTurn, user } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

const ctx = createRootContext().named("kissopen-agent-base-withdraw-test");

function userTexts(persistence: InMemoryPersistence): string[] {
    return persistence.records.flatMap((record) =>
        record.type === "user" && record.message.role === "user"
            ? record.message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
    );
}

function queuedIds(persistence: InMemoryPersistence): unknown[] {
    return [...persistence.values]
        .filter(([key]) => key.startsWith("steering.") || key.startsWith("send."))
        .map(([, value]) => (value as { readonly id?: unknown }).id);
}

/**
 * Withdraws a steering message right after the consumption's first look at the durable queue, so
 * the withdrawal commits between that look and the transaction that would consume it.
 */
class WithdrawingPersistence extends InMemoryPersistence {
    withdrawAfterQueueRead: string | undefined;

    override async readValues(
        readCtx: Context,
        prefix: string,
    ): Promise<readonly { readonly key: string; readonly value: unknown }[]> {
        const result = await super.readValues(readCtx, prefix);
        const target = this.withdrawAfterQueueRead;
        if (target !== undefined && prefix === "steering.") {
            const found = result.find(
                ({ value }) => (value as { readonly id?: unknown }).id === target,
            );
            if (found !== undefined) {
                this.withdrawAfterQueueRead = undefined;
                this.values.delete(found.key);
            }
        }
        return result;
    }
}

describe("AgentBase withdraw", () => {
    it("takes back a queued send before the agent consumes it", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("first answer"), textTurn("never")]);
        let agent: AgentBase;
        let withdrawn: boolean | undefined;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: async (_hookCtx, event) => {
                    if (event.type !== "text_delta" || withdrawn !== undefined) return;
                    await persistence.outsideTransaction(async () => {
                        await agent.send(ctx, user("take me back"), { id: "later" });
                        withdrawn = await agent.withdraw(ctx, "later");
                    });
                },
            },
        });

        await agent.send(ctx, user("go"), { id: "first" });
        await agent.waitForIdle();

        expect(withdrawn).toBe(true);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(userTexts(persistence)).toEqual(["go"]);
        expect(queuedIds(persistence)).toEqual([]);
        // It is gone, and the ID stays spent.
        await expect(agent.withdraw(ctx, "later")).resolves.toBe(false);
        await expect(
            agent.send(ctx, user("take me back"), { id: "later" }),
        ).resolves.toMatchObject({ accepted: "existing" });
        await agent.close();
    });

    it("answers a steering message an abort left waiting in a fresh turn", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answer"), textTurn("answer again")]);
        let agent: AgentBase;
        let steered = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: async (_hookCtx, event) => {
                    if (event.type !== "text_delta" || steered) return;
                    steered = true;
                    await persistence.outsideTransaction(async () => {
                        await agent.steer(ctx, user("left behind"), { id: "left" });
                        await agent.abort(ctx);
                    });
                },
            },
        });

        await agent.send(ctx, user("go"), { id: "first" });
        await agent.waitForIdle();

        // Stopping ends the work in progress, not what the person said before stopping: the
        // message is answered rather than left queued behind an idle agent.
        expect(queuedIds(persistence)).toEqual([]);
        expect(userTexts(persistence)).toEqual(["go", "left behind"]);
        await expect(agent.withdraw(ctx, "left")).resolves.toBe(false);
        expect(agent.active).toBe(false);
        await agent.close();
    });

    it("does not withdraw a message the agent already consumed", async () => {
        const persistence = new InMemoryPersistence();
        const provider = new ScriptedProvider([textTurn("answer")]);
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });

        await agent.send(ctx, user("go"), { id: "first" });
        await agent.waitForIdle();

        await expect(agent.withdraw(ctx, "first")).resolves.toBe(false);
        await expect(agent.withdraw(ctx, "never-sent")).resolves.toBe(false);
        expect(userTexts(persistence)).toEqual(["go"]);
        await agent.close();
    });

    it("never both withdraws and consumes a message withdrawn while it is being consumed", async () => {
        const persistence = new WithdrawingPersistence();
        const provider = new ScriptedProvider([textTurn("first"), textTurn("second")]);
        let agent: AgentBase;
        let steered = false;
        agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
            hooks: {
                onEvent: async (_hookCtx, event) => {
                    if (event.type !== "text_delta" || steered) return;
                    steered = true;
                    await persistence.outsideTransaction(async () => {
                        await agent.steer(ctx, user("racing"), { id: "racing" });
                    });
                    persistence.withdrawAfterQueueRead = "racing";
                },
            },
        });

        await agent.send(ctx, user("go"), { id: "first" });
        await agent.waitForIdle();

        expect(userTexts(persistence)).toEqual(["go"]);
        expect(provider.sessions[0]?.requests).toHaveLength(1);
        expect(queuedIds(persistence)).toEqual([]);
        await agent.close();
    });
});
