import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { detectKissopenAgentUpdate } from "../detectKissopenAgentUpdate.js";
import {
    ensureKissopenAgentBinary,
    upgradeKissopenAgentBinary,
} from "../ensureKissopenAgentBinary.js";
import { resolveLocalKissopenAgentSources } from "../ensureLocalProtocolServer.js";
import { getKissopenDaemonPaths, kissopenAgentBinaryPath } from "../getKissopenDaemonPaths.js";

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ensureKissopenAgentBinary", () => {
    it("installs the matching release and atomically selects it", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const statuses: string[] = [];

        const installed = await ensureKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive),
            onStatus: (status) => statuses.push(status),
            paths,
            platform: "darwin",
        });

        expect(installed).toEqual({
            path: kissopenAgentBinaryPath(paths, "1.2.3"),
            version: "1.2.3",
        });
        expect(JSON.parse(await readFile(paths.binaryConfigPath, "utf8"))).toEqual({
            downloadedVersions: ["1.2.3"],
            selectedVersion: "1.2.3",
        });
        if (process.platform !== "win32") {
            expect((await stat(installed.path)).mode & 0o777).toBe(0o700);
        }
        expect(await readdir(paths.versionsDirectory)).toEqual(["1.2.3"]);
        expect(statuses).toEqual([
            "Checking for the latest KISSOPEN Agent release.",
            "Downloading KISSOPEN Agent 1.2.3.",
        ]);
    });

    it("downloads Windows x64 from the KissOpen repository and installs the executable", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const fetch_ = releaseFetch(archive);
        const extract = vi.fn(fakeExtract);

        const installed = await ensureKissopenAgentBinary({
            arch: "x64",
            extractArchive: extract,
            fetch: fetch_,
            paths,
            platform: "win32",
        });

        expect(String(fetch_.mock.calls[0]?.[0])).toBe(
            "https://api.github.com/repos/kissopen/kissopen-agent/releases/latest",
        );
        expect(extract.mock.calls[0]?.[2]).toBe("kissopen-agent-win32-x64.exe");
        expect(await readFile(installed.path, "utf8")).toBe("#!/bin/sh\n");
        expect(JSON.parse(await readFile(paths.binaryConfigPath, "utf8")).selectedVersion).toBe(
            "1.2.3",
        );
    });

    it("starts from the selected downloaded version without checking GitHub", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const first = await ensureKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive),
            paths,
            platform: "darwin",
        });
        const fetch_ = vi.fn<typeof fetch>(() => {
            throw new Error("GitHub must not be queried for an installed selection.");
        });

        const second = await ensureKissopenAgentBinary({ fetch: fetch_, paths });

        expect(second).toEqual(first);
        expect(fetch_).not.toHaveBeenCalled();
    });

    it("serializes concurrent first-run downloads across launchers", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const fetch_ = releaseFetch(archive, 30);

        const [first, second] = await Promise.all([
            ensureKissopenAgentBinary({
                arch: "x64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "linux",
            }),
            ensureKissopenAgentBinary({
                arch: "x64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "linux",
            }),
        ]);

        expect(first).toEqual(second);
        expect(fetch_).toHaveBeenCalledTimes(2);
        expect(await readdir(paths.versionsDirectory)).toEqual(["1.2.3"]);
    });

    it("does not publish a version or config after a checksum failure", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("corrupt archive");
        const fetch_ = releaseFetch(archive, 0, "0".repeat(64));

        await expect(
            ensureKissopenAgentBinary({
                arch: "arm64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "linux",
            }),
        ).rejects.toThrow("checksum does not match");
        await expect(readFile(paths.binaryConfigPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
        expect(await readdir(paths.versionsDirectory)).toEqual([]);
        await expect(readFile(paths.installLockPath, "utf8")).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("downloads and selects a newer release without removing the previous version", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        await ensureKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive),
            paths,
            platform: "darwin",
        });

        const upgraded = await upgradeKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive, 0, undefined, "1.2.4"),
            paths,
            platform: "darwin",
        });

        expect(upgraded).toEqual({
            path: kissopenAgentBinaryPath(paths, "1.2.4"),
            version: "1.2.4",
        });
        expect(JSON.parse(await readFile(paths.binaryConfigPath, "utf8"))).toEqual({
            downloadedVersions: ["1.2.3", "1.2.4"],
            selectedVersion: "1.2.4",
        });
        expect(await readdir(paths.versionsDirectory)).toEqual(["1.2.3", "1.2.4"]);
    });

    it("never replaces a selected release with an older latest release", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        const installed = await upgradeKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive, 0, undefined, "2.0.0"),
            paths,
            platform: "darwin",
        });
        const fetch_ = releaseFetch(archive, 0, undefined, "1.9.0");

        await expect(
            upgradeKissopenAgentBinary({
                arch: "arm64",
                extractArchive: fakeExtract,
                fetch: fetch_,
                paths,
                platform: "darwin",
            }),
        ).resolves.toEqual(installed);
        expect(fetch_).toHaveBeenCalledOnce();
        expect(await readdir(paths.versionsDirectory)).toEqual(["2.0.0"]);
    });

    it("detects a newer release and reuses the bounded lookup cache", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        await ensureKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive),
            paths,
            platform: "darwin",
        });
        const fetch_ = releaseFetch(archive, 0, undefined, "1.2.4");

        await expect(
            detectKissopenAgentUpdate({
                currentVersion: "1.2.3",
                fetch: fetch_,
                now: 1_700_000_000_000,
                paths,
            }),
        ).resolves.toEqual({ currentVersion: "1.2.3", latestVersion: "1.2.4" });
        expect(fetch_).toHaveBeenCalledOnce();

        const cachedFetch = vi.fn<typeof fetch>(() => {
            throw new Error("A fresh update cache must not query GitHub.");
        });
        await expect(
            detectKissopenAgentUpdate({
                currentVersion: "1.2.3",
                fetch: cachedFetch,
                now: 1_700_000_000_001,
                paths,
            }),
        ).resolves.toEqual({ currentVersion: "1.2.3", latestVersion: "1.2.4" });
        expect(cachedFetch).not.toHaveBeenCalled();
    });

    it("does not check releases for a daemon outside the selected managed binary", async () => {
        const paths = await temporaryPaths();
        const fetch_ = vi.fn<typeof fetch>();

        await expect(
            detectKissopenAgentUpdate({ currentVersion: "development", fetch: fetch_, paths }),
        ).resolves.toBeUndefined();
        expect(fetch_).not.toHaveBeenCalled();
    });

    it("offers a published release as the way off a locally linked KISSOPEN Agent", async () => {
        const paths = await temporaryPaths();
        const archive = Buffer.from("release archive");
        await upgradeKissopenAgentBinary({
            arch: "arm64",
            extractArchive: fakeExtract,
            fetch: releaseFetch(archive, 0, undefined, "0.0.0"),
            paths,
            platform: "darwin",
        });
        const fetch_ = releaseFetch(archive, 0, undefined, "1.2.3");

        await expect(
            detectKissopenAgentUpdate({
                currentVersion: "0.0.0",
                fetch: fetch_,
                now: 1_700_000_000_000,
                paths,
            }),
        ).resolves.toEqual({ currentVersion: "0.0.0", latestVersion: "1.2.3" });
        expect(fetch_).toHaveBeenCalledOnce();
    });
});

