import type { ChatCompletionsModelProfile } from "@/protocol/chatCompletions/createChatCompletionsRequest.js";

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

/** Rig model IDs carry the vendor prefix; the wire ID is the rest. */
export function resolveDeepSeekModelId(model: string): string {
    return model.startsWith("deepseek/") ? model.slice("deepseek/".length) : model;
}

/**
 * What DeepSeek documents for each model it serves (api-docs.deepseek.com, 模型 & 价格).
 *
 * `deepseek-flash` (DeepSeek-V4.1-Flash) reads images; `deepseek-v4-pro` (DeepSeek-V4-Pro-0813)
 * does not. Both have a 1M context, think by default, and take the thinking switch and effort in
 * DeepSeek's own fields. With tools in the request, every earlier `reasoning_content` must come
 * back or DeepSeek answers 400. The output budget is raised well above the default because
 * thinking counts against it.
 */
export function deepseekModelProfile(model: string): ChatCompletionsModelProfile {
    const wireModel = resolveDeepSeekModelId(model);
    return {
        wireModel,
        vision: wireModel === "deepseek-flash",
        maxTokens: 65_536,
        thinkingControl: "deepseek",
        reasoningReplay: "all",
    };
}
