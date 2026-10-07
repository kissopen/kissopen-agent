import { defineAgentTool } from "@kissopen/kissopen-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingWaitResultSchema,
    schedulingWaitToolInputSchema,
    type SchedulingWaitToolInput,
} from "../Scheduling.js";

export function waitTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "wait",
        defer: true,
        capabilities: ["Pause for a while within the current task."],
        searchKeywords: ["pause duration", "timer", "wait for time"],
        description:
            "Pause for up to 24 hours. Give the duration in seconds, minutes, hours, or days, as fields or as text such as '90 seconds' or '1h 30m'. The wait survives a restart, and any new message in this chat ends it early; the result says how much time actually passed. Waiting is for something this task is already doing, such as a build or a reply; to have something happen at a later time or on a repeating basis, use create_scheduled_task instead.",
        parameters: schedulingWaitToolInputSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        steerable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingWaitToolInput, call) =>
            await scheduling.wait(ctx, agentId, { ...input, id: call.id }),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}
