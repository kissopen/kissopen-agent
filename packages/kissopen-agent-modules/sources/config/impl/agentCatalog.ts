import { KissopenProvider } from "./KissopenProvider.js";
import { AgentProviders, type AgentModel } from "@kissopen/kissopen-agent-base";
import {
    AnthropicProvider,
    type AnthropicBedrockTransport,
    BedrockAwsCredential,
    BedrockBearerTokenCredential,
    ClaudeApiKeyCredential,
    ClaudeAuthTokenCredential,
    ClaudeCodeCredential,
    ClaudeOAuthCredential,
    CodexApiKeyCredential,
    CodexProvider,
    CodexSessionCredential,
    DeepSeekApiKeyCredential,
    DeepSeekProvider,
    GrokApiKeyCredential,
    GrokProvider,
    GrokSessionCredential,
    KimiApiKeyCredential,
    KimiProvider,
    loadCodexCredential,
    resolveClaudeCodeExecutablePath,
    type BaseProvider,
    type ProviderModelCompatibilityType,
    type ProviderUsage,
} from "@kissopen/kissopen-providers";
import type { KissopenAgentConfigValues, KissopenAgentConfiguration } from "../ConfigModule.js";
import { RoundRobinRouterProvider } from "./RoundRobinRouterProvider.js";
import type { KissopenServedModel, KissopenServedRoute } from "./kissopenServedModels.js";
import {
    customModelReasoningSchema,
    type CustomModelReasoning,
} from "@kissopen/kissopen-agent-client";
import { Value } from "@sinclair/typebox/value";

type ConfiguredProvider = KissopenAgentConfigValues["providers"][string];
type ConcreteConfiguredProvider = Exclude<ConfiguredProvider, { readonly type: "smart" }>;

/** Provider-facing context limits that are not part of Agent Base's routing identity. */
export interface AgentModelContext {
    readonly contextWindow: number;
    readonly autoCompactWindow: number;
}

type CatalogAgentModel = AgentModel & AgentModelContext;

export interface SmartProviderModelRoute {
    readonly candidates: readonly string[];
    readonly model: CatalogAgentModel;
    readonly region?: string;
}

export interface SmartProviderRoute {
    readonly models: readonly SmartProviderModelRoute[];
    readonly type: ProviderModelCompatibilityType;
}

/** One provider/model route in the complete catalog, whether or not configuration enables it. */
export type ConfiguredAgentModel = AgentModel & {
    readonly customReasoning?: CustomModelReasoning | null;
    readonly contextWindow: number | null;
    readonly enabled: boolean;
};

/**
 * Claude Code's own default compacts just under the full 1M window, but the Claude Code team
 * recommends 400k as the compromise between task depth and context pollution, and measured
 * sessions show 300k to 400k halving re-read tokens at the same wall-clock time while Opus
 * starts degrading on task-related context beyond that range. See the commit that set this.
 */
const CLAUDE_CONTEXT_WINDOW = 1_000_000;
const CLAUDE_AUTO_COMPACT_WINDOW = 400_000;

/**
 * DeepSeek V4 models serve a 1M window. Like Claude's, the conversation compacts well before it
 * (400K): a longer prompt costs more and answers slower long before it stops fitting.
 */
const DEEPSEEK_CONTEXT: AgentModelContext = Object.freeze({
    contextWindow: 1_000_000,
    autoCompactWindow: 400_000,
});

/** DeepSeek's thinking: off, or low / high / max (medium and above high map onto high). */
const DEEPSEEK_EFFORTS: AgentModel["effortLevels"] = ["off", "low", "high", "max"];

/**
 * Kimi K2 serves a 256K window. Compacting at 230K keeps the prompt plus the 32K output budget
 * the provider requests inside it.
 */
const KIMI_CONTEXT: AgentModelContext = Object.freeze({
    contextWindow: 262_144,
    autoCompactWindow: 230_000,
});

