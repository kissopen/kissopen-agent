import { Type, type Static } from "@sinclair/typebox";

const id = Type.String({ minLength: 1, maxLength: 128 });
const instant = Type.Integer({ minimum: 0 });
const nullableInstant = Type.Union([instant, Type.Null()]);
export const localTaskRuleSchema = Type.Object(
    {
        recurrence: Type.Union([
            Type.Literal("once"),
            Type.Literal("daily"),
            Type.Literal("weekdays"),
            Type.Literal("weekly"),
            Type.Literal("interval"),
        ]),
        timezone: Type.String({ minLength: 1, maxLength: 128 }),
        intervalMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10080 })),
        weekday: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
        atMinute: Type.Optional(Type.Integer({ minimum: 0, maximum: 1439 })),
        onceAt: Type.Optional(instant),
    },
    { additionalProperties: false },
);
export const localTaskPlanSchema = Type.Object(
    {
        name: Type.String({ minLength: 1, maxLength: 160 }),
        instruction: Type.String({ minLength: 1, maxLength: 4000 }),
        rule: localTaskRuleSchema,
    },
    { additionalProperties: false },
);
export const createLocalTaskSchema = Type.Object(
    {
        id,
        agentId: id,
        ...localTaskPlanSchema.properties,
    },
    { additionalProperties: false },
);
export const updateLocalTaskSchema = Type.Object(
    {
        name: Type.Optional(localTaskPlanSchema.properties.name),
        instruction: Type.Optional(localTaskPlanSchema.properties.instruction),
        rule: Type.Optional(localTaskRuleSchema),
        status: Type.Optional(
            Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("ended")]),
        ),
        delete: Type.Optional(Type.Boolean()),
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
);
const localTaskCoreSchema = Type.Object(
    {
        ...createLocalTaskSchema.properties,
        status: Type.Union([
            Type.Literal("active"),
            Type.Literal("paused"),
            Type.Literal("ended"),
            Type.Literal("completed"),
        ]),
        nextRunAt: nullableInstant,
        createdAt: instant,
        updatedAt: instant,
        revision: Type.Integer({ minimum: 1 }),
        projectPath: Type.String(),
        projectName: Type.String(),
    },
    { additionalProperties: false },
);
export const localTaskRunSchema = Type.Object(
    {
        id,
        taskId: id,
        agentId: id,
        messageId: id,
        scheduledFor: instant,
        startedAt: nullableInstant,
        endedAt: nullableInstant,
        readAt: nullableInstant,
        status: Type.Union([
            Type.Literal("queued"),
            Type.Literal("running"),
            Type.Literal("succeeded"),
            Type.Literal("failed"),
            Type.Literal("cancelled"),
            Type.Literal("missed"),
            Type.Literal("skipped"),
        ]),
        summary: Type.String(),
        error: Type.String(),
    },
    { additionalProperties: false },
);
export const runLocalTaskSchema = Type.Object({ id }, { additionalProperties: false });
export const localTaskSchema = Type.Object(
    { ...localTaskCoreSchema.properties, lastRun: Type.Optional(localTaskRunSchema) },
    { additionalProperties: false },
);
export const localTaskResponseSchema = Type.Object({ task: localTaskSchema });
export const localTaskRunResponseSchema = Type.Object({ run: localTaskRunSchema });
export const localTaskListSchema = Type.Object({
    tasks: Type.Array(localTaskSchema, { maxItems: 100 }),
    nextCursor: Type.Union([id, Type.Null()]),
});
export const localTaskRunsSchema = Type.Object({
    runs: Type.Array(localTaskRunSchema, { maxItems: 200 }),
});
export type LocalTaskRule = Static<typeof localTaskRuleSchema>;
export type LocalTaskPlan = Static<typeof localTaskPlanSchema>;
export type CreateLocalTask = Static<typeof createLocalTaskSchema>;
export type UpdateLocalTask = Static<typeof updateLocalTaskSchema>;
export type LocalTask = Static<typeof localTaskSchema>;
export type LocalTaskRun = Static<typeof localTaskRunSchema>;
export type LocalTaskResponse = Static<typeof localTaskResponseSchema>;
export type LocalTaskRunResponse = Static<typeof localTaskRunResponseSchema>;
export type LocalTaskList = Static<typeof localTaskListSchema>;
export type LocalTaskRuns = Static<typeof localTaskRunsSchema>;
