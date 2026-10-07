import { afterEach, describe, expect, it, vi } from "vitest";
import { KissopenBrowser } from "../../sources/kissopen/KissopenBrowser.js";

const leaseId = "a".repeat(32);
const tabId = "b".repeat(32);
const attach = { action: "attach" as const, leaseId, tabId };
const broker = new KissopenBrowser();
afterEach(() => {
    broker.close();
    vi.useRealTimers();
});

describe("visible browser lease security", () => {
    it("refuses unadvertised operations and excessive fill budgets before claiming any work", async () => {
        const broker = new KissopenBrowser();
        broker.control("a", attach);
        expect((await broker.execute("a", { action: "wait", condition: "load" })).ok).toBe(false);
        expect(broker.control("a", { action: "poll", leaseId })).toEqual({
            ok: true,
            paused: false,
        });
        const secondId = "c".repeat(32);
        broker.control("b", { ...attach, leaseId: secondId, capabilities: ["batch", "wait"] });
        expect(
            (
                await broker.execute("b", {
                    action: "batch",
                    steps: [
                        { action: "fill", ref: "r1", text: "x".repeat(8000) },
                        { action: "fill", ref: "r2", text: "x".repeat(4001) },
                    ],
                })
            ).ok,
        ).toBe(false);
        expect(broker.control("b", { action: "poll", leaseId: secondId })).toEqual({
            ok: true,
            paused: false,
        });
        broker.close();
    });

    it("claims a supported batch once, retains partial progress and cancels waits on takeover", async () => {
        const broker = new KissopenBrowser();
        broker.control("a", { ...attach, capabilities: ["batch", "wait"] });
        const pending = broker.execute("a", {
            action: "batch",
            steps: [{ action: "click", ref: "r1" }],
        });
        const answer = broker.control("a", { action: "poll", leaseId });
        if (!answer.ok || !answer.command) throw new Error("Missing batch command");
        expect(broker.control("a", { action: "poll", leaseId })).toEqual({
            ok: true,
            paused: false,
        });
        const result = {
            ok: true,
            text: "Fresh observation",
            batch: { completedSteps: 1, totalSteps: 1, reason: "page_changed" as const },
        };
        broker.control("a", { action: "complete", leaseId, commandId: answer.command.id, result });
        expect(await pending).toEqual(result);
        const wait = broker.execute("a", { action: "wait", condition: "enabled", ref: "r2" });
        broker.control("a", { action: "pause", leaseId });
        expect((await wait).ok).toBe(false);
        broker.close();
    });
    it("rejects inconsistent batch progress without consuming the pending completion", async () => {
        const own = new KissopenBrowser();
        own.control("alice", { ...attach, capabilities: ["batch"] });
        const pending = own.execute("alice", {
            action: "batch",
            steps: [{ action: "click", ref: "r1" }],
        });
        const claimed = own.control("alice", { action: "poll", leaseId });
        if (!claimed.ok || !claimed.command) throw new Error("Missing command");
        const complete = {
            action: "complete" as const,
            leaseId,
            commandId: claimed.command.id,
            result: {
                ok: true,
                text: "Observed",
                batch: { completedSteps: 1, totalSteps: 1, reason: "completed" as const },
            },
        };
        expect(
            own.control("alice", {
                ...complete,
                result: { ...complete.result, batch: { ...complete.result.batch, totalSteps: 2 } },
            }).ok,
        ).toBe(false);
        expect(
            own.control("alice", {
                ...complete,
                result: {
                    ...complete.result,
                    batch: { ...complete.result.batch, completedSteps: 2 },
                },
            }).ok,
        ).toBe(false);
        expect(own.control("alice", complete).ok).toBe(true);
        expect(await pending).toEqual(complete.result);
        own.close();
    });
    it("isolates agents and accounts, refuses competing owners and forged completion", async () => {
        const own = new KissopenBrowser();
        const otherAccount = new KissopenBrowser();
        expect(own.control("alice", attach).ok).toBe(true);
        expect(own.control("alice", { ...attach, leaseId: "c".repeat(32) }).ok).toBe(false);
        expect(own.control("bob", { action: "poll", leaseId }).ok).toBe(false);
        expect(otherAccount.control("alice", { action: "poll", leaseId }).ok).toBe(false);
        const result = own.execute("alice", { action: "read" });
        expect(
            own.control("alice", {
                action: "complete",
                leaseId,
                commandId: "fake",
                result: { ok: true, text: "fake" },
            }).ok,
        ).toBe(false);
        const first = own.control("alice", { action: "poll", leaseId });
        expect(first.ok && first.command).toBeTruthy();
        expect(own.control("alice", { action: "poll", leaseId })).toEqual({
            ok: true,
            paused: false,
        });
        if (!first.ok || !first.command) throw new Error("Missing command");
        const complete = {
            action: "complete" as const,
            leaseId,
            commandId: first.command.id,
            result: { ok: true, text: "Observed" },
        };
        expect(own.control("alice", complete).ok).toBe(true);
        expect(await result).toEqual(complete.result);
        expect(own.control("alice", complete).ok).toBe(false);
        own.close();
        otherAccount.close();
    });

    it("pause cancels pending work, rejects new actions and requires explicit resume", async () => {
        const own = new KissopenBrowser();
        own.control("alice", attach);
        const result = own.execute("alice", { action: "click", ref: "r0" });
        own.control("alice", { action: "pause", leaseId });
        expect((await result).ok).toBe(false);
        expect((await own.execute("alice", { action: "read" })).ok).toBe(false);
        expect(own.control("alice", { action: "poll", leaseId })).toEqual({
            ok: true,
            paused: true,
        });
        expect(own.control("alice", { action: "resume", leaseId })).toEqual({
            ok: true,
            paused: false,
        });
        own.close();
    });

    it("revoke and expiration cannot be revived by stale attachments", async () => {
        vi.useFakeTimers();
        const own = new KissopenBrowser();
        own.control("alice", attach);
        own.control("alice", { action: "revoke", leaseId });
        expect(own.control("alice", attach).ok).toBe(false);
        const next = { ...attach, leaseId: "d".repeat(32) };
        expect(own.control("alice", next).ok).toBe(true);
        await vi.advanceTimersByTimeAsync(45001);
        expect(own.control("alice", { action: "resume", leaseId: next.leaseId }).ok).toBe(false);
        expect(own.control("alice", next).ok).toBe(false);
        own.close();
    });

    it("refuses an attach that arrives after its revoke", () => {
        const own = new KissopenBrowser();
        own.control("alice", { action: "revoke", leaseId });
        expect(own.control("alice", attach).ok).toBe(false);
        own.close();
    });

    it("times out without replaying a claimed action", async () => {
        vi.useFakeTimers();
        broker.control("alice", attach);
        const result = broker.execute("alice", { action: "click", ref: "r0" });
        broker.control("alice", { action: "poll", leaseId });
        await vi.advanceTimersByTimeAsync(25001);
        expect(await result).toMatchObject({ ok: false, text: expect.stringContaining("unknown") });
        expect(broker.control("alice", { action: "poll", leaseId })).toEqual({
            ok: true,
            paused: false,
        });
    });
});
