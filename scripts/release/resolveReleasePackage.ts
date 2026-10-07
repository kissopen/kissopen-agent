import { fileURLToPath } from "node:url";

import type { ReleasePackage, ReleasePackageKey } from "./ReleasePackage.js";

const PACKAGES: Record<ReleasePackageKey, ReleasePackage> = {
    "kissopen-agent-base": {
        buildArguments: ["--filter", "@kissopen/kissopen-agent-base", "build"],
        checkArguments: ["--filter", "@kissopen/kissopen-agent-base", "check"],
        commitPrefix: "Release kissopen-agent-base v",
        directory: fileURLToPath(new URL("../../packages/kissopen-agent-base/", import.meta.url)),
        key: "kissopen-agent-base",
        manifestPath: "packages/kissopen-agent-base/package.json",
        tagPrefix: "kissopen-agent-base-v",
        testArguments: [["--filter", "@kissopen/kissopen-agent-base", "test"]],
    },
    "kissopen-agent-client": {
        buildArguments: ["--filter", "@kissopen/kissopen-agent-client", "build"],
        checkArguments: ["--filter", "@kissopen/kissopen-agent-client", "check"],
        commitPrefix: "Release kissopen-agent-client v",
        directory: fileURLToPath(new URL("../../packages/kissopen-agent-client/", import.meta.url)),
        key: "kissopen-agent-client",
        manifestPath: "packages/kissopen-agent-client/package.json",
        tagPrefix: "kissopen-agent-client-v",
        testArguments: [["--filter", "@kissopen/kissopen-agent-client", "test"]],
    },
    "kissopen-agent-compute": {
        buildArguments: ["--filter", "@kissopen/kissopen-agent-compute", "build"],
        checkArguments: ["--filter", "@kissopen/kissopen-agent-compute", "check"],
        commitPrefix: "Release kissopen-agent-compute v",
        directory: fileURLToPath(new URL("../../packages/kissopen-agent-compute/", import.meta.url)),
        key: "kissopen-agent-compute",
        manifestPath: "packages/kissopen-agent-compute/package.json",
        tagPrefix: "kissopen-agent-compute-v",
        testArguments: [["--filter", "@kissopen/kissopen-agent-compute", "test"]],
    },
    "kissopen-providers": {
        buildArguments: ["--filter", "@kissopen/kissopen-providers", "build"],
        checkArguments: ["--filter", "@kissopen/kissopen-providers", "check"],
        commitPrefix: "Release kissopen-providers v",
        directory: fileURLToPath(new URL("../../packages/kissopen-providers/", import.meta.url)),
        key: "kissopen-providers",
        manifestPath: "packages/kissopen-providers/package.json",
        tagPrefix: "kissopen-providers-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "@kissopen/kissopen-providers", "test"],
        ],
    },
    "kissopen-plugins": {
        buildArguments: ["--filter", "kissopen-plugins", "build"],
        checkArguments: ["--filter", "kissopen-plugins", "check"],
        commitPrefix: "Release kissopen-plugins v",
        directory: fileURLToPath(new URL("../../packages/kissopen-plugins/", import.meta.url)),
        key: "kissopen-plugins",
        manifestPath: "packages/kissopen-plugins/package.json",
        tagPrefix: "kissopen-plugins-v",
        testArguments: [
            ["run", "test:scripts"],
            ["--filter", "kissopen-plugins", "test"],
        ],
    },
    "kissopen-terminal": {
        buildArguments: ["run", "build"],
        checkArguments: ["run", "check"],
        commitPrefix: "Release KISSOPEN Terminal v",
        directory: fileURLToPath(new URL("../../packages/kissopen-terminal/", import.meta.url)),
        key: "kissopen-terminal",
        manifestPath: "packages/kissopen-terminal/package.json",
        tagPrefix: "kissopen-terminal-v",
        testArguments: [["run", "test:release"]],
    },
};

export function resolveReleasePackage(value: string | undefined): ReleasePackage {
    const key = value ?? "kissopen-terminal";
    if (
        key !== "kissopen-terminal" &&
        key !== "kissopen-agent-base" &&
        key !== "kissopen-agent-client" &&
        key !== "kissopen-agent-compute" &&
        key !== "kissopen-plugins" &&
        key !== "kissopen-providers"
    ) {
        throw new Error(
            `Unknown release package ${key}. Expected kissopen-terminal, kissopen-agent-base, kissopen-agent-client, kissopen-agent-compute, kissopen-plugins, or kissopen-providers.`,
        );
    }
    return PACKAGES[key];
}
