import { agentDatabaseRows, agentDatabaseRun } from "@kissopen/kissopen-agent-base";
import type { BotCoreFileName } from "@kissopen/kissopen-agent-client";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

import { BOT_FILE_REVISIONS_TABLE } from "./BotMigrations.js";

/** How many revisions of each core file are kept; older ones are pruned as new ones arrive. */
export const BOT_FILE_REVISIONS_KEPT = 50;

export type BotFileRevisionSource = "user" | "external";

export interface BotFileRevision {
    readonly id: string;
    readonly sha256: string;
    readonly size: number;
    readonly source: BotFileRevisionSource;
    readonly createdAt: number;
}

interface RevisionRow {
    readonly id: string;
    readonly sha256: string;
    readonly size: number | string;
    readonly source: string;
    readonly created_at: number | string;
    readonly content?: string;
}

function revisionFromRow(row: RevisionRow): BotFileRevision {
    return {
        id: row.id,
        sha256: row.sha256,
        size: Number(row.size),
        source: row.source === "user" ? "user" : "external",
        createdAt: Number(row.created_at),
    };
}

export async function readLatestBotFileRevision(
    ctx: Context,
    botId: string,
    name: BotCoreFileName,
): Promise<BotFileRevision | undefined> {
    const rows = await agentDatabaseRows<RevisionRow>(
        ctx.db,
        sql`SELECT id, sha256, size, source, created_at FROM ${sql.raw(BOT_FILE_REVISIONS_TABLE)}
            WHERE bot_id = ${botId} AND name = ${name}
            ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    return rows[0] === undefined ? undefined : revisionFromRow(rows[0]);
}

export async function readBotFileRevisions(
    ctx: Context,
    botId: string,
    name: BotCoreFileName,
): Promise<readonly BotFileRevision[]> {
    const rows = await agentDatabaseRows<RevisionRow>(
        ctx.db,
        sql`SELECT id, sha256, size, source, created_at FROM ${sql.raw(BOT_FILE_REVISIONS_TABLE)}
            WHERE bot_id = ${botId} AND name = ${name}
            ORDER BY created_at DESC, id DESC LIMIT ${BOT_FILE_REVISIONS_KEPT}`,
    );
    return rows.map(revisionFromRow);
}

export async function readBotFileRevision(
    ctx: Context,
    botId: string,
    name: BotCoreFileName,
    revisionId: string,
): Promise<(BotFileRevision & { readonly content: string }) | undefined> {
    const rows = await agentDatabaseRows<RevisionRow>(
        ctx.db,
        sql`SELECT id, sha256, size, source, created_at, content
            FROM ${sql.raw(BOT_FILE_REVISIONS_TABLE)}
            WHERE bot_id = ${botId} AND name = ${name} AND id = ${revisionId} LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return undefined;
    return { ...revisionFromRow(row), content: row.content ?? "" };
}

/** Records one revision and prunes the file's history down to the newest kept. */
export async function insertBotFileRevision(
    ctx: Context,
    botId: string,
    name: BotCoreFileName,
    revision: BotFileRevision & { readonly content: string },
): Promise<void> {
    await agentDatabaseRun(
        ctx.db,
        sql`INSERT INTO ${sql.raw(BOT_FILE_REVISIONS_TABLE)} (
            id, bot_id, name, sha256, size, source, content, created_at
        ) VALUES (
            ${revision.id}, ${botId}, ${name}, ${revision.sha256}, ${revision.size},
            ${revision.source}, ${revision.content}, ${revision.createdAt}
        )`,
    );
    await agentDatabaseRun(
        ctx.db,
        sql`DELETE FROM ${sql.raw(BOT_FILE_REVISIONS_TABLE)}
            WHERE bot_id = ${botId} AND name = ${name} AND id NOT IN (
                SELECT id FROM ${sql.raw(BOT_FILE_REVISIONS_TABLE)}
                WHERE bot_id = ${botId} AND name = ${name}
                ORDER BY created_at DESC, id DESC LIMIT ${BOT_FILE_REVISIONS_KEPT}
            )`,
    );
}
