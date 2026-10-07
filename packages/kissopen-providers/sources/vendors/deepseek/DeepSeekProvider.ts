import type { ProviderModality } from "@/core/ProviderModality.js";
import type { InferenceRetryOptions } from "@/core/inferenceRetrySettings.js";
import { ChatCompletionsProvider } from "@/protocol/chatCompletions/ChatCompletionsProvider.js";
import type { DeepSeekApiKeyCredential } from "@/vendors/deepseek/DeepSeekApiKeyCredential.js";
import {
    DEEPSEEK_DEFAULT_BASE_URL,
    deepseekModelProfile,
} from "@/vendors/deepseek/impl/deepseekModels.js";

export interface DeepSeekProviderOptions extends InferenceRetryOptions {
    credential: DeepSeekApiKeyCredential;
    /** Defaults to `https://api.deepseek.com`. */
    baseUrl?: string;
    model?: string;
    userAgent?: string;
    fetch?: typeof fetch;
    responseTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
}

/** DeepSeek's platform API over the shared Chat Completions protocol. */
export class DeepSeekProvider extends ChatCompletionsProvider {
    static override readonly name: string = "deepseek";
    // Flash reads images; for Pro each image becomes a short note (see the model profile).
    static override readonly inputTypes: readonly ProviderModality[] = ["text", "image"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: DeepSeekApiKeyCredential;

    constructor(options: DeepSeekProviderOptions) {
        const { credential, baseUrl, ...rest } = options;
        super({
            ...rest,
            apiKey: credential.credential.apiKey,
            baseUrl: baseUrl?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
            service: "DeepSeek",
            resolveModel: deepseekModelProfile,
            // DeepSeek accepts JSON mode but not a JSON schema.
            structuredOutputMode: "json_object",
        });
        this.credential = credential;
    }
}
