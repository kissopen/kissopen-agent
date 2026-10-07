import { describe, expect, it, vi, afterEach } from "vitest";
import { LocalScheduledTasksModule } from "../../sources/localScheduledTasks/LocalScheduledTasksModule.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import { TestAgents } from "./support/schedulingHarness.js";
import { cuid2Schema, type AgentModuleScope } from "@kissopen/kissopen-agent-base";
import { Value } from "@sinclair/typebox/value";
import { nextLocalTaskTime } from "../../sources/localScheduledTasks/localTaskTime.js";
import type { HistoryModule } from "../../sources/history/index.js";
import { withTeamUser, type TeamModule } from "../../sources/team/index.js";

afterEach(() => vi.useRealTimers());
describe("local tasks do not require a commercial account", () => {
    it("commits an interval task, deduplicates creation and dispatches once", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 9, 6) });
        const durable = new DurableFunctionsModule();
        const agents = new TestAgents();
        Object.assign(agents, { config: async () => ({ metadata: {} }) });
        const tasks = new LocalScheduledTasksModule(durable);
        const db = moduleDatabase([...durable.migrations, ...tasks.migrations], "local-tasks");
        await db.ready;
        const durableHooks = await resolveModuleHooks(db.context, durable, agents.ref);
        const hooks = await resolveModuleHooks(db.context, tasks, agents.ref);
        try {
            await durableHooks.afterStart?.(db.context, {} as never);
            const input = {
                id: "task-one",
                agentId: "secretary",
                name: "Reminder",
                instruction: "Send a reminder",
                rule: {
                    recurrence: "interval" as const,
                    intervalMinutes: 1,
                    timezone: "Asia/Shanghai",
                },
            };
            const created = await tasks.create(db.context, input);
            expect(created.nextRunAt).toBe(Date.now() + 60000);
            expect(await tasks.create(db.context, input)).toEqual(created);
            expect((await tasks.list(db.context)).tasks).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(60000);
            await tasks.tick(db.context);
            await vi.advanceTimersByTimeAsync(0);
            await tasks.tick(db.context);
            expect(agents.delivered).toHaveLength(1);
            const runs = await tasks.runs(db.context, created.id);
            expect(runs.runs).toHaveLength(1);
            expect(runs.runs[0]!.status).toBe("queued");
            expect(agents.delivered[0]!.id).toBe(runs.runs[0]!.messageId);
            expect(Value.Check(cuid2Schema, runs.runs[0]!.messageId)).toBe(true);
            await tasks.update(db.context, created.id, { status: "paused" });
            await vi.advanceTimersByTimeAsync(60000);
            await tasks.tick(db.context);
            expect(agents.delivered).toHaveLength(1);
        } finally {
            tasks.stop();
            durable.stop();
            db.close();
        }
    });
    it("recovers a queued delivery once across module restart and skips stale occurrences", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 9, 6) });
        const durable = new DurableFunctionsModule();
        const tasks = new LocalScheduledTasksModule(durable);
        const agents = new TestAgents();
        Object.assign(agents, { config: async () => ({ metadata: {} }) });
        const db = moduleDatabase([...durable.migrations, ...tasks.migrations], "local-recovery");
        await db.ready;
        await resolveModuleHooks(db.context, tasks, agents.ref);
        let recoveredTasks: LocalScheduledTasksModule | undefined;
        let recoveredDurable: DurableFunctionsModule | undefined;
        try {
            const input = {
                id: "recovery",
                agentId: "secretary",
                name: "Reminder",
                instruction: "Send a reminder",
                rule: { recurrence: "interval" as const, intervalMinutes: 1, timezone: "UTC" },
            };
            await tasks.create(db.context, input);
            await vi.advanceTimersByTimeAsync(60000);
            await tasks.tick(db.context);
            expect(agents.delivered).toHaveLength(0);
            tasks.stop();
            durable.stop();
            recoveredDurable = new DurableFunctionsModule();
            recoveredTasks = new LocalScheduledTasksModule(recoveredDurable);
            const hook = await resolveModuleHooks(db.context, recoveredDurable, agents.ref);
            await resolveModuleHooks(db.context, recoveredTasks, agents.ref);
            await hook.afterStart?.(db.context, {} as never);
            await vi.advanceTimersByTimeAsync(0);
            expect(agents.delivered).toHaveLength(1);
            await recoveredTasks.tick(db.context);
            expect(agents.delivered).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(10 * 60000);
            await recoveredTasks.tick(db.context);
            const runs = (await recoveredTasks.runs(db.context, input.id)).runs;
            expect(runs).toHaveLength(2);
            expect(runs[0]!.status).toBe("missed");
            expect((await recoveredTasks.get(db.context, input.id)).nextRunAt).toBe(
                Date.now() + 60000,
            );
        } finally {
            tasks.stop();
            durable.stop();
            recoveredTasks?.stop();
            recoveredDurable?.stop();
            db.close();
        }
    });
    it("keeps accepted work running until settlement and cancels pending work on clear", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 9, 6) });
        const durable = new DurableFunctionsModule();
        const history = {
            message: async () => ({ runId: "inference" }),
            run: async () => ({ status: "running" }),
        };
        const tasks = new LocalScheduledTasksModule(durable, history as unknown as HistoryModule);
        const agents = new TestAgents();
        Object.assign(agents, { config: async () => ({ metadata: {} }) });
        const db = moduleDatabase([...durable.migrations, ...tasks.migrations], "local-settlement");
        await db.ready;
        const hooks = await resolveModuleHooks(db.context, tasks, agents.ref);
        const scope = { agent: { id: "secretary" } } as AgentModuleScope;
        try {
            await tasks.create(db.context, {
                id: "settlement",
                agentId: "secretary",
                name: "Task",
                instruction: "Do the work",
                rule: { recurrence: "interval", intervalMinutes: 1, timezone: "UTC" },
            });
            const run = await tasks.runNow(db.context, "settlement", "manual-one");
            expect(await tasks.runNow(db.context, "settlement", "manual-one")).toEqual(run);
            await expect(tasks.runNow(db.context, "settlement", "manual-two")).rejects.toThrow(
                "already active",
            );
            await hooks.messageAcceptedTransact?.(db.context, scope, {
                id: run.messageId,
                metadata: { localScheduledRunId: run.id },
            } as never);
            await hooks.afterAgentSettledTransact?.(db.context, scope, {} as never);
            expect((await tasks.runs(db.context, "settlement")).runs[0]!.status).toBe("running");
            history.run = async () => ({ status: "completed" });
            await hooks.afterAgentSettledTransact?.(db.context, scope, {} as never);
            expect((await tasks.list(db.context)).tasks[0]!.lastRun?.status).toBe("succeeded");
            await vi.advanceTimersByTimeAsync(1);
            await tasks.runNow(db.context, "settlement", "manual-two");
            await hooks.conversationClearedTransact?.(db.context, scope);
            expect((await tasks.runs(db.context, "settlement")).runs[0]!.status).toBe("cancelled");
            expect((await tasks.get(db.context, "settlement")).status).toBe("paused");
        } finally {
            tasks.stop();
            durable.stop();
            db.close();
        }
    });
    it("validates timing and revisions, paginates, and detects conflicting retries", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 9, 6) });
        const durable = new DurableFunctionsModule();
        const tasks = new LocalScheduledTasksModule(durable);
        const agents = new TestAgents();
        Object.assign(agents, { config: async () => ({ metadata: {} }) });
        const db = moduleDatabase([...durable.migrations, ...tasks.migrations], "local-validation");
        await db.ready;
        await resolveModuleHooks(db.context, tasks, agents.ref);
        try {
            const input = {
                id: "a",
                agentId: "secretary",
                name: "Task",
                instruction: "Do work",
                rule: { recurrence: "interval" as const, intervalMinutes: 1, timezone: "UTC" },
            };
            await expect(
                tasks.create(db.context, {
                    ...input,
                    rule: { recurrence: "daily", timezone: "UTC" },
                }),
            ).rejects.toMatchObject({ status: 400 });
            await tasks.create(db.context, input);
            await expect(
                tasks.create(db.context, { ...input, name: "Different" }),
            ).rejects.toMatchObject({ status: 409 });
            await tasks.create(db.context, { ...input, id: "b" });
            const page = await tasks.list(db.context, "", 1);
            expect(page.tasks[0]!.id).toBe("a");
            expect(page.nextCursor).toBe("a");
            expect((await tasks.list(db.context, page.nextCursor!, 1)).tasks[0]!.id).toBe("b");
            await tasks.update(db.context, "a", { status: "paused", revision: 1 });
            await expect(
                tasks.update(db.context, "a", { status: "active", revision: 1 }),
            ).rejects.toMatchObject({ status: 409 });
            expect(
                (
                    await tasks.create(db.context, {
                        ...input,
                        rule: { timezone: "UTC", intervalMinutes: 1, recurrence: "interval" },
                    })
                ).status,
            ).toBe("paused");
        } finally {
            tasks.stop();
            durable.stop();
            db.close();
        }
    });
    it("pauses owed but not-yet-accepted work without cancelling a running Agent", async () => {
        const durable = new DurableFunctionsModule();
        const tasks = new LocalScheduledTasksModule(durable);
        const agents = new TestAgents();
        Object.assign(agents, { config: async () => ({ metadata: {} }) });
        const db = moduleDatabase([...durable.migrations, ...tasks.migrations], "local-pause");
        await db.ready;
        const hooks = await resolveModuleHooks(db.context, tasks, agents.ref);
        try {
            await tasks.create(db.context, {
                id: "pause",
                agentId: "secretary",
                name: "Task",
                instruction: "Do work",
                rule: { recurrence: "interval", intervalMinutes: 1, timezone: "UTC" },
            });
            await tasks.runNow(db.context, "pause", "queued-before-pause");
            await tasks.update(db.context, "pause", { status: "paused" });
            expect((await tasks.runs(db.context, "pause")).runs[0]!.status).toBe("cancelled");
            const run = await tasks.runNow(db.context, "pause", "explicit-while-paused");
            await hooks.messageAcceptedTransact?.(
                db.context,
                { agent: { id: "secretary" } } as AgentModuleScope,
                { id: run.messageId, metadata: { localScheduledRunId: run.id } } as never,
            );
            await tasks.update(db.context, "pause", { status: "ended" });
            expect(
                (await tasks.runs(db.context, "pause")).runs.find((r) => r.id === run.id)?.status,
            ).toBe("running");
        } finally {
            tasks.stop();
            durable.stop();
            db.close();
        }
    });
});

