import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A replay can reuse only the directory carrying this creation's ownership marker. */
export async function createEmptyProjectDirectory(path: string, projectId: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const marker = join(path, ".kissopen-project-owner");
    try {
        await mkdir(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const directory = await lstat(path);
        const owner = await lstat(marker).catch(() => undefined);
        if (
            !directory.isDirectory() ||
            !owner?.isFile() ||
            (await readFile(marker, "utf8")) !== projectId
        ) {
            throw new Error("The project destination is already occupied. No files were changed.");
        }
        return;
    }
    // A crash before this exclusive marker is written fails closed on replay.
    await writeFile(marker, projectId, { flag: "wx", mode: 0o600 });
}
