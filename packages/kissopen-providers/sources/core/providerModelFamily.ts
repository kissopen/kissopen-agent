import type { ProviderModelFamily } from "@/core/ProviderModelCompatibility.js";

export function providerModelFamily(modelId: string): ProviderModelFamily | undefined {
    if (modelId.startsWith("anthropic/")) return "claude";
    if (modelId.startsWith("openai/")) return "codex";
    if (modelId.startsWith("xai/")) return "grok";
    if (modelId.startsWith("deepseek/")) return "deepseek";
    if (modelId.startsWith("moonshot/")) return "kimi";
    return undefined;
}