const MODEL_CONTEXTS: Readonly<Record<string, AgentModelContext>> = Object.freeze({
    // Kissopen's conservative per-session budget; not a claim about the vendor's maximum.
    "openai/gpt-4o-mini-2024-07-18": Object.freeze({
        contextWindow: 32000,
        autoCompactWindow: 28000,
    }),
    "anthropic/fable-5-1": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/fable-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/opus-4-8": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/opus-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "anthropic/sonnet-5": Object.freeze({
        contextWindow: CLAUDE_CONTEXT_WINDOW,
        autoCompactWindow: CLAUDE_AUTO_COMPACT_WINDOW,
    }),
    "openai/gpt-5.4": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-6-astra": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-5.6-luna": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-5.6-sol": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "openai/gpt-5.6-terra": Object.freeze({
        contextWindow: 272_000,
        autoCompactWindow: 244_800,
    }),
    "xai/grok-4.5": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-4.6": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-build": Object.freeze({
        contextWindow: 500_000,
        autoCompactWindow: 450_000,
    }),
    "xai/grok-composer-2.5-fast": Object.freeze({
        contextWindow: 200_000,
        autoCompactWindow: 180_000,
    }),
    "deepseek/deepseek-flash": DEEPSEEK_CONTEXT,
    "deepseek/deepseek-v4-pro": DEEPSEEK_CONTEXT,
    "moonshot/kimi-k2-turbo-preview": KIMI_CONTEXT,
    "moonshot/kimi-k2-0905-preview": KIMI_CONTEXT,
    "moonshot/kimi-k2-thinking": KIMI_CONTEXT,
});

const EVERY_EFFORT: AgentModel["effortLevels"] = ["off", "low", "medium", "high", "xhigh", "max"];
const ALL_BUT_OFF: AgentModel["effortLevels"] = ["low", "medium", "high", "xhigh", "max"];

/**
 * The curated catalog. Kissopen Agent never asks a vendor which models exist; the list is source, and a
 * configured provider entry decides which of these its own key serves.
 */
