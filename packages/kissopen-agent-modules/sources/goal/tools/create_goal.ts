import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { GoalModule } from "../GoalModule.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { goalObjectiveSchema, sessionGoalSchema, type SessionGoal } from "../SessionGoal.js";

/** The durable tool that starts a goal for its owning agent. */
export function createGoalTool(
    goals: GoalModule,
    agentId: string,
    maxOutputCharacters: number,
    observeActiveLifecycle: (ctx: Context, goal: SessionGoal, lifecycleId: string) => Promise<void>,
) {
    return defineAgentTool({
        name: "create_goal",
        defer: false,
        capabilities: ["Create, inspect, update, and clear persistent long-running goals."],
        description: `Automatically create a persistent goal for a clear human request to accomplish a multi-step objective, even when the person does not say "long-running" or "goal". Keep working, observing results and adjusting the plan until the objective is verified. Do not create a goal for questions, discussion, or requests only for analysis or a plan. A new goal cannot replace an unfinished goal; explicit abandonment uses clear_goal. Read get_goal to obtain the goalId, revision and acceptance requirements, then maintain a rolling task list and verified evidence.`,
        parameters: Type.Object(
            {
                objective: goalObjectiveSchema,
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ goal: sessionGoalSchema }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { objective }, call) =>
            await ctx.inTx(async (txCtx) => {
                const activation = await goals.setGoal(txCtx, agentId, objective, call.id);
                await observeActiveLifecycle(txCtx, activation.goal, activation.lifecycleId);
                return { goal: activation.goal };
            }),
        toLLM: ({ goal }) => [
            { type: "text", text: formatGoalForModel(goal, maxOutputCharacters) },
        ],
    });
}
