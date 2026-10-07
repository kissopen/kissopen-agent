import { afterEach, describe, expect, it } from "vitest";
import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("local scheduled work without a cloud account", () => {
    it("creates semantically in the conversation, runs now, survives restart and runs when due", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_scheduled_task",
                            arguments: {
                                request: "每分钟提醒我喝水",
                                plan: {
                                    name: "Drink water",
                                    instruction: "Remind me to drink water",
                                    rule: {
                                        recurrence: "interval",
                                        intervalMinutes: 1,
                                        timezone: "Asia/Shanghai",
                                    },
                                },
                            },
                        },
                    ],
                },
                { content: [{ type: "text", text: "The local reminder has been created." }] },
                { content: [{ type: "text", text: "Time to drink water." }] },
                { content: [{ type: "text", text: "The scheduled reminder ran after restart." }] },
            ],
            permissionMode: "full_access",
        });
        running.add(gym);
        await gym.send("每分钟提醒我喝水");
        const list = await gym.client.listLocalTasks();
        expect(list.tasks).toHaveLength(1);
        const task = list.tasks[0]!;
        expect(task.agentId).toBe(gym.defaultSessionId);
        expect(task.rule.intervalMinutes).toBe(1);
        expect(
            gym.inference
                .toolResults()
                .map((result) => result.text)
                .join("\n"),
        ).toContain('"status":"created"');
        const manual = await gym.client.runLocalTask(task.id, { id: "manual-once" });
        await gym.waitUntil(async () => {
            const runs = await gym.client.listLocalTaskRuns(task.id);
            return runs.runs.find((run) => run.id === manual.run.id && run.status === "succeeded");
        }, "the manual task to actually finish");
        expect((await gym.client.runLocalTask(task.id, { id: "manual-once" })).run.status).toBe(
            "succeeded",
        );
        await gym.client.updateLocalTask(task.id, {
            rule: { recurrence: "once", onceAt: Date.now() + 3000, timezone: "UTC" },
        });
        await gym.restart();
        expect((await gym.client.getLocalTask(task.id)).task.name).toBe("Drink water");
        await gym.waitUntil(async () => {
            const runs = (await gym.client.listLocalTaskRuns(task.id)).runs;
            return runs.length === 2 && runs.every((run) => run.status === "succeeded")
                ? runs
                : undefined;
        }, "the due reminder to finish exactly once");
        expect((await gym.client.getLocalTask(task.id)).task.status).toBe("completed");
        const texts = gym.inference.userTexts();
        expect(texts).toContain("Scheduled task: Remind me to drink water");
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("asks in the same conversation when timing is missing and rejects an unavailable agent", async () => {
        const gym = await createAgentGym({
            inference: [
                {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_scheduled_task",
                            arguments: { request: "以后提醒我喝水" },
                        },
                    ],
                },
                { content: [{ type: "text", text: "When should I remind you?" }] },
            ],
        });
        running.add(gym);
        await gym.send("以后提醒我喝水");
        expect((await gym.client.listLocalTasks()).tasks).toEqual([]);
        expect(
            gym.inference
                .toolResults()
                .map((result) => result.text)
                .join("\n"),
        ).toContain('"status":"needs"');
        await expect(
            gym.client.createLocalTask({
                id: "invalid",
                agentId: "missingagent",
                name: "Task",
                instruction: "Reminder",
                rule: { recurrence: "interval", intervalMinutes: 1, timezone: "UTC" },
            }),
        ).rejects.toMatchObject({ status: 404 });
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    });
});
