import { AnthropicBedrock, AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import type { AnthropicBedrockTransport } from "@/vendors/bedrock/AnthropicBedrockTransport.js";

export type AnthropicBedrockClient = Pick<AnthropicBedrock | AnthropicBedrockMantle, "beta">;

export function createAnthropicBedrockClient(options: {
    credential: BedrockCredential;
    endpoint?: string;
    region: string;
    transport: AnthropicBedrockTransport;
    userAgent?: string;
    /** Sent with every request, for a gateway that routes by them. */
    headers?: Readonly<Record<string, string>>;
}): AnthropicBedrockClient {
    const userAgent = options.userAgent?.trim();
    // Left to the SDK unless the caller would rather its traffic be recognizable as its own, or
    // routes by headers of its own.
    const named = userAgent === undefined || userAgent.length === 0 ? {} : { "User-Agent": userAgent };
    const defaultHeaders =
        options.headers === undefined && Object.keys(named).length === 0
            ? undefined
            : { ...options.headers, ...named };
    const clientOptions = {
        awsRegion: options.region,
        maxRetries: 0,
        ...(options.endpoint === undefined ? {} : { baseURL: options.endpoint }),
        ...(defaultHeaders === undefined ? {} : { defaultHeaders }),
    };
    if (options.credential.name === "bedrock-bearer-token") {
        const authenticated = {
            ...clientOptions,
            apiKey: options.credential.credential.bearerToken,
        };
        return options.transport === "mantle"
            ? new AnthropicBedrockMantle(authenticated)
            : new AnthropicBedrock(authenticated);
    }
    const provider = options.credential.credential.provider;
    const providerChainResolver = async () => async () => await provider();
    if (options.transport === "mantle") {
        return new AnthropicBedrockMantle({
            ...clientOptions,
            // A profile selects SigV4 ahead of an ambient bearer token. The custom provider still
            // supplies the credentials, so this name is only the SDK's authentication-mode flag.
            awsProfile: options.credential.credential.profile ?? "default",
            providerChainResolver,
        });
    }
    return new AnthropicBedrock({
        ...clientOptions,
        // Runtime defaults an omitted key from AWS_BEARER_TOKEN_BEDROCK. An explicit empty key
        // disables that fallback and leaves signing to the custom AWS credential provider.
        apiKey: "",
        providerChainResolver,
    });
}
