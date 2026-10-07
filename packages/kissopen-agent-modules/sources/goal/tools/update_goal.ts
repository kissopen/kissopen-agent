import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";

import type { GoalModule } from "../GoalModule.js";
import { formatGoalForModel } from "../impl/formatGoalForModel.js";
import { sessionGoalSchema } from "../SessionGoal.js";

/** The durable model tool that marks a goal complete or blocked. */
export function updateGoalTool(goals: GoalModule, agentId: string, maxOutputCharacters: number) {
    return defineAgentTool({
        name: "update_goal",
        defer: false,
        capabilities: ["Create, inspect, update, and clear persistent long-running goals."],
        searchKeywords: ["complete persistent goal", "block goal", "finish objective"],
        description: `Mark the persistent goal complete or blocked.
Use complete only when the full objective is achieved and verified with no required work remaining.
First record actual evidence for each acceptance criterion with update_goal_plan. Supply the current revision from get_goal. Successful goal bookkeeping or task completion is not proof of the deliverable.
Use blocked only when meaningful progress cannot continue without user input or an external state change. A first temporary transport failure is not sufficient: use wait_for_goal for a bounded recheck, inspect current state, and preserve the active goal while recovery remains possible. Repeated unchanged failures may establish a genuine blocker; never keep retrying an uncertain click or submission.
Pausing, resuming, and clearing a goal are controlled by the user.`,
        parameters: Type.Object(
            {
                status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")], {
                    description: "The terminal status for the current goal.",
                }),
                revision: Type.Optional(Type.Integer({ minimum: 1 })),
            },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ goal: sessionGoalSchema }),
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { status, revision }) => ({
            goal:
                status === "complete"
                    ? await goals.completeGoal(ctx, agentId, revision)
                    : await goals.changeGoalStatus(ctx, agentId, status),
        }),
        toLLM: ({ goal }) => [
            {
                type: "text",
                text: formatGoalForModel(goal, maxOutputCharacters),
            },
        ],
    });
}
