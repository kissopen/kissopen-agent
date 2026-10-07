import { AutonomyBudget, type AutonomyStep } from "../../sources/autonomy/index.js";
import type { ConfigModule } from "../../sources/config/index.js";

/**
 * An autonomy budget that never runs out, for suites about something else: a test that launches
 * a dozen workflows or collects a dozen reports is not testing the per-turn allowance.
 */
export class UnboundedAutonomy extends AutonomyBudget {
    override limit(_step: AutonomyStep): number {
        return Number.MAX_SAFE_INTEGER;
    }
}

/** An autonomy budget whose limits a test sets directly instead of through configuration. */
export class FixedAutonomy extends AutonomyBudget {
    readonly limits: Record<AutonomyStep, number>;

    constructor(config: ConfigModule, limits: Partial<Record<AutonomyStep, number>> = {}) {
        super(config);
        this.limits = { expert_call: 4, workflow_start: 2, auto_round: 6, ...limits };
    }

    override limit(step: AutonomyStep): number {
        return this.limits[step];
    }
}
