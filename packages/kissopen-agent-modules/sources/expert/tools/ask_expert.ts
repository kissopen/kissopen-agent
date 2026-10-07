import {
    defineAgentTool,
    type AgentKV,
    type AgentModuleAgent,
} from "@kissopen/kissopen-agent-base";

import { askExpertInputSchema, askExpertResultSchema, type AskExpertInput } from "../Expert.js";
import type { ExpertModule } from "../ExpertModule.js";
import { formatExpertResult } from "../expertText.js";

/** The tool's name, which the escalation counter also recognizes. */
export const ASK_EXPERT_TOOL_NAME = "ask_expert";

/**
 * Hand a task to the expert model and wait for its finished result.
 *
 * The description never names the policy's kinds or models: those change from the console, and a
 * tool that looks the same on every turn keeps the provider's prompt cache. The kinds are in the
 * module's instructions instead. It is eager, like structured user input: the instructions require
 * it at particular moments, so it must never sit behind tool search.
 *
 * Durable and reloadable: the expert's identity is this call's ID and its answer is recorded in
 * the settling transaction, so executing the call again — after a crash, or after a drain left it
 * for the next process — re-attaches to the same expert instead of starting a second one, and
 * the deadline is the one the first execution stored. A call that stopped waiting because the
 * person wrote finds its note marked detached and returns that again, never a second expert.
 */
export function askExpertTool(expert: ExpertModule, agent: AgentModuleAgent, sharedKV: AgentKV) {
    return defineAgentTool({
        name: ASK_EXPERT_TOOL_NAME,
        defer: false,
        capabilities: ["Hand hard work to a stronger expert model and relay its result."],
        description:
            "Hand a task to the expert — a stronger model than the one you run on — and wait for its finished result. Use it for the kinds of work your instructions route to the expert, and when the same step keeps failing. The expert works in this same workspace with the same tools but cannot see this conversation, so the task must be complete and self-contained. It can take many minutes. The call returns the expert's final answer with a check of the files it lists; relay it to the person with links to any files it produced. If the person writes while the expert works, the call returns early as detached and the result arrives later as a message.",
        parameters: askExpertInputSchema,
        returnType: askExpertResultSchema,
        durable: true,
        reloadable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: AskExpertInput, call) =>
            await expert.ask(ctx, agent, input, call, sharedKV),
        toLLM: (result) => [{ type: "text", text: formatExpertResult(result) }],
        // Detached is not a failure: the expert is still working and its result will arrive.
        isError: (result) => result.status === "failed" || result.status === "timed_out",
    });
}
