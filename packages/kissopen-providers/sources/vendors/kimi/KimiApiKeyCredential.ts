import { BaseCredential } from "@/core/BaseCredential.js";

export type KimiApiKeyCredentialValue = {
    readonly apiKey: string;
};

export interface KimiApiKeyCredentialLoadOptions {
    /** An explicit key, which wins over the environment. */
    apiKey?: string;
    env?: NodeJS.ProcessEnv;
}

/** A Moonshot platform API key, given explicitly or read from `MOONSHOT_API_KEY` or `KIMI_API_KEY`. */
export class KimiApiKeyCredential extends BaseCredential<
    "kimi-api-key",
    KimiApiKeyCredentialValue
> {
    static async tryLoad(
        options: KimiApiKeyCredentialLoadOptions = {},
    ): Promise<KimiApiKeyCredential | null> {
        const env = options.env ?? process.env;
        const apiKey =
            options.apiKey?.trim() || env.MOONSHOT_API_KEY?.trim() || env.KIMI_API_KEY?.trim();
        return apiKey ? new KimiApiKeyCredential({ apiKey }) : null;
    }

    private constructor(credential: KimiApiKeyCredentialValue) {
        super("kimi-api-key", credential);
    }
}
