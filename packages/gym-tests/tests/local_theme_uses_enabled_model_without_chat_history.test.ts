import { afterEach, describe, expect, it } from "vitest";
import { createAgentGym, type AgentGym } from "@kissopen/kissopen-agent-gym";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const light = {
    accent: "#6554c0",
    on_accent: "#ffffff",
    canvas: "#ffffff",
    surface: "#ffffff",
    raised: "#eeeeff",
    text: "#000000",
    muted: "#555555",
    line: "#dddddd",
    success: "#008800",
    warning: "#dd8800",
    danger: "#dd0000",
};
const output = {
    name: "青川",
    description: "清爽的蓝绿配色",
    doc: {
        version: 1,
        font: "sans",
        radius: "soft",
        light,
        dark: {
            ...light,
            canvas: "#111111",
            surface: "#222222",
            text: "#ffffff",
            muted: "#bbbbbb",
        },
    },
};

describe("local theme generation through the real daemon and SDK", () => {
    it("uses the enabled default model in a separate tool-free session and leaves history unchanged", async () => {
        const gym = await createAgentGym({
            inference: (request) => ({
                content: [
                    {
                        type: "text",
                        text: request.sessionId.startsWith("theme:")
                            ? JSON.stringify(output)
                            : "Unrelated conversation reply",
                    },
                ],
            }),
        });
        running.add(gym);
        await gym.send("PRIVATE_HISTORY_DO_NOT_SEND_TO_THEME_MODEL");
        const history = await gym.history();
        const before = gym.inference.requests.length;
        expect(await gym.client.getThemeGeneration()).toEqual({
            available: true,
            model: { providerId: gym.selection.providerId, modelId: gym.selection.modelId },
        });
        const result = await gym.client.generateTheme({ prompt: "设计清爽的蓝绿主题" });
        expect(result.name).toBe("青川");
        expect(gym.inference.requests.slice(before)).toHaveLength(1);
        const request = gym.inference.last!;
        expect(request.sessionId).toMatch(/^theme:/u);
        expect(request.model).toBe(gym.selection.modelId);
        expect(request.tools).toEqual([]);
        expect(request.messages).toEqual([
            { role: "user", content: [{ type: "text", text: "设计清爽的蓝绿主题" }] },
        ]);
        expect(JSON.stringify(request)).not.toContain("PRIVATE_HISTORY");
        expect(await gym.history()).toEqual(history);

        await gym.client.patchConfig({ providers: { gym: { enabled: false } } });
        expect(await gym.client.getThemeGeneration()).toEqual({ available: false, model: null });
        await expect(gym.client.generateTheme({ prompt: "blue" })).rejects.toMatchObject({
            status: 503,
            code: "theme_model_unavailable",
        });
        expect(gym.errors).toEqual([]);
    }, 60000);

    it("returns friendly schema/model errors and remains usable after a failure", async () => {
        let invalid = true;
        const gym = await createAgentGym({
            inference: () => ({
                content: [
                    { type: "text", text: invalid ? "unusable theme" : JSON.stringify(output) },
                ],
            }),
        });
        running.add(gym);
        await expect(gym.client.generateTheme({ prompt: "   " })).rejects.toMatchObject({
            status: 400,
        });
        expect(gym.inference.requests).toHaveLength(0);
        await expect(gym.client.generateTheme({ prompt: "blue" })).rejects.toMatchObject({
            status: 502,
            code: "theme_invalid_output",
            message: expect.stringContaining("previous draft is unchanged"),
        });
        invalid = false;
        await expect(gym.client.generateTheme({ prompt: "blue" })).resolves.toMatchObject({
            name: "青川",
        });
        expect(gym.inference.requests).toHaveLength(2);
        expect(gym.errors).toEqual([]);
    }, 60000);
});
