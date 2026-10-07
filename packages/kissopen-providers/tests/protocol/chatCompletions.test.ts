import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { SessionAssistantMessageAccumulator } from "@/core/SessionAssistantMessageAccumulator.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionMessage } from "@/core/SessionContext.js";
import type { SessionTool } from "@/core/SessionTool.js";
import {
    ChatCompletionsProvider,
    type ChatCompletionsProviderOptions,
} from "@/protocol/chatCompletions/ChatCompletionsProvider.js";
import { toChatCompletionsMessages } from "@/protocol/chatCompletions/createChatCompletionsRequest.js";
import { ChatCompletionsToolNames } from "@/protocol/chatCompletions/toChatCompletionsTools.js";
import { testContext, testContextWith } from "../testContext.js";

type FetchCall = { url: string; init: RequestInit; body: Record<string, any> };

/** Streams SSE text in deliberately awkward pieces so framing is exercised, not assumed. */
function sse(items: readonly unknown[], options: { done?: boolean; pieceSize?: number } = {}) {
    const text =
        ": keep-alive\r\n\r\n" +
        items
            .map(
                (item) => `data: ${typeof item === "string" ? item : JSON.stringify(item)}\r\n\r\n`,
            )
            .join("") +
        (options.done === false ? "" : "data: [DONE]\n\n");
    const bytes = new TextEncoder().encode(text);
    const size = options.pieceSize ?? 7;
    let offset = 0;
    return new Response(
        new ReadableStream<Uint8Array>({
            pull(controller) {
                if (offset >= bytes.length) {
                    controller.close();
                    return;
                }
                controller.enqueue(bytes.slice(offset, offset + size));
                offset += size;
            },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
    );
}

function errorResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
}

function chunk(delta: Record<string, unknown>, finish: string | null = null, extra = {}) {
    return { id: "chatcmpl-1", choices: [{ index: 0, delta, finish_reason: finish }], ...extra };
}

function usageChunk(usage: Record<string, unknown>) {
    return { id: "chatcmpl-1", choices: [], usage };
}

function mockFetch(responses: readonly (Response | (() => Response | Promise<Response>))[]) {
    const calls: FetchCall[] = [];
    let index = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({
            url: String(input),
            init: init ?? {},
            body: JSON.parse(String(init?.body ?? "{}")),
        });
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (next === undefined) throw new Error("No response scripted.");
        return typeof next === "function" ? await next() : next;
    }) as typeof globalThis.fetch;
    return { fetch, calls };
}

function provider(
    fetch: typeof globalThis.fetch,
    options: Partial<ChatCompletionsProviderOptions> = {},
) {
    return new ChatCompletionsProvider({
        apiKey: "sk-test",
        baseUrl: "https://api.example.test/v1/",
        service: "Example",
        model: "example-model",
        fetch,
        waitForInferenceRetry: async () => {},
        ...options,
    });
}

const userTurn: SessionMessage = { role: "user", content: [{ type: "text", text: "Hello" }] };

