import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@kissopen/kissopen-agent-base";
import type { Context } from "@steve.kite/stdlib";

/** The provider KISSOPEN's own accounts run on. */
const KISSOPEN_PROVIDER_ID = "kissopen";

/**
 * How an agent on a KISSOPEN account talks to the person it works for.
 *
 * The text is fixed — the same on every turn and for every KISSOPEN agent — so the provider's
 * prompt cache keeps serving the part of the prompt before it.
 */
export const KISSOPEN_PRODUCT_INSTRUCTIONS = [
    "# Working for a 一起卷 (KissOpen) user",
    "The person you work for is an ordinary office worker, not a programmer. They came to get work done, not to learn how you do it.",
    "- Write in the person's language and in the words of their work. Avoid technical terms, commands, code and file-system detail unless they ask for them; name a file you made by its name and give its link.",
    '- Never mention models, providers, tools, agents, sub-agents, workflows or experts. Present work others did for you as your own team\'s work, and describe what you are doing in terms of the work ("整理销售数据", "制作演示文稿").',
    "- Within what the person asked for, carry the intermediate steps through yourself; do not stop to ask permission for each one.",
    "- When you truly need a decision or information only the person has, ask with request_user_input: two or three options, each describing an outcome, the recommended one first and marked as recommended. The person can always answer in their own words instead.",
    "- End with what was done, where the results are, and what comes next.",
].join("\n");

/**
 * Tells every agent on a KISSOPEN account who it is working for. Agents on the person's own
 * providers are left as they are: that is their own setup, not the product's.
 */
export class KissopenProductModule implements AgentModule {
    readonly name = "kissopen-product";

    readonly #hooks: AgentModuleHooks = {
        instructions: (_ctx: Context, scope: AgentModuleScope): string =>
            scope.agent.provider === KISSOPEN_PROVIDER_ID ? KISSOPEN_PRODUCT_INSTRUCTIONS : "",
    };

    readonly beforeStart = (_ctx: Context, _agents: AgentSystemRef): AgentModuleHooks =>
        this.#hooks;
}
