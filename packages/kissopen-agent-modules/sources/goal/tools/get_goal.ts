import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";

import type { GoalModule } from "../GoalModule.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { sessionGoalSchema } from "../SessionGoal.js";
import { goalExecutionSchema } from "../GoalExecution.js";
import { formatExecutionForModel } from "../impl/formatExecutionForModel.js";

/** The durable tool that reads its owning agent's goal. */
export function getGoalTool(goals: GoalModule, agentId: string, maxOutputCharacters: number) {
    return defineAgentTool({
        name: "get_goal",
        defer: false,
        capabilities: ["Create, inspect, update, and clear persistent long-running goals."],
        description:
            "Get this agent's persistent objective, status, stable goalId, current revision, rolling summary, acceptance evidence and lifetime usage. Use the current revision for plan changes and completion; read_agent_history supplies actual evidence positions.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: Type.Object({
            goal: Type.Union([sessionGoalSchema, Type.Null()]),
            execution: Type.Optional(goalExecutionSchema),
        }),
        durable: true,
        reloadable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => {
            const execution = await goals.execution(ctx, agentId);
            return {
                goal: (await goals.goal(ctx, agentId)) ?? null,
                ...(execution === undefined ? {} : { execution }),
            };
        },
        toLLM: ({ goal, execution }) => [
            {
                type: "text",
                text: `${formatGoalForModel(goal, Math.min(4_000, Math.floor(maxOutputCharacters / 2)))}\n${formatExecutionForModel(execution)}`,
            },
        ],
    });
}