const CATALOG: readonly CatalogAgentModel[] = [
    model("codex", "openai/gpt-6-astra", "GPT-6 Astra", ALL_BUT_OFF, "high", ["priority"]),
    model("codex", "openai/gpt-5.6-sol", "GPT-5.6 Sol", ALL_BUT_OFF, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-terra", "GPT-5.6 Terra", EVERY_EFFORT, "medium", ["priority"]),
    model("codex", "openai/gpt-5.6-luna", "GPT-5.6 Luna", EVERY_EFFORT, "medium", ["priority"]),
    model("claude", "anthropic/opus-5", "Opus 5 1M"),
    model("claude", "anthropic/sonnet-5", "Sonnet 5"),
    model("claude", "anthropic/fable-5-1", "Fable 5.1"),
    model("claude", "anthropic/fable-5", "Fable 5"),
    model("claude", "anthropic/opus-4-8", "Opus 4.8 1M"),
    model("grok", "xai/grok-4.6", "Grok 4.6", ["low", "medium", "high", "xhigh"], "high"),
    model("grok", "xai/grok-build", "Grok Build", ["medium"]),
    model("grok", "xai/grok-4.5", "Grok 4.5", ["low", "medium", "high"], "high"),
    model("grok", "xai/grok-composer-2.5-fast", "Composer 2.5", ["off"], "off"),
    // Chat models expose no effort control: they either never reason or always do.
    model("deepseek", "deepseek/deepseek-flash", "DeepSeek V4.1 Flash", DEEPSEEK_EFFORTS, "high"),
    model("deepseek", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", DEEPSEEK_EFFORTS, "high"),
    model("kimi", "moonshot/kimi-k2-turbo-preview", "Kimi K2 Turbo", ["off"], "off"),
    model("kimi", "moonshot/kimi-k2-0905-preview", "Kimi K2", ["off"], "off"),
    model("kimi", "moonshot/kimi-k2-thinking", "Kimi K2 Thinking", ["high"], "high"),
];

/** Bedrock resells a documented subset of the native catalogs and adds one model of its own. */
const BEDROCK_CATALOG: readonly CatalogAgentModel[] = [
    ...CATALOG.filter(
        (candidate) => candidate.providerId === "claude" || candidate.providerId === "codex",
    ).map((candidate) => {
        const { serviceTiers: _unsupported, ...rest } = candidate;
        return { ...rest, providerId: "bedrock" };
    }),
    model("bedrock", "openai/gpt-5.4", "GPT-5.4", ["off", "low", "medium", "high", "xhigh"]),
];

/** Exact curated Chat Completions wire IDs only; never infer a family or display name. */
export function curatedCustomModelReasoning(wireId: string): CustomModelReasoning | undefined {
    const candidate = [...CATALOG, ...BEDROCK_CATALOG].find(
        (entry) =>
            (entry.id.startsWith("openai/") || entry.providerId === "deepseek") &&
            (entry.id === wireId || entry.id.slice(entry.id.indexOf("/") + 1) === wireId),
    );
    if (!candidate) return undefined;
    const reasoning = {
        mode: candidate.providerId === "deepseek" ? "deepseek" : "openai",
        efforts: [...candidate.effortLevels],
        defaultEffort: candidate.defaultEffort,
    };
    return Value.Check(customModelReasoningSchema, reasoning) ? reasoning : undefined;
}

/**
 * Every model the configuration actually enables, with the configured default first.
 *
 * The order matters: the first entry is what a session gets when it names nothing. A configured
 * default that no enabled provider serves — a removed model, a disabled provider, or a hostile
 * project file — must not keep the daemon down: the first available model stands in and the
 * ignored value is reported through `onIgnored` for the caller to surface.
 */
export function agentModels(
    configuration: KissopenAgentConfiguration,
    onIgnored?: (message: string) => void,
    isProviderEnabled?: (id: string) => boolean,
    isAccountEnabled?: (id: string) => boolean,
    served: readonly KissopenServedModel[] = [],
): readonly CatalogAgentModel[] {
    const values = configuration.values;
    const available = agentModelCatalog(configuration, isProviderEnabled, isAccountEnabled, served)
        .filter((candidate) => candidate.enabled)
        .map(({ enabled: _enabled, ...candidate }) => candidate as CatalogAgentModel);
    const wantedModel = values.defaults.modelId;
    const wantedProvider = values.defaults.providerId;
    const chosen =
        available.find(
            (candidate) =>
                candidate.id === wantedModel &&
                (wantedProvider === undefined || candidate.providerId === wantedProvider),
        ) ?? undefined;
    if (chosen === undefined) {
        const standIn = available[0];
        if (standIn !== undefined) {
            onIgnored?.(
                `The configured default model "${wantedModel}" is not served by any enabled provider, so "${standIn.id}" stands in.`,
            );
        }
        return available;
    }
    const effort = values.defaults.effort;
    const effortSupported =
        effort === undefined || chosen.effortLevels.includes(effort as AgentModel["defaultEffort"]);
    if (!effortSupported) {
        onIgnored?.(
            `The configured effort "${effort ?? ""}" is not supported by model "${chosen.id}", so its own default effort stands in.`,
        );
    }
    const first =
        effort === undefined || !effortSupported
            ? chosen
            : { ...chosen, defaultEffort: effort as AgentModel["defaultEffort"] };
    return [first, ...available.filter((candidate) => candidate !== chosen)];
}

/**
 * Every curated model for every configured provider, including disabled and filtered routes.
 *
 * Catalog responses must not be inferred from models that happened to run: an excluded model is
 * still one the daemon knows, and its false `enabled` value is the fact clients need to display.
 */
export function agentModelCatalog(
    configuration: KissopenAgentConfiguration,
    isProviderEnabled: (id: string) => boolean = (id) =>
        configuration.values.providers[id]?.enabled !== false &&
        configuration.values.providers[id]?.hidden !== true,
    isAccountEnabled: (id: string) => boolean = (id) =>
        configuration.values.providers[id]?.enabled !== false,
    served: readonly KissopenServedModel[] = [],
): readonly ConfiguredAgentModel[] {
    const concreteModels: ConfiguredAgentModel[] = [];
    const values = configuration.values;
    for (const [id, provider] of Object.entries(values.providers)) {
        if (provider.type === "smart") continue;
        const source =
            id === "kissopen" && provider.type === "codex"
                ? kissopenCatalog(served)
                : provider.type === "bedrock"
                  ? BEDROCK_CATALOG
                  : CATALOG;
        // A model the KISSOPEN server serves from a console upstream is offered on the server's
        // own word, the policy it answered with; the allowlist written when this device first
        // connected predates it.
        const servedIds = new Set(
            id === "kissopen" && provider.type === "codex" ? served.map((model) => model.id) : [],
        );
        for (const candidate of source) {
            if (provider.type !== "bedrock" && candidate.providerId !== provider.type) continue;
            if (!modelAvailableOnProvider(provider, candidate.id)) continue;
            const enabled =
                isProviderEnabled(id) &&
                (servedIds.has(candidate.id) ||
                    provider.includeModels?.includes(candidate.id) !== false) &&
                provider.excludeModels?.includes(candidate.id) !== true;
            concreteModels.push({ ...candidate, enabled, providerId: id });
        }
    }
    const models = [...concreteModels];
    for (const [id, provider] of Object.entries(values.providers)) {
        if (provider.type !== "smart") continue;
        const route = smartProviderRoute(configuration, id, concreteModels);
        if (route === undefined) continue;
        for (const routed of route.models) {
            const enabled =
                isProviderEnabled(id) &&
                provider.includeModels?.includes(routed.model.id) !== false &&
                provider.excludeModels?.includes(routed.model.id) !== true &&
                routed.candidates.some((candidate) => isAccountEnabled(candidate));
            models.push({ ...routed.model, enabled, providerId: id });
        }
    }
    return models;
}

/** Resolve one smart provider into exact-model routes, silently dropping invalid members. */
export function smartProviderRoute(
    configuration: KissopenAgentConfiguration,
    providerId: string,
    catalog: readonly ConfiguredAgentModel[] = concreteAgentModelCatalog(configuration),
): SmartProviderRoute | undefined {
    const smart = configuration.values.providers[providerId];
    if (smart?.type !== "smart") return undefined;
    const concrete = smart.providers
        .map((id) => [id, configuration.values.providers[id]] as const)
        .filter(
            (
                entry,
            ): entry is readonly [
                string,
                Exclude<ConfiguredProvider, { readonly type: "smart" }>,
            ] => entry[1] !== undefined && entry[1].type !== "smart",
        );
    const type = concrete[0]?.[1].type;
    if (type === undefined) return undefined;
    const compatibleIds = new Set(
        concrete.filter(([, provider]) => provider.type === type).map(([id]) => id),
    );
    const orderedModels: string[] = [];
    const routes = new Map<
        string,
        { candidates: string[]; model: CatalogAgentModel; region?: string }
    >();
    for (const candidateId of smart.providers) {
        if (!compatibleIds.has(candidateId)) continue;
        for (const entry of catalog) {
            if (entry.providerId !== candidateId) continue;
            const candidateProvider = configuration.values.providers[candidateId];
            if (
                candidateProvider === undefined ||
                candidateProvider.type === "smart" ||
                candidateProvider.includeModels?.includes(entry.id) === false ||
                candidateProvider.excludeModels?.includes(entry.id) === true
            ) {
                continue;
            }
            let route = routes.get(entry.id);
            const region =
                type === "bedrock"
                    ? bedrockModelRegion(configuration, candidateId, entry.id)
                    : undefined;
            if (route === undefined) {
                const { enabled: _enabled, ...model } = entry;
                route = {
                    candidates: [],
                    model: model as CatalogAgentModel,
                    ...(region === undefined ? {} : { region }),
                };
                routes.set(entry.id, route);
                orderedModels.push(entry.id);
            }
            if (
                type === "bedrock" &&
                !sameBedrockRegion(route.region, region, route.candidates.length)
            ) {
                continue;
            }
            route.candidates.push(candidateId);
        }
    }
    return {
        models: orderedModels
            .map((modelId) => routes.get(modelId)!)
            .filter((route) => route.candidates.length > 0),
        type,
    };
}

/**
 * Context limits for one enabled provider/model route, when the curated catalog knows them or
 * the KISSOPEN server stated them for a model it serves.
 */
export function agentModelContext(
    modelId: string,
    served: readonly KissopenServedModel[] = [],
): AgentModelContext | undefined {
    const context = MODEL_CONTEXTS[modelId];
    if (context !== undefined) return { ...context };
    const model = served.find((candidate) => candidate.id === modelId);
    return model === undefined ? undefined : servedContext(model);
}

/**
 * One registry holding every configured provider, each constructing its client on first use so a
 * credential is read when a session needs it rather than at startup.
 */
export function agentProviders(
    configuration: KissopenAgentConfiguration,
    onAccountUsage?: (usage: ProviderUsage) => void,
    isProviderEnabled: (providerId: string) => boolean = () => true,
    providerSignal: (providerId: string) => AbortSignal | undefined = () => undefined,
    concreteProviders?: AgentProviders,
    servedRoute: (modelId: string | undefined) => KissopenServedRoute | undefined = () => undefined,
): AgentProviders {
    const providers = new AgentProviders();
    const retryLimit = configuration.values.settings.inferenceMaxRetries;
    if (concreteProviders !== undefined) {
        for (const id of concreteProviders.ids) {
            if (configuration.values.providers[id]?.type === "smart") continue;
            const type = concreteProviders.typeOf(id);
            if (type === null) continue;
            providers.add(
                id,
                async ({ model }) => {
                    const provider = await concreteProviders.resolve(id, model);
                    if (provider === null) throw new Error(`Provider "${id}" is unavailable.`);
                    return provider;
                },
                type,
            );
        }
    }
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.type === "smart" || concreteProviders !== undefined) continue;
        providers.add(
            id,
            async ({ model: selected }) =>
                await createProvider(
                    id,
                    provider,
                    selected,
                    retryLimit,
                    onAccountUsage,
                    servedRoute,
                ),
            provider.type,
        );
    }
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.type !== "smart") continue;
        const route = smartProviderRoute(configuration, id);
        if (route === undefined || route.models.length === 0) continue;
        const cache = new Map<string, RoundRobinRouterProvider>();
        providers.add(
            id,
            ({ model: selected }) => {
                const routed =
                    route.models.find((candidate) => candidate.model.id === selected) ??
                    (selected === undefined ? route.models[0] : undefined);
                if (routed === undefined) {
                    throw new Error(
                        `Smart provider "${id}" has no compatible route for model "${selected ?? ""}".`,
                    );
                }
                let resolved = cache.get(routed.model.id);
                if (resolved === undefined) {
                    resolved = new RoundRobinRouterProvider({
                        candidates: routed.candidates.map((providerId) => ({ providerId })),
                        isEnabled: isProviderEnabled,
                        model: routed.model.id,
                        ...(routed.region === undefined ? {} : { region: routed.region }),
                        resolve: async (providerId, model) =>
                            await providers.resolve(providerId, model),
                        signal: providerSignal,
                    });
                    cache.set(routed.model.id, resolved);
                }
                return resolved;
            },
            route.type,
        );
    }
    return providers;
}