async function collect(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

function types(events: readonly SessionEvent[]): string[] {
    return events.map((event) => (event.type === "done" ? `done:${event.state}` : event.type));
}

describe("Chat Completions protocol", () => {
    it.each(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)(
        "sends explicitly configured standard reasoning effort %s",
        async (effort) => {
            const { fetch, calls } = mockFetch([
                sse([chunk({ content: "Hi" }), chunk({}, "stop")]),
            ]);
            const session = await provider(fetch, {
                resolveModel: () => ({ wireModel: "custom", thinkingControl: "openai" }),
            }).session("reasoning", { instructions: "", tools: [] });
            try {
                await collect(
                    session.run(testContext, {
                        context: { instructions: "", messages: [userTurn] },
                        effort,
                    }),
                );
                expect(calls).toHaveLength(1);
                expect(calls[0]?.body.reasoning_effort).toBe(effort === "off" ? "none" : effort);
                expect(calls[0]?.body).not.toHaveProperty("thinking");
            } finally {
                await session.destroy();
            }
        },
    );
    it("leaves service defaults untouched when reasoning capability is not declared", async () => {
        const { fetch, calls } = mockFetch([sse([chunk({ content: "Hi" }), chunk({}, "stop")])]);
        const session = await provider(fetch).session("default", { instructions: "", tools: [] });
        try {
            await collect(
                session.run(testContext, {
                    context: { instructions: "", messages: [userTurn] },
                    effort: "off",
                }),
            );
            expect(calls[0]?.body).not.toHaveProperty("reasoning_effort");
            expect(calls[0]?.body).not.toHaveProperty("thinking");
        } finally {
            await session.destroy();
        }
    });
    it("streams text and sends the documented request", async () => {
        const { fetch, calls } = mockFetch([
            sse([
                chunk({ role: "assistant", content: "" }),
                chunk({ content: "Hi" }),
                chunk({ content: " there" }),
                chunk({}, "stop"),
                usageChunk({
                    prompt_tokens: 20,
                    completion_tokens: 3,
                    total_tokens: 23,
                    prompt_cache_hit_tokens: 16,
                    prompt_cache_miss_tokens: 4,
                }),
            ]),
        ]);
        const session = await provider(fetch).session("text", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, {
                context: { instructions: "Be brief.", messages: [userTurn] },
            }),
        );

        expect(types(events)).toEqual([
            "block_start",
            "text_start",
            "text_delta",
            "text_end",
            "token_usage",
            "block_stop",
            "done:normal",
        ]);
        expect(events.at(-3)).toEqual({
            type: "token_usage",
            usage: { input: 20, output: 3, cacheRead: 16, cacheWrite: 0, totalTokens: 23 },
        });
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "normal",
            tokens: { input: 20, output: 3 },
            endTurn: true,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe("https://api.example.test/v1/chat/completions");
        const headers = new Headers(calls[0]!.init.headers);
        expect(headers.get("authorization")).toBe("Bearer sk-test");
        expect(calls[0]!.body).toEqual({
            model: "example-model",
            messages: [
                { role: "system", content: "Be brief." },
                { role: "user", content: "Hello" },
            ],
            stream: true,
            stream_options: { include_usage: true },
        });
    });

    it("streams reasoning before the answer and keeps blocks from interleaving", async () => {
        const { fetch } = mockFetch([
            sse([
                chunk({ role: "assistant", reasoning_content: "Think", content: null }),
                chunk({ reasoning_content: "ing." }),
                chunk({ content: "Done." }),
                chunk({}, "stop"),
            ]),
        ]);
        const session = await provider(fetch).session("reasoning", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );

        expect(types(events)).toEqual([
            "block_start",
            "reasoning_start",
            "reasoning_delta",
            "reasoning_end",
            "text_start",
            "text_delta",
            "text_end",
            "block_stop",
            "done:normal",
        ]);
        const accumulator = new SessionAssistantMessageAccumulator();
        for (const event of events) accumulator.add(event);
        expect(accumulator.message()?.content).toEqual([
            { type: "reasoning", text: "Thinking." },
            { type: "text", text: "Done." },
        ]);
    });

    it("maps interleaved streamed tool calls by index, including namespaced tools", async () => {
        const tools: SessionTool[] = [
            {
                name: "read_file",
                description: "Read a file.",
                parameters: Type.Object({ path: Type.String() }),
            },
            {
                name: "lookup",
                namespace: "docs",
                description: "Search the docs.",
                parameters: Type.Object({ query: Type.String() }),
                defer: true,
            },
            {
                name: "fetch",
                namespace: "web.tools",
                parameters: Type.Object({ url: Type.String() }),
            },
            { name: "web_search", server: { type: "web_search" } },
        ];
        const { fetch, calls } = mockFetch([
            sse([
                chunk({ content: "Let me look." }),
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: "call_a",
                            type: "function",
                            function: { name: "read_file", arguments: "" },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [
                        {
                            index: 1,
                            id: "call_b",
                            type: "function",
                            function: { name: "mcp__docs__lookup", arguments: "" },
                        },
                    ],
                }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
                chunk({ tool_calls: [{ index: 1, function: { arguments: '{"query":"x"}' } }] }),
                chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
                chunk({}, "tool_calls"),
                usageChunk({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }),
            ]),
        ]);
        const session = await provider(fetch).session("tools", { instructions: "", tools });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );

        const sent = calls[0]!.body.tools as { function: { name: string } }[];
        expect(sent.map((tool) => tool.function.name)).toEqual([
            "read_file",
            "mcp__docs__lookup",
            expect.stringMatching(/^mcp__web_tools__fetch_[0-9a-f]{8}$/),
        ]);
        expect(types(events)).toEqual([
            "block_start",
            "text_start",
            "text_delta",
            "text_end",
            "toolcall_start",
            "toolcall_start",
            "toolcall_delta",
            "toolcall_delta",
            "toolcall_delta",
            "toolcall_end",
            "toolcall_end",
            "token_usage",
            "block_stop",
            "done:tool_call",
        ]);
        expect(events[5]).toEqual({
            type: "toolcall_start",
            callId: "call_b",
            name: "lookup",
            namespace: "docs",
        });
        expect(events.filter((event) => event.type === "toolcall_delta")).toEqual([
            { type: "toolcall_delta", callId: "call_a", delta: '{"path":' },
            { type: "toolcall_delta", callId: "call_b", delta: '{"query":"x"}' },
            { type: "toolcall_delta", callId: "call_a", delta: '"a.ts"}' },
        ]);
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "tool_call",
            tokens: { input: 50, output: 20 },
        });
        const accumulator = new SessionAssistantMessageAccumulator();
        for (const event of events) accumulator.add(event);
        expect(accumulator.message()?.content).toEqual([
            { type: "text", text: "Let me look." },
            {
                type: "tool_call",
                callId: "call_a",
                name: "read_file",
                arguments: '{"path":"a.ts"}',
            },
            {
                type: "tool_call",
                callId: "call_b",
                name: "lookup",
                namespace: "docs",
                arguments: '{"query":"x"}',
            },
        ]);

        // A hashed name streamed back resolves to the caller's namespace and name.
        const hashed = sent[2]!.function.name;
        const { fetch: second } = mockFetch([
            sse([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: "call_c",
                            function: { name: hashed, arguments: '{"url":"https://x"}' },
                        },
                    ],
                }),
                chunk({}, "tool_calls"),
            ]),
        ]);
        const replay = await provider(second).session("tools-hashed", { instructions: "", tools });
        const replayed = await collect(
            replay.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(replayed.find((event) => event.type === "toolcall_start")).toEqual({
            type: "toolcall_start",
            callId: "call_c",
            name: "fetch",
            namespace: "web.tools",
        });
    });

    it("sends grammar tools as one input string and hands back the raw text", async () => {
        const tools: SessionTool[] = [
            {
                name: "apply_patch",
                description: "Edit files.",
                grammar: { type: "lark", grammar: 'start: "*** Begin Patch"' },
                parameters: Type.Object({ input: Type.String() }),
            },
        ];
        const patch = "*** Begin Patch\n*** End Patch";
        const { fetch, calls } = mockFetch([
            sse([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: "call_p",
                            function: {
                                name: "apply_patch",
                                arguments: JSON.stringify({ input: patch }).slice(0, 10),
                            },
                        },
                    ],
                }),
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            function: { arguments: JSON.stringify({ input: patch }).slice(10) },
                        },
                    ],
                }),
                chunk({}, "tool_calls"),
            ]),
        ]);
        const session = await provider(fetch).session("grammar", { instructions: "", tools });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );

        expect(calls[0]!.body.tools).toEqual([
            {
                type: "function",
                function: {
                    name: "apply_patch",
                    description: expect.stringContaining('start: "*** Begin Patch"'),
                    parameters: {
                        type: "object",
                        properties: { input: expect.objectContaining({ type: "string" }) },
                        required: ["input"],
                        additionalProperties: false,
                    },
                },
            },
        ]);
        expect(events.filter((event) => event.type.startsWith("toolcall"))).toEqual([
            {
                type: "toolcall_start",
                callId: "call_p",
                name: "apply_patch",
                vendor: { type: "chat_completions_freeform" },
            },
            { type: "toolcall_delta", callId: "call_p", delta: patch },
            { type: "toolcall_end", callId: "call_p", arguments: patch },
        ]);

        const messages = toChatCompletionsMessages(
            [
                userTurn,
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            callId: "call_p",
                            name: "apply_patch",
                            arguments: patch,
                            vendor: { type: "chat_completions_freeform" },
                        },
                    ],
                },
                { role: "tool", callId: "call_p", content: [{ type: "text", text: "ok" }] },
            ],
            { names: new ChatCompletionsToolNames([]), vision: false },
        );
        expect(messages[1]).toMatchObject({
            tool_calls: [{ function: { arguments: JSON.stringify({ input: patch }) } }],
        });
    });

    it("reads Moonshot usage from the finishing choice and cached tokens", async () => {
        const { fetch } = mockFetch([
            sse([
                chunk({ content: "ok" }),
                {
                    id: "chatcmpl-1",
                    choices: [
                        {
                            index: 0,
                            delta: {},
                            finish_reason: "stop",
                            usage: {
                                prompt_tokens: 100,
                                completion_tokens: 2,
                                total_tokens: 102,
                                cached_tokens: 64,
                            },
                        },
                    ],
                },
            ]),
        ]);
        const session = await provider(fetch).session("kimi-usage", {
            instructions: "",
            tools: [],
        });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(events.find((event) => event.type === "token_usage")).toEqual({
            type: "token_usage",
            usage: { input: 100, output: 2, cacheRead: 64, cacheWrite: 0, totalTokens: 102 },
        });
    });

    it("reads OpenAI-style cached token details", async () => {
        const { fetch } = mockFetch([
            sse([
                chunk({ content: "ok" }, "stop"),
                usageChunk({
                    prompt_tokens: 10,
                    completion_tokens: 1,
                    prompt_tokens_details: { cached_tokens: 8 },
                }),
            ]),
        ]);
        const session = await provider(fetch).session("details", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(events.find((event) => event.type === "token_usage")).toEqual({
            type: "token_usage",
            usage: { input: 10, output: 1, cacheRead: 8, cacheWrite: 0, totalTokens: 11 },
        });
    });

    it("reports a length stop and marks unfinished tool calls incomplete", async () => {
        const { fetch } = mockFetch([
            sse([
                chunk({
                    tool_calls: [
                        {
                            index: 0,
                            id: "call_x",
                            function: { name: "read_file", arguments: '{"pa' },
                        },
                    ],
                }),
                chunk({}, "length"),
                usageChunk({ prompt_tokens: 5, completion_tokens: 8192 }),
            ]),
        ]);
        const session = await provider(fetch).session("length", {
            instructions: "",
            tools: [{ name: "read_file", parameters: Type.Object({ path: Type.String() }) }],
        });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(events.find((event) => event.type === "toolcall_end")).toEqual({
            type: "toolcall_end",
            callId: "call_x",
            arguments: '{"pa',
            incomplete: true,
        });
        expect(events.at(-1)).toEqual({
            type: "done",
            state: "length",
            tokens: { input: 5, output: 8192 },
        });
    });

    it("retries a 429 before any output and then succeeds", async () => {
        const { fetch, calls } = mockFetch([
            errorResponse(
                429,
                { error: { message: "Rate limit reached", type: "rate_limit_error" } },
                { "retry-after": "0" },
            ),
            errorResponse(503, { error: { message: "Server busy" } }),
            sse([chunk({ content: "ok" }, "stop")]),
        ]);
        const session = await provider(fetch).session("retry", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(3);
        expect(types(events)).toEqual([
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "block_reset",
            "retrying",
            "block_start",
            "text_start",
            "text_delta",
            "text_end",
            "block_stop",
            "done:normal",
        ]);
        expect(events[2]).toMatchObject({ type: "retrying", attempt: 1 });
        expect(events[5]).toMatchObject({ type: "retrying", attempt: 2 });
    });

    it("stops retrying at the configured budget with a rate-limit error", async () => {
        const { fetch, calls } = mockFetch([
            () => errorResponse(429, { error: { message: "Rate limit reached" } }),
        ]);
        const session = await provider(fetch, { inferenceMaxRetries: 2 }).session("budget", {
            instructions: "",
            tools: [],
        });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(3);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            providerError: { type: "rate_limit", diagnostics: { status: 429, attempts: 3 } },
        });
    });

    it("does not retry after output has streamed", async () => {
        const { fetch, calls } = mockFetch([
            sse([chunk({ content: "partial" })], { done: false }),
            sse([chunk({ content: "never" }, "stop")]),
        ]);
        const session = await provider(fetch).session("no-replay", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(1);
        expect(types(events)).toEqual([
            "block_start",
            "text_start",
            "text_delta",
            "block_reset",
            "done:error",
        ]);
    });

    it("classifies a context-length 400 as context overflow without retrying", async () => {
        const { fetch, calls } = mockFetch([
            errorResponse(400, {
                error: {
                    message:
                        "This model's maximum context length is 131072 tokens. However, you requested 140000 tokens.",
                    type: "invalid_request_error",
                },
            }),
        ]);
        const session = await provider(fetch).session("overflow", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "context_overflow",
        });
    });

    it("recognizes Moonshot's token-limit wording as context overflow", async () => {
        const { fetch } = mockFetch([
            errorResponse(400, {
                error: {
                    message: "Invalid request: Your request exceeded model token limit: 262144",
                    type: "invalid_request_error",
                },
            }),
        ]);
        const session = await provider(fetch).session("overflow-kimi", {
            instructions: "",
            tools: [],
        });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(events.at(-1)).toMatchObject({ state: "error", kind: "context_overflow" });
    });

    it("reports a rejected key as terminal authentication failure", async () => {
        const { fetch, calls } = mockFetch([
            errorResponse(401, {
                error: {
                    message: "Authentication Fails (no such user)",
                    type: "authentication_error",
                },
            }),
        ]);
        const session = await provider(fetch).session("auth", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(1);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            message: "Example rejected the API key. Check the key configured for this provider.",
            providerError: {
                type: "authentication",
                diagnostics: {
                    status: 401,
                    upstreamMessage: "Authentication Fails (no such user)",
                },
            },
        });
    });

    it("does not retry a hosted usage limit or expose the underlying provider", async () => {
        const resetAt = Date.now() + 3_600_000;
        const { fetch, calls } = mockFetch([
            errorResponse(
                429,
                { error: "已达到本周用量上限", code: "usage_limit" },
                {
                    "retry-after": new Date(resetAt).toUTCString(),
                },
            ),
        ]);
        const session = await provider(fetch, { service: "DeepSeek" }).session("usage-limit", {
            instructions: "",
            tools: [],
        });
        const events = await collect(
            session.run(testContext, {
                context: { instructions: "", messages: [userTurn] },
            }),
        );
        expect(calls).toHaveLength(1);
        expect(types(events)).not.toContain("retrying");
        expect(events.at(-1)).toMatchObject({
            state: "error",
            kind: "billing_error",
            message:
                "Your usage allowance cannot cover this request. Open Usage to see your limits and options.",
            providerError: {
                type: "out_of_tokens",
                resetAt: Math.floor(resetAt / 1_000) * 1_000,
                diagnostics: { code: "usage_limit", attempts: 1 },
            },
        });
    });

    it("treats an exhausted balance as a billing error, not a rate limit", async () => {
        for (const response of [
            errorResponse(402, { error: { message: "Insufficient Balance" } }),
            errorResponse(429, {
                error: {
                    message:
                        "Your account is suspended, please check your plan and billing details",
                    type: "exceeded_current_quota_error",
                },
            }),
        ]) {
            const { fetch, calls } = mockFetch([response]);
            const session = await provider(fetch).session("billing", {
                instructions: "",
                tools: [],
            });
            const events = await collect(
                session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
            );
            expect(calls).toHaveLength(1);
            expect(events.at(-1)).toMatchObject({
                state: "error",
                kind: "billing_error",
                providerError: { type: "out_of_tokens" },
            });
        }
    });

    it("retries an empty response", async () => {
        const { fetch, calls } = mockFetch([
            sse([
                chunk({ content: "" }, "stop"),
                usageChunk({ prompt_tokens: 4, completion_tokens: 0 }),
            ]),
            sse([chunk({ content: "ok" }, "stop")]),
        ]);
        const session = await provider(fetch).session("empty", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(2);
        expect(types(events)).toContain("retrying");
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("retries a stream that goes silent before output", async () => {
        const { fetch, calls } = mockFetch([
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) }),
                    {
                        status: 200,
                    },
                ),
            sse([chunk({ content: "ok" }, "stop")]),
        ]);
        const session = await provider(fetch, { streamIdleTimeoutMs: 30 }).session("idle", {
            instructions: "",
            tools: [],
        });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(2);
        expect(events.find((event) => event.type === "retrying")).toMatchObject({
            reason: expect.stringContaining("silent"),
        });
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("ends with a cancellation when the lifetime aborts mid-stream", async () => {
        const controller = new AbortController();
        const encoder = new TextEncoder();
        const { fetch } = mockFetch([
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(stream) {
                            stream.enqueue(
                                encoder.encode(
                                    `data: ${JSON.stringify(chunk({ content: "hi" }))}\n\n`,
                                ),
                            );
                        },
                    }),
                    { status: 200 },
                ),
        ]);
        const session = await provider(fetch).session("abort", { instructions: "", tools: [] });
        const events: SessionEvent[] = [];
        for await (const event of session.run(testContextWith(controller.signal), {
            context: { instructions: "", messages: [userTurn] },
        })) {
            events.push(event);
            if (event.type === "text_delta") controller.abort();
        }
        expect(types(events)).toEqual([
            "block_start",
            "text_start",
            "text_delta",
            "block_reset",
            "done:cancelled",
        ]);
    });

    it("compacts into a portable plaintext checkpoint without tools", async () => {
        const { fetch, calls } = mockFetch([
            sse([
                chunk({ content: "Goal: ship it." }, "stop"),
                usageChunk({ prompt_tokens: 30, completion_tokens: 5 }),
            ]),
            sse([chunk({ content: "Continuing." }, "stop")]),
        ]);
        const tools: SessionTool[] = [{ name: "read_file", parameters: Type.Object({}) }];
        const session = await provider(fetch).session("compact", { instructions: "Base.", tools });
        const result = await session.compact(testContext, {
            context: { instructions: "Base.", messages: [userTurn] },
        });
        expect(result).toMatchObject({
            status: "completed",
            summary: "Goal: ship it.",
            context: {
                instructions: "Base.",
                messages: [
                    { role: "compaction", content: "Goal: ship it.", encryptedContent: null },
                ],
            },
        });
        expect(calls[0]!.body.tools).toBeUndefined();
        expect(calls[0]!.body.messages[0].content).toContain("continuation checkpoint");

        if (result.status !== "completed") throw new Error("Compaction failed.");
        await collect(
            session.run(testContext, {
                context: {
                    instructions: "Base.",
                    messages: [...result.context.messages, userTurn],
                },
            }),
        );
        expect(calls[1]!.body.messages).toEqual([
            { role: "system", content: "Base." },
            {
                role: "user",
                content:
                    "Conversation continuation checkpoint (historical context):\nGoal: ship it.",
            },
            { role: "user", content: "Hello" },
        ]);
    });
});

