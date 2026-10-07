import { describe, expect, it } from "vitest";

import { areProviderModelsCompatible } from "@/core/ProviderModelCompatibility.js";
import { providerModelFamily } from "@/core/providerModelFamily.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { DeepSeekApiKeyCredential } from "@/vendors/deepseek/DeepSeekApiKeyCredential.js";
import { DeepSeekProvider } from "@/vendors/deepseek/DeepSeekProvider.js";
import { KimiApiKeyCredential } from "@/vendors/kimi/KimiApiKeyCredential.js";
import { KimiProvider } from "@/vendors/kimi/KimiProvider.js";
import { tryLoadCredentials } from "@/vendors/tryLoadCredentials.js";
import { testContext } from "../testContext.js";

function recordingFetch() {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        const chunk = {
            choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            status: 200,
        });
    }) as typeof globalThis.fetch;
    return { fetch, requests };
}

async function drain(stream: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}

const hello = { role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] };

describe("DeepSeek and Kimi credentials", () => {
    it("reads DeepSeek's key from the environment unless one is given", async () => {
        expect(await DeepSeekApiKeyCredential.tryLoad({ env: {} })).toBeNull();
        expect(
            (await DeepSeekApiKeyCredential.tryLoad({ env: { DEEPSEEK_API_KEY: " sk-env " } }))
                ?.credential,
        ).toEqual({ apiKey: "sk-env" });
        expect(
            (
                await DeepSeekApiKeyCredential.tryLoad({
                    apiKey: "sk-explicit",
                    env: { DEEPSEEK_API_KEY: "sk-env" },
                })
            )?.credential,
        ).toEqual({ apiKey: "sk-explicit" });
    });

    it("reads Moonshot's key from MOONSHOT_API_KEY, then KIMI_API_KEY", async () => {
        expect(await KimiApiKeyCredential.tryLoad({ env: {} })).toBeNull();
        expect(
            (await KimiApiKeyCredential.tryLoad({ env: { KIMI_API_KEY: "sk-kimi" } }))?.credential,
        ).toEqual({ apiKey: "sk-kimi" });
        expect(
            (
                await KimiApiKeyCredential.tryLoad({
                    env: { KIMI_API_KEY: "sk-kimi", MOONSHOT_API_KEY: "sk-moonshot" },
                })
            )?.credential,
        ).toEqual({ apiKey: "sk-moonshot" });
    });

    it("joins machine-wide credential discovery", async () => {
        const credentials = await tryLoadCredentials({
            env: { DEEPSEEK_API_KEY: "sk-d", MOONSHOT_API_KEY: "sk-m" },
        });
        const names = credentials.map((credential) => credential.name);
        expect(names).toContain("deepseek-api-key");
        expect(names).toContain("kimi-api-key");
    });
});

describe("DeepSeekProvider", () => {
    it("targets the default endpoint with the vendor model ID and its output budget", async () => {
        const credential = await DeepSeekApiKeyCredential.tryLoad({ apiKey: "sk-d" });
        const { fetch, requests } = recordingFetch();
        const provider = new DeepSeekProvider({ credential: credential!, fetch });
        expect(provider.name).toBe("deepseek");
        const session = await provider.session("deepseek", { instructions: "", tools: [] });

        await drain(
            session.run(testContext, {
                model: "deepseek/deepseek-flash",
                effort: "off",
                context: { instructions: "", messages: [hello] },
            }),
        );
        await drain(
            session.run(testContext, {
                model: "deepseek/deepseek-v4-pro",
                effort: "medium",
                context: { instructions: "", messages: [hello] },
            }),
        );

        expect(requests[0]).toMatchObject({
            url: "https://api.deepseek.com/chat/completions",
            body: { model: "deepseek-flash", max_tokens: 65_536, thinking: { type: "disabled" } },
        });
        expect(requests[0]!.body).not.toHaveProperty("reasoning_effort");
        expect(requests[1]!.body).toMatchObject({
            model: "deepseek-v4-pro",
            thinking: { type: "enabled" },
            reasoning_effort: "high",
        });
    });

    it("accepts an overriding base URL", async () => {
        const credential = await DeepSeekApiKeyCredential.tryLoad({ apiKey: "sk-d" });
        const { fetch, requests } = recordingFetch();
        const provider = new DeepSeekProvider({
            credential: credential!,
            baseUrl: "https://gateway.example.test/deepseek/v1",
            fetch,
        });
        const session = await provider.session("deepseek", { instructions: "", tools: [] });
        await drain(
            session.run(testContext, {
                model: "deepseek/deepseek-flash",
                context: { instructions: "", messages: [hello] },
            }),
        );
        expect(requests[0]!.url).toBe("https://gateway.example.test/deepseek/v1/chat/completions");
    });
});

describe("KimiProvider", () => {
    it("targets Moonshot with the vendor model ID and recommended sampling", async () => {
        const credential = await KimiApiKeyCredential.tryLoad({ apiKey: "sk-m" });
        const { fetch, requests } = recordingFetch();
        const provider = new KimiProvider({ credential: credential!, fetch });
        expect(provider.name).toBe("kimi");
        const session = await provider.session("kimi", { instructions: "", tools: [] });
        for (const model of ["moonshot/kimi-k2-turbo-preview", "moonshot/kimi-k2-thinking"]) {
            await drain(
                session.run(testContext, {
                    model,
                    context: { instructions: "", messages: [hello] },
                }),
            );
        }
        expect(requests[0]).toMatchObject({
            url: "https://api.moonshot.cn/v1/chat/completions",
            body: { model: "kimi-k2-turbo-preview", max_tokens: 32_000, temperature: 0.6 },
        });
        expect(requests[1]!.body).toMatchObject({
            model: "kimi-k2-thinking",
            max_tokens: 32_000,
            temperature: 1,
        });
    });
});

describe("DeepSeek and Kimi model families", () => {
    it("names each family by its model prefix", () => {
        expect(providerModelFamily("deepseek/deepseek-flash")).toBe("deepseek");
        expect(providerModelFamily("moonshot/kimi-k2-thinking")).toBe("kimi");
    });

    it("keeps history across models of one family and never across families", () => {
        const select = (
            providerType: "deepseek" | "kimi",
            modelId: string,
            providerId: string = providerType,
        ) => ({ modelId, providerId, providerType });
        expect(
            areProviderModelsCompatible(
                select("deepseek", "deepseek/deepseek-flash"),
                select("deepseek", "deepseek/deepseek-v4-pro", "deepseek-work"),
            ),
        ).toBe(true);
        expect(
            areProviderModelsCompatible(
                select("kimi", "moonshot/kimi-k2-0905-preview"),
                select("kimi", "moonshot/kimi-k2-thinking"),
            ),
        ).toBe(true);
        expect(
            areProviderModelsCompatible(
                select("deepseek", "deepseek/deepseek-flash"),
                select("kimi", "moonshot/kimi-k2-thinking"),
            ),
        ).toBe(false);
    });
});
