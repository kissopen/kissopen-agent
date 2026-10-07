import type { SessionMessage } from "@kissopen/kissopen-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase } from "../sources/index.js";
import { providersOf, textTurn } from "./gym/fixtures.js";
import { InMemoryPersistence } from "./gym/InMemoryPersistence.js";
import { ScriptedProvider } from "./gym/ScriptedProvider.js";

import {
    CONTEXT_IMAGE_BUDGET_BYTES,
    CONTEXT_IMAGE_BUDGET_COUNT,
    limitContextImages,
} from "../sources/limitContextImages.js";

const image = (label: string, bytes: number) => ({
    type: "image" as const,
    mimeType: "image/png",
    data: label.padEnd(bytes, "x"),
});
const shown = (messages: readonly SessionMessage[]): string[] =>
    messages.flatMap((message) => {
        if (message.role === "compaction") return [];
        const blocks: readonly {
            readonly type: string;
            readonly data?: string;
            readonly text?: string;
        }[] =
            message.role === "assistant"
                ? message.content.flatMap((block): readonly { readonly type: string }[] =>
                      block.type === "tool_result" ? block.content : [block],
                  )
                : message.content;
        return blocks.flatMap((block) =>
            block.type === "image"
                ? [(block.data ?? "").slice(0, 2)]
                : block.type === "text" && (block.text ?? "").startsWith("[An earlier image")
                  ? ["omitted"]
                  : [],
        );
    });

describe("limitContextImages", () => {
    it("keeps the newest images within the byte budget and notes every older one", () => {
        const third = Math.floor(CONTEXT_IMAGE_BUDGET_BYTES / 3);
        const messages: SessionMessage[] = [
            { role: "user", content: [{ type: "text", text: "a" }, image("i1", third)] },
            { role: "tool", callId: "c1", content: [image("i2", 10)] },
            { role: "user", content: [image("i3", third), image("i4", third)] },
            { role: "user", content: [image("i5", third)] },
        ];
        const limited = limitContextImages(messages);
        // Newest first: i5, i4, i3 fit; i2 would still fit but comes after the first refusal.
        expect(shown(limited)).toEqual(["omitted", "omitted", "i3", "i4", "i5"]);
        // Untouched messages are the same objects; the input is not changed.
        expect(limited[3]).toBe(messages[3]);
        expect(shown(messages)).toEqual(["i1", "i2", "i3", "i4", "i5"]);
    });

    it("always keeps the newest image, however large", () => {
        const limited = limitContextImages([
            { role: "user", content: [image("i1", 10)] },
            { role: "user", content: [image("i2", CONTEXT_IMAGE_BUDGET_BYTES * 2)] },
        ]);
        expect(shown(limited)).toEqual(["omitted", "i2"]);
    });

    it("caps how many images a request carries", () => {
        const messages: SessionMessage[] = Array.from(
            { length: CONTEXT_IMAGE_BUDGET_COUNT + 2 },
            (_, index) => ({
                role: "user" as const,
                content: [image(String(index).padStart(2, "0"), 10)],
            }),
        );
        const limited = shown(limitContextImages(messages));
        expect(limited.filter((entry) => entry === "omitted")).toHaveLength(2);
        expect(limited.slice(0, 2)).toEqual(["omitted", "omitted"]);
    });

    it("reaches images inside server tool results of an assistant message", () => {
        const limited = limitContextImages([
            {
                role: "assistant",
                content: [
                    {
                        type: "tool_result",
                        callId: "c1",
                        content: [image("i1", CONTEXT_IMAGE_BUDGET_BYTES)],
                    },
                ],
            },
            { role: "user", content: [image("i2", 10)] },
        ]);
        expect(shown(limited)).toEqual(["omitted", "i2"]);
    });
});

describe("the request an agent sends", () => {
    it("carries only the newest images, while the stored history keeps all of them", async () => {
        const ctx = createRootContext().named("kissopen-agent-base-image-budget-test");
        const large = Math.floor(CONTEXT_IMAGE_BUDGET_BYTES / 2);
        const provider = new ScriptedProvider([
            textTurn("one"),
            textTurn("two"),
            textTurn("three"),
        ]);
        const persistence = new InMemoryPersistence();
        const agent = await AgentBase.create(ctx, {
            id: "test-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence,
        });
        for (const label of ["p1", "p2", "p3"]) {
            await agent.send(ctx, {
                role: "user",
                content: [{ type: "text", text: label }, image(label, large)],
            });
            await agent.waitForIdle();
        }

        const request = provider.sessions.at(-1)!.requests.at(-1)!;
        expect(shown(request.context.messages)).toEqual(["omitted", "p2", "p3"]);
        const stored = persistence.records.flatMap((record) =>
            record.type === "user"
                ? record.message.content.flatMap((block) =>
                      block.type === "image" ? [block.data.slice(0, 2)] : [],
                  )
                : [],
        );
        expect(stored).toEqual(["p1", "p2", "p3"]);
        await agent.close();
    });
});
