import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/*
Sets up a KISSOPEN scheduled task from inside a conversation.

The person asks for it here — "每个工作日早上 9 点汇总昨晚的邮件" — and it is made
here. It used to be handed back as a card the person opened to make the same
task a second time in Scheduled tasks; nobody wants to ask twice. The business
server reads the sentence into a plan and saves it; the task runs where this
conversation is, and every run comes back into this conversation. When what
was said leaves the time open, the server says what to ask, and nothing is
made until the person has answered.
*/

export const CREATE_SCHEDULED_TASK_TOOL = "create_scheduled_task";

export const scheduledTaskRequestSchema = Type.Object(
    {
        request: Type.String({
            minLength: 1,
            maxLength: 4000,
            description:
                "One sentence in the person's own language saying what should happen and when, e.g. '每个工作日早上 9 点，汇总昨晚进来的邮件'. After the person answered a question about the time, include their answer in it.",
        }),
    },
    { additionalProperties: false },
);
export type ScheduledTaskRequest = Static<typeof scheduledTaskRequestSchema>;

export const createdScheduleSchema = Type.Object({
    id: Type.String(),
    name: Type.String(),
    instruction: Type.String(),
    target: Type.String(),
    recurrence: Type.String(),
    weekday: Type.Number(),
    at_minute: Type.Number(),
    once_at: Type.Number(),
    timezone: Type.String(),
    next_run_at: Type.Number(),
    project_name: Type.String(),
});

export const scheduledTaskResultSchema = Type.Union([
    Type.Object({ status: Type.Literal("created"), schedule: createdScheduleSchema }),
    Type.Object({
        status: Type.Literal("needs"),
        question: Type.String(),
        choices: Type.Array(Type.String()),
    }),
    Type.Object({ status: Type.Literal("failed"), error: Type.String() }),
]);
export type ScheduledTaskResult = Static<typeof scheduledTaskResultSchema>;

function nextRunText(result: Extract<ScheduledTaskResult, { status: "created" }>): string {
    const at = result.schedule.next_run_at;
    if (!at) return "";
    const when = new Date(at).toLocaleString("zh-CN", {
        timeZone: result.schedule.timezone || "Asia/Shanghai",
        hour12: false,
    });
    return ` Next run: ${when} (${result.schedule.timezone}).`;
}

/** What the model is told to do after the call, beside the outcome itself. */
export function scheduledTaskNote(result: ScheduledTaskResult): string {
    if (result.status === "created")
        return `The scheduled task "${result.schedule.name}" is created and active.${nextRunText(result)} Tell the person briefly what will happen and when; do not ask them to create it again.`;
    if (result.status === "needs")
        return `Nothing was created yet: the time is not settled. Ask the person with request_user_input: "${result.question}"${result.choices.length > 0 ? `, offering: ${result.choices.join(" / ")}` : ""}. Then call ${CREATE_SCHEDULED_TASK_TOOL} again with a request that includes their answer.`;
    return `The scheduled task could not be created: ${result.error}. Tell the person plainly; do not say it was created.`;
}

export function createScheduledTaskTool(
    create: (ctx: Context, request: string) => Promise<ScheduledTaskResult>,
) {
    return defineAgentTool({
        name: CREATE_SCHEDULED_TASK_TOOL,
        defer: true,
        capabilities: [
            "Set up reminders and tasks that run later or repeat, in KissOpen Scheduled tasks.",
        ],
        searchKeywords: [
            "schedule task",
            "recurring task",
            "remind me later",
            "every day",
            "every morning",
            "daily summary",
            "定时任务",
            "计划任务",
            "提醒",
            "每天",
        ],
        description:
            "Create a KissOpen scheduled task for the person. Use it whenever they want something to happen at a later time or on a repeating basis — a reminder, a daily summary, a weekly check — instead of waiting or promising to do it later. It is created at once, runs where this conversation runs, and each run comes back into this conversation. If the result asks a question (status `needs`), ask the person with request_user_input, offering its choices, then call again with a request that includes their answer. When it is created, tell them in one or two sentences what will happen and when it next runs; they can change or stop it in Scheduled tasks.",
        parameters: scheduledTaskRequestSchema,
        returnType: scheduledTaskResultSchema,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: ScheduledTaskRequest) => await create(ctx, input.request),
        /*
         * Said as JSON: the outcome itself, which the person's apps draw as the task's card (they
         * read it from the stored result, there being no protocol presentation for it), and a
         * note telling the model what to do next.
         */
        toLLM: (result: ScheduledTaskResult) => [
            { type: "text", text: JSON.stringify({ ...result, note: scheduledTaskNote(result) }) },
        ],
    });
}
