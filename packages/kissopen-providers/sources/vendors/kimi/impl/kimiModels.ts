import type { ChatCompletionsModelProfile } from "@/protocol/chatCompletions/createChatCompletionsRequest.js";

/** Moonshot's mainland endpoint; `https://api.moonshot.ai/v1` serves international accounts. */
export const KIMI_DEFAULT_BASE_URL = "https://api.moonshot.cn/v1";

/** Rig model IDs carry the vendor prefix; the wire ID is the rest. */
export function resolveKimiModelId(model: string): string {
    return model.startsWith("moonshot/") ? model.slice("moonshot/".length) : model;
}

/**
 * What Moonshot documents for the Kimi K2 family.
 *
 * Moonshot's default output budget is far below what an agent needs, and K2 Thinking needs room
 * for its reasoning as well as the answer, so every K2 model asks for 32,000 tokens. That still
 * fits beside the largest prompt the catalog lets a conversation reach before compacting. The
 * sampling temperatures are the ones Moonshot recommends: 0.6 for K2 and 1.0 for K2 Thinking.
 * None of these models accepts images.
 */
export function kimiModelProfile(model: string): ChatCompletionsModelProfile {
    const wireModel = resolveKimiModelId(model);
    if (wireModel.startsWith("kimi-k2-thinking")) {
        return { wireModel, maxTokens: 32_000, temperature: 1 };
    }
    if (wireModel.startsWith("kimi-k2")) {
        return { wireModel, maxTokens: 32_000, temperature: 0.6 };
    }
    return { wireModel };
}
