import type { ProviderModality } from "@/core/ProviderModality.js";
import type { InferenceRetryOptions } from "@/core/inferenceRetrySettings.js";
import { ChatCompletionsProvider } from "@/protocol/chatCompletions/ChatCompletionsProvider.js";
import type { KimiApiKeyCredential } from "@/vendors/kimi/KimiApiKeyCredential.js";
import { KIMI_DEFAULT_BASE_URL, kimiModelProfile } from "@/vendors/kimi/impl/kimiModels.js";

export interface KimiProviderOptions extends InferenceRetryOptions {
    credential: KimiApiKeyCredential;
    /** Defaults to `https://api.moonshot.cn/v1`. */
    baseUrl?: string;
    model?: string;
    userAgent?: string;
    fetch?: typeof fetch;
    responseTimeoutMs?: number;
    streamIdleTimeoutMs?: number;
}

/** Moonshot's Kimi platform API over the shared Chat Completions protocol. */
export class KimiProvider extends ChatCompletionsProvider {
    static override readonly name: string = "kimi";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly credential: KimiApiKeyCredential;

    constructor(options: KimiProviderOptions) {
        const { credential, baseUrl, ...rest } = options;
        super({
            ...rest,
            apiKey: credential.credential.apiKey,
            baseUrl: baseUrl?.trim() || KIMI_DEFAULT_BASE_URL,
            service: "Kimi",
            resolveModel: kimiModelProfile,
            // Moonshot documents JSON mode, not JSON schema.
            structuredOutputMode: "json_object",
        });
        this.credential = credential;
    }
}
