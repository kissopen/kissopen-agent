import { describe, expect, it } from "vitest";
import { classifyExpertTask } from "../../sources/expert/classifyExpertTask.js";
import { DEFAULT_EXPERT_POLICY } from "../../sources/expert/ExpertPolicy.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { AgentProviders } from "@kissopen/kissopen-agent-base";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

describe("deterministic routing", () => {
    it.each([
        ["ping", undefined],
        ["你好", undefined],
        ["PPT 是什么", undefined],
        ["不要制作 PPT", undefined],
        ["帮我制作产品发布 PPT", "slides"],
        ["Create a presentation for launch", "slides"],
        ["制定下个月的销售计划", "plan"],
        ["帮我撰写经营报告", "document"],
        ["分析销售数据并预测趋势", "analysis"],
        ["what is a sales report?", undefined],
    ])("routes %s to %s", (text, kind) => {
        expect(classifyExpertTask(DEFAULT_EXPERT_POLICY.policy, text!)?.id).toBe(kind);
    });
    it("follows edited rules, their order and enabled state", () => {
        const policy = structuredClone(DEFAULT_EXPERT_POLICY.policy);
        policy.expert_tasks = [
            { id: "first", name: "合同", description: "", enabled: true, match_any: ["审合同"] },
            { id: "second", name: "合同", description: "", enabled: true, match_any: ["审合同"] },
        ];
        expect(classifyExpertTask(policy, "帮我审合同")?.id).toBe("first");
        policy.expert_tasks[0]!.enabled = false;
        expect(classifyExpertTask(policy, "帮我审合同")?.id).toBe("second");
        expect(classifyExpertTask(policy, "制作 PPT")).toBeUndefined();
    });
    it("replaces stale hosted selections but preserves BYOK and internal explicit routes", async () => {
        const providers = new AgentProviders();
        providers.add("kissopen", new ScriptedProvider([]), "codex");
        const config = await temporaryTestConfig(undefined, {
            inference: {
                providers,
                models: [
                    {
                        providerId: "kissopen",
                        id: "deepseek/deepseek-flash",
                        name: "Flash",
                        effortLevels: ["high"],
                        defaultEffort: "high",
                    },
                ],
            },
        });
        config.suggestDefault({
            providerId: "kissopen",
            modelId: "deepseek/deepseek-flash",
            effort: "high",
        });
        const stale = {
            providerId: "kissopen",
            modelId: "openai/gpt-6-astra",
            effort: "high",
            serviceTier: "priority",
            permissionMode: "auto",
        };
        expect(config.kissopenMessageMode(stale)).toMatchObject({
            modelId: "deepseek/deepseek-flash",
            serviceTier: null,
            permissionMode: "auto",
        });
        const own = { ...stale, providerId: "codex" };
        expect(config.kissopenMessageMode(own)).toBe(own);
        expect(stale.modelId).toBe("openai/gpt-6-astra");
        config.suggestDefault({ providerId: "kissopen", modelId: "not-served", effort: "high" });
        expect(() => config.kissopenMessageMode(stale)).toThrow("unavailable");
    });
});
