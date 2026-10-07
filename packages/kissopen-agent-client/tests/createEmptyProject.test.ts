import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { createEmptyProjectRequestSchema, KissopenAgentClient } from "../sources/index.js";

describe("named empty project creation", () => {
    it("accepts a name without a Home project or a filesystem path", () => {
        expect(Value.Check(createEmptyProjectRequestSchema, { name: "新项目" })).toBe(true);
        for (const input of [{}, { name: "" }, { name: 1 }, { name: "Test", path: "/tmp" }]) {
            expect(Value.Check(createEmptyProjectRequestSchema, input)).toBe(false);
        }
    });

    it("preserves retry identity and cancellation through the authenticated peer route", async () => {
        const controller = new AbortController();
        const request = { name: "新项目", projectId: "project123", mutationId: "mutation123" };
        let calls = 0;
        const client = new KissopenAgentClient({
            endpoint: "http://main/prefix",
            token: "test-token",
            fetch: async (input, init) => {
                calls++;
                expect(new URL(input.toString()).pathname).toBe(
                    "/prefix/v0/connections/peer/api/v0/projects/create",
                );
                expect(init?.method).toBe("POST");
                expect(init?.signal).toBe(controller.signal);
                expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
                expect(JSON.parse(String(init?.body))).toEqual(request);
                return Response.json({ project: { id: request.projectId } }, { status: 202 });
            },
        });
        const peer = client.connection("peer");
        await expect(
            peer.createEmptyProject(request, { signal: controller.signal }),
        ).resolves.toEqual({ project: { id: request.projectId } });
        await peer.createEmptyProject(request, { signal: controller.signal });
        expect(calls).toBe(2);
    });

    it.each([400, 401, 404, 503])(
        "preserves HTTP %i without replaying creation",
        async (status) => {
            let calls = 0;
            const client = new KissopenAgentClient({
                endpoint: "http://main",
                token: "test-token",
                fetch: async () => {
                    calls++;
                    return Response.json({ code: "not_found", error: "Unavailable." }, { status });
                },
            });
            await expect(
                client.createEmptyProject({ name: "Project", projectId: "project123" }),
            ).rejects.toMatchObject({ status });
            expect(calls).toBe(1);
        },
    );
});
