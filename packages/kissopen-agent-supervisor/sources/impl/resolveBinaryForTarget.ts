import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLATFORM_TARGETS, type PlatformKey } from "../platform.js";

const require = createRequire(import.meta.url);

export function resolveBinaryForTarget(key: PlatformKey, binaryPath?: string): string {
    if (binaryPath !== undefined) {
        const explicit = path.resolve(binaryPath);
        if (!existsSync(explicit)) {
            throw new Error(`KISSOPEN agent supervisor binary does not exist: ${explicit}`);
        }
        return explicit;
    }

    const platform = PLATFORM_TARGETS[key];
    const executable =
        platform.os === "win32" ? "kissopen-agent-supervisor.exe" : "kissopen-agent-supervisor";
    // The optional binary packages are upstream's published tarballs, so the file
    // they vendor keeps its upstream name; only a local Rust build carries ours.
    const vendored = platform.os === "win32" ? "happy-agent-supervisor.exe" : "happy-agent-supervisor";
    // A local build wins over the vendored tarball. The other order silently
    // ignores `pnpm build:native`, so editing the Rust source would change
    // nothing as long as the optional binary package happened to be installed.
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const localCandidates = [
        path.join(packageRoot, "native", "target", platform.target, "release", executable),
        path.join(packageRoot, "native", "target", platform.target, "debug", executable),
        path.join(packageRoot, "native", "target", "release", executable),
        path.join(packageRoot, "native", "target", "debug", executable),
    ];
    const local = localCandidates.find((candidate) => existsSync(candidate));
    if (local !== undefined) return local;

    try {
        const manifest = require.resolve(`${platform.alias}/package.json`);
        const installed = path.join(
            path.dirname(manifest),
            "vendor",
            platform.target,
            "bin",
            vendored,
        );
        if (existsSync(installed)) return installed;
    } catch {
        // No published binary for this platform either.
    }

    throw new Error(
        `The optional binary package ${platform.alias} is missing. Reinstall ` +
            "@kissopen/kissopen-agent-supervisor or build the matching native target.",
    );
}