describe("local calendar rules", () => {
    it("supports minute intervals and skips weekends", () => {
        expect(
            nextLocalTaskTime(
                { recurrence: "interval", intervalMinutes: 1, timezone: "UTC" },
                1000,
            ),
        ).toBe(61000);
        expect(
            nextLocalTaskTime(
                { recurrence: "weekdays", atMinute: 9 * 60, timezone: "Asia/Shanghai" },
                Date.UTC(2026, 9, 9, 2),
            ),
        ).toBe(Date.UTC(2026, 9, 12, 1));
    });
    it("does not replay the repeated DST clock hour, and skips nonexistent clock minutes", () => {
        expect(
            nextLocalTaskTime(
                { recurrence: "daily", atMinute: 90, timezone: "America/New_York" },
                Date.UTC(2026, 10, 1, 5, 30),
            ),
        ).toBe(Date.UTC(2026, 10, 2, 6, 30));
        expect(
            nextLocalTaskTime(
                { recurrence: "daily", atMinute: 150, timezone: "America/New_York" },
                Date.UTC(2026, 2, 8, 5),
            ),
        ).toBe(Date.UTC(2026, 2, 9, 6, 30));
    });
});

it("isolates team-owned tasks and rejects unauthenticated management", async () => {
    const durable = new DurableFunctionsModule();
    const tasks = new LocalScheduledTasksModule(durable, undefined, undefined, {
        enabled: true,
    } as TeamModule);
    const agents = new TestAgents();
    Object.assign(agents, { config: async () => ({ metadata: {} }) });
    const db = moduleDatabase([...durable.migrations, ...tasks.migrations], "local-owners");
    await db.ready;
    await resolveModuleHooks(db.context, tasks, agents.ref);
    const member = (id: string) =>
        withTeamUser(db.context, {
            id,
            workosUserId: id,
            firstName: "Test",
            lastName: null,
            email: "test@example.com",
            isOwner: false,
            photo: null,
            createdAt: 0,
            updatedAt: 0,
            version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
        });
    try {
        await expect(tasks.list(db.context)).rejects.toMatchObject({ status: 401 });
        const owner = member("one");
        const other = member("two");
        await tasks.create(owner, {
            id: "private",
            agentId: "secretary",
            name: "Private",
            instruction: "Do work",
            rule: { recurrence: "interval", intervalMinutes: 1, timezone: "UTC" },
        });
        expect((await tasks.list(other)).tasks).toEqual([]);
        await expect(tasks.get(other, "private")).rejects.toMatchObject({ status: 404 });
        await expect(tasks.update(other, "private", { status: "paused" })).rejects.toMatchObject({
            status: 404,
        });
        await expect(tasks.runNow(other, "private", "unauthorized-run")).rejects.toMatchObject({
            status: 404,
        });
        expect((await tasks.get(owner, "private")).status).toBe("active");
    } finally {
        tasks.stop();
        durable.stop();
        db.close();
    }
});