function concreteAgentModelCatalog(
    configuration: KissopenAgentConfiguration,
): readonly ConfiguredAgentModel[] {
    const models: ConfiguredAgentModel[] = [];
    for (const [id, provider] of Object.entries(configuration.values.providers)) {
        if (provider.type === "smart") continue;
        const source =
            id === "kissopen" && provider.type === "codex"
                ? KISSOPEN_CATALOG
                : provider.type === "bedrock"
                  ? BEDROCK_CATALOG
                  : CATALOG;
        for (const candidate of source) {
            if (provider.type !== "bedrock" && candidate.providerId !== provider.type) continue;
            if (!modelAvailableOnProvider(provider, candidate.id)) continue;
            models.push({ ...candidate, enabled: true, providerId: id });
        }
    }
    return models;
}

/** AWS's Sonnet 5 model card lists Mantle in-region support only in these regions.
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html
 * Runtime inference profiles have separate availability; never silently switch transport/region.
 */
/**
 * What the KISSOPEN server offers: the Codex models through the resource pool, GPT-4o mini, and
 * DeepSeek's models, which the server reaches on DeepSeek's own API. The provider is Codex-typed,
 * so every entry is listed as a Codex model; `KissopenProvider` sends the DeepSeek ones over Chat
 * Completions.
 */
