import { Type, type Static } from "@sinclair/typebox";
import { goalOperationIdSchema, goalTimestampSchema } from "./SessionGoal.js";

const text = Type.String({ minLength: 1, maxLength: 2_000 });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const goalCriterionSchema = Type.Object(
    { id: Type.String({ minLength: 1, maxLength: 80 }), description: text },
    { additionalProperties: false },
);
export const goalEvidenceSchema = Type.Object(
    {
        criterionId: Type.String({ minLength: 1, maxLength: 80 }),
        historyPosition: Type.Integer({
            minimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            description:
                "Zero-based position in this agent's history. read_agent_history displays one-based numbered headings: subtract one from the heading number. Use callId only from an actual successful tool result.",
        }),
        callId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        conclusion: text,
    },
    { additionalProperties: false },
);
export const goalPlanSchema = Type.Object(
    {
        revision: Type.Integer({ minimum: 1 }),
        objective: Type.Optional(Type.String({ minLength: 1, maxLength: 20_000 })),
        criteria: Type.Optional(Type.Array(goalCriterionSchema, { minItems: 1, maxItems: 32 })),
        summary: Type.Optional(text),
        evidence: Type.Optional(Type.Array(goalEvidenceSchema, { maxItems: 32 })),
    },
    { additionalProperties: false },
);
export const goalExecutionSchema = Type.Object(
    {
        goalId: goalOperationIdSchema,
        revision: Type.Integer({ minimum: 1 }),
        criteria: Type.Array(goalCriterionSchema, { minItems: 1, maxItems: 32 }),
        evidence: Type.Array(goalEvidenceSchema, { maxItems: 32 }),
        evidenceFrom: count,
        summary: Type.String({ maxLength: 2_000 }),
        taskIds: Type.Array(goalOperationIdSchema, { maxItems: 500, uniqueItems: true }),
        observedCallIds: Type.Array(goalOperationIdSchema, { maxItems: 256, uniqueItems: true }),
        requirementMessageId: Type.Optional(goalOperationIdSchema),
        phase: Type.Union([
            Type.Literal("executing"),
            Type.Literal("waiting"),
            Type.Literal("verifying"),
            Type.Literal("stopped"),
        ]),
        reason: Type.Optional(text),
        wait: Type.Optional(
            Type.Object(
                {
                    id: goalOperationIdSchema,
                    lifecycleId: goalOperationIdSchema,
                    dueAt: goalTimestampSchema,
                },
                { additionalProperties: false },
            ),
        ),
        budget: Type.Object(
            {
                inferences: count,
                actions: count,
                continuations: count,
                tokens: count,
                missingUsage: count,
                inferenceLimit: count,
                actionLimit: count,
                continuationLimit: count,
            },
            { additionalProperties: false },
        ),
        lastToolFingerprint: Type.Optional(Type.String({ maxLength: 64 })),
        repeatedToolOutcomes: count,
        idleRounds: count,
        activity: count,
        observedActivity: count,
        updatedAt: goalTimestampSchema,
    },
    { additionalProperties: false },
);

export type GoalExecution = Static<typeof goalExecutionSchema>;
export type GoalPlan = Static<typeof goalPlanSchema>;
export type GoalEvidence = Static<typeof goalEvidenceSchema>;

export function newGoalExecution(objective: string, evidenceFrom: number): GoalExecution {
    return {
        goalId: globalThis.crypto.randomUUID(),
        revision: 1,
        criteria: [{ id: "result", description: objective.slice(0, 2_000) }],
        evidence: [],
        evidenceFrom,
        summary: "",
        taskIds: [],
        observedCallIds: [],
        phase: "executing",
        budget: {
            inferences: 0,
            actions: 0,
            continuations: 0,
            tokens: 0,
            missingUsage: 0,
            inferenceLimit: 200,
            actionLimit: 500,
            continuationLimit: 50,
        },
        repeatedToolOutcomes: 0,
        idleRounds: 0,
        activity: 0,
        observedActivity: 0,
        updatedAt: Date.now(),
    };
}
