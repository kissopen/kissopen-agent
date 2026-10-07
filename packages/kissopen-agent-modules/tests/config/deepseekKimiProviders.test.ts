import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DeepSeekProvider, KimiProvider } from "@kissopen/kissopen-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseKissopenAgentConfigToml } from "../../sources/config/index.js";
import { ProviderScanModule } from "../../sources/providerScan/index.js";
import { testConfigRootedAt } from "../support/configModule.js";

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), "kissopen-deepseek-kimi-"));
    roots.push(value);
    return value;
}

/** Keeps the vendors this test is not about from reading this machine's own sign-ins. */
const otherProvidersIsolated = [
    "[providers.bedrock]",
    "credential_isolation = true",
    "[providers.claude]",
    "credential_isolation = true",
    "[providers.codex]",
    "credential_isolation = true",
    "[providers.grok]",
    "credential_isolation = true",
];

function withoutAmbientKeys(): void {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("MOONSHOT_API_KEY", "");
    vi.stubEnv("KIMI_API_KEY", "");
}

describe("DeepSeek and Kimi providers", () => {
    it("are built in, disabled, and report missing credentials on a machine without keys", async () => {
        withoutAmbientKeys();
        const config = await testConfigRootedAt(await root(), otherProvidersIsolated.join("\n"));

        expect(config.providerIds).toEqual(expect.arrayContaining(["deepseek", "kimi"]));
        expect(config.configuration.values.providers.deepseek).toEqual({
            enabled: false,
            type: "deepseek",
        });
        expect(config.configuration.values.providers.kimi).toEqual({
            enabled: false,
            type: "kimi",
        });
        await expect(config.probeLocalProviderCredentials("deepseek")).resolves.toBe("missing");
        await expect(config.probeLocalProviderCredentials("kimi")).resolves.toBe("missing");

        const scan = await new ProviderScanModule(config).open(createRootContext());
        for (const providerId of ["deepseek", "kimi"]) {
            expect(scan.providers).toContainEqual({
                credentials: "missing",
                enabled: false,
                enablement: "default",
                providerId,
                remembered: false,
            });
        }
        expect(config.models.some((model) => model.providerId === "deepseek")).toBe(false);
        expect(
            config.catalog
                .filter((model) => model.providerId === "deepseek")
                .map((model) => [model.id, model.enabled]),
        ).toEqual([
            ["deepseek/deepseek-flash", false],
            ["deepseek/deepseek-v4-pro", false],
        ]);
    });

    it("enable themselves from the vendor environment variables", async () => {
        withoutAmbientKeys();
        vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek-env");
        vi.stubEnv("KIMI_API_KEY", "sk-kimi-env");
        const config = await testConfigRootedAt(await root(), otherProvidersIsolated.join("\n"));

        const scan = await new ProviderScanModule(config).open(createRootContext());
        for (const providerId of ["deepseek", "kimi"]) {
            expect(scan.providers).toContainEqual({
                credentials: "available",
                enabled: true,
                enablement: "scan",
                providerId,
                remembered: true,
            });
        }

        const deepseek = await config.providers.resolve("deepseek", "deepseek/deepseek-v4-pro");
        expect(deepseek).toBeInstanceOf(DeepSeekProvider);
        expect((deepseek as DeepSeekProvider).credential.credential.apiKey).toBe("sk-deepseek-env");
        expect((deepseek as DeepSeekProvider).baseUrl).toBe("https://api.deepseek.com");

        const kimi = await config.providers.resolve("kimi", "moonshot/kimi-k2-thinking");
        expect(kimi).toBeInstanceOf(KimiProvider);
        expect((kimi as KimiProvider).credential.credential.apiKey).toBe("sk-kimi-env");
        expect((kimi as KimiProvider).baseUrl).toBe("https://api.moonshot.cn/v1");

        expect(
            config.models
                .filter((model) => model.providerId === "kimi")
                .map(({ id, name, effortLevels, defaultEffort }) => ({
                    id,
                    name,
                    effortLevels,
                    defaultEffort,
                })),
        ).toEqual([
            {
                id: "moonshot/kimi-k2-turbo-preview",
                name: "Kimi K2 Turbo",
                effortLevels: ["off"],
                defaultEffort: "off",
            },
            {
                id: "moonshot/kimi-k2-0905-preview",
                name: "Kimi K2",
                effortLevels: ["off"],
                defaultEffort: "off",
            },
            {
                id: "moonshot/kimi-k2-thinking",
                name: "Kimi K2 Thinking",
                effortLevels: ["high"],
                defaultEffort: "high",
            },
        ]);
        expect(config.modelContext("deepseek", "deepseek/deepseek-flash")).toEqual({
            contextWindow: 1_000_000,
            autoCompactWindow: 400_000,
        });
        expect(
            config.models
                .filter((model) => model.providerId === "deepseek")
                .map(({ id, effortLevels, defaultEffort }) => ({
                    id,
                    effortLevels,
                    defaultEffort,
                })),
        ).toEqual([
            {
                id: "deepseek/deepseek-flash",
                effortLevels: ["off", "low", "high", "max"],
                defaultEffort: "high",
            },
            {
                id: "deepseek/deepseek-v4-pro",
                effortLevels: ["off", "low", "high", "max"],
                defaultEffort: "high",
            },
        ]);
        expect(config.modelContext("kimi", "moonshot/kimi-k2-thinking")).toEqual({
            contextWindow: 262_144,
            autoCompactWindow: 230_000,
        });
    });

    it("prefers a configured key and base URL and honors credential isolation", async () => {
        withoutAmbientKeys();
        vi.stubEnv("DEEPSEEK_API_KEY", "sk-ambient");
        vi.stubEnv("MOONSHOT_API_KEY", "sk-ambient");
        const config = await testConfigRootedAt(
            await root(),
            [
                ...otherProvidersIsolated,
                "[providers.deepseek]",
                "enabled = true",
                'api_key = "sk-configured"',
                'base_url = "https://gateway.example.test/deepseek"',
                "[providers.kimi]",
                "enabled = true",
                "credential_isolation = true",
                "[providers.kimi-work]",
                'type = "kimi"',
                "enabled = true",
                "credential_isolation = true",
                'api_key = "sk-work"',
            ].join("\n"),
        );

        const deepseek = (await config.providers.resolve(
            "deepseek",
            "deepseek/deepseek-flash",
        )) as DeepSeekProvider;
        expect(deepseek.credential.credential.apiKey).toBe("sk-configured");
        expect(deepseek.baseUrl).toBe("https://gateway.example.test/deepseek");

        // An isolated account never borrows the machine's environment variable.
        await expect(config.probeLocalProviderCredentials("kimi")).resolves.toBe("missing");
        await expect(config.providers.resolve("kimi", "moonshot/kimi-k2-thinking")).rejects.toThrow(
            'Kimi authentication is unavailable for provider "kimi".',
        );
        const work = (await config.providers.resolve(
            "kimi-work",
            "moonshot/kimi-k2-thinking",
        )) as KimiProvider;
        expect(work).toBeInstanceOf(KimiProvider);
        expect(work.credential.credential.apiKey).toBe("sk-work");
        expect(
            config.catalog.filter((model) => model.providerId === "kimi-work").map((m) => m.id),
        ).toEqual([
            "moonshot/kimi-k2-turbo-preview",
            "moonshot/kimi-k2-0905-preview",
            "moonshot/kimi-k2-thinking",
        ]);
    });

    it("rejects a built-in ID with another type and unknown fields", () => {
        expect(() => parseKissopenAgentConfigToml('[providers.deepseek]\ntype = "kimi"\n')).toThrow(
            'Built-in provider "deepseek" must use type "deepseek".',
        );
        expect(() =>
            parseKissopenAgentConfigToml('[providers.custom]\ntype = "moonshot"\n'),
        ).toThrow('Provider "custom" must set type to');
        const parsed = parseKissopenAgentConfigToml(
            '[providers.kimi]\napi_key = "sk"\nauth_file = "/tmp/auth.json"\n',
        );
        expect(parsed.values.providers?.kimi).toEqual({ api_key: "sk" });
        expect(parsed.unknownSettings).toContain("providers.kimi.auth_file");
    });
});
