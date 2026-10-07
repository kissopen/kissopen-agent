import { createHash } from "node:crypto";
import {
    agentDatabase,
    agentDatabaseRows,
    agentDatabaseRun,
    withAgentDatabase,
    defineAgentTool,
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleMigration,
    type AgentSystemRef,
} from "@kissopen/kissopen-agent-base";
import {
    createLocalTaskSchema,
    localTaskPlanSchema,
    localTaskSchema,
    localTaskRunSchema,
    updateLocalTaskSchema,
    type CreateLocalTask,
    type UpdateLocalTask,
    type LocalTask,
    type LocalTaskRun,
} from "@kissopen/kissopen-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { detach, withLifetime, type Context } from "@steve.kite/stdlib";
import { sql } from "drizzle-orm";
import type { DurableFunctionsModule } from "../durableFunctions/index.js";
import type { HistoryModule } from "../history/index.js";
import type { ProjectsModule } from "../projects/index.js";
import { teamUser, type TeamModule } from "../team/index.js";
import { AGENT_MESSAGE_ORIGIN_METADATA, isUserOriginMetadata } from "../impl/messageOrigin.js";
import { nextLocalTaskTime as resolveNextTime } from "./localTaskTime.js";

const storedTaskSchema = Type.Object({
    task: localTaskSchema,
    owner: Type.String(),
    original: Type.String(),
});
const storedRunSchema = Type.Object({
    run: localTaskRunSchema,
    instruction: Type.String(),
    owner: Type.String(),
    agentRunId: Type.Union([Type.String(), Type.Null()]),
});
type StoredTask = Static<typeof storedTaskSchema>;
type StoredRun = Static<typeof storedRunSchema>;
const args = Type.Object({ runId: Type.String() });
const toolInput = Type.Object(
    {
        request: Type.String({ minLength: 1, maxLength: 4000 }),
        plan: Type.Optional(localTaskPlanSchema),
    },
    { additionalProperties: false },
);
const toolResult = Type.Union([
    Type.Object({
        status: Type.Literal("created"),
        schedule: Type.Object({
            id: Type.String(),
            name: Type.String(),
            instruction: Type.String(),
            target: Type.String(),
            recurrence: Type.String(),
            weekday: Type.Number(),
            at_minute: Type.Number(),
            once_at: Type.Number(),
            timezone: Type.String(),
            next_run_at: Type.Number(),
            project_name: Type.String(),
            interval_minutes: Type.Optional(Type.Number()),
        }),
    }),
    Type.Object({
        status: Type.Literal("needs"),
        question: Type.String(),
        choices: Type.Array(Type.String()),
    }),
    Type.Object({ status: Type.Literal("failed"), error: Type.String() }),
]);

export class LocalTaskError extends Error {
    constructor(
        readonly status: 400 | 401 | 404 | 409,
        message: string,
    ) {
        super(message);
    }
}

/** The local daemon owns plans, due-work transactions and idempotent delivery. */
export class LocalScheduledTasksModule implements AgentModule {
    readonly name = "localScheduledTasks";
    readonly migrations: readonly AgentModuleMigration[] = [
        [
            "001-local-scheduled-tasks",
            async (_ctx, db) => {
                await agentDatabaseRun(
                    db,
                    sql`CREATE TABLE local_scheduled_tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL, next_due BIGINT, payload TEXT NOT NULL)`,
                );
                await agentDatabaseRun(
                    db,
                    sql`CREATE INDEX local_tasks_due ON local_scheduled_tasks(status, next_due)`,
                );
                await agentDatabaseRun(
                    db,
                    sql`CREATE INDEX local_tasks_owner ON local_scheduled_tasks(owner, id)`,
                );
                await agentDatabaseRun(
                    db,
                    sql`CREATE TABLE local_scheduled_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, agent_run_id TEXT, status TEXT NOT NULL, scheduled_for BIGINT NOT NULL, payload TEXT NOT NULL)`,
                );
                await agentDatabaseRun(
                    db,
                    sql`CREATE INDEX local_runs_task ON local_scheduled_runs(task_id, scheduled_for DESC, id)`,
                );
                await agentDatabaseRun(
                    db,
                    sql`CREATE INDEX local_runs_active ON local_scheduled_runs(agent_id, status)`,
                );
            },
        ],
    ];
    #agents: AgentSystemRef | undefined;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #context: Context | undefined;
    readonly #lifetime = new AbortController();