const KISSOPEN_CATALOG: readonly CatalogAgentModel[] = [
    ...CATALOG.filter((candidate) => candidate.providerId === "codex"),
    model("codex", "openai/gpt-4o-mini-2024-07-18", "GPT-4o mini · KissOpen", ["off"], "off"),
    ...CATALOG.filter((candidate) => candidate.providerId === "deepseek").map((candidate) => ({
        ...candidate,
        providerId: "codex",
    })),
];

/**
 * The KISSOPEN catalog with the models the server serves from upstreams added in its console.
 * The curated entries come first and keep their own description of a model the server also
 * happens to list.
 */
function kissopenCatalog(served: readonly KissopenServedModel[]): readonly CatalogAgentModel[] {
    if (served.length === 0) return KISSOPEN_CATALOG;
    const curated = new Set(KISSOPEN_CATALOG.map((candidate) => candidate.id));
    return [
        ...KISSOPEN_CATALOG,
        ...served
            .filter((candidate) => !curated.has(candidate.id))
            .map((candidate): CatalogAgentModel => {
                const efforts = SERVED_EFFORTS[candidate.protocol];
                return {
                    ...servedContext(candidate),
                    defaultEffort: efforts.default,
                    effortLevels: efforts.levels,
                    id: candidate.id,
                    name: candidate.name,
                    providerId: "codex",
                };
            }),
    ];
}

