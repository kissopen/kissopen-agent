import { afterEach, describe, expect, it } from "vitest";
import {
    createKissopenSyncDatabase,
    kissopenSyncMigrations,
} from "../../sources/kissopen/KissopenSyncDatabase.js";
import {
    createKissopenProjectSyncDatabase,
    kissopenProjectSyncMigrations,
} from "../../sources/kissopen/KissopenProjectSyncDatabase.js";
import {
    createKissopenIntegrationDatabase,
    kissopenIntegrationMigrations,
} from "../../sources/kissopen/KissopenIntegrationDatabase.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const databases: ModuleDatabase[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

describe("personal mobile persistence", () => {
    it("isolates the same agent, project, account and message IDs across owners and transactions", async () => {
        const db = moduleDatabase(
            [...kissopenSyncMigrations, ...kissopenProjectSyncMigrations, ...kissopenIntegrationMigrations],
            "personal-kissopen",
        );
        databases.push(db);
        await db.ready;
        const alice = createKissopenSyncDatabase("alice123");
        const bob = createKissopenSyncDatabase("bob456");
        const standalone = createKissopenSyncDatabase();
        const input = {
            agentId: "agent123",
            sessionId: "agent123",
            credentialFingerprint: "same-account",
            encryptionVariant: "legacy" as const,
            encryptionKeyBase64: Buffer.alloc(32).toString("base64"),
        };
        await db.context.inTx(async (ctx) => {
            await alice.ensureSession(ctx, input, 1);
            await bob.ensureSession(ctx, input, 1);
            await standalone.ensureSession(ctx, input, 1);
            await alice.setRemoteSession(ctx, input.agentId, "alice-remote", 2);
            await bob.setRemoteSession(ctx, input.agentId, "bob-remote", 2);
            await alice.enqueue(
                ctx,
                input.agentId,
                [{ localId: "shared-id", payload: { text: "Alice" } }],
                2,
            );
            await bob.enqueue(
                ctx,
                input.agentId,
                [{ localId: "shared-id", payload: { text: "Bob" } }],
                2,
            );
        });
        expect((await alice.readSession(db.context, input.agentId))?.remoteSessionId).toBe(
            "alice-remote",
        );
        expect((await bob.readSession(db.context, input.agentId))?.remoteSessionId).toBe(
            "bob-remote",
        );
        expect(
            (await standalone.readSession(db.context, input.agentId))?.remoteSessionId,
        ).toBeUndefined();
        expect((await alice.readSession(db.context, input.agentId))?.tag).not.toBe(
            (await bob.readSession(db.context, input.agentId))?.tag,
        );
        await alice.acknowledge(db.context, input.agentId, ["shared-id"], 3);
        expect(await bob.pending(db.context, input.agentId, 10)).toMatchObject([
            { payload: { text: "Bob" } },
        ]);
        await alice.removeSession(db.context, input.agentId);
        expect(await alice.listAgentIds(db.context, "same-account", 10)).toEqual([]);
        expect(await bob.listAgentIds(db.context, "same-account", 10)).toEqual([input.agentId]);
        const aliceProjects = createKissopenProjectSyncDatabase("alice123");
        const bobProjects = createKissopenProjectSyncDatabase("bob456");
        const project = {
            localProjectId: "project123",
            credentialFingerprint: "same-account",
            encryptionVariant: "legacy" as const,
            encryptionKeyBase64: input.encryptionKeyBase64,
        };
        await db.context.inTx(async (ctx) => {
            await aliceProjects.ensure(ctx, project, 1);
            await bobProjects.ensure(ctx, project, 1);
            await aliceProjects.setRemoteProject(ctx, project.localProjectId, "alice-project", 2);
            await bobProjects.setRemoteProject(ctx, project.localProjectId, "bob-project", 2);
        });
        expect(
            (await aliceProjects.read(db.context, project.localProjectId))?.remoteProjectId,
        ).toBe("alice-project");
        expect((await bobProjects.read(db.context, project.localProjectId))?.remoteProjectId).toBe(
            "bob-project",
        );
        const aliceState = createKissopenIntegrationDatabase("alice123");
        const bobState = createKissopenIntegrationDatabase("bob456");
        await aliceState.addBlockedCredentialFingerprints(db.context, ["alice-blocked"]);
        expect((await bobState.read(db.context)).blockedCredentialFingerprints).toEqual([]);
        const bobVersion = await bobState.reserveVersion(db.context, () => 1000);
        await expect(
            db.context.inTx(async (ctx) => {
                await bobState.addBlockedCredentialFingerprints(ctx, ["rolled-back"]);
                await bob.removeSession(ctx, input.agentId);
                throw new Error("rollback");
            }),
        ).rejects.toThrow("rollback");
        expect(await bob.readSession(db.context, input.agentId)).toBeDefined();
        expect(await bobState.read(db.context)).toEqual({
            blockedCredentialFingerprints: [],
            version: bobVersion,
        });
        expect(
            (await createKissopenIntegrationDatabase("bob456").reserveVersion(db.context, () => 999)) >
                bobVersion,
        ).toBe(true);
    });
});
