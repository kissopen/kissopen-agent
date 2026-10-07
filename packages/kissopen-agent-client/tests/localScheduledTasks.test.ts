import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import {
    KissopenAgentClient,
    createLocalTaskSchema,
    localTaskRuleSchema,
} from "../sources/index.js";

describe("local scheduled task SDK", () => {
    it("accepts minute-level plans and rejects invalid limits", () => {
        const request = {
            id: "task1",
            agentId: "agent1",
            name: "Reminder",
            instruction: "Check progress",
            rule: { recurrence: "interval", timezone: "UTC", intervalMinutes: 1 },
        };
        expect(Value.Check(createLocalTaskSchema, request)).toBe(true);
        for (const minutes of [0, 1.5, 10081])
            expect(
                Value.Check(localTaskRuleSchema, { ...request.rule, intervalMinutes: minutes }),
            ).toBe(false);
    });
    it("keeps identity, authentication, cancellation and route encoding on all methods", async () => {
        const seen: { path: string; method: string; body: unknown }[] = [];
        const controller = new AbortController();
        const client = new KissopenAgentClient({
            endpoint: "http://local/prefix",
            token: "test-token",
            fetch: async (input, init) => {
                expect(init?.signal).toBe(controller.signal);
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
                seen.push({
                    path: new URL(input.toString()).pathname,
                    method: init!.method!,
                    body: init?.body ? JSON.parse(String(init.body)) : null,
                });
                return Response.json({});
            },
        });
        const options = { signal: controller.signal };
        const request = {
            id: "task1",
            agentId: "agent1",
            name: "Reminder",
            instruction: "Check",
            rule: { recurrence: "interval" as const, timezone: "UTC", intervalMinutes: 1 },
        };
        await client.createLocalTask(request, options);
        await client.createLocalTask(request, options);
        await client.listLocalTasks({ limit: 100 }, options);
        await client.getLocalTask("task1", options);
        await client.updateLocalTask("task1", { status: "paused" }, options);
        await client.runLocalTask("task1", { id: "run1" }, options);
        await client.listLocalTaskRuns("task1", { limit: 200 }, options);
        await client.readLocalTaskRun("task1", "run1", options);
        expect(seen[0]!.body).toEqual(seen[1]!.body);
        expect(seen.map((s) => s.path)).toEqual(
            [
                "",
                "",
                "",
                "/task1",
                "/task1",
                "/task1/run",
                "/task1/runs",
                "/task1/runs/run1/read",
            ].map((suffix) => "/prefix/v0/scheduled-tasks" + suffix),
        );
    });
    it("does not replay a rejected mutation", async () => {
        let calls = 0;
        const client = new KissopenAgentClient({
            endpoint: "http://local",
            token: "test",
            fetch: async () => {
                calls++;
                return Response.json(
                    { code: "conflict", error: "Already running." },
                    { status: 409 },
                );
            },
        });
        await expect(client.runLocalTask("task", { id: "run" })).rejects.toMatchObject({
            status: 409,
        });
        expect(calls).toBe(1);
    });
});
