import { withAgentContext } from "@kissopen/kissopen-agent-base";
import { describe, expect, it } from "vitest";
import { GoalModule } from "../../sources/goal/GoalModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { recordingAgents } from "./recordingAgents.js";
import { HistoryModule } from "../../sources/history/index.js";
import { TasksModule } from "../../sources/tasks/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { AutonomyBudget } from "../../sources/autonomy/index.js";
import { testConfig } from "../support/computeModule.js";
import { writeExecution } from "../../sources/goal/impl/executionState.js";
import { ensureAgentDatabaseConnection } from "@kissopen/kissopen-agent-base";
import { formatExecutionForModel } from "../../sources/goal/impl/formatExecutionForModel.js";

function store() {
    const values = new Map<string, unknown>();
    return {
        read: async (_ctx: unknown, key: string) => values.get(key),
        write: async (_ctx: unknown, key: string, value: unknown) => {
            values.set(key, structuredClone(value));
        },
        delete: async (_ctx: unknown, key: string) => {
            values.delete(key);
        },
    };
}

describe("Goal execution", () => {
    it("handles an inference failure in the real hook order without parking the goal", async () => {
        const goal = new GoalModule();
        const db = moduleDatabase(goal.migrations, "goal-failure-hook-order");
        await db.ready;
        const agents = recordingAgents();
        const hooks = goal.beforeStart(db.context, agents.ref);
        const ctx = withAgentContext(db.context, {
            id: "agent-a",
            provider: "scripted",
            permissionMode: "auto",
        });
        const scope = { agent: { id: "agent-a" }, runKV: store() } as never;
        try {
            await goal.setGoal(ctx, "agent-a", "Finish and verify the report");
            await hooks.beforeAgentLoopTransact!(ctx, scope, { loopId: "loop-a" });
            await hooks.afterInferenceTransact!(ctx, scope, { state: "error" } as never);
            await hooks.afterTurnTransact!(ctx, scope, { aborted: false } as never);
            await hooks.afterAgentLoop!(ctx, scope, { loopId: "loop-a" });
            expect(await goal.goal(ctx, "agent-a")).toMatchObject({ status: "active" });
        } finally {
            db.close();
        }
    });

    async function setup(name: string) {
        const history = new HistoryModule();
        const tasks = new TasksModule();
        const durable = new DurableFunctionsModule();
        const goal = new GoalModule(tasks, history, durable);
        const db = moduleDatabase(
            [...history.migrations, ...tasks.migrations, ...durable.migrations, ...goal.migrations],
            name,
        );
        ensureAgentDatabaseConnection(db.database);
        await db.ready;
        const agents = recordingAgents();
        const durableHooks = durable.beforeStart(db.context);
        const hooks = goal.beforeStart(db.context, agents.ref);
        const ctx = withAgentContext(db.context, {
            id: "agent-a",
            provider: "scripted",
            permissionMode: "auto",
        });
        const scope = { agent: { id: "agent-a" }, runKV: store() } as never;
        await goal.setGoal(ctx, "agent-a", "Deliver and verify the report");
        return {
            history,
            tasks,
            durable,
            goal,
            db,
            agents,
            hooks,
            durableHooks,
            ctx,
            scope,
            close: () => {
                durable.stop();
                db.close();
            },
        };
    }

    it("binds tasks without relying on model metadata and keeps identity and usage after pause/reload", async () => {
        const f = await setup("goal-identity-reload");
        try {
            await f.tasks.create(f.ctx, "agent-a", { id: "step-a", title: "Write report" });
            const original = (await f.goal.execution(f.ctx, "agent-a"))!;
            expect(original.taskIds).toEqual(["step-a"]);
            await f.goal.chargeAutonomy(f.ctx, "agent-a", "action");
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "paused");
            const reloaded = new GoalModule(f.tasks, f.history);
            reloaded.beforeStart(f.db.context, f.agents.ref);
            await reloaded.changeGoalStatus(f.ctx, "agent-a", "active");
            expect(await reloaded.execution(f.ctx, "agent-a")).toMatchObject({
                goalId: original.goalId,
                taskIds: ["step-a"],
                budget: { actions: 1 },
            });
        } finally {
            f.close();
        }
    });

    it("rejects fabricated evidence and remaining tasks, then completes with an actual delivered result", async () => {
        const f = await setup("goal-acceptance-gate");
        try {
            await f.tasks.create(f.ctx, "agent-a", { id: "verify-a", title: "Verify report" });
            await expect(
                f.goal.updatePlan(f.ctx, "agent-a", {
                    revision: 1,
                    evidence: [{ criterionId: "result", historyPosition: 20, conclusion: "Done" }],
                }),
            ).rejects.toThrow("does not exist");
            await f.history.record(f.ctx, "agent-a", {
                role: "assistant",
                blocks: [{ type: "text", text: "The complete report is delivered here." }],
            });
            await f.goal.updatePlan(f.ctx, "agent-a", {
                revision: 1,
                evidence: [
                    {
                        criterionId: "result",
                        historyPosition: 0,
                        conclusion: "Report delivered and checked.",
                    },
                ],
            });
            await expect(f.goal.completeGoal(f.ctx, "agent-a", 1)).rejects.toThrow(
                "required tasks",
            );
            await f.tasks.complete(f.ctx, "agent-a", "verify-a");
            expect(await f.goal.completeGoal(f.ctx, "agent-a", 1)).toMatchObject({
                status: "complete",
            });
        } finally {
            f.close();
        }
    });

    it("invalidates evidence on a human requirement revision and rejects autonomous weakening", async () => {
        const f = await setup("goal-revision-gate");
        try {
            await f.history.record(f.ctx, "agent-a", {
                role: "assistant",
                blocks: [{ type: "text", text: "First report" }],
            });
            await f.goal.updatePlan(f.ctx, "agent-a", {
                revision: 1,
                evidence: [
                    {
                        criterionId: "result",
                        historyPosition: 0,
                        conclusion: "First version delivered",
                    },
                ],
            });
            await expect(
                f.goal.updatePlan(f.ctx, "agent-a", { revision: 1, objective: "Just say done" }),
            ).rejects.toThrow("new human instruction");
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "human-revision",
                message: { role: "user", content: [{ type: "text", text: "加上中英文两个版本" }] },
                metadata: { messageOrigin: "user" },
            } as never);
            await f.goal.updatePlan(f.ctx, "agent-a", {
                revision: 1,
                objective: "Deliver Chinese and English reports",
            });
            expect(await f.goal.execution(f.ctx, "agent-a")).toMatchObject({
                revision: 2,
                evidence: [],
            });
            await expect(f.goal.completeGoal(f.ctx, "agent-a", 1)).rejects.toThrow("Stale");
            await expect(f.goal.completeGoal(f.ctx, "agent-a", 2)).rejects.toThrow(
                "Missing verified",
            );
            await expect(
                f.goal.updatePlan(f.ctx, "agent-a", {
                    revision: 2,
                    evidence: [
                        { criterionId: "result", historyPosition: 0, conclusion: "Old report" },
                    ],
                }),
            ).rejects.toThrow("predates");
        } finally {
            f.close();
        }
    });

    it("does not let synthetic input resume or replenish a paused goal; a human resume continues the same goal", async () => {
        const f = await setup("goal-human-control");
        try {
            await f.goal.chargeAutonomy(f.ctx, "agent-a", "action");
            const original = (await f.goal.execution(f.ctx, "agent-a"))!;
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "paused");
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "fake-human",
                message: { role: "user", content: [{ type: "text", text: "继续" }] },
                metadata: { messageOrigin: "agent" },
            } as never);
            await expect(f.goal.controlGoal(f.ctx, "agent-a", "resume")).rejects.toThrow(
                "human instruction",
            );
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "actual-human",
                message: { role: "user", content: [{ type: "text", text: "继续" }] },
                metadata: { messageOrigin: "user" },
            } as never);
            const tools = await f.hooks.tools!(f.ctx, f.scope);
            const resume = tools.find((tool) => tool.name === "control_goal")!;
            await resume.execute(f.ctx, { action: "resume" }, { id: "resume-call" } as never);
            expect(await f.goal.execution(f.ctx, "agent-a")).toMatchObject({
                goalId: original.goalId,
                budget: { actions: 1 },
            });
            await f.hooks.afterInferenceTransact!(f.ctx, f.scope, { state: "normal" } as never);
            expect(
                await f.hooks.afterAgentLoop!(f.ctx, f.scope, { loopId: "resumed-loop" }),
            ).toHaveLength(1);
            await expect(f.goal.controlGoal(f.ctx, "agent-a", "resume")).rejects.toThrow(
                "already applied",
            );
        } finally {
            f.close();
        }
    });

    it("persists exhausted inference limits before stopping and keeps ordinary messages from resetting them", async () => {
        const f = await setup("goal-inference-allowance");
        try {
            const execution = (await f.goal.execution(f.ctx, "agent-a"))!;
            execution.budget.inferenceLimit = 0;
            await writeExecution(f.ctx, "agent-a", execution);
            await expect(
                f.hooks.beforeInference!(f.ctx, f.scope, { inferenceId: "request-a" } as never),
            ).rejects.toThrow("allowance exhausted");
            expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "paused" });
            expect(f.agents.aborts).toEqual(["agent-a"]);
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "status-question",
                message: { role: "user", content: [{ type: "text", text: "做到哪里了？" }] },
                metadata: { messageOrigin: "user" },
            } as never);
            // Accepting a human status question opens a conversational turn, not a
            // control mutation. The model must request an explicitly reviewed resume.
            const tools = await f.hooks.tools!(f.ctx, f.scope);
            const resume = tools.find((tool) => tool.name === "control_goal")!;
            expect(await resume.shouldReviewInAutoMode({ action: "resume" }, f.ctx)).toBe(true);
            expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "paused" });
            expect((await f.goal.execution(f.ctx, "agent-a"))?.budget.inferenceLimit).toBe(0);
        } finally {
            f.close();
        }
    });

    it.each([
        "自己操作，不要再问我。",
        "真人验证及确认条款也自动完成。",
        "Handle it yourself; I have approved the remaining steps.",
    ])(
        "resumes from human execution intent without requiring a fixed keyword: %s",
        async (text) => {
            const f = await setup("goal-semantic-control");
            try {
                const original = (await f.goal.execution(f.ctx, "agent-a"))!;
                await f.goal.changeGoalStatus(f.ctx, "agent-a", "blocked");
                await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                    id: "current-human",
                    message: { role: "user", content: [{ type: "text", text }] },
                    metadata: { messageOrigin: "user" },
                } as never);
                await f.goal.controlGoal(f.ctx, "agent-a", "resume");
                expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "active" });
                expect(await f.goal.execution(f.ctx, "agent-a")).toMatchObject({
                    goalId: original.goalId,
                });
            } finally {
                f.close();
            }
        },
    );

    it("does not reuse an earlier human control instruction after automatic input", async () => {
        const f = await setup("goal-current-control-authority");
        try {
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "earlier-human",
                message: { role: "user", content: [{ type: "text", text: "自己操作" }] },
                metadata: { messageOrigin: "user" },
            } as never);
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "paused");
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "automatic-wake",
                message: { role: "user", content: [{ type: "text", text: "继续" }] },
                metadata: { messageOrigin: "agent" },
            } as never);
            await expect(f.goal.controlGoal(f.ctx, "agent-a", "resume")).rejects.toThrow(
                "current human instruction",
            );
        } finally {
            f.close();
        }
    });

    it("returns failed control calls to inference instead of treating them as explicit stops", async () => {
        const f = await setup("goal-failed-control-recovery");
        try {
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "blocked");
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "current-human",
                message: { role: "user", content: [{ type: "text", text: "自己操作" }] },
                metadata: { messageOrigin: "user" },
            } as never);
            const aborts = f.agents.aborts.length;
            await f.hooks.beforeToolCallTransact!(f.ctx, f.scope, {
                callId: "failed-control",
                name: "control_goal",
                arguments: { action: "resume" },
            } as never);
            await f.hooks.afterToolCallTransact!(f.ctx, f.scope, {
                callId: "failed-control",
                isError: true,
                content: [{ type: "text", text: "Control was not applied" }],
            } as never);
            await expect(
                f.hooks.beforeInferenceTransact!(f.ctx, f.scope, {} as never),
            ).resolves.toBeUndefined();
            expect(f.agents.aborts.length).toBe(aborts);
            expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "blocked" });
        } finally {
            f.close();
        }
    });

    it("uses goal allowances beyond six wakes and retains ordinary conversation limits", async () => {
        const f = await setup("goal-autonomy-allowance");
        try {
            const autonomy = new AutonomyBudget(testConfig, f.goal);
            autonomy.beforeStart(f.db.context, { parentOf: async () => null } as never);
            for (let i = 0; i < 8; i++)
                expect(await autonomy.wake(f.ctx, "agent-a")).toBeUndefined();
            autonomy.reset("agent-a");
            expect((await f.goal.execution(f.ctx, "agent-a"))?.budget.continuations).toBe(8);
            for (let i = 0; i < 6; i++)
                expect(await autonomy.wake(f.ctx, "ordinary")).toBeUndefined();
            expect(await autonomy.wake(f.ctx, "ordinary")).toContain("自动推进上限");
        } finally {
            f.close();
        }
    });

    it("parks without autonomous polling and makes duplicate or stopped wake events harmless", async () => {
        const f = await setup("goal-durable-wait");
        try {
            await f.hooks.beforeAgentLoopTransact!(f.ctx, f.scope, { loopId: "loop-a" });
            await f.hooks.afterInferenceTransact!(f.ctx, f.scope, { state: "normal" } as never);
            await f.goal.waitForGoal(f.ctx, "agent-a", 1, "Wait for the report builder");
            const waitId = (await f.goal.execution(f.ctx, "agent-a"))!.wait!.id;
            expect(
                await f.hooks.afterAgentLoop!(f.ctx, f.scope, { loopId: "loop-a" }),
            ).toBeUndefined();
            expect(await f.goal.wakeGoal(f.db.context, "agent-a", waitId)).toBe(true);
            expect(await f.goal.wakeGoal(f.db.context, "agent-a", waitId)).toBe(false);
            expect(f.agents.wakes).toHaveLength(1);
            expect(f.agents.wakes[0]?.metadata).toMatchObject({ messageOrigin: "agent" });
            await f.goal.waitForGoal(f.ctx, "agent-a", 1, "Second wait");
            const stoppedWait = (await f.goal.execution(f.ctx, "agent-a"))!.wait!.id;
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "paused");
            expect(await f.goal.wakeGoal(f.db.context, "agent-a", stoppedWait)).toBe(false);
        } finally {
            f.close();
        }
    });

    it("recovers a pending durable recheck with new module instances", async () => {
        const f = await setup("goal-wait-restart");
        const restartedDurable = new DurableFunctionsModule();
        try {
            await f.goal.waitForGoal(f.ctx, "agent-a", 1, "Waiting across restart");
            f.durable.stop();
            const recovered = new GoalModule(undefined, f.history, restartedDurable);
            const durableHooks = restartedDurable.beforeStart(f.db.context);
            recovered.beforeStart(f.db.context, f.agents.ref);
            await durableHooks.afterStart!(f.db.context, f.agents.ref);
            await expect.poll(() => f.agents.wakes.length, { timeout: 3_000 }).toBe(1);
            expect((await recovered.execution(f.ctx, "agent-a"))?.phase).toBe("executing");
        } finally {
            restartedDurable.stop();
            f.close();
        }
    });

    it("rejects stale activation messages without pausing a newer goal activation", async () => {
        const f = await setup("goal-obsolete-activation");
        try {
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "paused");
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "active");
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "obsolete-wake",
                message: { role: "user", content: [{ type: "text", text: "Continue" }] },
                metadata: {
                    messageOrigin: "agent",
                    goalLifecycleId: "old-activation",
                    goalRevision: 1,
                },
            } as never);
            await f.hooks.prepareInference!(f.ctx, f.scope, {} as never);
            await expect(
                f.hooks.beforeInferenceTransact!(f.ctx, f.scope, {} as never),
            ).rejects.toThrow("obsolete");
            await f.hooks.afterTurnTransact!(f.ctx, f.scope, { aborted: true } as never);
            expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "active" });
            expect(await f.hooks.afterAgentLoop!(f.ctx, f.scope, {} as never)).toBeUndefined();
        } finally {
            f.close();
        }
    });

    it("stops repeated identical failures and rounds consisting only of goal bookkeeping", async () => {
        const f = await setup("goal-progress-detector");
        try {
            for (let i = 0; i < 6; i++) {
                await f.hooks.beforeToolCallTransact!(f.ctx, f.scope, {
                    callId: `failed-${i}`,
                    name: "write_report",
                    arguments: { destination: "missing" },
                } as never);
                await f.hooks.afterToolCallTransact!(f.ctx, f.scope, {
                    callId: `failed-${i}`,
                    content: [{ type: "text", text: "Missing destination" }],
                    isError: true,
                } as never);
            }
            expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "blocked" });
            await f.goal.changeGoalStatus(f.ctx, "agent-a", "active");
            for (let i = 0; i < 5; i++) {
                await f.hooks.beforeAgentLoopTransact!(f.ctx, f.scope, {} as never);
                await f.hooks.beforeToolCallTransact!(f.ctx, f.scope, {
                    callId: `read-${i}`,
                    name: "get_goal",
                    arguments: {},
                } as never);
                await f.hooks.afterToolCallTransact!(f.ctx, f.scope, {
                    callId: `read-${i}`,
                    content: [{ type: "text", text: `Allowance ${i}` }],
                } as never);
                await f.hooks.afterInferenceTransact!(f.ctx, f.scope, {
                    inferenceId: `idle-${i}`,
                    state: "normal",
                } as never);
                await f.hooks.afterAgentLoop!(f.ctx, f.scope, {} as never);
            }
            expect(await f.goal.goal(f.ctx, "agent-a")).toMatchObject({ status: "blocked" });
            expect((await f.goal.execution(f.ctx, "agent-a"))?.reason).toContain(
                "Five autonomous rounds",
            );
        } finally {
            f.close();
        }
    });

    it("requires real verification results and does not count repeated evidence as new progress", async () => {
        const f = await setup("goal-current-evidence");
        try {
            await f.hooks.beforeToolCallTransact!(f.ctx, f.scope, {
                callId: "verifiedcall",
                name: "verify_report",
                arguments: {},
            } as never);
            await f.hooks.afterToolCallTransact!(f.ctx, f.scope, {
                callId: "verifiedcall",
                content: [{ type: "text", text: "Report verified" }],
            } as never);
            await f.history.record(f.ctx, "agent-a", {
                role: "assistant",
                blocks: [
                    {
                        type: "tool_result",
                        callId: "verifiedcall",
                        toolName: "verify_report",
                        output: "Report verified",
                        display: "Verified",
                    },
                ],
            });
            const evidence = {
                criterionId: "result",
                historyPosition: 0,
                callId: "verifiedcall",
                conclusion: "Saved report was read back",
            };
            await f.goal.updatePlan(f.ctx, "agent-a", { revision: 1, evidence: [evidence] });
            const activity = (await f.goal.execution(f.ctx, "agent-a"))!.activity;
            await f.goal.updatePlan(f.ctx, "agent-a", {
                revision: 1,
                evidence: [{ ...evidence, conclusion: "Same verification, renamed" }],
            });
            expect((await f.goal.execution(f.ctx, "agent-a"))?.activity).toBe(activity);
            await f.hooks.beforeToolCallTransact!(f.ctx, f.scope, {
                callId: "bookkeeping",
                name: "get_goal",
                arguments: {},
            } as never);
            await f.hooks.afterToolCallTransact!(f.ctx, f.scope, {
                callId: "bookkeeping",
                content: [{ type: "text", text: "Active" }],
            } as never);
            await f.history.record(f.ctx, "agent-a", {
                role: "assistant",
                blocks: [
                    {
                        type: "tool_result",
                        callId: "bookkeeping",
                        toolName: "get_goal",
                        output: "Active",
                        display: "Active",
                    },
                ],
            });
            await expect(
                f.goal.updatePlan(f.ctx, "agent-a", {
                    revision: 1,
                    evidence: [{ ...evidence, historyPosition: 1, callId: "bookkeeping" }],
                }),
            ).rejects.toThrow("bookkeeping");
        } finally {
            f.close();
        }
    });

    it("preserves measured usage without inventing missing token counts or charging duplicate inference settlement", async () => {
        const f = await setup("goal-usage-idempotency");
        try {
            const inference = {
                inferenceId: "measured-request",
                state: "normal",
                tokens: { input: 20, output: 5 },
            };
            await f.hooks.afterInferenceTransact!(f.ctx, f.scope, inference as never);
            await f.hooks.afterInferenceTransact!(f.ctx, f.scope, inference as never);
            await f.hooks.afterInferenceTransact!(f.ctx, f.scope, {
                inferenceId: "unmeasured-request",
                state: "normal",
            } as never);
            expect((await f.goal.execution(f.ctx, "agent-a"))?.budget).toMatchObject({
                tokens: 25,
                missingUsage: 1,
            });
        } finally {
            f.close();
        }
    });

    it("bounds model state without losing identity or emitting malformed JSON", async () => {
        const f = await setup("goal-bounded-state");
        try {
            const adopted = (await f.goal.execution(f.ctx, "agent-a"))!;
            adopted.criteria = Array.from({ length: 32 }, (_, i) => ({
                id: `${i}${"\u0000".repeat(70)}`,
                description: "\u0000".repeat(2000),
            }));
            adopted.summary = "\u0000".repeat(2000);
            const formatted = formatExecutionForModel(adopted);
            expect(formatted.length).toBeLessThanOrEqual(6000);
            expect(JSON.parse(formatted)).toMatchObject({ goalId: adopted.goalId });
        } finally {
            f.close();
        }
    });

    it("does not let the model erase an unfinished goal to reset its allowance", async () => {
        const f = await setup("goal-explicit-abandonment");
        try {
            await expect(f.goal.abandonGoal(f.ctx, "agent-a")).rejects.toThrow("explicit human");
            await f.hooks.messageAcceptedTransact!(f.ctx, f.scope, {
                id: "abandon-human",
                message: { role: "user", content: [{ type: "text", text: "放弃这个任务" }] },
                metadata: { messageOrigin: "user" },
            } as never);
            expect(await f.goal.abandonGoal(f.ctx, "agent-a")).toBe(true);
            await f.goal.setGoal(f.ctx, "agent-a", "Another task");
            await expect(f.goal.abandonGoal(f.ctx, "agent-a")).rejects.toThrow("already applied");
        } finally {
            f.close();
        }
    });
});
