import { Value } from "@sinclair/typebox/value";
import { localTaskRuleSchema, type LocalTaskRule } from "@kissopen/kissopen-agent-client";

export function validateLocalTaskRule(rule: LocalTaskRule): void {
    if (!Value.Check(localTaskRuleSchema, rule)) throw new Error("The schedule is invalid.");
    try {
        new Intl.DateTimeFormat("en", { timeZone: rule.timezone }).format(0);
    } catch {
        throw new Error("Choose a valid timezone, such as Asia/Shanghai.");
    }
    if (rule.recurrence === "interval" && rule.intervalMinutes === undefined)
        throw new Error("Specify how many minutes there are between runs.");
    if (rule.recurrence === "once" && rule.onceAt === undefined)
        throw new Error("Specify the date and time for this task.");
    if (["daily", "weekdays", "weekly"].includes(rule.recurrence) && rule.atMinute === undefined)
        throw new Error("Specify what time of day this task should run.");
    if (rule.recurrence === "weekly" && rule.weekday === undefined)
        throw new Error("Specify the day of the week for this task.");
}

/** First future occurrence. Calendar matching preserves local time across DST. */
export function nextLocalTaskTime(rule: LocalTaskRule, after: number): number | null {
    validateLocalTaskRule(rule);
    if (rule.recurrence === "once") return rule.onceAt! > after ? rule.onceAt! : null;
    if (rule.recurrence === "interval") return after + rule.intervalMinutes! * 60000;
    const format = new Intl.DateTimeFormat("en-US", {
        timeZone: rule.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    });
    const local = (at: number) => {
        const parts = format.formatToParts(at);
        const part = (name: string) => Number(parts.find((p) => p.type === name)!.value);
        const day = Date.UTC(part("year"), part("month") - 1, part("day"));
        return {
            day,
            weekday: new Date(day).getUTCDay(),
            minute: part("hour") * 60 + part("minute"),
        };
    };
    const previous = local(after);
    for (
        let at = Math.floor(after / 60000) * 60000 + 60000;
        at <= after + 8 * 86400000;
        at += 60000
    ) {
        const candidate = local(at);
        // A repeated clock minute must not create two runs on the same local date.
        if (candidate.day === previous.day && previous.minute >= rule.atMinute!) continue;
        if (candidate.minute !== rule.atMinute) continue;
        if (rule.recurrence === "weekdays" && (candidate.weekday === 0 || candidate.weekday === 6))
            continue;
        if (rule.recurrence === "weekly" && candidate.weekday !== rule.weekday) continue;
        return at;
    }
    throw new Error("The next scheduled time could not be resolved.");
}
