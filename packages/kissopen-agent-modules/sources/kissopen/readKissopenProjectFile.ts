import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/*
The two files a project keeps about itself, which other devices draw its board
from. Only these, and only from a project folder's own `.kissopen`: this is read
through the machine's connection, which is there when no conversation in the
project is, and it must not become a way to read anything else on the machine.
*/
const projectFileRequestSchema = Type.Object({
    directory: Type.String({ minLength: 1 }),
    name: Type.Union([Type.Literal("board.json"), Type.Literal("project.json")]),
});
const PROJECT_FILE_MAX_BYTES = 1024 * 1024;

export type KissopenProjectFileAnswer =
    | { readonly success: true; readonly content: string; readonly size: number }
    | { readonly success: false; readonly error: string };

/** Reads `<directory>/.kissopen/<name>`, for a device drawing that project's board. */
export async function readKissopenProjectFile(params: unknown): Promise<KissopenProjectFileAnswer> {
    if (!Value.Check(projectFileRequestSchema, params))
        return {
            success: false,
            error: "Only a project's board and project.json can be read this way.",
        };
    const { directory, name } = params;
    if (!isAbsolute(directory) || directory.split(/[\\/]/).includes(".."))
        return { success: false, error: "The project folder must be an absolute path." };
    try {
        const folder = await realpath(directory);
        const file = await realpath(join(folder, ".kissopen", name));
        // A link out of the project's own folder is not the project's file.
        if (!file.startsWith(folder + sep))
            return { success: false, error: "The requested path was not found." };
        const info = await stat(file);
        if (!info.isFile()) return { success: false, error: "The requested path was not found." };
        if (info.size > PROJECT_FILE_MAX_BYTES)
            return { success: false, error: "The file is too large." };
        const bytes = await readFile(file);
        return { success: true, content: bytes.toString("base64"), size: bytes.byteLength };
    } catch {
        return { success: false, error: "The requested path was not found." };
    }
}