/**
 * The effort a served model starts on. Every level is accepted: a message from the phone or a
 * cloud workspace names an effort without knowing which API the model answers on, and one it
 * could not take would be refused whole. `KissopenProvider` fits the effort to the model's API
 * instead — Chat Completions has no common control and ignores it.
 */
const SERVED_EFFORTS: Readonly<
    Record<
        KissopenServedModel["protocol"],
        { levels: AgentModel["effortLevels"]; default: AgentModel["defaultEffort"] }
    >
> = {
    chat: { levels: EVERY_EFFORT, default: "medium" },
    responses: { levels: EVERY_EFFORT, default: "medium" },
    messages: { levels: EVERY_EFFORT, default: "high" },
};

/**
 * A served model compacts once a prompt plus its longest answer would come near the window, and
 * never later than 85% of it, the margin the curated windows keep.
 */
function servedContext(model: KissopenServedModel): AgentModelContext {
    const window = model.context_window;
    const beforeAnswer = window - Math.min(model.max_output_tokens, window / 4) - 4_000;
    return {
        contextWindow: window,
        autoCompactWindow: Math.max(
            Math.floor(window / 2),
            Math.min(Math.floor(window * 0.85), beforeAnswer),
        ),
    };
}

function modelAvailableOnProvider(provider: ConcreteConfiguredProvider, modelId: string): boolean {
    if (provider.type !== "bedrock" || modelId !== "anthropic/sonnet-5") return true;
    if (resolveAnthropicBedrockTransport(provider, modelId) !== "mantle") return true;
    const region = provider.modelOverrides?.[modelId]?.region ?? provider.region ?? "us-east-1";
    return ["us-east-1", "us-gov-west-1", "eu-north-1", "eu-west-1", "ap-southeast-4"].includes(
        region,
    );
}

function bedrockModelRegion(
    configuration: KissopenAgentConfiguration,
    providerId: string,
    modelId: string,
): string | undefined {
    const provider = configuration.values.providers[providerId];
    if (provider?.type !== "bedrock") return undefined;
    return provider.modelOverrides?.[modelId]?.region ?? provider.region;
}

function sameBedrockRegion(
    anchor: string | undefined,
    candidate: string | undefined,
    existingCandidates: number,
): boolean {
    if (existingCandidates === 0) return true;
    return anchor !== undefined && candidate !== undefined && anchor === candidate;
}

