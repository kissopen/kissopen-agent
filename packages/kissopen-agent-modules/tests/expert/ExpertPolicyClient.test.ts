import { describe, expect, it } from "vitest";

import {
    DEFAULT_EXPERT_POLICY,
    ExpertPolicyClient,
    policyUrl,
    type ExpertPolicyResponse,
} from "../../sources/expert/index.js";

const KEY = "device-key-that-must-never-be-logged";
const BASE_URL = "https://api.firstcache.cc/api/agent/v1";

const SERVER_POLICY: ExpertPolicyResponse = {
    models: ["openai/gpt-6-astra", "deepseek/deepseek-flash"],
    policy: {
        default_model: "deepseek/deepseek-flash",
        default_effort: "high",
        expert_model: "openai/gpt-6-astra",
        expert_effort: "high",
        expert_tasks: [
            { id: "slides", name: "演示文稿", description: "制作 PPT", enabled: true },
            { id: "analysis", name: "数据分析", description: "分析数据", enabled: false },
        ],
        escalate_after_failures: 2,
        hide_model_picker: true,
    },
};

interface Request {
    readonly url: string;
    readonly headers: Record<string, string>;
}

/** A transport that answers each request with the next scripted reply. */
function scriptedFetch(replies: Array<() => Promise<Response>>) {
    const requests: Request[] = [];
    const transport = async (
        input: Parameters<typeof fetch>[0],
        init?: RequestInit,
    ): Promise<Response> => {
        requests.push({
            url: String(input),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        const reply = replies.shift();
        if (reply === undefined) throw new Error("No scripted reply is left.");
        return await reply();
    };
    return { requests, transport: transport as typeof fetch };
}

function json(body: unknown, status = 200): () => Promise<Response> {
    return async () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        });
}

function client(
    transport: typeof fetch,
    logs: Array<{ message: string; fields: Record<string, unknown> }> = [],
    source: { baseUrl: string; apiKey: string } | null = { baseUrl: BASE_URL, apiKey: KEY },
) {
    return new ExpertPolicyClient({
        source: () => source ?? undefined,
        fetch: transport,
        now: () => 1_000,
        log: (message, fields) => {
            logs.push({ message, fields });
        },
    });
}

describe("expert policy client", () => {
    it("starts from the built-in default, which is the server's own default", () => {
        const { transport } = scriptedFetch([]);
        const snapshot = client(transport).current();

        expect(snapshot.origin).toBe("default");
        expect(snapshot).toBe(DEFAULT_EXPERT_POLICY);
        expect(snapshot.policy.expert_model).toBe("openai/gpt-5.6-sol");
        expect(snapshot.policy.expert_effort).toBe("medium");
        expect(snapshot.policy.default_model).toBe("deepseek/deepseek-flash");
        expect(snapshot.policy.escalate_after_failures).toBe(3);
        expect(snapshot.policy.expert_tasks.map((task) => task.id)).toEqual([
            "slides",
            "plan",
            "document",
            "analysis",
        ]);
        expect(snapshot.models).toContain("openai/gpt-5.6-sol");
    });

    it("reads {base_url}/policy with the device key as a bearer token and keeps the answer", async () => {
        const { requests, transport } = scriptedFetch([json(SERVER_POLICY)]);
        const policy = client(transport);

        await expect(policy.refresh()).resolves.toBe(true);

        expect(requests).toHaveLength(1);
        expect(requests[0]!.url).toBe(`${BASE_URL}/policy`);
        expect(requests[0]!.headers["authorization"]).toBe(`Bearer ${KEY}`);
        expect(policy.current()).toEqual({ ...SERVER_POLICY, origin: "server", fetchedAt: 1_000 });
    });

    it("keeps the last good policy when a later reading fails in any way", async () => {
        const { transport } = scriptedFetch([
            json(SERVER_POLICY),
            json({ error: "bad gateway" }, 502),
            json({ models: [], policy: { expert_model: 5 } }),
            async () => new Response("not json", { status: 200 }),
            async () => {
                throw new TypeError("fetch failed");
            },
        ]);
        const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
        const policy = client(transport, logs);
        await policy.refresh();

        for (let attempt = 0; attempt < 4; attempt += 1) {
            await expect(policy.refresh()).resolves.toBe(false);
            expect(policy.current().policy.expert_model).toBe("openai/gpt-6-astra");
            expect(policy.current().origin).toBe("server");
        }
        expect(logs).toHaveLength(4);
        expect(logs[0]!.fields).toEqual({ url: `${BASE_URL}/policy`, status: 502 });
    });

    it("stays on the built-in default while the server has never answered", async () => {
        const { transport } = scriptedFetch([json({}, 401)]);
        const policy = client(transport);

        await expect(policy.refresh()).resolves.toBe(false);

        expect(policy.current()).toBe(DEFAULT_EXPERT_POLICY);
    });

    it("never logs the device key, even when a transport error quotes it", async () => {
        const { transport } = scriptedFetch([
            async () => {
                throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`);
            },
            json({ echoed: `Bearer ${KEY}` }, 403),
        ]);
        const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
        const policy = client(transport, logs);

        await policy.refresh();
        await policy.refresh();

        expect(logs).toHaveLength(2);
        const written = JSON.stringify(logs);
        expect(written).not.toContain(KEY);
        expect(written).toContain("[redacted]");
    });

    it("asks nothing when no KISSOPEN provider is configured", async () => {
        const { requests, transport } = scriptedFetch([json(SERVER_POLICY)]);
        const policy = client(transport, [], null);

        await expect(policy.refresh()).resolves.toBe(false);

        expect(requests).toHaveLength(0);
        expect(policy.current()).toBe(DEFAULT_EXPERT_POLICY);
    });

    it("shares one request between refreshes asked for while it is in flight", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const { requests, transport } = scriptedFetch([
            async () => {
                await gate;
                return await json(SERVER_POLICY)();
            },
        ]);
        const policy = client(transport);

        const first = policy.refresh();
        const second = policy.refresh();
        release();

        await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
        expect(requests).toHaveLength(1);
    });

    it("builds the policy URL from the base URL alone", () => {
        expect(policyUrl(`${BASE_URL}/`)).toBe(`${BASE_URL}/policy`);
        expect(policyUrl("https://user:pass@example.test/v1?token=x")).toBe(
            "https://example.test/v1/policy",
        );
        expect(policyUrl("file:///etc/passwd")).toBeUndefined();
        expect(policyUrl("not a url")).toBeUndefined();
    });
});