describe("Chat Completions history", () => {
    const names = new ChatCompletionsToolNames([
        { name: "read_file", parameters: Type.Object({ path: Type.String() }) },
    ]);

    it("replays reasoning only on the current turn's tool-call messages", () => {
        const messages = toChatCompletionsMessages(
            [
                { role: "user", content: [{ type: "text", text: "First" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "old thought" },
                        {
                            type: "tool_call",
                            callId: "c1",
                            name: "read_file",
                            arguments: '{"path":"a"}',
                        },
                    ],
                },
                { role: "tool", callId: "c1", content: [{ type: "text", text: "A" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "old answer thought" },
                        { type: "text", text: "Answer one." },
                    ],
                },
                { role: "user", content: [{ type: "text", text: "Second" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "new thought" },
                        { type: "text", text: "Checking." },
                        {
                            type: "tool_call",
                            callId: "c2",
                            name: "read_file",
                            arguments: '{"path":"b"}',
                        },
                    ],
                },
                {
                    role: "tool",
                    callId: "c2",
                    content: [
                        { type: "text", text: "B" },
                        { type: "image", mimeType: "image/png", data: "AAAA" },
                    ],
                },
                {
                    role: "system",
                    content: [{ type: "text", text: "The user is away." }],
                },
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "second thought" },
                        {
                            type: "tool_call",
                            callId: "c3",
                            name: "read_file",
                            arguments: '{"path":"c"}',
                        },
                    ],
                },
                { role: "tool", callId: "c3", content: [] },
            ],
            { names, vision: false },
        );

        expect(messages).toEqual([
            { role: "user", content: "First" },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    {
                        id: "c1",
                        type: "function",
                        function: { name: "read_file", arguments: '{"path":"a"}' },
                    },
                ],
            },
            { role: "tool", tool_call_id: "c1", content: "A" },
            { role: "assistant", content: "Answer one." },
            { role: "user", content: "Second" },
            {
                role: "assistant",
                content: "Checking.",
                reasoning_content: "new thought",
                tool_calls: [
                    {
                        id: "c2",
                        type: "function",
                        function: { name: "read_file", arguments: '{"path":"b"}' },
                    },
                ],
            },
            {
                role: "tool",
                tool_call_id: "c2",
                content:
                    "B\n\n[An image (image/png) was omitted because this model cannot view images.]",
            },
            {
                role: "user",
                content: "<system-reminder>\nThe user is away.\n</system-reminder>",
            },
            {
                role: "assistant",
                content: "",
                reasoning_content: "second thought",
                tool_calls: [
                    {
                        id: "c3",
                        type: "function",
                        function: { name: "read_file", arguments: '{"path":"c"}' },
                    },
                ],
            },
            { role: "tool", tool_call_id: "c3", content: "(no output)" },
        ]);
    });

    it("replays every earlier turn's reasoning when the endpoint asks for all of it", () => {
        const messages = toChatCompletionsMessages(
            [
                { role: "user", content: [{ type: "text", text: "First" }] },
                {
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "old thought" },
                        { type: "text", text: "Answer one." },
                    ],
                },
                { role: "user", content: [{ type: "text", text: "Second" }] },
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            callId: "c1",
                            name: "read_file",
                            arguments: '{"path":"a"}',
                        },
                    ],
                },
                { role: "tool", callId: "c1", content: [{ type: "text", text: "A" }] },
            ],
            { names, vision: false, replayAllReasoning: true },
        );

        expect(messages[1]).toEqual({
            role: "assistant",
            content: "Answer one.",
            reasoning_content: "old thought",
        });
        // A message another model wrote has no reasoning; it still carries the field, empty.
        expect(messages[3]).toMatchObject({ role: "assistant", reasoning_content: "" });
    });

    it("keeps tool answers adjacent to their calls and fills a missing one", () => {
        const messages = toChatCompletionsMessages(
            [
                userTurn,
                {
                    role: "assistant",
                    content: [
                        { type: "tool_call", callId: "c1", name: "read_file", arguments: "" },
                        { type: "tool_call", callId: "c2", name: "read_file", arguments: "{bad" },
                    ],
                },
                { role: "user", content: [{ type: "text", text: "Also this." }] },
                { role: "tool", callId: "c2", content: [{ type: "text", text: "two" }] },
                { role: "tool", callId: "orphan", content: [{ type: "text", text: "lost" }] },
                {
                    role: "assistant",
                    content: [{ type: "reasoning", text: "only thinking" }],
                },
            ],
            { names, vision: false },
        );
        expect(messages).toEqual([
            { role: "user", content: "Hello" },
            {
                role: "assistant",
                content: "",
                tool_calls: [
                    {
                        id: "c1",
                        type: "function",
                        function: { name: "read_file", arguments: "{}" },
                    },
                    {
                        id: "c2",
                        type: "function",
                        function: { name: "read_file", arguments: "{}" },
                    },
                ],
            },
            { role: "tool", tool_call_id: "c2", content: "two" },
            {
                role: "tool",
                tool_call_id: "c1",
                content: "The tool call did not return a result.",
            },
            { role: "user", content: "Also this." },
        ]);
    });

    it("sends images only to vision models", () => {
        const image: SessionMessage = {
            role: "user",
            content: [
                { type: "text", text: "Look" },
                { type: "image", mimeType: "image/png", data: "AAAA" },
            ],
        };
        expect(toChatCompletionsMessages([image], { names, vision: false })).toEqual([
            {
                role: "user",
                content:
                    "Look\n\n[An image (image/png) was omitted because this model cannot view images.]",
            },
        ]);
        expect(toChatCompletionsMessages([image], { names, vision: true })).toEqual([
            {
                role: "user",
                content: [
                    { type: "text", text: "Look" },
                    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
                ],
            },
        ]);
    });

    it("presents another agent's message as a named reminder and drops opaque checkpoints", () => {
        const messages = toChatCompletionsMessages(
            [
                { role: "compaction", content: null, encryptedContent: "opaque" },
                {
                    role: "agent",
                    author: { id: "agent-7", description: "Reviewer" },
                    content: [{ type: "text", text: "Looks good." }],
                },
            ],
            { names, vision: false },
        );
        expect(messages).toEqual([
            {
                role: "user",
                content:
                    "<system-reminder>\nMessage from agent Reviewer (agent-7):\n\nLooks good.\n</system-reminder>",
            },
        ]);
    });
});

describe("Chat Completions transport failures", () => {
    it("retries a connection failure before the response starts", async () => {
        const { fetch, calls } = mockFetch([
            () => {
                throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
            },
            sse([chunk({ content: "ok" }, "stop")]),
        ]);
        const session = await provider(fetch).session("network", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(2);
        expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    });

    it("gives up on a response that never starts", async () => {
        const { fetch, calls } = mockFetch([() => new Promise<Response>(() => {})]);
        const session = await provider(fetch, {
            responseTimeoutMs: 20,
            inferenceMaxRetries: 1,
        }).session("start-timeout", { instructions: "", tools: [] });
        const events = await collect(
            session.run(testContext, { context: { instructions: "", messages: [userTurn] } }),
        );
        expect(calls).toHaveLength(2);
        expect(events.at(-1)).toMatchObject({
            type: "done",
            state: "error",
            kind: "internal_error",
            message: expect.stringContaining("No response started within"),
        });
    });
});
