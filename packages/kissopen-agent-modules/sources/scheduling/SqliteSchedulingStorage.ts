import {
    agentDatabaseRows,
    agentDatabaseRun,
    type AgentDatabase,
    type AgentModuleMigration,
} from "@kissopen/kissopen-agent-base";
import { sql } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { schedulingWaitRecordSchema, type SchedulingWaitRecord } from "./Scheduling.js";
import { type SchedulingStore } from "./SchedulingStore.js";

/** Tables owned by SchedulingModule. Keys are intentionally append-only module migrations. */
export const schedulingMigrations: readonly AgentModuleMigration[] = [
    [
        "001-scheduling",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS kissopen_scheduling_waits (
                    id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL,
                    record_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS kissopen_scheduling_waits_agent
                    ON kissopen_scheduling_waits(agent_id, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS kissopen_scheduling_schedules (
                    id TEXT PRIMARY KEY,
                    sender_agent_id TEXT NOT NULL,
                    target_agent_id TEXT NOT NULL,
                    due_at BIGINT NOT NULL,
                    status TEXT NOT NULL,
                    schedule_json TEXT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS kissopen_scheduling_schedules_sender
                    ON kissopen_scheduling_schedules(sender_agent_id, due_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS kissopen_scheduling_schedules_target
                    ON kissopen_scheduling_schedules(target_agent_id, due_at, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS kissopen_scheduling_receipts (
                    acting_agent_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    receipt_json TEXT NOT NULL,
                    PRIMARY KEY (acting_agent_id, kind, operation_id)
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE IF NOT EXISTS kissopen_scheduling_proofs (
                    acting_agent_id TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    operation_id TEXT NOT NULL,
                    proof_json TEXT NOT NULL,
                    PRIMARY KEY (acting_agent_id, kind, operation_id)
                )`,
            );
        },
    ],
    [
        "002-remove-scheduling-idempotency",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS kissopen_scheduling_receipts`,
            );
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS kissopen_scheduling_proofs`);
        },
    ],
    [
        "003-remove-scheduling-operation-state",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS kissopen_scheduling_receipts`,
            );
            await agentDatabaseRun(database, sql`DROP TABLE IF EXISTS kissopen_scheduling_proofs`);
        },
    ],
    [
        // Recovery reads the pending messages of every agent in due order, which the per-sender and
        // per-target indexes cannot serve.
        "004-scheduling-due-index",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX IF NOT EXISTS kissopen_scheduling_schedules_due
                    ON kissopen_scheduling_schedules(status, due_at, id)`,
            );
        },
    ],
    [
        /*
         * Scheduled messages are gone. Anything that should happen later is a Scheduled task,
         * held by the business server where the person can see and cancel it; a message an agent
         * booked for itself was neither, and was mostly used to rebook itself every day. The
         * rows go with the table, so a message still pending is never delivered.
         */
        "005-remove-scheduled-messages",
        async (_ctx, database) => {
            await agentDatabaseRun(
                database,
                sql`DROP TABLE IF EXISTS kissopen_scheduling_schedules`,
            );
        },
    ],
];

export function createSqliteSchedulingStorage<
    Database extends AgentDatabase = AgentDatabase,
>(): SchedulingStore {
    const dbFor = (ctx: Context): Database => ctx.db as Database;
    const readWait = async (
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> => {
        const rows = await agentDatabaseRows<WaitRow>(
            dbFor(ctx),
            sql`SELECT record_json FROM kissopen_scheduling_waits
                WHERE id = ${id} AND agent_id = ${agentId} LIMIT 1`,
        );
        if (rows[0] === undefined) return undefined;
        const wait = parse(rows[0].record_json, "wait");
        if (!Value.Check(schedulingWaitRecordSchema, wait)) {
            throw new Error("Scheduling database returned an invalid durable wait.");
        }
        return wait as SchedulingWaitRecord;
    };
    const writeWait = async (ctx: Context, wait: SchedulingWaitRecord): Promise<void> => {
        await agentDatabaseRun(
            dbFor(ctx),
            sql`INSERT INTO kissopen_scheduling_waits (id, agent_id, record_json)
                VALUES (${wait.id}, ${wait.agentId}, ${JSON.stringify(wait)})
                ON CONFLICT(id) DO UPDATE SET
                    agent_id = excluded.agent_id,
                    record_json = excluded.record_json`,
        );
    };
    return { readWait, writeWait };
}

interface WaitRow {
    readonly record_json: string;
}

function parse(value: unknown, label: string): unknown {
    if (typeof value !== "string") throw new Error(`Scheduling ${label} is not JSON text.`);
    try {
        return JSON.parse(value) as unknown;
    } catch {
        throw new Error(`Scheduling ${label} contains invalid JSON.`);
    }
}
