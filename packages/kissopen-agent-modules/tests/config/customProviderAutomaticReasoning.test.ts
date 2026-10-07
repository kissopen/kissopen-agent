import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";
import {
    CustomProviders,
    discoverCustomModels,
} from "../../sources/config/impl/customProviders.js";

describe("automatic custom model reasoning", () => {
    it("matches only exact curated IDs and preserves explicit overrides across reload", async () => {
        const root = await mkdtemp(join(tmpdir(), "custom-auto-reasoning-"));
        try {
            const path = join(root, "custom.json");
            const providers = new CustomProviders(path);
            const id = await providers.save({
                mutationId: "save",
                baseUrl: "https://example.test/v1",
                apiKey: "local-test-only",
                models: [
                    { id: "gpt-6-astra", name: "Known" },
                    { id: "openai/gpt-5.6-sol", name: "Canonical" },
                    { id: "deepseek-flash", name: "DeepSeek" },
                    { id: "gpt-6-astra-unknown-date", name: "Unknown suffix" },
                    { id: "not-gpt-6-astra", name: "gpt-6-astra" },
                    { id: "gpt-5.6-luna", name: "Forced default", reasoning: null },
                    {
                        id: "gpt-5.6-terra",
                        name: "Override",
                        discoveredReasoning: {
                            mode: "openai",
                            efforts: ["high"],
                            defaultEffort: "high",
                        },
                        reasoning: { mode: "openai", efforts: ["low"], defaultEffort: "low" },
                    },
                    {
                        id: "gpt-6-astra-provider-default",
                        name: "Provider metadata",
                        discoveredReasoning: {
                            mode: "openai",
                            efforts: ["minimal"],
                            defaultEffort: "minimal",
                        },
                    },
                    { id: "gpt-5.4", name: "Provider default", discoveredReasoning: null },
                ],
            });
            const catalog = providers.catalog();
            expect(catalog[0]).toMatchObject({
                effortLevels: ["low", "medium", "high", "xhigh", "max"],
                defaultEffort: "high",
                customReasoning: { mode: "openai" },
            });
            expect(catalog[1]).toMatchObject({
                defaultEffort: "medium",
                customReasoning: { mode: "openai" },
            });
            expect(catalog[2]).toMatchObject({
                effortLevels: ["off", "low", "high", "max"],
                customReasoning: { mode: "deepseek" },
            });
            for (const index of [3, 4, 5, 8])
                expect(catalog[index]).toMatchObject({
                    customReasoning: null,
                    effortLevels: ["off"],
                });
            expect(catalog[6]).toMatchObject({ effortLevels: ["low"], defaultEffort: "low" });
            expect(catalog[7]).toMatchObject({
                effortLevels: ["minimal"],
                defaultEffort: "minimal",
            });
            const reopened = new CustomProviders(path);
            await reopened.load();
            expect(reopened.catalog()).toEqual(catalog);
            const models = reopened.details(id).provider.models.map((model) => {
                if (model.id !== "gpt-5.6-terra") return model;
                const { reasoning: _override, ...automatic } = model;
                return automatic;
            });
            await reopened.update(id, { mutationId: "automatic", models });
            expect(reopened.catalog()[6]).toMatchObject({
                effortLevels: ["high"],
                defaultEffort: "high",
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("validates provider metadata and sends the same capabilities advertised by the catalog", async () => {
        const calls: Record<string, unknown>[] = [];
        const server = createServer(async (request, response) => {
            if (request.url === "/v1/models") {
                response.setHeader("Content-Type", "application/json");
                response.end(
                    JSON.stringify({
                        data: [
                            {
                                id: "gpt-6-astra",
                                reasoning: {
                                    mode: "openai",
                                    efforts: ["low"],
                                    defaultEffort: "low",
                                },
                            },
                            { id: "deepseek-flash" },
                            {
                                id: "unknown",
                                reasoning: {
                                    mode: "openai",
                                    efforts: ["low"],
                                    defaultEffort: "high",
                                },
                            },
                            { id: "gpt-5.6-sol", reasoning: "unsupported metadata" },
                            { id: "gpt-5.6-luna", reasoning: null },
                        ],
                    }),
                );
                return;
            }
            let raw = "";
            for await (const bytes of request) raw += String(bytes);
            calls.push(JSON.parse(raw));
            response.writeHead(200, { "Content-Type": "text/event-stream" });
            response.end(
                'data: {"choices":[{"index":0,"delta":{"content":"pong"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            );
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const root = await mkdtemp(join(tmpdir(), "custom-auto-wire-"));
        try {
            const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
            const discovered = await discoverCustomModels({ baseUrl, apiKey: "local-test-only" });
            expect(discovered.models.find((model) => model.id === "gpt-6-astra")).toMatchObject({
                discoveredReasoning: { efforts: ["low"] },
            });
            expect(discovered.models.find((model) => model.id === "unknown")).not.toHaveProperty(
                "discoveredReasoning",
            );
            expect(
                discovered.models.find((model) => model.id === "gpt-5.6-sol"),
            ).not.toHaveProperty("discoveredReasoning");
            expect(discovered.models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
                discoveredReasoning: null,
            });
            const providers = new CustomProviders(join(root, "custom.json"));
            const id = await providers.save({
                mutationId: "save",
                baseUrl,
                apiKey: "local-test-only",
                models: discovered.models,
            });
            for (const model of providers.catalog()) {
                const session = await providers
                    .provider(id)
                    .session("wire-test", { instructions: "", tools: [] });
                try {
                    const events = [];
                    for await (const event of session.run(createRootContext(), {
                        model: model.id,
                        effort: model.defaultEffort,
                        context: {
                            instructions: "",
                            messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }],
                        },
                    }))
                        events.push(event);
                    expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
                    const wire = calls.at(-1)!;
                    if (model.customReasoning === null) {
                        expect(wire).not.toHaveProperty("reasoning_effort");
                        expect(wire).not.toHaveProperty("thinking");
                    } else {
                        expect(wire.reasoning_effort).toBe(model.defaultEffort);
                        if (model.customReasoning?.mode === "deepseek")
                            expect(wire.thinking).toEqual({ type: "enabled" });
                        else expect(wire).not.toHaveProperty("thinking");
                    }
                } finally {
                    await session.destroy();
                }
            }
            expect(calls).toHaveLength(discovered.models.length);
            expect(calls.find((call) => call.model === "gpt-6-astra")).toMatchObject({
                reasoning_effort: "low",
            });
        } finally {
            await rm(root, { recursive: true, force: true });
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
