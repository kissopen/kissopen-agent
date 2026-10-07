import { agentDatabaseRun } from "@kissopen/kissopen-agent-base";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
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
import { moduleDatabase } from "../support/moduleDatabase.js";

it("preserves existing standalone credentials metadata, session cursors, queued messages and project bindings without assigning them to a user", async () => {
    const db = moduleDatabase(
        [kissopenSyncMigrations[0]!, kissopenIntegrationMigrations[0]!, kissopenProjectSyncMigrations[0]!],
        "personal-migration",
    );
    await db.ready;
    try {
        const key = Buffer.alloc(32).toString("base64");
        const version = "01900000-0000-7000-8000-000000000001";
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO kissopen_agent_kissopen_sessions
            (agent_id, session_id, credential_fingerprint, tag, remote_session_id, encryption_variant, encryption_key_base64, last_remote_seq, history_backfilled, projected_event_id, created_at_ms, updated_at_ms)
            VALUES ('agent123', 'agent123', 'account', 'old-tag', 'remote123', 'legacy', ${key}, 7, 1, ${version}, 1, 2)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO kissopen_agent_kissopen_outbox (agent_id, position, local_id, payload_json, created_at_ms)
            VALUES ('agent123', 1, 'message123', '{"text":"still owed"}', 2)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO kissopen_agent_kissopen_projects
            (local_project_id, credential_fingerprint, remote_project_id, encryption_variant, encryption_key_base64, created_at_ms, updated_at_ms)
            VALUES ('project123', 'account', 'remote-project123', 'legacy', ${key}, 1, 2)`,
        );
        await agentDatabaseRun(
            db.database,
            sql`INSERT INTO kissopen_agent_kissopen_integration_state (singleton_id, state_json)
            VALUES (1, ${JSON.stringify({ blockedCredentialFingerprints: ["rejected"], version })})`,
        );
        for (const [, migrate] of [
            ...kissopenSyncMigrations.slice(1),
            ...kissopenIntegrationMigrations.slice(1),
            ...kissopenProjectSyncMigrations.slice(1),
        ]) {
            await db.context.inTx(async (ctx) => {
                await migrate(ctx, ctx.db);
            });
        }
        const standalone = createKissopenSyncDatabase();
        expect(await standalone.readSession(db.context, "agent123")).toMatchObject({
            remoteSessionId: "remote123",
            lastRemoteSeq: 7,
            projectedEventId: version,
            tag: "old-tag",
            historyBackfilled: true,
        });
        expect(await standalone.pending(db.context, "agent123", 10)).toMatchObject([
            { localId: "message123", payload: { text: "still owed" } },
        ]);
        expect(await createKissopenProjectSyncDatabase().read(db.context, "project123")).toMatchObject(
            { remoteProjectId: "remote-project123" },
        );
        expect(await createKissopenIntegrationDatabase().read(db.context)).toEqual({
            blockedCredentialFingerprints: ["rejected"],
            version,
        });
        expect(
            await createKissopenSyncDatabase("alice123").readSession(db.context, "agent123"),
        ).toBeUndefined();
        expect(
            await createKissopenProjectSyncDatabase("alice123").read(db.context, "project123"),
        ).toBeUndefined();
        expect(await createKissopenIntegrationDatabase("alice123").read(db.context)).toEqual({
            blockedCredentialFingerprints: [],
        });
    } finally {
        db.close();
    }
});
