import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalThemeGenerated } from "@kissopen/kissopen-agent-client";
import type { ConfigModule } from "../../sources/config/index.js";
import { localThemeGenerate, localThemeRead } from "../../sources/kissopen/localTheme.js";

function theme(): LocalThemeGenerated {
    const palette = {
        accent: "#6554c0",
        on_accent: "#ffffff",
        canvas: "#ffffff",
        surface: "#ffffff",
        raised: "#f0f0ff",
        text: "#000000",
        muted: "#555555",
        line: "#dddddd",
        success: "#008800",
        warning: "#dd8800",
        danger: "#dd0000",
    };
    return {
        name: "青川",
        description: "清爽的蓝绿配色",
        doc: {
            version: 1,
            font: "sans",
            radius: "soft",
            light: palette,
            dark: {
                ...palette,
                canvas: "#111111",
                surface: "#222222",
                raised: "#333333",
                text: "#ffffff",
                muted: "#bbbbbb",
            },
        },
    };
}

afterEach(() => vi.useRealTimers());

describe("local theme output stays bounded and readable", () => {
    it("accepts a JSON code fence and repairs unreadable text without changing accent colors", () => {
        const output = theme();
        output.doc.light.text = output.doc.light.muted = "#ffffff";
        output.doc.dark.text = output.doc.dark.muted = "#222222";
        output.doc.light.on_accent = output.doc.light.accent;
        const result = localThemeRead("```json\n" + JSON.stringify(output) + "\n```", {
            prompt: "清爽一点",
        });
        expect(result.doc.light.text).toBe("#000000");
        expect(result.doc.light.muted).toBe("#000000");
        expect(result.doc.dark.text).toBe("#ffffff");
        expect(result.doc.dark.muted).toBe("#ffffff");
        expect(result.doc.light.on_accent).toBe("#ffffff");
        expect(result.doc.light.accent).toBe(output.doc.light.accent);
    });

    it("ignores model-written background URLs and preserves the trusted draft", () => {
        const base = theme().doc;
        base.background = {
            url: "https://kissopen.com/api/themes/images/0123456789abcdef",
            opacity: 0.4,
            blur: 3,
        };
        const previous = structuredClone(base);
        const output = theme();
        output.doc.background = { url: "javascript:bad", opacity: 10, blur: -1 };
        expect(
            localThemeRead(JSON.stringify(output), { prompt: "更绿", base }).doc.background,
        ).toEqual(base.background);
        expect(
            localThemeRead(JSON.stringify(output), { prompt: "更绿" }).doc.background,
        ).toBeUndefined();
        expect(base).toEqual(previous);
    });

    it.each([
        [
            "incomplete palette",
            (value: LocalThemeGenerated) => {
                delete (value.doc.light as Partial<typeof value.doc.light>).text;
            },
        ],
        [
            "CSS injection",
            (value: LocalThemeGenerated) => {
                value.doc.light.accent = "red; background: url(bad)";
            },
        ],
        [
            "wrong light canvas",
            (value: LocalThemeGenerated) => {
                value.doc.light.canvas = "#111111";
            },
        ],
        [
            "wrong dark surface",
            (value: LocalThemeGenerated) => {
                value.doc.dark.surface = "#ffffff";
            },
        ],
        [
            "empty name",
            (value: LocalThemeGenerated) => {
                value.name = "   ";
            },
        ],
        [
            "oversize name",
            (value: LocalThemeGenerated) => {
                value.name = "a".repeat(41);
            },
        ],
        [
            "unknown executable field",
            (value: LocalThemeGenerated) => {
                Object.assign(value.doc, { css: "bad" });
            },
        ],
    ] as const)("rejects %s with a draft-preserving message", (_name, change) => {
        const output = theme();
        change(output);
        expect(() => localThemeRead(JSON.stringify(output), { prompt: "blue" })).toThrow(
            "previous draft is unchanged",
        );
    });

    it("rejects malformed JSON", () => {
        expect(() => localThemeRead("not json", { prompt: "blue" })).toThrow(
            "incomplete or unreadable",
        );
    });
});

describe("one-shot model lifetime", () => {
    it("does not fall back to the commercial provider", async () => {
        const config = {
            models: [{ providerId: "kissopen", id: "hosted" }],
        } as unknown as ConfigModule;
        await expect(
            localThemeGenerate(createRootContext(), config, { prompt: "blue" }),
        ).rejects.toMatchObject({ code: "theme_model_unavailable", status: 503 });
    });

    it("times out even when provider resolution never completes", async () => {
        vi.useFakeTimers();
        const config = {
            models: [{ providerId: "local", id: "default" }],
            providers: { resolve: () => new Promise(() => {}) },
        } as unknown as ConfigModule;
        const outcome = localThemeGenerate(createRootContext(), config, { prompt: "blue" });
        const assertion = expect(outcome).rejects.toMatchObject({
            code: "theme_generation_timeout",
            status: 504,
        });
        await vi.advanceTimersByTimeAsync(120000);
        await assertion;
    });
});
