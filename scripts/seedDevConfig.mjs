import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Copies the user's real Kissopen configuration into the development Kissopen home.
 *
 * `pnpm dev` runs the daemon against `<checkout>/.kissopen-terminal-dev/.kissopen`, whose config home is
 * `<checkout>/.kissopen-terminal-dev/Kissopen/Config` on macOS or `kissopen/config` on Linux. A fresh checkout would otherwise get the commented starter
 * template there, so the dev daemon would serve none of the user's configured providers and a
 * shell exporting KISSOPEN_TERMINAL_MODEL / KISSOPEN_TERMINAL_PROVIDER would fail at startup. Seeding a copy of the real
 * user configuration keeps the dev daemon serving the same providers as the real one.
 *
 * A marker file records what was last seeded, so an unchanged copy is refreshed on every run
 * while a hand-edited dev configuration is recognized and left alone.
 */
const configDirectory = process.platform === "darwin" ? "Kissopen/Config" : "kissopen/config";
const realConfigPath = join(homedir(), configDirectory, "kissopen.toml");
const devConfigDirectory = join(process.cwd(), ".kissopen-terminal-dev", configDirectory);
const devConfigPath = join(devConfigDirectory, "kissopen.toml");
const seededMarkerPath = join(devConfigDirectory, ".kissopen.toml.seeded");

const realConfig = readIfPresent(realConfigPath);
if (realConfig === undefined) {
    process.exit(0);
}
mkdirSync(devConfigDirectory, { recursive: true });

const existing = statIfPresent(devConfigPath);
if (existing?.isSymbolicLink()) {
    // An earlier seeding strategy linked instead of copying; replace the link with a copy.
    unlinkSync(devConfigPath);
} else if (
    existing !== undefined &&
    readIfPresent(seededMarkerPath) !== hash(readIfPresent(devConfigPath))
) {
    console.log(`Keeping dev-only configuration at ${devConfigPath}`);
    process.exit(0);
}
writeFileSync(devConfigPath, realConfig);
writeFileSync(seededMarkerPath, hash(realConfig));
console.log(`Dev configuration copied from ${realConfigPath}`);

function hash(content) {
    return content === undefined ? undefined : createHash("sha256").update(content).digest("hex");
}

function readIfPresent(path) {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return undefined;
    }
}

function statIfPresent(path) {
    try {
        return lstatSync(path);
    } catch {
        return undefined;
    }
}
