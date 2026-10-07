import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The SDK packages whose sources live here. Until they are published under `@kissopen` on npm,
 * every package links the workspace copy; once published, every package pins the same version.
 *
 * pnpm gives a `workspace:*` link and a version pin two separate copies of the same package, and
 * two copies mean two copies of every class: `instanceof` fails across the seam, and an error
 * thrown by one copy is not recognized by the other. Every package therefore has to name the same
 * specifier, never a mix of workspace links and published versions.
 */
const PUBLISHED_SDK_PACKAGES = [
    "@kissopen/kissopen-providers",
    "@kissopen/kissopen-agent-base",
    "@kissopen/kissopen-agent-client",
    "@kissopen/kissopen-agent-compute",
] as const;

const PACKAGES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "packages");

async function declaredVersions(dependency: string): Promise<ReadonlyMap<string, string>> {
    const found = new Map<string, string>();
    for (const entry of await readdir(PACKAGES_DIRECTORY, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(PACKAGES_DIRECTORY, entry.name, "package.json");
        const manifest = await readFile(manifestPath, "utf8").catch(() => undefined);
        if (manifest === undefined) continue;
        const parsed = JSON.parse(manifest) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const declared = parsed.dependencies?.[dependency] ?? parsed.devDependencies?.[dependency];
        if (declared !== undefined) found.set(entry.name, declared);
    }
    return found;
}

function publishedVersion(dependency: string, specifier: string): string {
    const aliasPrefix = `npm:${dependency}@`;
    return specifier.startsWith(aliasPrefix) ? specifier.slice(aliasPrefix.length) : specifier;
}

describe("published SDK dependencies", () => {
    for (const dependency of PUBLISHED_SDK_PACKAGES) {
        it(`resolves ${dependency} to one copy everywhere`, async () => {
            const declared = await declaredVersions(dependency);
            assert.ok(declared.size > 0, `No package declares ${dependency}.`);

            const linked = [...declared]
                .filter(([, version]) => version.startsWith("workspace:"))
                .map(([name]) => name);
            assert.ok(
                linked.length === 0 || linked.length === declared.size,
                `${dependency} mixes workspace links (${linked.join(", ")}) with published versions.`,
            );

            const versions = [
                ...new Set(
                    [...declared.values()].map((specifier) =>
                        publishedVersion(dependency, specifier),
                    ),
                ),
            ];
            assert.equal(
                versions.length,
                1,
                `${dependency} is pinned to more than one version: ${versions.join(", ")}.`,
            );
        });
    }
});
