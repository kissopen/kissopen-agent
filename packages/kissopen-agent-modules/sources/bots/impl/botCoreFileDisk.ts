import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { BotCoreFileName } from "@kissopen/kissopen-agent-client";

/** A core file as it is on disk right now. */
export interface BotCoreFileOnDisk {
    readonly content: string;
    readonly sha256: string;
    readonly size: number;
    readonly updatedAt: number;
}

export function botCoreFileSha256(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

/** Reads one core file from the root of the bot's folder; undefined when it is not there. */
export async function readBotCoreFile(
    folder: string,
    name: BotCoreFileName,
): Promise<BotCoreFileOnDisk | undefined> {
    const path = join(folder, name);
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "EISDIR") return undefined;
        throw error;
    });
    if (bytes === undefined) return undefined;
    const info = await stat(path);
    return {
        content: bytes.toString("utf8"),
        sha256: botCoreFileSha256(bytes),
        size: bytes.byteLength,
        updatedAt: Math.trunc(info.mtimeMs),
    };
}

/**
 * Replaces one core file atomically: the new text is written beside it and renamed over it, so a
 * reader — the bot at the start of a turn — sees the old file or the new one, never half of one.
 */
export async function writeBotCoreFile(
    folder: string,
    name: BotCoreFileName,
    content: string,
): Promise<BotCoreFileOnDisk> {
    const path = join(folder, name);
    const staging = join(folder, `.${name}.${randomUUID()}.tmp`);
    try {
        await writeFile(staging, content, { encoding: "utf8", mode: 0o644 });
        await rename(staging, path);
    } catch (error) {
        await rm(staging, { force: true });
        throw error;
    }
    const written = await readBotCoreFile(folder, name);
    if (written === undefined) throw new Error("The core file disappeared after it was written.");
    return written;
}
