import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { CodexApiKeyCredential, type SessionEvent } from "@kissopen/kissopen-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { KissopenProvider } from "../../sources/config/impl/KissopenProvider.js";
import type { KissopenServedRoute } from "../../sources/config/impl/kissopenServedModels.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});

interface Call {
    path: string;
    authorization: string;
    session: string;
    body: Record<string, unknown>;
}

/** A stand-in for the KISSOPEN server that answers Chat Completions and Anthropic Messages. */
async function gateway(): Promise<{ baseUrl: string; calls: Call[] }> {
    const calls: Call[] = [];
    const server = createServer(async (request: IncomingMessage, response) => {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        calls.push({
            path: request.url ?? "",
            authorization: request.headers.authorization ?? "",
            session: String(request.headers["session-id"] ?? ""),
            body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
        if ((request.url ?? "").startsWith("/api/agent/v1/messages")) {
            const event = (type: string, value: Record<string, unknown>) =>
                `event: ${type}\n${data({ type, ...value })}`;
            response.end(
                event("message_start", {
                    message: {
                        id: "msg_1",
                        type: "message",
                        role: "assistant",
                        model: "claude-x",
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: { input_tokens: 12, output_tokens: 1 },
                    },
                }) +
                    event("content_block_start", {
                        index: 0,
                        content_block: { type: "text", text: "" },
                    }) +
                    event("content_block_delta", {
                        index: 0,
                        delta: { type: "text_delta", text: "pong" },
                    }) +
                    event("content_block_stop", { index: 0 }) +
                    event("message_delta", {
                        delta: { stop_reason: "end_turn", stop_sequence: null },
                        usage: { output_tokens: 2 },
                    }) +
                    event("message_stop", {}),
            );
            return;
        }
        response.end(
            data({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] }) +
                data({
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 12, completion_tokens: 1 },
                }) +
                "data: [DONE]\n\n",
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${String(port)}/api/agent/v1`, calls };
}

const served: Record<string, KissopenServedRoute> = {
    "zen/glm-5": { protocol: "chat", max_output_tokens: 32_768 },
    "zen/claude-x": { protocol: "messages", max_output_tokens: 64_000 },
};

async function run(model: string): Promise<{ calls: Call[]; events: SessionEvent[] }> {
    const server = await gateway();
    const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "device-key" });
    const provider = new KissopenProvider({
        credential: credential!,
        endpoint: server.baseUrl,
        servedRoute: (id) => (id === undefined ? undefined : served[id]),
    });
    const session = await provider.session("agent", { instructions: "Be brief.", tools: [] });
    const events: SessionEvent[] = [];
    for await (const event of session.run(createRootContext(), {
        model,
        context: {
            instructions: "Be brief.",
            messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
        },
    })) {
        events.push(event);
    }
    await session.destroy();
    return { calls: server.calls, events };
}

describe("models the KISSOPEN server serves from console upstreams", () => {
    it("go over Chat Completions when the server says so, under the Agent's own name", async () => {
        const { calls, events } = await run("zen/glm-5");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            path: "/api/agent/v1/chat/completions",
            authorization: "Bearer device-key",
            session: "agent",
            body: { model: "zen/glm-5", max_tokens: 32_768 },
        });
        expect(events).toContainEqual({ type: "text_delta", delta: "pong" });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("go over Anthropic Messages to the server with the device key as a bearer token", async () => {
        const { calls, events } = await run("zen/claude-x");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.path.startsWith("/api/agent/v1/messages")).toBe(true);
        expect(calls[0]).toMatchObject({
            authorization: "Bearer device-key",
            session: "agent",
            body: { model: "zen/claude-x", stream: true },
        });
        expect(events).toContainEqual({ type: "text_delta", delta: "pong" });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });
});
