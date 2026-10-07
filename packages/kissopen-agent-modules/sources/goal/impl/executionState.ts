import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import { goalExecutionSchema, type GoalExecution } from "../GoalExecution.js";
import { goalKV } from "./goalKV.js";

export const GOAL_EXECUTION_KEY = "execution";
export async function readExecution(
    ctx: Context,
    agentId: string,
): Promise<GoalExecution | undefined> {
    const value = await goalKV(agentId).read(ctx, GOAL_EXECUTION_KEY);
    if (value === undefined) return undefined;
    if (!Value.Check(goalExecutionSchema, value))
        throw new Error("The stored Goal execution is invalid.");
    return structuredClone(value);
}
export async function writeExecution(
    ctx: Context,
    agentId: string,
    execution: GoalExecution,
): Promise<void> {
    if (!Value.Check(goalExecutionSchema, execution)) throw new Error("Goal execution is invalid.");
    await goalKV(agentId).write(ctx, GOAL_EXECUTION_KEY, execution);
}