describe("resolveLocalKissopenAgentSources", () => {
    it("finds sibling KISSOPEN Agent sources for the in-process Gym daemon", () => {
        const found = resolveLocalKissopenAgentSources(
            "file:///workspace/packages/kissopen-terminal/dist/main.js",
            (path) => path.pathname.includes("/packages/kissopen-agent/sources/"),
        );

        expect(found).toEqual({
            cliPath: "/workspace/packages/kissopen-agent/sources/cli.ts",
            runModuleUrl:
                "file:///workspace/packages/kissopen-agent/sources/lifecycle/runAgentDaemon.ts",
        });
    });
});

async function temporaryPaths() {
    const root = await mkdtemp(join(tmpdir(), "kissopen-terminal-kissopen-agent-download-"));
    roots.push(root);
    return getKissopenDaemonPaths({ KISSOPEN_HOME_DIR: root }, root);
}

async function fakeExtract(
    _archivePath: string,
    destination: string,
    archivedBinaryName: string,
): Promise<void> {
    const path = join(destination, archivedBinaryName);
    await writeFile(path, "#!/bin/sh\n", "utf8");
    await chmod(path, 0o700);
}

function releaseFetch(
    archive: Buffer,
    delayMs = 0,
    digest = createHash("sha256").update(archive).digest("hex"),
    version = "1.2.3",
) {
    return vi.fn<typeof fetch>(async (input) => {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/releases/latest")) {
            return Response.json({
                assets: [
                    {
                        browser_download_url: "https://downloads.example/kissopen-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: `kissopen-agent-${version}-win32-x64.tar.gz`,
                        size: archive.length,
                    },
                    {
                        browser_download_url: "https://downloads.example/kissopen-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: url.includes("never")
                            ? "never"
                            : `kissopen-agent-${version}-darwin-arm64.tar.gz`,
                        size: archive.length,
                    },
                    {
                        browser_download_url: "https://downloads.example/kissopen-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: `kissopen-agent-${version}-linux-x64.tar.gz`,
                        size: archive.length,
                    },
                    {
                        browser_download_url: "https://downloads.example/kissopen-agent.tar.gz",
                        digest: `sha256:${digest}`,
                        name: `kissopen-agent-${version}-linux-arm64.tar.gz`,
                        size: archive.length,
                    },
                ],
                draft: false,
                prerelease: false,
                tag_name: `v${version}`,
            });
        }
        return new Response(archive, { status: 200 });
    });
}
