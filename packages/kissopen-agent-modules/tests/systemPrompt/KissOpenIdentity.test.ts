import { describe, expect, it } from "vitest";
import { formatBotIdentityPrompt } from "../../sources/bots/impl/formatBotIdentityPrompt.js";
import { chiefOfStaffGuidance } from "../../sources/bots/impl/formatChiefOfStaffInstructions.js";
import { DEFAULT_SYSTEM_PROMPT_IDENTITY } from "../../sources/systemPrompt/SystemPromptIdentity.js";
import { AGENTS_MD_SPEC } from "../../sources/systemPrompt/AgentsMd.js";
import { assembleEnvironmentPrompt } from "../../sources/systemPrompt/impl/assembleEnvironmentPrompt.js";
import { systemPromptWorld } from "./support/systemPromptWorld.js";

describe("KissOpen open-source identity", () => {
    it("uses KissOpen in every model family, including custom-provider fallback", async () => {
        const { module } = await systemPromptWorld({ models: [] });
        expect(DEFAULT_SYSTEM_PROMPT_IDENTITY.name).toBe("KissOpen");
        for (const selection of [
            { model: "anthropic/opus-5", providerKind: "claude" as const },
            { model: "openai/gpt-5.6-sol", providerKind: "codex" as const },
            { model: "xai/grok-4.5", providerKind: "grok" as const },
            { model: "custom/model" },
        ]) {
            const prompt = module.promptFor(selection);
            expect(prompt).toContain("You are KissOpen");
            expect(prompt).not.toMatch(/一起卷|WorPar|\{\{(?:name|identity)\}\}/u);
        }
    });

    it("keeps the named assistant identity and describes only KissOpen as its runtime", () => {
        const prompt = formatBotIdentityPrompt({ id: "secretary", name: "小秘书", username: "secretary" });
        expect(prompt).toContain('persistent bot named "小秘书"');
        expect(prompt).toContain("KissOpen is the runtime");
        expect(prompt).not.toMatch(/一起卷|WorPar/u);
        expect(chiefOfStaffGuidance()).not.toMatch(/一起卷|WorPar/u);
    });

    it("does not reintroduce the commercial brand in shared environment instructions", () => {
        const prompt = assembleEnvironmentPrompt({
            environment: { workingDirectory: "/workspace", platform: "darwin", shell: "/bin/zsh", osVersion: "26" },
            availableModels: [], currentModel: undefined, currentProvider: "custom",
            designSystemPath: "/docs/DESIGN.md", documentationPath: "/docs/README.md",
        });
        expect(prompt + AGENTS_MD_SPEC).not.toMatch(/一起卷|WorPar/u);
    });
});
