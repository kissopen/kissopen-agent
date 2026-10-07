import type { AgentModule, AgentModuleHooks, AgentSystemRef } from "@kissopen/kissopen-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ConfigModule } from "../config/index.js";
import type { GoalModule } from "../goal/index.js";

/**
 * What the model is told once it has gone as far as it may on its own. It is the product's own
 * wording: the person decides whether the work goes on, and the project board shows the card as
 * waiting for that decision.
 */
export const AUTONOMY_LIMIT_NOTICE =
    "已达到自动推进上限。用提问工具问用户是否继续（继续 / 先停下 / 换个做法），并把 project.json 里这张卡片设为 needs_decision。";

/** The kinds of step one conversation may take on its own a bounded number of times. */
export type AutonomyStep = "expert_call" | "workflow_start" | "auto_round";

/** How far up the tree a root is looked for; far past any depth collaboration allows. */
const MAX_ANCESTORS = 128;

/**
 * How far an agent carries on by itself between two things the person says.
 *
 * Asking the expert, starting a workflow, and being woken by work that finished in the background
 * each let an agent keep going with no one watching; chained together they could go on for
 * hours. So each conversation — a root agent and everything under it — gets a small allowance of
 * each per turn of the person's: `max_expert_calls_per_turn`, `max_workflow_starts_per_turn` and
 * `max_auto_rounds` in `[settings]`. When the person writes (or answers a question), the
 * allowance starts again.
 *
 * A spent allowance never removes a tool: the tool surface stays the same on every turn, so the
 * provider's prompt cache keeps working. The step is refused with `AUTONOMY_LIMIT_NOTICE` instead,
 * and a wake-up carries the notice in place of its usual instructions, so the model asks the
 * person whether to go on.
 *
 * The counts are in memory only. A restart starts them again, which errs on the side of the work
 * carrying on; nothing about them is worth a table.
 */
export class AutonomyBudget implements AgentModule {
    readonly name = "autonomy";

    readonly #config: ConfigModule;
    readonly #goal: GoalModule | undefined;
    /** Steps taken since the person last wrote, per root agent. */
    readonly #spent = new Map<string, Record<AutonomyStep, number>>();
    #agents: AgentSystemRef | undefined;

    constructor(config: ConfigModule, goal?: GoalModule) {
        this.#config = config;
        this.#goal = goal;
    }

    /** Take the agent collection, which is how a subagent's step is charged to its conversation. */
    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return {};
    };

    /** The person wrote to this conversation: its allowance starts again. */
    reset(agentId: string): void {
        this.#spent.delete(agentId);
    }

    /** How many of a step one turn allows, as configured right now. */
    limit(step: AutonomyStep): number {
        const settings = this.#config.configuration.values.settings;
        switch (step) {
            case "expert_call":
                return settings.maxExpertCallsPerTurn;
            case "workflow_start":
                return settings.maxWorkflowStartsPerTurn;
            case "auto_round":
                return settings.maxAutoRounds;
        }
    }

    /**
     * Charge one model-requested step to the agent's conversation, or refuse it with the notice
     * once the turn's allowance is spent. The thrown message is what the tool reports.
     */
    async take(
        ctx: Context,
        agentId: string,
        step: "expert_call" | "workflow_start",
    ): Promise<void> {
        const root = await this.#rootOf(ctx, agentId);
        if (await this.#goal?.chargeAutonomy(ctx, root, "action")) return;
        if (this.#charge(root, step)) return;
        throw new Error(`${refusal(step, this.limit(step))}\n${AUTONOMY_LIMIT_NOTICE}`);
    }

    /**
     * Charge one automatic wake-up of this agent. Returns nothing while the allowance lasts, and
     * the notice to deliver in place of the wake-up's own instructions once it is spent.
     *
     * Only a wake-up of the conversation itself counts: one collaborator reporting to another is
     * work inside a step already taken, and no person reads that agent's conversation.
     */
    async wake(ctx: Context, agentId: string): Promise<string | undefined> {
        const parent =
            this.#agents === undefined ? null : await this.#agents.parentOf(ctx, agentId);
        if (parent !== null) return undefined;
        if (this.#goal !== undefined) {
            try {
                if (await this.#goal.chargeAutonomy(ctx, agentId, "wake")) return undefined;
            } catch (error: unknown) {
                return `Automatic execution stopped: ${error instanceof Error ? error.message : String(error)} Report completed background results and saved progress.`;
            }
        }
        return this.#charge(agentId, "auto_round") ? undefined : AUTONOMY_LIMIT_NOTICE;
    }

    /** Count one step; false, and nothing counted, once the allowance is spent. */
    #charge(root: string, step: AutonomyStep): boolean {
        const spent = this.#spent.get(root) ?? { expert_call: 0, workflow_start: 0, auto_round: 0 };
        if (spent[step] >= this.limit(step)) return false;
        spent[step] += 1;
        this.#spent.set(root, spent);
        return true;
    }

    /** The conversation an agent belongs to: itself, or the root it was created under. */
    async #rootOf(ctx: Context, agentId: string): Promise<string> {
        const agents = this.#agents;
        if (agents === undefined) return agentId;
        let current = agentId;
        for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
            const parent = await agents.parentOf(ctx, current);
            if (parent === null) return current;
            current = parent;
        }
        return current;
    }
}

function refusal(step: "expert_call" | "workflow_start", limit: number): string {
    return step === "expert_call"
        ? `The expert has already been asked ${String(limit)} times since the person last wrote.`
        : `${String(limit)} workflows have already been started since the person last wrote.`;
}
