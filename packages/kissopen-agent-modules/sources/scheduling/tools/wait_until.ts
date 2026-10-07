import { defineAgentTool } from "@kissopen/kissopen-agent-base";

import type { SchedulingModule } from "../SchedulingModule.js";
import {
    schedulingWaitResultSchema,
    schedulingWaitUntilToolInputSchema,
    type SchedulingWaitUntilToolInput,
} from "../Scheduling.js";

export function waitUntilTool(scheduling: SchedulingModule, agentId: string) {
    return defineAgentTool({
        name: "wait_until",
        defer: true,
        capabilities: ["Pause for a while within the current task."],
        searchKeywords: ["pause until date", "wait until timestamp", "future time"],
        description:
            "Pause until a date at most 24 hours away. Write it as ISO 8601, RFC 2822, or a Unix timestamp in seconds or milliseconds; a date already past returns at once. The wait survives a restart, and any new message in this chat ends it early. Waiting is for something this task is already doing, such as a build or a reply; to have something happen at a later time or on a repeating basis, use create_scheduled_task instead.",
        parameters: schedulingWaitUntilToolInputSchema,
        returnType: schedulingWaitResultSchema,
        durable: true,
        steerable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: SchedulingWaitUntilToolInput, call) =>
            await scheduling.waitUntil(ctx, agentId, { ...input, id: call.id }),
        toLLM: (result) => [{ type: "text", text: scheduling.formatWaitForModel(result) }],
    });
}
