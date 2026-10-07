import { afterEach, describe, expect, it } from "vitest";

import { createGym, type Gym } from "@kissopen/kissopen-terminal-gym";
import { decryptKissopenPayload } from "@kissopen/kissopen-agent-modules";

const running = new Set<Gym>();

afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("KISSOPEN machine registration", () => {
    it("publishes a distinct persistent KISSOPEN Agent machine with the launch catalog", async () => {
        const secret = new Uint8Array(32).fill(7);
        let registeredMachine: { id: string; metadata: unknown } | undefined;
        const gym = await createGym({
            environment: {
                NO_PROXY: "127.0.0.1,localhost",
                KISSOPEN_AGENT_KISSOPEN_SERVER_URL: "{{HTTP_PROXY_URL}}",
            },
            homeFiles: {
                ".kissopen/access.key": JSON.stringify({
                    secret: Buffer.from(secret).toString("base64"),
                    token: "kissopen-gym-token",
                }),
                ".kissopen/settings.json": JSON.stringify({ machineId: "native-kissopen-machine" }),
            },
            httpProxy: {
                handler(request) {
                    const url = new URL(request.url);
                    const json = (value: unknown) => ({
                        response: {
                            body: JSON.stringify(value),
                            headers: { "content-type": "application/json" },
                            status: 200,
                        },
                    });
                    if (request.method === "POST" && url.pathname === "/v1/machines") {
                        const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
                            id: string;
                            metadata: string;
                        };
                        registeredMachine = {
                            id: body.id,
                            metadata: decryptKissopenPayload(
                                secret,
                                "legacy",
                                Buffer.from(body.metadata, "base64"),
                            ),
                        };
                        return json({
                            machine: {
                                daemonStateVersion: 0,
                                id: body.id,
                                metadata: body.metadata,
                                metadataVersion: 0,
                            },
                        });
                    }
                    if (request.method === "POST" && url.pathname === "/v1/sessions") {
                        const body = JSON.parse(Buffer.from(request.body).toString("utf8")) as {
                            metadata: string;
                        };
                        return json({
                            session: {
                                id: "kissopen-session-1",
                                metadata: body.metadata,
                                metadataVersion: 0,
                            },
                        });
                    }
                    if (url.pathname === "/v3/sessions/kissopen-session-1/messages") {
                        return json({ hasMore: false, messages: [] });
                    }
                    return { response: { body: "Not found", status: 404 } };
                },
            },
            inference: [
                {
                    content: [
                        {
                            text: "KISSOPEN Agent stayed available after registration.",
                            type: "text",
                        },
                    ],
                },
            ],
            timeoutMs: 30_000,
        });
        running.add(gym);

        gym.terminal.type("Verify the KISSOPEN Agent machine registration.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("KISSOPEN Agent stayed available after registration.", 30_000);

        expect(registeredMachine?.id).not.toBe("native-kissopen-machine");
        expect(registeredMachine?.metadata).toMatchObject({
            capabilities: { newSession: true, resume: false, worktrees: false },
            client: { id: "rig", name: "KISSOPEN Agent" },
            defaults: { permissionMode: "auto" },
            machineKind: "rig",
            models: expect.arrayContaining([
                expect.objectContaining({
                    id: "openai/gym",
                    name: "Gym",
                    providerId: "gym",
                }),
            ]),
            rigOnly: true,
            sessionCreation: {
                idempotencyKey: "clientRequestId",
                pendingRetryAfterMs: 2_000,
            },
        });
        const identity = await gym.runInContainer("node", [
            "-e",
            [
                'const fs=require("node:fs")',
                'const path="/home/kissopen-terminal/.kissopen/agent/kissopen/machine.json"',
                'process.stdout.write(JSON.parse(fs.readFileSync(path,"utf8")).id)',
            ].join(";"),
        ]);
        expect(identity.stdout).toBe(registeredMachine?.id);
    }, 60_000);
});