async function createProvider(
    id: string,
    provider: ConcreteConfiguredProvider,
    selectedModel: string | undefined,
    retryLimit: number | undefined,
    onAccountUsage?: (usage: ProviderUsage) => void,
    servedRoute: (modelId: string | undefined) => KissopenServedRoute | undefined = () => undefined,
): Promise<BaseProvider> {
    // Credential isolation means this provider may use only what its own configuration names.
    // Without it, each vendor's ambient discovery — its CLI's own login files and environment —
    // is allowed to answer, which is how KISSOPEN Agent reuses a Codex or Claude Code sign-in.
    const ambient = provider.credentialIsolation !== true;
    const retries = retryLimit === undefined ? {} : { inferenceMaxRetries: retryLimit };
    const configured = async <T>(
        value: string | undefined,
        fromValue: (value: string) => Promise<T | null>,
        discover: () => Promise<T | null>,
    ): Promise<T | null> =>
        value === undefined ? (ambient ? await discover() : null) : await fromValue(value);

    if (provider.type === "codex") {
        const credential = ambient
            ? await loadCodexCredential({
                  ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                  ...(provider.authFile === undefined ? {} : { authFile: provider.authFile }),
              })
            : ((provider.apiKey === undefined
                  ? null
                  : await CodexApiKeyCredential.tryLoad({ apiKey: provider.apiKey })) ??
              (provider.authFile === undefined
                  ? null
                  : await CodexSessionCredential.tryLoad({ authFile: provider.authFile })));
        const options = {
            credential: required(credential, "Codex", id),
            parallelToolCalls: true,
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...(provider.transport === undefined || provider.transport === "auto"
                ? {}
                : {
                      transport:
                          provider.transport === "websocket-cached"
                              ? ("websocket" as const)
                              : provider.transport,
                  }),
            ...retries,
        };
        return id === "kissopen"
            ? new KissopenProvider({ ...options, servedRoute })
            : new CodexProvider(options);
    }

    if (provider.type === "claude") {
        const credential =
            (await configured(
                provider.oauthToken,
                async (oauthToken) => await ClaudeOAuthCredential.tryLoad({ oauthToken }),
                async () => await ClaudeOAuthCredential.tryLoad({}),
            )) ??
            (await configured(
                provider.apiKey,
                async (apiKey) => await ClaudeApiKeyCredential.tryLoad({ apiKey }),
                async () => await ClaudeApiKeyCredential.tryLoad({}),
            )) ??
            (await configured(
                provider.authToken,
                async (authToken) => await ClaudeAuthTokenCredential.tryLoad({ authToken }),
                async () => await ClaudeAuthTokenCredential.tryLoad({}),
            )) ??
            (await configured(
                provider.configDir,
                async (configDir) => await ClaudeCodeCredential.tryLoad({ configDir }),
                async () => await ClaudeCodeCredential.tryLoad({}),
            ));
        return new AnthropicProvider({
            credential: required(credential, "Claude", id),
            // Bun cannot use the SDK's runtime require.resolve from its compiled filesystem.
            // The standalone build adapts this resolver to materialize its embedded executable.
            pathToClaudeCodeExecutable: provider.executable ?? resolveClaudeCodeExecutablePath(),
            // Every Claude response already carries the account's own limiter reading, so the
            // account is measured by the work it does. The vendor names the reading after its own
            // vendor key; this account is whichever configured provider actually spent the tokens.
            ...(onAccountUsage === undefined
                ? {}
                : {
                      onAccountUsage: (usage: ProviderUsage) =>
                          onAccountUsage({ ...usage, providerId: id }),
                  }),
            ...retries,
        });
    }

    if (provider.type === "grok") {
        // Grok reads its key from the environment unless isolation forbids it. Ambient providers
        // may also reuse the default Grok CLI session; isolated ones must name their auth file.
        const env = ambient ? undefined : {};
        const withEnv = <T extends object>(input: T) =>
            env === undefined ? input : { ...input, env };
        const credential =
            (await GrokApiKeyCredential.tryLoad(
                withEnv({
                    ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
                    ...(provider.authFile === undefined || provider.apiKey !== undefined
                        ? {}
                        : { authFile: provider.authFile }),
                }),
            )) ??
            (ambient || provider.authFile !== undefined
                ? await GrokSessionCredential.tryLoad(
                      withEnv(
                          provider.authFile === undefined ? {} : { authFile: provider.authFile },
                      ),
                  )
                : null);
        return new GrokProvider({
            credential: required(credential, "Grok", id),
            ...(provider.baseUrl === undefined ? {} : { endpoint: provider.baseUrl }),
            ...retries,
        });
    }

    if (provider.type === "deepseek" || provider.type === "kimi") {
        // The key comes from configuration, or from the vendor's environment variable unless
        // isolation forbids ambient credentials.
        const env = ambient ? undefined : {};
        const options = {
            ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
            ...(env === undefined ? {} : { env }),
        };
        const shared = {
            ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
            ...retries,
        };
        if (provider.type === "deepseek") {
            return new DeepSeekProvider({
                credential: required(
                    await DeepSeekApiKeyCredential.tryLoad(options),
                    "DeepSeek",
                    id,
                ),
                ...shared,
            });
        }
        return new KimiProvider({
            credential: required(await KimiApiKeyCredential.tryLoad(options), "Kimi", id),
            ...shared,
        });
    }

    const bearer = {
        ...(provider.bearerToken === undefined ? {} : { bearerToken: provider.bearerToken }),
        ...(provider.bearerTokenEnvVar === undefined
            ? {}
            : { bearerTokenEnvVar: provider.bearerTokenEnvVar }),
    };
    const explicitBearer =
        provider.bearerToken !== undefined || provider.bearerTokenEnvVar !== undefined;
    const explicitAws =
        provider.configFile !== undefined ||
        provider.credentialsFile !== undefined ||
        provider.profile !== undefined;
    const aws = {
        ...(provider.configFile === undefined ? {} : { configFilepath: provider.configFile }),
        ...(provider.credentialsFile === undefined
            ? {}
            : { credentialsFilepath: provider.credentialsFile }),
        // Naming either shared file selects its default profile instead of allowing unrelated
        // environment credentials to win the standard AWS chain.
        ...(provider.profile === undefined
            ? explicitAws
                ? { profile: "default" }
                : {}
            : { profile: provider.profile }),
    };
    const bearerCredential = explicitAws
        ? null
        : await BedrockBearerTokenCredential.tryLoad(
              ambient
                  ? bearer
                  : {
                        ...bearer,
                        env: provider.bearerTokenEnvVar === undefined ? {} : process.env,
                    },
          );
    const credential = required(
        bearerCredential ??
            (explicitAws || (ambient && !explicitBearer)
                ? await BedrockAwsCredential.tryLoad(aws)
                : null),
        "Bedrock",
        id,
    );
    // Bedrock serves each family through that family's own wire protocol, so the selected model
    // decides which client speaks to it.
    const override =
        selectedModel === undefined ? undefined : provider.modelOverrides?.[selectedModel];
    const transport = resolveAnthropicBedrockTransport(provider, selectedModel);
    const shared = {
        credential,
        ...(override?.endpoint === undefined ? {} : { endpoint: override.endpoint }),
        ...(selectedModel === undefined ? {} : { model: selectedModel }),
        ...((override?.region ?? provider.region) === undefined
            ? {}
            : { region: override?.region ?? provider.region }),
        ...retries,
    };
    return selectedModel?.startsWith("anthropic/") === true
        ? new AnthropicProvider({
              ...shared,
              ...(transport === undefined ? {} : { transport }),
          })
        : new CodexProvider({
              ...shared,
              ...(override?.transport === undefined
                  ? {}
                  : { bedrockTransport: override.transport }),
          });
}

