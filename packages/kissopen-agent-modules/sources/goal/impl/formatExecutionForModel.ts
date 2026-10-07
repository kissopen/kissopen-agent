import type { GoalExecution } from "../GoalExecution.js";

/** Bounded current domain state; omit internal observation indexes and keep valid JSON. */
export function formatExecutionForModel(execution: GoalExecution | undefined): string {
    if (execution === undefined) return "null";
    const state = {
        goalId: execution.goalId,
        revision: execution.revision,
        phase: execution.phase,
        summary: execution.summary.slice(0, 128),
        reason: execution.reason?.slice(0, 256),
        budget: execution.budget,
        taskCount: execution.taskIds.length,
        criteria: execution.criteria.map((criterion) => {
            const evidence = execution.evidence.find((item) => item.criterionId === criterion.id);
            return {
                id: criterion.id,
                description: criterion.description.slice(0, 100),
                evidence:
                    evidence === undefined ? null : { historyPosition: evidence.historyPosition },
            };
        }),
        omittedCriteria: 0,
        recheckAt: execution.wait?.dueAt,
    };
    while (JSON.stringify(state).length > 6_000 && state.criteria.length > 0) {
        state.criteria.pop();
        state.omittedCriteria += 1;
    }
    return JSON.stringify(state);
}
