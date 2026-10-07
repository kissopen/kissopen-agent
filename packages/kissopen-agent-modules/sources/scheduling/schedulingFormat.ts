import { type SchedulingWaitResult } from "./Scheduling.js";
import { humanDuration } from "./schedulingTime.js";

/** What the model is told when a wait ends. A wait ID means nothing to it, so it never appears. */
export function waitText(result: SchedulingWaitResult): string {
    const elapsed = humanDuration(result.elapsedMs);
    return result.outcome === "interrupted"
        ? `The wait ended early because a new message arrived after ${elapsed}.`
        : `The wait finished after ${elapsed}.`;
}
