import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CustomProviders } from "../../sources/config/impl/customProviders.js";

describe("custom model reasoning declarations", () => {
    it("advertises the selected efforts and distinguishes service defaults from off", async () => {
        const root = await mkdtemp(join(tmpdir(), "custom-reasoning-"));
        try {
            const providers = new CustomProviders(join(root, "custom.json"));
            await providers.save({
                mutationId: "reasoning-test",
                baseUrl: "https://example.test/v1",
                apiKey: "private-test-key",
                models: [
                    { id: "ordinary", name: "Ordinary" },
                    {
                        id: "explicit",
                        name: "Explicit",
                        reasoning: {
                            mode: "openai",
                            efforts: ["low", "high"],
                            defaultEffort: "low",
                        },
                    },
                ],
            });
            expect(providers.catalog()[0]).toMatchObject({
                customReasoning: null,
                effortLevels: ["off"],
            });
            expect(providers.catalog()[1]).toMatchObject({
                effortLevels: ["low", "high"],
                defaultEffort: "low",
                customReasoning: { mode: "openai" },
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
    it("updates existing models without losing keys, enablement or other selections and survives reload", async () => {
        const root = await mkdtemp(join(tmpdir(), "custom-reasoning-"));
        const path = join(root, "custom.json");
        try {
            const providers = new CustomProviders(path);
            const id = await providers.save({
                mutationId: "save",
                baseUrl: "https://example.test/v1",
                apiKey: "private-test-key",
                models: [
                    { id: "one", name: "One" },
                    { id: "two", name: "Two" },
                ],
            });
            await providers.setEnabled(id, false);
            const reasoning = {
                mode: "deepseek" as const,
                efforts: ["off", "high"] as ("off" | "high")[],
                defaultEffort: "high" as const,
            };
            await providers.setReasoning(id, {
                mutationId: "update",
                modelId: `${id}/one`,
                reasoning,
            });
            expect(JSON.parse(await readFile(path, "utf8"))[id]).toMatchObject({
                apiKey: "private-test-key",
                enabled: false,
                models: [{ id: "one", reasoning }, { id: "two" }],
            });
            expect((await stat(path)).mode & 0o777).toBe(0o600);
            const reopened = new CustomProviders(path);
            await reopened.load();
            expect(reopened.catalog()).toEqual(providers.catalog());
            await reopened.setReasoning(id, {
                mutationId: "reset",
                modelId: `${id}/one`,
                reasoning: null,
            });
            expect(reopened.catalog()[0]).toMatchObject({
                customReasoning: null,
                effortLevels: ["off"],
                defaultEffort: "off",
            });
            const before = await readFile(path, "utf8");
            await expect(
                reopened.setReasoning(id, {
                    mutationId: "invalid",
                    modelId: `${id}/one`,
                    reasoning: { mode: "openai", efforts: ["low"], defaultEffort: "high" },
                }),
            ).rejects.toThrow("Choose a default");
            await expect(
                reopened.setReasoning(id, {
                    mutationId: "missing",
                    modelId: `${id}/missing`,
                    reasoning: null,
                }),
            ).rejects.toThrow("no longer available");
            expect(await readFile(path, "utf8")).toBe(before);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
