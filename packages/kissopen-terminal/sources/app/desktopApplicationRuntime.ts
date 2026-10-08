import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { KissopenTerminalUserError } from "../KissopenTerminalUserError.js";

export const desktopApplicationName = "KISSOPEN Nightly";
export const desktopApplicationId = "com.slopus.kissopen2.nightly";
export const desktopLocalWebOrigin = "https://local.app.kissopen.com/downloads/kissopen-preview/";

const packageManifestSchema = Type.Object(
    {
        version: Type.String({ minLength: 1 }),
    },
    { additionalProperties: true },
);

export async function desktopApplicationStagingPrepare(
    kissopen2Staging: string,
    rigRuntime: string,
): Promise<void> {
    const manifestPath = join(kissopen2Staging, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (!Value.Check(packageManifestSchema, manifest)) {
        throw new KissopenTerminalUserError("The KISSOPEN desktop package manifest is invalid.");
    }
    await writeFile(
        manifestPath,
        `${JSON.stringify(
            {
                ...manifest,
                main: "kissopen-terminal-main.mjs",
                name: "kissopen2-desktop-local",
            },
            null,
            4,
        )}\n`,
    );
    await writeFile(
        join(kissopen2Staging, "kissopen-terminal-main.mjs"),
        desktopApplicationEntrypoint(),
    );

    const runtimeBin = join(rigRuntime, "bin");
    await mkdir(runtimeBin, { recursive: true });
    const terminalLauncher = join(runtimeBin, "kissopen-terminal");
    const loginShell = join(runtimeBin, "kissopen2-login-shell");
    await writeFile(terminalLauncher, desktopKissopenTerminalLauncher());
    await writeFile(loginShell, desktopLoginShell());
    await chmod(terminalLauncher, 0o755);
    await chmod(loginShell, 0o755);
}

export function desktopApplicationEntrypoint(): string {
    return [
        'import { delimiter, join } from "node:path";',
        'import process from "node:process";',
        "",
        'const runtimeBin = join(process.resourcesPath, "kissopen-terminal-runtime", "bin");',
        "process.env.PATH = [runtimeBin, process.env.PATH].filter(Boolean).join(delimiter);",
        'process.env.SHELL = join(runtimeBin, "kissopen2-login-shell");',
        'await import("./dist/main.js");',
        "",
    ].join("\n");
}

export function desktopKissopenTerminalLauncher(): string {
    return [
        "#!/bin/sh",
        "set -eu",
        'bin_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'contents_directory=$(CDPATH= cd -- "$bin_directory/../../.." && pwd)',
        "export ELECTRON_RUN_AS_NODE=1",
        `exec "$contents_directory/MacOS/${desktopApplicationName}" "$bin_directory/../dist/main.js" "$@"`,
        "",
    ].join("\n");
}

export function desktopLoginShell(): string {
    return [
        "#!/bin/sh",
        "set -eu",
        'bin_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'if [ "$1" = "-l" ] && [ "$2" = "-c" ]; then',
        `    exec /bin/zsh -l -c 'export PATH="$1:$PATH"; eval "$2"' kissopen2 "$bin_directory" "$3"`,
        "fi",
        'exec /bin/zsh "$@"',
        "",
    ].join("\n");
}

export function desktopBuilderConfiguration(input: {
    buildResources: string;
    kissopen2NodeModules: string;
    output: string;
    rigRuntime: string;
}): object {
    return {
        appId: desktopApplicationId,
        asar: true,
        asarUnpack: ["node_modules/**/*.node"],
        directories: {
            buildResources: input.buildResources,
            output: input.output,
        },
        executableName: desktopApplicationName,
        extraResources: [
            {
                filter: [
                    "**/*",
                    "!.pnpm{,/**/*}",
                    "!.modules.yaml",
                    "!.pnpm-workspace-state-v1.json",
                    "!.bin{,/**/*}",
                ],
                from: input.kissopen2NodeModules,
                to: "node_modules",
            },
            {
                filter: ["**/*", "!node_modules{,/**/*}"],
                from: input.rigRuntime,
                to: "kissopen-terminal-runtime",
            },
            {
                filter: [
                    "**/*",
                    "!.pnpm{,/**/*}",
                    "!.modules.yaml",
                    "!.pnpm-workspace-state-v1.json",
                    "!.bin{,/**/*}",
                ],
                from: join(input.rigRuntime, "node_modules"),
                to: "kissopen-terminal-runtime/node_modules",
            },
        ],
        files: ["dist/main.js", "dist/preload.cjs", "kissopen-terminal-main.mjs", "package.json"],
        mac: {
            category: "public.app-category.developer-tools",
            hardenedRuntime: false,
            icon: join(input.buildResources, "icon.icns"),
            identity: null,
            notarize: false,
            target: ["dir"],
        },
        productName: desktopApplicationName,
        publish: null,
    };
}
