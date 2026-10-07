import { BedrockAwsCredential } from "@/vendors/bedrock/BedrockAwsCredential.js";
import { BedrockBearerTokenCredential } from "@/vendors/bedrock/BedrockBearerTokenCredential.js";
import { ClaudeApiKeyCredential } from "@/vendors/claude/ClaudeApiKeyCredential.js";
import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeOAuthCredential } from "@/vendors/claude/ClaudeOAuthCredential.js";
import { loadCodexCredential } from "@/vendors/codex/loadCodexCredential.js";
import { DeepSeekApiKeyCredential } from "@/vendors/deepseek/DeepSeekApiKeyCredential.js";
import { GeminiApiKeyCredential } from "@/vendors/gemini/GeminiApiKeyCredential.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokSessionCredential } from "@/vendors/grok/GrokSessionCredential.js";
import { KimiApiKeyCredential } from "@/vendors/kimi/KimiApiKeyCredential.js";
import type { VendorCredential } from "@/vendors/VendorCredential.js";

export interface TryLoadCredentialsOptions {
    bedrockAwsConfigFilepath?: string;
    bedrockAwsCredentialsFilepath?: string;
    bedrockAwsProfile?: string;
    bedrockBearerToken?: string;
    bedrockBearerTokenEnvVar?: string;
    claudeApiKey?: string;
    claudeAuthToken?: string;
    claudeConfigDir?: string;
    claudeOAuthToken?: string;
    codexApiKey?: string;
    codexAuthFile?: string;
    deepseekApiKey?: string;
    env?: NodeJS.ProcessEnv;
    geminiApiKey?: string;
    grokApiKey?: string;
    grokAuthFile?: string;
    kimiApiKey?: string;
}

export async function tryLoadCredentials(
    options: TryLoadCredentialsOptions = {},
): Promise<VendorCredential[]> {
    const env = options.env;
    const explicitAws =
        options.bedrockAwsConfigFilepath !== undefined ||
        options.bedrockAwsCredentialsFilepath !== undefined ||
        options.bedrockAwsProfile !== undefined;
    const credentials = await Promise.all([
        BedrockBearerTokenCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.bedrockBearerToken === undefined
                ? {}
                : { bearerToken: options.bedrockBearerToken }),
            ...(options.bedrockBearerTokenEnvVar === undefined
                ? {}
                : { bearerTokenEnvVar: options.bedrockBearerTokenEnvVar }),
        }),
        env === undefined || explicitAws
            ? BedrockAwsCredential.tryLoad({
                  ...(options.bedrockAwsConfigFilepath === undefined
                      ? {}
                      : { configFilepath: options.bedrockAwsConfigFilepath }),
                  ...(options.bedrockAwsCredentialsFilepath === undefined
                      ? {}
                      : { credentialsFilepath: options.bedrockAwsCredentialsFilepath }),
                  ...(options.bedrockAwsProfile === undefined
                      ? {}
                      : { profile: options.bedrockAwsProfile }),
              })
            : null,
        ClaudeApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeApiKey === undefined ? {} : { apiKey: options.claudeApiKey }),
        }),
        ClaudeAuthTokenCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeAuthToken === undefined
                ? {}
                : { authToken: options.claudeAuthToken }),
        }),
        ClaudeOAuthCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeOAuthToken === undefined
                ? {}
                : { oauthToken: options.claudeOAuthToken }),
        }),
        ClaudeCodeCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.claudeConfigDir === undefined
                ? {}
                : { configDir: options.claudeConfigDir }),
        }),
        loadCodexCredential({
            ...(options.codexApiKey === undefined ? {} : { apiKey: options.codexApiKey }),
            ...(env === undefined ? {} : { env }),
            ...(options.codexAuthFile === undefined ? {} : { authFile: options.codexAuthFile }),
        }),
        DeepSeekApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.deepseekApiKey === undefined ? {} : { apiKey: options.deepseekApiKey }),
        }),
        GeminiApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.geminiApiKey === undefined ? {} : { apiKey: options.geminiApiKey }),
        }),
        GrokApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.grokApiKey === undefined ? {} : { apiKey: options.grokApiKey }),
            ...(options.grokAuthFile === undefined ? {} : { authFile: options.grokAuthFile }),
        }),
        GrokSessionCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.grokAuthFile === undefined ? {} : { authFile: options.grokAuthFile }),
        }),
        KimiApiKeyCredential.tryLoad({
            ...(env === undefined ? {} : { env }),
            ...(options.kimiApiKey === undefined ? {} : { apiKey: options.kimiApiKey }),
        }),
    ]);

    return credentials.filter((credential): credential is VendorCredential => credential !== null);
}
