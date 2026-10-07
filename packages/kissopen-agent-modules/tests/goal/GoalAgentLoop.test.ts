import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AgentProviders,
    AgentStorage,
    AgentSystemLocal,
    defineAgentTool,
    type AgentModule,
} from "@kissopen/kissopen-agent-base";
import {
    BaseProvider,
    BaseSession,
    type SessionOptions,
    type SessionEvent,
    type SessionRunRequest,
    type SessionStream,
    type SessionCompaction,
} from "@kissopen/kissopen-providers";
import { Type } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import { GoalModule } from "../../sources/goal/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { TasksModule } from "../../sources/tasks/index.js";
import { DurableFunctionsModule } from "../../sources/durableFunctions/index.js";
import { EventsModule } from "../../sources/events/index.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { writeExecution } from "../../sources/goal/impl/executionState.js";

class GoalGymProvider extends BaseProvider {
    static override readonly name = "goal-gym";
    static override readonly inputTypes = ["text"] as const;
    static override readonly outputTypes = ["text"] as const;
    requests: SessionRunRequest[] = [];
    constructor(
        readonly next: (
            ctx: Context,
            request: SessionRunRequest,
            index: number,
        ) => Promise<SessionEvent[]>,
    ) {
        super();
    }
    async session(id: string, _options: SessionOptions): Promise<BaseSession> {
        const eventsFor = async (ctx: Context, request: SessionRunRequest) => {
            const index = this.requests.length;
            this.requests.push(request);
            return await this.next(ctx, request, index);
        };
        return new (class extends BaseSession {
            constructor() {
                super(id);
            }
            run(ctx: Context, request: SessionRunRequest): SessionStream {
                return (async function* () {
                    yield* await eventsFor(ctx, request);
                })();
            }
            async compact(): Promise<SessionCompaction> {
                throw new Error("Unexpected compaction in bounded goal gym");
            }
            destroy(): void {}
        })();
    }
}

function call(index: number, name: string, args: unknown): SessionEvent[] {
    return [
        { type: "toolcall_start", callId: `fixture-${index}`, name },
        { type: "toolcall_end", callId: `fixture-${index}`, arguments: JSON.stringify(args) },
        { type: "done", state: "tool_call", tokens: { input: 10, output: 10 } },
    ];
}
function reply(text: string): SessionEvent[] {
    return [
        { type: "text_start" },
        { type: "text_delta", delta: text },
        { type: "text_end" },
        { type: "done", state: "normal", tokens: { input: 10, output: 10 } },
    ];
}

async function gym(
    next: (ctx: Context, goal: GoalModule, index: number) => Promise<SessionEvent[]>,
    retryForever = false,
) {
    const events = new EventsModule();
    const history = new HistoryModule(events);
    const tasks = new TasksModule();
    const durable = new DurableFunctionsModule();
    const goal = new GoalModule(tasks, history, durable);
    const db = moduleDatabase([], "goal-agent-control-gym");
    await db.ready;
    const provider = new GoalGymProvider(
        async (ctx, _request, index) => await next(ctx, goal, index),
    );
    const providers = new AgentProviders();
    providers.add("scripted", provider, "gym");
    const storage = new AgentStorage({
        database: db.database,
        acquireLock: async () => ({ release: async () => {} }),
    });
    const system = await AgentSystemLocal.create(db.context, storage, {
        provider: "scripted",
        providers,
        models: [],
        retryForever,
        modules: [events, history, goal, tasks, durable],
    });
    const agent = await system.create(db.context, {}, { id: "agentgym" });
    return {
        db,
        goal,
        provider,
        agent,
        send: async (text: string) => {
            await agent.send(
                db.context,
                { role: "user", content: [{ type: "text", text }] },
                { metadata: { messageOrigin: "user" } },
            );
            await agent.waitForIdle();
        },
        close: async () => {
            await system.close(db.context);
            durable.stop();
            db.close();
        },
    };
}