    constructor(
        readonly durable: DurableFunctionsModule,
        readonly history?: HistoryModule,
        readonly projects?: ProjectsModule,
        readonly team?: TeamModule,
    ) {
        durable.register({
            name: "local-scheduled-task-delivery",
            argumentsSchema: args,
            resultSchema: Type.Boolean(),
            executor: async (ctx, call) => {
                try {
                    return await ctx.inTx(async (tx) => {
                        const row = await this.#run(tx, call.arguments.runId);
                        if (!row || row.run.status !== "queued") return true;
                        const config = await this.#agents!.config(tx, row.run.agentId);
                        if (!config || config.metadata?.["archivedAt"] != null)
                            throw new Error("The task's conversation is no longer available.");
                        await this.#agents!.send(
                            tx,
                            row.run.agentId,
                            {
                                role: "user",
                                content: [
                                    { type: "text", text: `Scheduled task: ${row.instruction}` },
                                ],
                            },
                            {
                                id: row.run.messageId,
                                metadata: {
                                    ...AGENT_MESSAGE_ORIGIN_METADATA,
                                    localScheduledRunId: row.run.id,
                                    ...(row.owner ? { userId: row.owner } : {}),
                                },
                            },
                        );
                        return true;
                    });
                } catch (error) {
                    if (ctx.lifetime?.aborted) throw error; // Restart recovers the pending delivery.
                    await ctx.inTx(async (tx) => {
                        const row = await this.#run(tx, call.arguments.runId);
                        if (row?.run.status === "queued")
                            await this.#writeRun(tx, {
                                ...row,
                                run: {
                                    ...row.run,
                                    status: "failed",
                                    endedAt: Date.now(),
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "The scheduled task could not start.",
                                },
                            });
                    });
                    return false;
                }
            },
        });
    }

    readonly beforeStart = (ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        const database = agentDatabase(ctx);
        if (!database) throw new Error("Local scheduled tasks require the Agent database.");
        this.#context = withLifetime(
            withAgentDatabase(detach(ctx).named("local-scheduled-tasks"), database),
            this.#lifetime.signal,
        );
        return {
            afterStart: async () => {
                await this.tick(this.#context!);
                this.#arm();
            },
            tools: async (ctx, scope) => {
                if ((await agents.parentOf(ctx, scope.agent.id)) !== null) return [];
                return [
                    defineAgentTool({
                        name: "create_scheduled_task",
                        durable: true,
                        defer: true,
                        capabilities: [
                            "Create local scheduled reminders and recurring work, including minute intervals.",
                        ],
                        searchKeywords: [
                            "schedule",
                            "reminder",
                            "every minute",
                            "定时任务",
                            "提醒",
                            "每天",
                        ],
                        description: `Create a task directly in this conversation using the person's clear request. Interpret natural-language timing yourself and provide plan with the instruction and structured rule; there is no cloud parser or second confirmation. The current time is ${new Date().toISOString()} and the local timezone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}. Use intervalMinutes for minute/hour intervals, onceAt as epoch milliseconds, or atMinute (hour*60+minute) and weekday (Sunday=0). If timing or work is unclear, ask in this conversation before creating anything; do not invent a time. Plans run through this same Agent with its existing permissions. Only claim creation after status created. The user can edit or stop it in Scheduled tasks.`,
                        parameters: toolInput,
                        returnType: toolResult,
                        shouldReviewInAutoMode: () => false,
                        execute: async (
                            callCtx,
                            input,
                            call,
                        ): Promise<Static<typeof toolResult>> => {
                            if (!input.plan)
                                return {
                                    status: "needs" as const,
                                    question: "What should this task do, and when should it run?",
                                    choices: [],
                                };
                            try {
                                const owner = this.team?.enabled
                                    ? await scope.kv.read(callCtx, "owner")
                                    : "";
                                if (
                                    !Value.Check(Type.String(), owner) ||
                                    (this.team?.enabled && !owner)
                                )
                                    throw new LocalTaskError(
                                        401,
                                        "A scheduled task needs an authenticated conversation owner.",
                                    );
                                const task = await this.#create(
                                    callCtx,
                                    { id: call.id, agentId: scope.agent.id, ...input.plan },
                                    owner,
                                );
                                return {
                                    status: "created" as const,
                                    schedule: {
                                        id: task.id,
                                        name: task.name,
                                        instruction: task.instruction,
                                        target: "machine:local",
                                        recurrence: task.rule.recurrence,
                                        weekday: task.rule.weekday ?? 0,
                                        at_minute: task.rule.atMinute ?? 0,
                                        once_at: task.rule.onceAt ?? 0,
                                        timezone: task.rule.timezone,
                                        next_run_at: task.nextRunAt ?? 0,
                                        project_name: task.projectName,
                                        ...(task.rule.intervalMinutes === undefined
                                            ? {}
                                            : { interval_minutes: task.rule.intervalMinutes }),
                                    },
                                };
                            } catch (error) {
                                return {
                                    status: "failed" as const,
                                    error:
                                        error instanceof Error
                                            ? error.message
                                            : "The task could not be created.",
                                };
                            }
                        },
                        toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
                    }),
                ];
            },
            messageAcceptedTransact: async (ctx, scope, accepted) => {
                const owner = accepted.metadata?.["userId"];
                if (
                    this.team?.enabled &&
                    isUserOriginMetadata(accepted.metadata) &&
                    Value.Check(Type.String({ minLength: 1 }), owner)
                )
                    await scope.kv.write(ctx, "owner", owner);
                const id = accepted.metadata?.["localScheduledRunId"];
                if (!Value.Check(Type.String(), id)) return;
                const row = await this.#run(ctx, id);
                if (
                    !row ||
                    row.run.agentId !== scope.agent.id ||
                    row.run.messageId !== accepted.id ||
                    row.run.status !== "queued"
                )
                    return;
                const message = await this.history?.message(ctx, scope.agent.id, accepted.id);
                await this.#writeRun(ctx, {
                    ...row,
                    agentRunId: message?.runId ?? null,
                    run: { ...row.run, status: "running", startedAt: Date.now() },
                });
            },
            afterAgentSettledTransact: async (ctx, scope) => {
                const rows = await agentDatabaseRows<{ payload: string }>(
                    ctx.db,
                    sql`SELECT payload FROM local_scheduled_runs WHERE agent_id=${scope.agent.id} AND status='running' LIMIT 100`,
                );
                for (const raw of rows) {
                    const row = Value.Decode(storedRunSchema, JSON.parse(raw.payload));
                    if (!row.agentRunId) continue;
                    const state = await this.history?.run(ctx, scope.agent.id, row.agentRunId);
                    if (!state || state.status === "running") continue;
                    const status =
                        state.status === "completed"
                            ? "succeeded"
                            : state.status === "aborted"
                              ? "cancelled"
                              : "failed";
                    await this.#writeRun(ctx, {
                        ...row,
                        run: {
                            ...row.run,
                            status,
                            endedAt: state.endedAt ?? Date.now(),
                            summary:
                                status === "succeeded"
                                    ? "Completed in the task's conversation."
                                    : "",
                            error:
                                status === "failed"
                                    ? "The Agent run failed. Open the conversation for details."
                                    : "",
                        },
                    });
                }
            },
            conversationClearedTransact: async (ctx, scope) => {
                const plans = await agentDatabaseRows<{ payload: string }>(
                    ctx.db,
                    sql`SELECT payload FROM local_scheduled_tasks WHERE agent_id=${scope.agent.id} AND status='active'`,
                );
                for (const raw of plans) {
                    const row = Value.Decode(storedTaskSchema, JSON.parse(raw.payload));
                    await this.#writeTask(ctx, {
                        ...row,
                        task: {
                            ...row.task,
                            status: "paused",
                            nextRunAt: null,
                            revision: row.task.revision + 1,
                            updatedAt: Date.now(),
                        },
                    });
                }
                const runs = await agentDatabaseRows<{ payload: string }>(
                    ctx.db,
                    sql`SELECT payload FROM local_scheduled_runs WHERE agent_id=${scope.agent.id} AND status IN ('queued','running')`,
                );
                for (const raw of runs) {
                    const row = Value.Decode(storedRunSchema, JSON.parse(raw.payload));
                    await this.#writeRun(ctx, {
                        ...row,
                        run: {
                            ...row.run,
                            status: "cancelled",
                            endedAt: Date.now(),
                            summary: "The task's conversation was cleared.",
                        },
                    });
                }
            },
        };
    };

    stop(): void {
        this.#lifetime.abort();
        if (this.#timer) clearTimeout(this.#timer);
    }
    #arm(): void {
        if (this.#lifetime.signal.aborted) return;
        this.#timer = setTimeout(() => {
            void this.tick(this.#context!)
                .catch((error) =>
                    this.#context!.log.warn(
                        "Local scheduled tasks could not be checked.",
                        {},
                        error,
                    ),
                )
                .finally(() => this.#arm());
        }, 1000);
        this.#timer.unref?.();
    }
    #owner(ctx: Context): string {
        if (!this.team?.enabled) return "";
        const owner = teamUser(ctx)?.id;
        if (!owner)
            throw new LocalTaskError(
                401,
                "Sign in to the local Agent to manage your scheduled tasks.",
            );
        return owner;
    }
    async create(ctx: Context, input: CreateLocalTask): Promise<LocalTask> {
        return await this.#create(ctx, input, this.#owner(ctx));
    }
    async #create(ctx: Context, input: CreateLocalTask, owner: string): Promise<LocalTask> {
        if (
            !Value.Check(createLocalTaskSchema, input) ||
            !input.name.trim() ||
            !input.instruction.trim()
        )
            throw new LocalTaskError(
                400,
                "Provide a task name, instruction and complete schedule.",
            );
        const original = JSON.stringify({
            agentId: input.agentId,
            name: input.name,
            instruction: input.instruction,
            rule: Object.fromEntries(
                Object.entries(input.rule).sort(([a], [b]) => a.localeCompare(b)),
            ),
        });
        return await ctx.inTx(async (tx) => {
            const existing = await this.#task(tx, input.id);
            if (existing) {
                if (existing.owner !== owner)
                    throw new LocalTaskError(404, "The scheduled task was not found.");
                if (existing.original !== original)
                    throw new LocalTaskError(
                        409,
                        "This task identity was already used. Do not repeat creation with another identity without checking the original task.",
                    );
                return existing.task;
            }
            const config = await this.#agents!.config(tx, input.agentId);
            if (
                !config ||
                config.metadata?.["archivedAt"] != null ||
                (await this.#agents!.parentOf(tx, input.agentId)) !== null
            )
                throw new LocalTaskError(
                    400,
                    "Choose an available root conversation for this task.",
                );
            const count = await agentDatabaseRows<{ count: number }>(
                tx.db,
                sql`SELECT COUNT(*) AS count FROM local_scheduled_tasks WHERE owner=${owner}`,
            );
            if (Number(count[0]!.count) >= 2000)
                throw new LocalTaskError(
                    409,
                    "This installation has reached its scheduled-task limit.",
                );
            const now = Date.now();
            const nextRunAt = nextLocalTaskTime(input.rule, now);
            if (nextRunAt === null)
                throw new LocalTaskError(400, "Choose a future date and time for this task.");
            const project = await this.projects?.projectForAgent(tx, input.agentId);
            const task: LocalTask = {
                ...input,
                status: "active",
                nextRunAt,
                createdAt: now,
                updatedAt: now,
                revision: 1,
                projectPath:
                    project?.kind === "regular" ? (config.environment?.workingDirectory ?? "") : "",
                projectName: project?.kind === "regular" ? project.name : "",
            };
            await this.#writeTask(tx, { task, owner, original });
            return task;
        });
    }
    async get(ctx: Context, id: string): Promise<LocalTask> {
        return (await this.#ownedTask(ctx, id)).task;
    }
    async list(
        ctx: Context,
        after = "",
        limit = 100,
    ): Promise<{ tasks: LocalTask[]; nextCursor: string | null }> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100)
            throw new LocalTaskError(400, "The task page size is invalid.");
        const rows = await agentDatabaseRows<{ payload: string; last_run: string | null }>(
            ctx.db,
            sql`SELECT t.payload,(SELECT r.payload FROM local_scheduled_runs r WHERE r.task_id=t.id ORDER BY r.scheduled_for DESC,r.id DESC LIMIT 1) AS last_run FROM local_scheduled_tasks t WHERE owner=${this.#owner(ctx)} AND t.id>${after} ORDER BY t.id LIMIT ${limit + 1}`,
        );
        const tasks = rows.slice(0, limit).map((row) => ({
            ...Value.Decode(storedTaskSchema, JSON.parse(row.payload)).task,
            ...(row.last_run
                ? { lastRun: Value.Decode(storedRunSchema, JSON.parse(row.last_run)).run }
                : {}),
        }));
        return { tasks, nextCursor: rows.length > limit ? tasks.at(-1)!.id : null };
    }
    async update(ctx: Context, id: string, input: UpdateLocalTask): Promise<LocalTask> {
        if (!Value.Check(updateLocalTaskSchema, input))
            throw new LocalTaskError(400, "The task update is invalid.");
        return await ctx.inTx(async (tx) => {
            const row = await this.#ownedTask(tx, id);
            if (input.revision !== undefined && input.revision !== row.task.revision)
                throw new LocalTaskError(409, "The task changed. Reopen it before editing.");
            const rule = input.rule ?? row.task.rule;
            const status = input.delete ? "ended" : (input.status ?? row.task.status);
            const nextRunAt =
                status !== "active"
                    ? null
                    : input.rule || row.task.status !== "active"
                      ? nextLocalTaskTime(rule, Date.now())
                      : row.task.nextRunAt;
            if (status === "active" && nextRunAt === null)
                throw new LocalTaskError(400, "Choose a future date and time for this task.");
            const task: LocalTask = {
                ...row.task,
                name: input.name ?? row.task.name,
                instruction: input.instruction ?? row.task.instruction,
                rule,
                status,
                nextRunAt,
                revision: row.task.revision + 1,
                updatedAt: Date.now(),
            };
            if (!task.name.trim() || !task.instruction.trim())
                throw new LocalTaskError(400, "The name and instruction cannot be empty.");
            await this.#writeTask(tx, { ...row, task });
            if (status === "paused" || status === "ended") {
                const queued = await agentDatabaseRows<{ payload: string }>(
                    tx.db,
                    sql`SELECT payload FROM local_scheduled_runs WHERE task_id=${id} AND status='queued'`,
                );
                for (const raw of queued) {
                    const pending = Value.Decode(storedRunSchema, JSON.parse(raw.payload));
                    await this.#writeRun(tx, {
                        ...pending,
                        run: {
                            ...pending.run,
                            status: "cancelled",
                            endedAt: Date.now(),
                            summary: "The task was stopped before this run began.",
                        },
                    });
                }
            }
            return task;
        });
    }
    async runNow(ctx: Context, id: string, runId: string): Promise<LocalTaskRun> {
        if (!Value.Check(Type.String({ minLength: 1, maxLength: 128 }), runId))
            throw new LocalTaskError(400, "A stable run identity is required.");
        return await ctx.inTx(async (tx) => {
            const task = await this.#ownedTask(tx, id);
            const old = await this.#run(tx, runId);
            if (old) {
                if (old.run.taskId !== id || old.owner !== task.owner)
                    throw new LocalTaskError(409, "This run identity is already in use.");
                return old.run;
            }
            if (await this.#busy(tx, task.task.agentId))
                throw new LocalTaskError(
                    409,
                    "A scheduled task is already active in this conversation.",
                );
            return await this.#enqueue(tx, task, runId, Date.now(), "queued");
        });
    }
    async runs(ctx: Context, id: string, limit = 100): Promise<{ runs: LocalTaskRun[] }> {
        await this.#ownedTask(ctx, id);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200)
            throw new LocalTaskError(400, "The run page size is invalid.");
        const rows = await agentDatabaseRows<{ payload: string }>(
            ctx.db,
            sql`SELECT payload FROM local_scheduled_runs WHERE task_id=${id} ORDER BY scheduled_for DESC,id DESC LIMIT ${limit}`,
        );
        return {
            runs: rows.map((row) => Value.Decode(storedRunSchema, JSON.parse(row.payload)).run),
        };
    }
    async markRead(ctx: Context, id: string, runId: string): Promise<LocalTaskRun> {
        return await ctx.inTx(async (tx) => {
            await this.#ownedTask(tx, id);
            const row = await this.#run(tx, runId);
            if (!row || row.run.taskId !== id)
                throw new LocalTaskError(404, "The task run was not found.");
            const run = { ...row.run, readAt: row.run.readAt ?? Date.now() };
            await this.#writeRun(tx, { ...row, run });
            return run;
        });
    }
    async tick(ctx: Context): Promise<void> {
        await ctx.inTx(async (tx) => {
            const now = Date.now();
            const rows = await agentDatabaseRows<{ payload: string }>(
                tx.db,
                sql`SELECT payload FROM local_scheduled_tasks WHERE status='active' AND next_due<=${now} ORDER BY next_due,id LIMIT 50`,
            );
            for (const raw of rows) {
                const row = Value.Decode(storedTaskSchema, JSON.parse(raw.payload));
                const due = row.task.nextRunAt!;
                const busy = await this.#busy(tx, row.task.agentId);
                const nextRunAt =
                    row.task.rule.recurrence === "interval"
                        ? due +
                          (Math.floor((now - due) / (row.task.rule.intervalMinutes! * 60000)) + 1) *
                              row.task.rule.intervalMinutes! *
                              60000
                        : nextLocalTaskTime(row.task.rule, Math.max(now, due));
                await this.#writeTask(tx, {
                    ...row,
                    task: {
                        ...row.task,
                        nextRunAt,
                        status: nextRunAt === null ? "completed" : "active",
                        updatedAt: now,
                        revision: row.task.revision + 1,
                    },
                });
                await this.#enqueue(
                    tx,
                    row,
                    hash("occurrence", row.task.id, String(due)),
                    due,
                    now - due > 300000 ? "missed" : busy ? "skipped" : "queued",
                );
            }
        });
    }
    async #enqueue(
        ctx: Context,
        row: StoredTask,
        id: string,
        due: number,
        status: "queued" | "missed" | "skipped",
    ): Promise<LocalTaskRun> {
        const run: LocalTaskRun = {
            id,
            taskId: row.task.id,
            agentId: row.task.agentId,
            messageId: hash("message", id),
            scheduledFor: due,
            status,
            startedAt: null,
            endedAt: status === "queued" ? null : Date.now(),
            readAt: null,
            summary:
                status === "missed"
                    ? "This computer was unavailable at the scheduled time."
                    : status === "skipped"
                      ? "Another scheduled task was still active in this conversation."
                      : "",
            error: "",
        };
        await this.#writeRun(ctx, {
            run,
            owner: row.owner,
            instruction: row.task.instruction,
            agentRunId: null,
        });
        if (status === "queued")
            await this.durable.invoke(ctx, {
                function: "local-scheduled-task-delivery",
                operationId: `local-schedule:${id}`,
                arguments: { runId: id },
                lockKeys: [`local-schedule-agent:${row.task.agentId}`],
            });
        return run;
    }
    async #busy(ctx: Context, id: string): Promise<boolean> {
        const rows = await agentDatabaseRows<{ id: string }>(
            ctx.db,
            sql`SELECT id FROM local_scheduled_runs WHERE agent_id=${id} AND status IN ('queued','running') LIMIT 1`,
        );
        return rows.length > 0;
    }
    async #ownedTask(ctx: Context, id: string): Promise<StoredTask> {
        const row = await this.#task(ctx, id);
        if (!row || row.owner !== this.#owner(ctx))
            throw new LocalTaskError(404, "The scheduled task was not found.");
        return row;
    }
    async #task(ctx: Context, id: string): Promise<StoredTask | undefined> {
        const rows = await agentDatabaseRows<{ payload: string }>(
            ctx.db,
            sql`SELECT payload FROM local_scheduled_tasks WHERE id=${id} LIMIT 1`,
        );
        return rows[0] ? Value.Decode(storedTaskSchema, JSON.parse(rows[0].payload)) : undefined;
    }
    async #run(ctx: Context, id: string): Promise<StoredRun | undefined> {
        const rows = await agentDatabaseRows<{ payload: string }>(
            ctx.db,
            sql`SELECT payload FROM local_scheduled_runs WHERE id=${id} LIMIT 1`,
        );
        return rows[0] ? Value.Decode(storedRunSchema, JSON.parse(rows[0].payload)) : undefined;
    }
    async #writeTask(ctx: Context, row: StoredTask): Promise<void> {
        Value.Assert(storedTaskSchema, row);
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO local_scheduled_tasks(id,owner,agent_id,status,next_due,payload) VALUES(${row.task.id},${row.owner},${row.task.agentId},${row.task.status},${row.task.nextRunAt},${JSON.stringify(row)}) ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_due=excluded.next_due,payload=excluded.payload`,
        );
    }
    async #writeRun(ctx: Context, row: StoredRun): Promise<void> {
        Value.Assert(storedRunSchema, row);
        await agentDatabaseRun(
            ctx.db,
            sql`INSERT INTO local_scheduled_runs(id,task_id,agent_id,agent_run_id,status,scheduled_for,payload) VALUES(${row.run.id},${row.run.taskId},${row.run.agentId},${row.agentRunId},${row.run.status},${row.run.scheduledFor},${JSON.stringify(row)}) ON CONFLICT(id) DO UPDATE SET agent_run_id=excluded.agent_run_id,status=excluded.status,payload=excluded.payload`,
        );
        await agentDatabaseRun(
            ctx.db,
            sql`DELETE FROM local_scheduled_runs WHERE task_id=${row.run.taskId} AND status NOT IN ('queued','running') AND id NOT IN (SELECT id FROM local_scheduled_runs WHERE task_id=${row.run.taskId} AND status NOT IN ('queued','running') ORDER BY scheduled_for DESC,id DESC LIMIT 200)`,
        );
    }
}
function hash(...parts: string[]): string {
    return "s" + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 31);
}
function nextLocalTaskTime(rule: LocalTask["rule"], after: number): number | null {
    try {
        return resolveNextTime(rule, after);
    } catch (error) {
        throw new LocalTaskError(
            400,
            error instanceof Error ? error.message : "The schedule is invalid.",
        );
    }
}
