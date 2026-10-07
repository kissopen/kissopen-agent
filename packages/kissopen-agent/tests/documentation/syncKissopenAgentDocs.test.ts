import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { syncKissopenAgentDocs } from "../../sources/documentation/syncKissopenAgentDocs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map(async (path) => await rm(path, { force: true, recursive: true })),
    );
});

async function temporaryDirectory(name: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), name));
    temporaryDirectories.push(directory);
    return directory;
}

describe("syncKissopenAgentDocs", () => {
    it("extracts the packaged documentation into the KISSOPEN home", async () => {
        const root = await temporaryDirectory("kissopen-agent-docs-");
        const source = join(root, "packaged-docs");
        const kissopenHome = join(root, ".kissopen");
        await mkdir(join(source, "guides"), { recursive: true });
        await writeFile(join(source, "README.md"), "# KISSOPEN Agent\n", "utf8");
        await writeFile(join(source, "guides", "workspaces.md"), "# Workspaces\n", "utf8");

        await syncKissopenAgentDocs(kissopenHome, source);

        await expect(readFile(join(kissopenHome, "docs", "README.md"), "utf8")).resolves.toBe(
            "# KISSOPEN Agent\n",
        );
        await expect(
            readFile(join(kissopenHome, "docs", "guides", "workspaces.md"), "utf8"),
        ).resolves.toBe("# Workspaces\n");
        expect((await lstat(join(kissopenHome, "docs", "README.md"))).mode & 0o222).toBe(0);
    });

    it("replaces read-only documentation on repeated startup", async () => {
        const root = await temporaryDirectory("kissopen-agent-docs-restart-");
        const source = join(root, "packaged-docs");
        const kissopenHome = join(root, ".kissopen");
        await mkdir(source, { recursive: true });
        await writeFile(join(source, "README.md"), "first release\n");
        await syncKissopenAgentDocs(kissopenHome, source);
        await writeFile(join(source, "README.md"), "second release\n");
        await syncKissopenAgentDocs(kissopenHome, source);
        await syncKissopenAgentDocs(kissopenHome, source);
        await expect(readFile(join(kissopenHome, "docs", "README.md"), "utf8")).resolves.toBe(
            "second release\n",
        );
        expect((await lstat(join(kissopenHome, "docs", "README.md"))).mode & 0o222).toBe(0);
    });

    it("restores shipped files to their current contents on every startup", async () => {
        const root = await temporaryDirectory("kissopen-agent-docs-update-");
        const source = join(root, "packaged-docs");
        const kissopenHome = join(root, ".kissopen");
        await mkdir(source, { recursive: true });
        await writeFile(join(source, "README.md"), "first release\n", "utf8");
        await syncKissopenAgentDocs(kissopenHome, source);

        await chmod(join(kissopenHome, "docs", "README.md"), 0o600);
        await writeFile(join(kissopenHome, "docs", "README.md"), "locally changed\n", "utf8");
        await writeFile(join(source, "README.md"), "second release\n", "utf8");

        await syncKissopenAgentDocs(kissopenHome, source);

        await expect(readFile(join(kissopenHome, "docs", "README.md"), "utf8")).resolves.toBe(
            "second release\n",
        );
        expect((await lstat(join(kissopenHome, "docs", "README.md"))).mode & 0o222).toBe(0);
    });

    it("does not follow a symlink placed at the managed documentation directory", async () => {
        const root = await temporaryDirectory("kissopen-agent-docs-symlink-");
        const source = join(root, "packaged-docs");
        const kissopenHome = join(root, ".kissopen");
        const outside = join(root, "outside");
        await mkdir(source, { recursive: true });
        await mkdir(kissopenHome, { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(source, "README.md"), "shipped\n", "utf8");
        await import("node:fs/promises").then(
            async ({ symlink }) =>
                await symlink(
                    outside,
                    join(kissopenHome, "docs"),
                    process.platform === "win32" ? "junction" : "dir",
                ),
        );

        await expect(syncKissopenAgentDocs(kissopenHome, source)).rejects.toThrow(
            "documentation directory is unsafe",
        );
        await expect(readFile(join(outside, "README.md"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("does not follow a symlink nested inside the managed documentation directory", async () => {
        const root = await temporaryDirectory("kissopen-agent-docs-nested-symlink-");
        const source = join(root, "packaged-docs");
        const kissopenHome = join(root, ".kissopen");
        const outside = join(root, "outside");
        await mkdir(join(source, "guides"), { recursive: true });
        await mkdir(join(kissopenHome, "docs"), { recursive: true });
        await mkdir(outside, { recursive: true });
        await writeFile(join(source, "guides", "workspaces.md"), "shipped\n", "utf8");
        await import("node:fs/promises").then(
            async ({ symlink }) =>
                await symlink(
                    outside,
                    join(kissopenHome, "docs", "guides"),
                    process.platform === "win32" ? "junction" : "dir",
                ),
        );

        await expect(syncKissopenAgentDocs(kissopenHome, source)).rejects.toThrow(
            "documentation directory is unsafe",
        );
        await expect(readFile(join(outside, "workspaces.md"), "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});