describe("Goal Agent loop", () => {
    it("stops repeated identical failed actions before another provider request", async () => {
        const f = await gym(async (_ctx, _goal, index) => {
            if (index === 0)
                return call(index, "create_goal", {
                    objective: "Find a working method to write the report",
                });
            if (index <= 6) return call(index, "permanently_missing_tool", {});
            throw new Error("A blocked action loop continued");
        });
        try {
            await f.send("生成报告");
            expect(await f.goal.goal(f.db.context, f.agent.id)).toMatchObject({
                status: "blocked",
            });
            expect(
                f.provider.requests,
                JSON.stringify(await f.goal.execution(f.db.context, f.agent.id)),
            ).toHaveLength(7);
            expect((await f.goal.execution(f.db.context, f.agent.id))?.reason).toContain(
                "six times",
            );
        } finally {
            await f.close();
        }
    });
    it("answers a request only for a plan without autonomous execution", async () => {
        const f = await gym(async () =>
            reply("Here is the implementation plan; execution has not been requested."),
        );
        try {
            await f.send("只分析实施方案，暂时不要执行");
            expect(await f.goal.goal(f.db.context, f.agent.id)).toBeUndefined();
            expect(f.provider.requests).toHaveLength(1);
            expect(f.provider.requests[0]?.context?.instructions).toContain(
                "requests only for analysis or a plan do not start execution",
            );
        } finally {
            await f.close();
        }
    });

    it("stops at a persisted goal allowance even with Ethan retries, answers status, and resumes the same goal", async () => {
        const f = await gym(async (ctx, goal, index) => {
            if (index === 0)
                return call(index, "create_goal", { objective: "Write and verify the report" });
            if (index === 1) {
                const execution = (await goal.execution(ctx, "agentgym"))!;
                execution.budget.inferenceLimit = execution.budget.inferences;
                await writeExecution(ctx, "agentgym", execution);
                return reply("The report is still in progress.");
            }
            if (index === 2) return reply("Execution is paused with saved progress.");
            if (index === 3) return call(index, "control_goal", { action: "resume" });
            if (index === 4)
                return call(index, "wait_for_goal", {
                    seconds: 3600,
                    reason: "Wait for the external report builder",
                });
            if (index === 5) return reply("Waiting for the report builder; progress is saved.");
            throw new Error("An exhausted goal bypassed the execution allowance");
        }, true);
        try {
            await f.send("生成并验证报告");
            expect(
                await f.goal.goal(f.db.context, f.agent.id),
                JSON.stringify({
                    requests: f.provider.requests.length,
                    execution: await f.goal.execution(f.db.context, f.agent.id),
                }),
            ).toMatchObject({ status: "paused" });
            const original = (await f.goal.execution(f.db.context, f.agent.id))!;
            expect(f.provider.requests).toHaveLength(2);
            await f.agent.send(
                f.db.context,
                {
                    role: "user",
                    content: [
                        { type: "text", text: "An automated result arrived. Continue the report." },
                    ],
                },
                { metadata: { messageOrigin: "agent", senderAgentId: "agentgym" } },
            );
            await f.agent.waitForIdle();
            expect(f.provider.requests).toHaveLength(2);
            expect(await f.goal.goal(f.db.context, f.agent.id)).toMatchObject({ status: "paused" });
            await f.send("现在做到哪里了？");
            expect((await f.goal.execution(f.db.context, f.agent.id))?.budget.inferenceLimit).toBe(
                original.budget.inferenceLimit,
            );
            await f.send("继续完成");
            expect(await f.goal.goal(f.db.context, f.agent.id)).toMatchObject({ status: "active" });
            expect(await f.goal.execution(f.db.context, f.agent.id)).toMatchObject({
                goalId: original.goalId,
                phase: "waiting",
            });
            expect(
                (await f.goal.execution(f.db.context, f.agent.id))!.budget.inferences,
            ).toBeGreaterThan(original.budget.inferences);
            expect(f.provider.requests).toHaveLength(6);
        } finally {
            await f.close();
        }
    }, 10_000);

    it("backs off failed inference turns and blocks after three failures", async () => {
        const f = await gym(async (_ctx, _goal, index) =>
            index === 0
                ? call(index, "create_goal", {
                      objective: "Complete the report despite a transient provider failure",
                  })
                : [
                      {
                          type: "done",
                          state: "error",
                          kind: "unknown",
                          message: "Provider temporarily unavailable",
                      },
                  ],
        );
        try {
            await f.send("完成报告");
            expect(await f.goal.goal(f.db.context, f.agent.id)).toMatchObject({ status: "active" });
            expect((await f.goal.execution(f.db.context, f.agent.id))?.phase).toBe("waiting");
            await expect
                .poll(async () => (await f.goal.goal(f.db.context, f.agent.id))?.status, {
                    timeout: 9_000,
                })
                .toBe("blocked");
            await f.agent.waitForIdle();
            expect(f.provider.requests).toHaveLength(4);
            expect((await f.goal.execution(f.db.context, f.agent.id))?.budget.continuations).toBe(
                2,
            );
        } finally {
            await f.close();
        }
    }, 12_000);

    it("runs a real durable agent through failure, a changed method, autonomous continuation and acceptance", async () => {
        const folder = await mkdtemp(join(tmpdir(), "worpar-goal-gym-"));
        const events = new EventsModule();
        const history = new HistoryModule(events);
        const tasks = new TasksModule();
        const durable = new DurableFunctionsModule();
        const goal = new GoalModule(tasks, history, durable);
        const db = moduleDatabase([], "goal-agent-gym");
        await db.ready;
        const report = "中文报告\nEnglish report\n";
        let writes = 0;
        const settlements: unknown[] = [];
        const fileTools: AgentModule = {
            name: "goal-gym-files",
            beforeStart: () => ({
                afterAgentSettled: async (_ctx, _scope, settled) => {
                    settlements.push(settled);
                },
                tools: () => [
                    defineAgentTool({
                        name: "write_report",
                        parameters: Type.Object({
                            destination: Type.Union([Type.Literal("draft"), Type.Literal("final")]),
                        }),
                        returnType: Type.Object({ written: Type.Boolean() }),
                        shouldReviewInAutoMode: () => false,
                        execute: async (_ctx, { destination }) => {
                            writes++;
                            await writeFile(
                                destination === "draft"
                                    ? join(folder, "missing", "report.md")
                                    : join(folder, "report.md"),
                                report,
                            );
                            return { written: true };
                        },
                        toLLM: () => [{ type: "text", text: "Report written" }],
                    }),
                    defineAgentTool({
                        name: "verify_report",
                        returnType: Type.Object({ verified: Type.Boolean() }),
                        shouldReviewInAutoMode: () => false,
                        execute: async () => {
                            const actual = await readFile(join(folder, "report.md"), "utf8");
                            if (actual !== report)
                                throw new Error("Report does not contain both languages");
                            return { verified: true };
                        },
                        toLLM: () => [
                            {
                                type: "text",
                                text: "Verified the Chinese and English report in the saved file",
                            },
                        ],
                    }),
                ],
            }),
        };
        const provider = new GoalGymProvider(async (ctx, _request, index) => {
            switch (index) {
                case 0:
                    return call(index, "create_goal", {
                        objective: "Write and verify a Chinese and English report",
                    });
                case 1:
                    return call(index, "update_goal_plan", {
                        revision: 1,
                        criteria: [
                            {
                                id: "report",
                                description:
                                    "Saved report contains the requested Chinese and English versions",
                            },
                        ],
                    });
                case 2:
                    return call(index, "create_task", {
                        title: "Write and verify the bilingual report",
                    });
                case 3:
                    return call(index, "write_report", { destination: "draft" });
                case 4:
                    return call(index, "write_report", { destination: "final" });
                case 5:
                    return reply("The report is written; verification remains.");
                case 6:
                    return call(index, "verify_report", {});
                case 7:
                    return call(index, "complete_task", {
                        id: (await tasks.list(ctx, "agentgym"))[0]!.id,
                    });
                case 8: {
                    const page = await history.read(ctx, "agentgym", { from: "end", limit: 20 });
                    const record = page.messages.find((record) =>
                        record.message.blocks.some(
                            (block) =>
                                block.type === "tool_result" && block.toolName === "verify_report",
                        ),
                    );
                    const result = record!.message.blocks.find(
                        (block) =>
                            block.type === "tool_result" && block.toolName === "verify_report",
                    );
                    if (result?.type !== "tool_result")
                        throw new Error("Missing actual verification evidence");
                    return call(index, "update_goal_plan", {
                        revision: 2,
                        evidence: [
                            {
                                criterionId: "report",
                                historyPosition: record!.position,
                                callId: result.callId,
                                conclusion: "The file was read back and both languages matched.",
                            },
                        ],
                    });
                }
                case 9:
                    return call(index, "update_goal", { status: "complete", revision: 2 });
                case 10:
                    return reply("The bilingual report is complete and verified.");
                default:
                    throw new Error("Goal continued after completion");
            }
        });
        const providers = new AgentProviders();
        providers.add("scripted", provider, "gym");
        const storage = new AgentStorage({
            database: db.database,
            acquireLock: async () => ({ release: async () => {} }),
        });
        const system = await AgentSystemLocal.create(db.context, storage, {
            provider: "scripted",
            providers,
            models: [],
            modules: [events, history, goal, tasks, durable, fileTools],
        });
        try {
            const agent = await system.create(db.context, {}, { id: "agentgym" });
            const accepted = await agent.send(
                db.context,
                { role: "user", content: [{ type: "text", text: "帮我生成并核实中英文报告" }] },
                { metadata: { messageOrigin: "user" } },
            );
            expect(accepted.accepted).toBe("created");
            await agent.waitForIdle();
            expect(
                await goal.goal(db.context, agent.id),
                JSON.stringify({
                    settlements,
                    requests: provider.requests.length,
                    errors: (
                        await history.messages(db.context, agent.id, { from: "end", limit: 30 })
                    ).flatMap((record) =>
                        record.message.blocks.filter(
                            (block) => block.type === "tool_result" && block.isError,
                        ),
                    ),
                }),
            ).toMatchObject({ status: "complete" });
            expect(await readFile(join(folder, "report.md"), "utf8")).toBe(report);
            expect(writes).toBe(2);
            expect(provider.requests).toHaveLength(11);
            expect((await goal.execution(db.context, agent.id))?.budget.continuations).toBe(1);
            const page = await history.read(db.context, agent.id, { roles: ["agent"] });
            expect(page.messages).toHaveLength(1);
            expect(page.messages[0]?.message.senderAgentId).toBe(agent.id);
        } finally {
            await system.close(db.context);
            durable.stop();
            db.close();
            await rm(folder, { recursive: true, force: true });
        }
    });
});
