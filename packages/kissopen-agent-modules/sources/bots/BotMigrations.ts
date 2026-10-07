import { agentDatabaseRun, type AgentDatabase } from "@kissopen/kissopen-agent-base";
import { sql } from "drizzle-orm";
import type { Context } from "@steve.kite/stdlib";

export const BOTS_TABLE = "kissopen_agent_module_bots";
export const BOT_AVATARS_TABLE = "kissopen_agent_module_bot_avatars";
export const BOT_SYSTEM_SEEDS_TABLE = "kissopen_agent_module_bot_system_seeds";
export const BOT_FILE_REVISIONS_TABLE = "kissopen_agent_module_bot_file_revisions";

export const botMigrations = [
    [
        "001-bots-catalog",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOTS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    username TEXT NOT NULL UNIQUE,
                    workspace_id TEXT NOT NULL UNIQUE,
                    workspace_version INTEGER NOT NULL,
                    workspace_updated_at BIGINT NOT NULL,
                    agent_id TEXT NOT NULL UNIQUE,
                    path TEXT NOT NULL UNIQUE,
                    status TEXT NOT NULL,
                    avatar_source TEXT,
                    avatar_thumbhash TEXT,
                    order_key TEXT NOT NULL,
                    version INTEGER NOT NULL,
                    created_at BIGINT NOT NULL,
                    updated_at BIGINT NOT NULL,
                    archived_at BIGINT
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${BOTS_TABLE}_order`)}
                    ON ${sql.raw(BOTS_TABLE)} (order_key, id)`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_AVATARS_TABLE)} (
                    bot_id TEXT PRIMARY KEY,
                    image_bytes BLOB NOT NULL,
                    content_type TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    thumbhash TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                )`,
            );
        },
    ],
    [
        "002-bot-avatars-are-webp",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            // Every bot picture is now re-encoded to WebP on the way in, so the stored format is
            // no longer a property of the row. Pictures kept in their original format cannot be
            // served as WebP, so they go, and the bots that had them go back to having none.
            await agentDatabaseRun(database, sql`DROP TABLE ${sql.raw(BOT_AVATARS_TABLE)}`);
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_AVATARS_TABLE)} (
                    bot_id TEXT PRIMARY KEY,
                    image_bytes BLOB NOT NULL,
                    content_hash TEXT NOT NULL,
                    thumbhash TEXT NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`UPDATE ${sql.raw(BOTS_TABLE)}
                    SET avatar_source = NULL, avatar_thumbhash = NULL`,
            );
        },
    ],
    [
        "003-bot-admin",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(BOTS_TABLE)}
                    ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`,
            );
        },
    ],
    [
        "004-system-bots",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(BOTS_TABLE)} ADD COLUMN system_key TEXT`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE UNIQUE INDEX ${sql.raw(`${BOTS_TABLE}_system_key`)}
                    ON ${sql.raw(BOTS_TABLE)} (system_key)
                    WHERE system_key IS NOT NULL`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_SYSTEM_SEEDS_TABLE)} (
                    system_key TEXT PRIMARY KEY,
                    bot_id TEXT NOT NULL UNIQUE
                )`,
            );
        },
    ],
    [
        "005-bot-name-configuration",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            await agentDatabaseRun(
                database,
                sql`ALTER TABLE ${sql.raw(BOTS_TABLE)}
                    ADD COLUMN name_configured INTEGER NOT NULL DEFAULT 1`,
            );
        },
    ],
    [
        "006-bot-assistant-settings",
        async (_ctx: Context, database: AgentDatabase): Promise<void> => {
            // What the bot is for, how it answers, the model it defaults to, and what it knows
            // about its person. Existing bots start with none of them, which is how they behaved.
            for (const column of [
                sql`description TEXT NOT NULL DEFAULT ''`,
                sql`style TEXT`,
                sql`model_provider_id TEXT`,
                sql`model_id TEXT`,
                sql`model_effort TEXT`,
                sql`user_name TEXT NOT NULL DEFAULT ''`,
                sql`user_language TEXT NOT NULL DEFAULT ''`,
                sql`user_note TEXT NOT NULL DEFAULT ''`,
                sql`user_background TEXT NOT NULL DEFAULT ''`,
            ]) {
                await agentDatabaseRun(
                    database,
                    sql`ALTER TABLE ${sql.raw(BOTS_TABLE)} ADD COLUMN ${column}`,
                );
            }
            // The recorded history of each core file, newest kept, pruned per file.
            await agentDatabaseRun(
                database,
                sql`CREATE TABLE ${sql.raw(BOT_FILE_REVISIONS_TABLE)} (
                    id TEXT PRIMARY KEY,
                    bot_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    sha256 TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    source TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at BIGINT NOT NULL
                )`,
            );
            await agentDatabaseRun(
                database,
                sql`CREATE INDEX ${sql.raw(`${BOT_FILE_REVISIONS_TABLE}_file`)}
                    ON ${sql.raw(BOT_FILE_REVISIONS_TABLE)} (bot_id, name, created_at)`,
            );
        },
    ],
] as const;
