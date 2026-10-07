import type { AgentSystemRef } from "@kissopen/kissopen-agent-base";
import { createRootContext, type Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AUTONOMY_LIMIT_NOTICE, AutonomyBudget } from "../../sources/autonomy/index.js";
import { testConfig } from "../support/computeModule.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const ctx = createRootContext().named("autonomy-test");

/** A conversation `root` with a collaborator `lead`, which created `worker`. */
function tree(): AgentSystemRef {
    const parents = new Map<string, string>([
        ["lead", "root"],
        ["worker", "lead"],
    ]);
    return {
        parentOf: async (_ctx: Context, agentId: string) => parents.get(agentId) ?? null,
    } as unknown as AgentSystemRef;
}

async function started(budget: AutonomyBudget): Promise<AutonomyBudget> {
    await resolveModuleHooks(ctx, budget, tree());
    return budget;
}

describe("autonomy budget", () => {
    it("allows the configured defaults: four expert calls, two workflows, six wake-ups", async () => {
        const budget = await started(new AutonomyBudget(testConfig));

        expect(budget.limit("expert_call")).toBe(4);
        expect(budget.limit("workflow_start")).toBe(2);
        expect(budget.limit("auto_round")).toBe(6);
        for (let index = 0; index < 4; index += 1) {
            await budget.take(ctx, "root", "expert_call");
        }
        await expect(budget.take(ctx, "root", "expert_call")).rejects.toThrow(
            AUTONOMY_LIMIT_NOTICE,
        );
        await budget.take(ctx, "root", "workflow_start");
        await budget.take(ctx, "root", "workflow_start");
        await expect(budget.take(ctx, "root", "workflow_start")).rejects.toThrow(
            "2 workflows have already been started",
        );
    });

    it("reads the limits from [settings]", async () => {
        const config = await temporaryTestConfig(
            [
                "[settings]",
                "max_expert_calls_per_turn = 1",
                "max_workflow_starts_per_turn = 3",
                "max_auto_rounds = 2",
                "",
            ].join("\n"),
        );
        const budget = await started(new AutonomyBudget(config));

        expect(budget.limit("expert_call")).toBe(1);
        expect(budget.limit("workflow_start")).toBe(3);
        expect(budget.limit("auto_round")).toBe(2);
        expect(config.configuration.provenance["settings.maxAutoRounds"]).toBe("global");
    });

    it("charges a collaborator's steps to the conversation it belongs to", async () => {
        const config = await temporaryTestConfig("[settings]\nmax_expert_calls_per_turn = 2\n");
        const budget = await started(new AutonomyBudget(config));

        await budget.take(ctx, "worker", "expert_call");
        await budget.take(ctx, "root", "expert_call");
        await expect(budget.take(ctx, "lead", "expert_call")).rejects.toThrow();
        // Another conversation has its own allowance.
        await budget.take(ctx, "other", "expert_call");
    });

    it("counts only wake-ups of the conversation itself, and says so once they are spent", async () => {
        const config = await temporaryTestConfig("[settings]\nmax_auto_rounds = 2\n");
        const budget = await started(new AutonomyBudget(config));

        expect(await budget.wake(ctx, "lead")).toBeUndefined();
        expect(await budget.wake(ctx, "root")).toBeUndefined();
        expect(await budget.wake(ctx, "worker")).toBeUndefined();
        expect(await budget.wake(ctx, "root")).toBeUndefined();
        expect(await budget.wake(ctx, "root")).toBe(AUTONOMY_LIMIT_NOTICE);
        expect(await budget.wake(ctx, "root")).toBe(AUTONOMY_LIMIT_NOTICE);
    });

    it("starts every allowance again when the person writes", async () => {
        const config = await temporaryTestConfig(
            "[settings]\nmax_auto_rounds = 1\nmax_workflow_starts_per_turn = 1\n",
        );
        const budget = await started(new AutonomyBudget(config));
        await budget.take(ctx, "root", "workflow_start");
        await budget.wake(ctx, "root");
        expect(await budget.wake(ctx, "root")).toBe(AUTONOMY_LIMIT_NOTICE);

        budget.reset("root");

        expect(await budget.wake(ctx, "root")).toBeUndefined();
        await budget.take(ctx, "worker", "workflow_start");
    });

    it("rejects limits outside the configured bounds", async () => {
        await expect(temporaryTestConfig("[settings]\nmax_auto_rounds = 0\n")).rejects.toThrow();
        await expect(
            temporaryTestConfig("[settings]\nmax_expert_calls_per_turn = 101\n"),
        ).rejects.toThrow();
    });
});
