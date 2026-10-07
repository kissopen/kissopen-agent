/** How Kissopen names the service behind a model. */
export interface KissopenProviderDescriptor {
    id: string;
    kind: string;
    name: string;
}

const KNOWN_PROVIDERS: Readonly<Record<string, Omit<KissopenProviderDescriptor, "id">>> = {
    claude: { kind: "claude", name: "Anthropic Claude" },
    codex: { kind: "codex", name: "OpenAI Codex" },
    deepseek: { kind: "deepseek", name: "DeepSeek" },
    grok: { kind: "grok", name: "xAI Grok" },
    kimi: { kind: "kimi", name: "Moonshot Kimi" },
};

/** Describes a provider for the phone, in words rather than an identifier. */
export function describeKissopenProvider(providerId: string): KissopenProviderDescriptor {
    return {
        id: providerId,
        ...(KNOWN_PROVIDERS[providerId] ?? {
            kind: "custom",
            name: providerId
                .replaceAll(/[_-]+/gu, " ")
                .replaceAll(/\b\w/gu, (character) => character.toUpperCase()),
        }),
    };
}