function resolveAnthropicBedrockTransport(
    provider: Extract<ConcreteConfiguredProvider, { readonly type: "bedrock" }>,
    model: string | undefined,
): AnthropicBedrockTransport | undefined {
    if (model?.startsWith("anthropic/") !== true) return undefined;
    return (
        provider.modelOverrides?.[model]?.transport ??
        (model === "anthropic/fable-5-1" ? "runtime" : "mantle")
    );
}

/** The one Anthropic transport shared by every concrete route behind this selection. */
export function configuredAnthropicBedrockTransport(
    configuration: KissopenAgentConfiguration,
    providerId: string,
    model: string | undefined,
): AnthropicBedrockTransport | undefined {
    if (model?.startsWith("anthropic/") !== true) return undefined;
    const provider = configuration.values.providers[providerId];
    if (provider === undefined) return undefined;
    if (provider.type === "bedrock") return resolveAnthropicBedrockTransport(provider, model);
    if (provider.type !== "smart") return undefined;

    const route = smartProviderRoute(configuration, providerId)?.models.find(
        (candidate) => candidate.model.id === model,
    );
    if (route === undefined || route.candidates.length === 0) return undefined;
    const transports = route.candidates.map((candidateId) => {
        const candidate = configuration.values.providers[candidateId];
        return candidate?.type === "bedrock"
            ? resolveAnthropicBedrockTransport(candidate, model)
            : undefined;
    });
    const first = transports[0];
    return first !== undefined && transports.every((transport) => transport === first)
        ? first
        : undefined;
}

function required<T>(credential: T | null, vendor: string, id: string): T {
    if (credential === null) {
        throw new Error(`${vendor} authentication is unavailable for provider "${id}".`);
    }
    return credential;
}

function model(
    providerId: string,
    id: string,
    name: string,
    effortLevels: AgentModel["effortLevels"] = EVERY_EFFORT,
    defaultEffort: AgentModel["defaultEffort"] = "medium",
    serviceTiers?: AgentModel["serviceTiers"],
): CatalogAgentModel {
    const context = MODEL_CONTEXTS[id];
    if (context === undefined) {
        throw new Error(`Model "${id}" has no configured context window.`);
    }
    return {
        ...context,
        defaultEffort,
        effortLevels,
        id,
        name,
        providerId,
        ...(serviceTiers === undefined ? {} : { serviceTiers }),
    };
}
