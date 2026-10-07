import { BaseProvider } from "@/core/BaseProvider.js";
import type { ProviderModality } from "@/core/ProviderModality.js";
import type { SessionOptions } from "@/core/SessionOptions.js";
import {
    createInferenceMaxRetriesResolver,
    sessionInferenceMaxRetriesResolver,
} from "@/core/inferenceRetrySettings.js";
import {
    ChatCompletionsSession,
    type ChatCompletionsEndpointOptions,
} from "@/protocol/chatCompletions/ChatCompletionsSession.js";

export type ChatCompletionsProviderOptions = ChatCompletionsEndpointOptions;

/**
 * A provider for any OpenAI-compatible Chat Completions endpoint with a bearer API key.
 *
 * Concrete vendors configure it — endpoint, credential, and a model resolver that states each
 * model's wire ID and capabilities — rather than reimplementing the protocol.
 */
export class ChatCompletionsProvider extends BaseProvider {
    static override readonly name: string = "chat-completions";
    static override readonly inputTypes: readonly ProviderModality[] = ["text"];
    static override readonly outputTypes: readonly ProviderModality[] = ["text"];

    readonly baseUrl: string;
    readonly model: string | undefined;
    readonly #options: ChatCompletionsProviderOptions;
    readonly #resolveInferenceMaxRetries: () => number;

    constructor(options: ChatCompletionsProviderOptions) {
        super();
        if (options.apiKey.trim().length === 0) {
            throw new TypeError("A Chat Completions provider requires an API key.");
        }
        this.#options = options;
        this.baseUrl = options.baseUrl;
        this.model = options.model;
        this.#resolveInferenceMaxRetries = createInferenceMaxRetriesResolver(options);
    }

    override async session(id: string, options: SessionOptions): Promise<ChatCompletionsSession> {
        const { resolveInferenceMaxRetries: _provider, ...endpoint } = this.#options;
        return new ChatCompletionsSession(id, {
            ...endpoint,
            ...options,
            resolveInferenceMaxRetries: sessionInferenceMaxRetriesResolver(
                options,
                this.#resolveInferenceMaxRetries,
            ),
        });
    }
}
