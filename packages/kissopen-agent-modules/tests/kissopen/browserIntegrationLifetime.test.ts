import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentProviders } from "@kissopen/kissopen-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";
import { ConfigModule } from "../../sources/config/index.js";
import { KissopenConnection } from "../../sources/kissopen/KissopenConnection.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

it("keeps a fresh desktop lease and pending observation across an already-unlinked account sync", async () => {
    const home = await mkdtemp(join(tmpdir(), "browser-integration-lifetime-"));
    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider([]), "codex");
    const config = await ConfigModule.load(home, {
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
    });
    // An idempotent unlink must not touch any collaborator or database. Fail if it does.
    const unused = new Proxy(
        {},
        {
            get: () => {
                throw new Error("Already-unlinked account work is not a lifecycle transition.");
            },
        },
    );
    type Dependencies = ConstructorParameters<typeof KissopenConnection>;
    const integration = new KissopenConnection(
        config,
        unused as Dependencies[1],
        unused as Dependencies[2],
        unused as Dependencies[3],
        unused as Dependencies[4],
        unused as Dependencies[5],
        unused as Dependencies[6],
        unused as Dependencies[7],
        unused as Dependencies[8],
        unused as Dependencies[9],
        unused as Dependencies[10],
        unused as Dependencies[11],
    );
    const ctx = createRootContext();
    try {
        await integration.disconnectIntegration(ctx);
        const leaseId = "l".repeat(32);
        const tabId = "t".repeat(32);
        expect(
            await integration.browserControl(ctx, "agent", { action: "attach", leaseId, tabId }),
        ).toEqual({ ok: true, paused: false });
        const reading = integration.browserExecute(ctx, "agent", { action: "read" });
        await integration.disconnectIntegration(ctx);
        const poll = await integration.browserControl(ctx, "agent", { action: "poll", leaseId });
        expect(poll.ok).toBe(true);
        if (!poll.ok || !poll.command)
            throw new Error("The fresh browser observation was revoked.");
        const result = { ok: true, text: "Current visible page." };
        expect(
            await integration.browserControl(ctx, "agent", {
                action: "complete",
                leaseId,
                commandId: poll.command.id,
                result,
            }),
        ).toEqual({ ok: true, paused: false });
        expect(await reading).toEqual(result);
        expect(await integration.browserControl(ctx, "agent", { action: "poll", leaseId })).toEqual(
            { ok: true, paused: false },
        );
    } finally {
        await integration.stop();
        config.closeProviders();
        await rm(home, { recursive: true, force: true });
    }
});
