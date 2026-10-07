import { describe, expect, it } from "vitest";

import { handleKissopenSessionRpc } from "../../sources/kissopen/index.js";

function recorder() {
    const calls: string[] = [];
    return {
        calls,
        options: {
            gitState: async () => ({
                success: false as const,
                code: "unavailable" as const,
                error: "Git is unavailable.",
            }),
            readFile: async () => ({ success: true as const, content: "", hash: "0".repeat(64) }),
            readFileAtRevision: async () => ({ success: true as const, content: "" }),
            listDirectory: async (request: { path: string }) => ({
                success: true as const,
                path: request.path,
                entries: [
                    { name: "outputs", type: "directory" as const, size: 0, modified: 1 },
                    { name: "deck.pptx", type: "file" as const, size: 191_000, modified: 2 },
                ],
                truncated: false,
            }),
            uploadFile: async (request: {
                path: string;
                offset: number;
                content: string;
                done: boolean;
            }) =>
                request.done
                    ? {
                          success: true as const,
                          done: true as const,
                          path: request.path,
                          size: request.offset + Buffer.from(request.content, "base64").byteLength,
                          hash: "0".repeat(64),
                      }
                    : {
                          success: true as const,
                          done: false as const,
                          received:
                              request.offset + Buffer.from(request.content, "base64").byteLength,
                      },
            abort: async () => {
                calls.push("abort");
            },
            answerQuestion: async (requestId: string, answers: Record<string, unknown>) => {
                calls.push(`answer:${requestId}:${JSON.stringify(answers)}`);
            },
            archive: async () => {
                calls.push("archive");
            },
            clear: async () => {
                calls.push("clear");
            },
            cancelQuestion: async (requestId: string) => {
                calls.push(`cancel:${requestId}`);
            },
        },
    };
}

describe("carrying out what the phone asked", () => {
    it("validates browser requests before invoking the account-scoped control", async () => {
        const { options } = recorder();
        const calls: unknown[] = [];
        const browserControl = async (request: unknown) => {
            calls.push(request);
            return { ok: true as const, paused: false };
        };
        const invoke = (params: unknown) =>
            handleKissopenSessionRpc({
                ...options,
                browserControl,
                method: "browserControl",
                params,
            });
        expect(await invoke({ action: "evaluate", script: "document.cookie" })).toMatchObject({
            ok: false,
        });
        expect(calls).toHaveLength(0);
        const request = { action: "attach", leaseId: "a".repeat(32), tabId: "b".repeat(32) };
        expect(await invoke(request)).toEqual({ ok: true, paused: false });
        expect(calls).toEqual([request]);
    });
    it("stops the agent", async () => {
        const { calls, options } = recorder();
        expect(await handleKissopenSessionRpc({ ...options, method: "abort", params: {} })).toEqual(
            {
                success: true,
            },
        );
        expect(calls).toEqual(["abort"]);
    });

    it("ends the session for the phone's kill switch", async () => {
        const { calls, options } = recorder();
        expect(
            await handleKissopenSessionRpc({ ...options, method: "killSession", params: {} }),
        ).toEqual({ success: true });
        expect(calls).toEqual(["archive"]);
    });

    it("clears the conversation, and says why when it cannot", async () => {
        const { calls, options } = recorder();
        expect(
            await handleKissopenSessionRpc({ ...options, method: "clearConversation", params: {} }),
        ).toEqual({ success: true });
        expect(calls).toEqual(["clear"]);

        expect(
            await handleKissopenSessionRpc({
                ...options,
                clear: async () => {
                    throw new Error(
                        "The agent is working; stop it before clearing its conversation.",
                    );
                },
                method: "clearConversation",
                params: {},
            }),
        ).toEqual({
            success: false,
            message: "The agent is working; stop it before clearing its conversation.",
        });
    });

    it("records an answer", async () => {
        const { calls, options } = recorder();
        expect(
            await handleKissopenSessionRpc({
                ...options,
                method: "communication",
                params: {
                    answers: { "req-1": { options: ["Yes"] } },
                    id: "req-1",
                    status: "answered",
                },
            }),
        ).toEqual({ success: true });
        expect(calls).toEqual([
            `answer:req-1:${JSON.stringify({ "req-1": { options: ["Yes"] } })}`,
        ]);
    });

    it("records an answer the desktop sent as a bare list in the shape every client reads", async () => {
        const { calls, options } = recorder();
        expect(
            await handleKissopenSessionRpc({
                ...options,
                method: "communication",
                params: {
                    answers: { meeting: ["十点", "带上周报"], note: "下午也行" },
                    id: "req-1",
                    status: "answered",
                },
            }),
        ).toEqual({ success: true });
        expect(calls).toEqual([
            `answer:req-1:${JSON.stringify({
                meeting: { options: ["十点", "带上周报"] },
                note: { options: [], custom: "下午也行" },
            })}`,
        ]);
    });

    it("takes the question away when the person dismissed it", async () => {
        const { calls, options } = recorder();
        expect(
            await handleKissopenSessionRpc({
                ...options,
                method: "communication",
                params: { id: "req-1", status: "cancelled" },
            }),
        ).toEqual({ success: true });
        expect(calls).toEqual(["cancel:req-1"]);
    });

    it("treats a phone that could not draw the form as a dismissal", async () => {
        const { calls, options } = recorder();
        await handleKissopenSessionRpc({
            ...options,
            method: "communication",
            params: { id: "req-1" },
        });
        expect(calls).toEqual(["cancel:req-1"]);
    });

    it("refuses an answer with nothing in it rather than answering with nothing", async () => {
        const { calls, options } = recorder();
        expect(
            await handleKissopenSessionRpc({
                ...options,
                method: "communication",
                params: { id: "req-1", status: "answered" },
            }),
        ).toEqual({ error: "KissOpen answered a question without any answers." });
        expect(calls).toEqual([]);
    });

    it("says so when it cannot read what arrived", async () => {
        const { options } = recorder();
        expect(
            await handleKissopenSessionRpc({
                ...options,
                method: "communication",
                params: "nonsense",
            }),
        ).toEqual({ error: "KissOpen sent an answer KissOpen Agent could not read." });
    });

    it("refuses a method it does not have", async () => {
        const { calls, options } = recorder();
        expect(await handleKissopenSessionRpc({ ...options, method: "bash", params: {} })).toEqual({
            error: "Method not found",
        });
        expect(calls).toEqual([]);
    });
});
