import type { PackageManifest } from "./PackageManifest.js";

const DAEMON_IMPLEMENTATION_PACKAGES = [
    "@kissopen/kissopen-agent",
    "@kissopen/kissopen-agent-base",
    "@kissopen/kissopen-agent-compute",
    "@kissopen/kissopen-agent-modules",
] as const;

/**
 * Keeps Kissopen Terminal on the public client contract. The daemon implementation is a selected
 * release binary under `~/.kissopen/dist`, including a locally built `0.0.0`, and Kissopen Terminal never
 * depends on the implementation packages.
 */
export function assertBundledKissopenRuntimeDependencies(manifest: PackageManifest): void {
    const implementationDependencies = DAEMON_IMPLEMENTATION_PACKAGES.filter(
        (dependency) =>
            manifest.dependencies?.[dependency] !== undefined ||
            manifest.devDependencies?.[dependency] !== undefined,
    );
    if (implementationDependencies.length > 0) {
        throw new Error(
            `KISSOPEN Terminal must not depend on KISSOPEN Agent implementation packages: ${implementationDependencies.join(", ")}.`,
        );
    }
    if (manifest.dependencies?.["@kissopen/kissopen-agent-client"] === undefined) {
        throw new Error("KISSOPEN Terminal must depend on @kissopen/kissopen-agent-client.");
    }
}
