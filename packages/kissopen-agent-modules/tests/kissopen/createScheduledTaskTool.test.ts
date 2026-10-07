import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    createScheduledTaskTool,
    type ScheduledTaskResult,
} from "../../sources/kissopen/createScheduledTaskTool.js";

const created: ScheduledTaskResult = {
    status: "created",
    schedule: {
        id: "s1",
        name: "汇总邮件",
        instruction: "汇总昨晚进来的邮件",
        target: "machine:mac",
        recurrence: "weekdays",
        weekday: 0,
        at_minute: 540,
        once_at: 0,
        timezone: "Asia/Shanghai",
        next_run_at: Date.UTC(2026, 8, 30, 1, 0),
        project_name: "发布会",
    },
};

describe("setting up a scheduled task from a conversation", () => {
    it("makes the task with the person's sentence and says it is made", async () => {
        const asked: string[] = [];
        const tool = createScheduledTaskTool(async (_ctx, request) => {
            asked.push(request);
            return created;
        });
        const request = "每个工作日早上 9 点，汇总昨晚进来的邮件";
        const result = await tool.execute(createRootContext(), { request }, { id: "c1" } as never);
        expect(asked).toEqual([request]);
        expect(result).toEqual(created);
        const told = JSON.stringify(tool.toLLM?.(result as never));
        expect(told).toContain("is created and active");
        expect(told).toContain("do not ask them to create it again");
        expect(told).toContain("2026/9/30 09:00:00");
    });

    it("turns an unsettled time into a question to ask, and a failure into plain words", () => {
        const tool = createScheduledTaskTool(async () => created);
        const needs = JSON.stringify(
            tool.toLLM?.({
                status: "needs",
                question: "几点汇总？",
                choices: ["每天 09:00", "每天 18:00"],
            }),
        );
        expect(needs).toContain("Nothing was created yet");
        expect(needs).toContain("request_user_input");
        expect(needs).toContain("每天 09:00 / 每天 18:00");
        const failed = JSON.stringify(tool.toLLM?.({ status: "failed", error: "连不上" }));
        expect(failed).toContain("could not be created: 连不上");
        expect(failed).toContain("do not say it was created");
    });
});
