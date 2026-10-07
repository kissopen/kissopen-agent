import { BaseCredential } from "@/core/BaseCredential.js";

export type DeepSeekApiKeyCredentialValue = {
    readonly apiKey: string;
};

export interface DeepSeekApiKeyCredentialLoadOptions {
    /** An explicit key, which wins over the environment. */
    apiKey?: string;
    env?: NodeJS.ProcessEnv;
}

/** A DeepSeek platform API key, given explicitly or read from `DEEPSEEK_API_KEY`. */
export class DeepSeekApiKeyCredential extends BaseCredential<
    "deepseek-api-key",
    DeepSeekApiKeyCredentialValue
> {
    static async tryLoad(
        options: DeepSeekApiKeyCredentialLoadOptions = {},
    ): Promise<DeepSeekApiKeyCredential | null> {
        const env = options.env ?? process.env;
        const apiKey = options.apiKey?.trim() || env.DEEPSEEK_API_KEY?.trim();
        return apiKey ? new DeepSeekApiKeyCredential({ apiKey }) : null;
    }

    private constructor(credential: DeepSeekApiKeyCredentialValue) {
        super("deepseek-api-key", credential);
    }
}
