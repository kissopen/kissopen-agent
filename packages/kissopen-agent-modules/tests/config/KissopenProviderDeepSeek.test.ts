import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { CodexApiKeyCredential, type SessionEvent } from "@kissopen/kissopen-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { KissopenProvider } from "../../sources/config/impl/KissopenProvider.js";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
});

/** A stand-in for the KISSOPEN server: records each call and streams one short answer. */
async function gateway(): Promise<{
    baseUrl: string;
    calls: { path: string; authorization: string; body: Record<string, unknown> }[];
}> {
    const calls: { path: string; authorization: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (request: IncomingMessage, response) => {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        calls.push({
            path: request.url ?? "",
            authorization: request.headers.authorization ?? "",
            body: JSON.parse(raw) as Record<string, unknown>,
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
        response.end(
            chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "pong" } }] }) +
                chunk({
                    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    usage: { prompt_tokens: 12, completion_tokens: 1, prompt_cache_hit_tokens: 8 },
                }) +
                "data: [DONE]\n\n",
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${String(port)}/api/agent/v1`, calls };
}

describe("KISSOPEN DeepSeek models", () => {
    it("go to the server's Chat Completions with the device key and DeepSeek's thinking fields", async () => {
        const server = await gateway();
        const credential = await CodexApiKeyCredential.tryLoad({ apiKey: "device-key" });
        const provider = new KissopenProvider({
            credential: credential!,
            endpoint: server.baseUrl,
        });
        const session = await provider.session("agent", { instructions: "Be brief.", tools: [] });

        const events: SessionEvent[] = [];
        for await (const event of session.run(createRootContext(), {
            model: "deepseek/deepseek-flash",
            effort: "high",
            context: {
                instructions: "Be brief.",
                messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
            },
        })) {
            events.push(event);
        }

        expect(server.calls).toHaveLength(1);
        expect(server.calls[0]).toMatchObject({
            path: "/api/agent/v1/chat/completions",
            authorization: "Bearer device-key",
            body: {
                model: "deepseek-flash",
                thinking: { type: "enabled" },
                reasoning_effort: "high",
            },
        });
        expect(events).toContainEqual({ type: "text_delta", delta: "pong" });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
        await session.destroy();
    });
});
