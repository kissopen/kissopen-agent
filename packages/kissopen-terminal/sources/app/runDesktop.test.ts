import { describe, expect, it } from "vitest";

import {
    desktopApplicationEntrypoint,
    desktopBuilderConfiguration,
    desktopLoginShell,
    desktopKissopenTerminalLauncher,
} from "./desktopApplicationRuntime.js";

describe("KISSOPEN desktop packaging", () => {
    it("boots KISSOPEN with the bundled KISSOPEN Terminal command ahead of the login-shell environment", () => {
        expect(desktopApplicationEntrypoint()).toContain(
            'join(process.resourcesPath, "kissopen-terminal-runtime", "bin")',
        );
        expect(desktopApplicationEntrypoint()).toContain(
            'process.env.SHELL = join(runtimeBin, "kissopen2-login-shell")',
        );
        expect(desktopLoginShell()).toContain('export PATH="$1:$PATH"');
    });

    it("runs the bundled KISSOPEN Terminal through the packaged Electron executable", () => {
        const launcher = desktopKissopenTerminalLauncher();

        expect(launcher).toContain("export ELECTRON_RUN_AS_NODE=1");
        expect(launcher).toContain('MacOS/KISSOPEN Nightly"');
        expect(launcher).toContain('"$bin_directory/../dist/main.js"');
    });

    it("packages the KISSOPEN local shell and complete KISSOPEN Terminal runtime", () => {
        expect(
            desktopBuilderConfiguration({
                buildResources: "/kissopen2/build",
                kissopen2NodeModules: "/staging/kissopen2/node_modules",
                output: "/staging/release",
                rigRuntime: "/staging/kissopen-terminal-runtime",
            }),
        ).toMatchObject({
            appId: "com.slopus.kissopen2.nightly",
            directories: { output: "/staging/release" },
            executableName: "KISSOPEN Nightly",
            extraResources: [
                { from: "/staging/kissopen2/node_modules", to: "node_modules" },
                { from: "/staging/kissopen-terminal-runtime", to: "kissopen-terminal-runtime" },
                {
                    from: "/staging/kissopen-terminal-runtime/node_modules",
                    to: "kissopen-terminal-runtime/node_modules",
                },
            ],
            files: [
                "dist/main.js",
                "dist/preload.cjs",
                "kissopen-terminal-main.mjs",
                "package.json",
            ],
            productName: "KISSOPEN Nightly",
        });
    });
});
