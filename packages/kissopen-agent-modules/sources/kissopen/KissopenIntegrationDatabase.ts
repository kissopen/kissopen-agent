import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentModuleMigration,
} from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { createKissopenIntegrationVersion } from "./createKissopenIntegrationVersion.js";
import { personalIntegrationMigration } from "./persistence/personalConnectionMigrations.js";

/** The immutable migration that gives Kissopen integration state a durable singleton. */
export const KISSOPEN_INTEGRATION_MIGRATION_KEY = "002-kissopen-integration-state";

const KISSOPEN_INTEGRATION_STATE_TABLE = "kissopen_agent_kissopen_integration_state";
const MAX_BLOCKED_CREDENTIAL_FINGERPRINTS = 32;
const UUID_V7_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

const exact = { additionalProperties: false } as const;

const credentialFingerprintSchema = Type.String({ maxLength: 128, minLength: 1 });

/** The one durable high-water mark and the credentials this daemon must not revive. */
export const kissopenIntegrationStateSchema = Type.Object(
    {
        blockedCredentialFingerprints: Type.Array(credentialFingerprintSchema, {
            maxItems: MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
        }),
        version: Type.Optional(Type.String({ pattern: UUID_V7_PATTERN })),
    },
    exact,
);
export type KissopenIntegrationState = Static<typeof kissopenIntegrationStateSchema>;

const kissopenIntegrationStateRowSchema = Type.Object(
    { state_json: Type.String({ minLength: 1 }) },
    exact,
);

/** Maximum remembered credential identities that Kissopen rejected for this daemon. */
export { MAX_BLOCKED_CREDENTIAL_FINGERPRINTS };

/** The Kissopen integration migration, appended after `kissopenSyncMigrations` by its owner. */
export const kissopenIntegrationMigrations: readonly AgentModuleMigration[] = [
    [
        KISSOPEN_INTEGRATION_MIGRATION_KEY,
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS ${sql.raw(KISSOPEN_INTEGRATION_STATE_TABLE)} (
                    singleton_id INTEGER PRIMARY KEY,
                    state_json TEXT NOT NULL
                )`,
            );
        },
    ],
    personalIntegrationMigration,
];

/**
 * Durable state owned by Kissopen integration itself.
 *
 * Every mutation composes with a caller transaction. The version is reserved before an
 * integration snapshot publishes, so it remains strictly newer over restart and clock rollback.
 */
export function createKissopenIntegrationDatabase(ownerId = "") {
    async function read(ctx: Context): Promise<KissopenIntegrationState> {
        const rows = await agentDatabaseRows<unknown>(
            ctx.db,
            sql`SELECT state_json FROM ${sql.raw(KISSOPEN_INTEGRATION_STATE_TABLE)}
                WHERE owner_id = ${ownerId}`,
        );
        const row = rows[0];
        if (row === undefined) return { blockedCredentialFingerprints: [] };
        if (!Value.Check(kissopenIntegrationStateRowSchema, row)) {
            throw new Error(
                "The WorPar integration state table contains a row WorPar Agent cannot read.",
            );
        }
        return parseState(row.state_json);
    }

    return {
        read,

        /** Reserves and durably records the next integration snapshot version. */
        async reserveVersion(ctx: Context, now: () => number): Promise<string> {
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                const version = createKissopenIntegrationVersion(current.version, now);
                await write(txCtx, ownerId, {
                    blockedCredentialFingerprints: current.blockedCredentialFingerprints,
                    version,
                });
                return version;
            });
        },

        /** Remembers rejected credential identities without letting the list grow unbounded. */
        async addBlockedCredentialFingerprints(
            ctx: Context,
            fingerprints: readonly string[],
        ): Promise<KissopenIntegrationState> {
            if (
                !Value.Check(
                    Type.Array(credentialFingerprintSchema, {
                        maxItems: MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
                    }),
                    fingerprints,
                )
            ) {
                throw new Error("The blocked WorPar credential fingerprints are invalid.");
            }
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                const nextFingerprints = [...current.blockedCredentialFingerprints];
                for (const fingerprint of fingerprints) {
                    if (!nextFingerprints.includes(fingerprint)) nextFingerprints.push(fingerprint);
                }
                const boundedFingerprints = nextFingerprints.slice(
                    -MAX_BLOCKED_CREDENTIAL_FINGERPRINTS,
                );
                if (
                    boundedFingerprints.length === current.blockedCredentialFingerprints.length &&
                    boundedFingerprints.every(
                        (fingerprint, index) =>
                            fingerprint === current.blockedCredentialFingerprints[index],
                    )
                ) {
                    return current;
                }
                const next: KissopenIntegrationState = {
                    blockedCredentialFingerprints: boundedFingerprints,
                    ...(current.version === undefined ? {} : { version: current.version }),
                };
                await write(txCtx, ownerId, next);
                return next;
            });
        },

        /** Forgets rejected credentials after a successful credential replacement. */
        async clearBlockedCredentialFingerprints(ctx: Context): Promise<KissopenIntegrationState> {
            return await ctx.inTx(async (txCtx) => {
                const current = await read(txCtx);
                if (current.blockedCredentialFingerprints.length === 0) {
                    return current;
                }
                const next: KissopenIntegrationState = {
                    blockedCredentialFingerprints: [],
                    ...(current.version === undefined ? {} : { version: current.version }),
                };
                await write(txCtx, ownerId, next);
                return next;
            });
        },
    };
}

export type KissopenIntegrationDatabase = ReturnType<typeof createKissopenIntegrationDatabase>;

async function write(
    ctx: Context,
    ownerId: string,
    state: KissopenIntegrationState,
): Promise<void> {
    if (!Value.Check(kissopenIntegrationStateSchema, state)) {
        throw new Error("The WorPar integration state is invalid.");
    }
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(KISSOPEN_INTEGRATION_STATE_TABLE)} (owner_id, state_json)
            VALUES (${ownerId}, ${JSON.stringify(state)})
            ON CONFLICT (owner_id)
            DO UPDATE SET state_json = EXCLUDED.state_json`,
    );
}

function parseState(value: string): KissopenIntegrationState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error("WorPar Agent could not read the stored WorPar integration state.");
    }
    if (!Value.Check(kissopenIntegrationStateSchema, parsed)) {
        throw new Error("The stored WorPar integration state is invalid.");
    }
    return structuredClone(parsed) as KissopenIntegrationState;
}
