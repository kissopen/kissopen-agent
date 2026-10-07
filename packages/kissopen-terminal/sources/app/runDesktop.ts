import { spawn } from "node:child_process";
import { join } from "node:path";

import { getKissopenTerminalHome } from "../config/index.js";
import { KissopenTerminalUserError } from "../KissopenTerminalUserError.js";
import { desktopApplicationBuild } from "./desktopApplicationBuild.js";
import { desktopApplicationName } from "./desktopApplicationRuntime.js";
import {
    desktopApplicationContentHash,
    desktopApplicationResolve,
    desktopBuildStampRead,
    kissopen2RepositoryRootResolve,
    rigRepositoryRootResolve,
} from "./desktopApplicationState.js";

export interface RunDesktopOptions {
    readonly buildOnly: boolean;
    readonly forceBuild: boolean;
    readonly kissopen2Root?: string;
    readonly skipBuild: boolean;
}

/** Builds and launches a relocatable Kissopen local app carrying the current Kissopen Terminal runtime. */
export async function runDesktop(options: RunDesktopOptions): Promise<void> {
    if (process.platform !== "darwin") {
        throw new KissopenTerminalUserError("The KISSOPEN desktop app currently builds only on macOS.");
    }

    const desktopRoot = join(getKissopenTerminalHome(), "desktop");
    const releaseDirectory = join(desktopRoot, "release");
    let application = await desktopApplicationResolve(releaseDirectory);

    if (options.skipBuild) {
        if (!application) {
            throw new KissopenTerminalUserError(
                "KISSOPEN Terminal has no packaged KISSOPEN desktop app to launch.",
                {
                    hint: "Run kissopen-terminal desktop once without --skip-build.",
                },
            );
        }
        console.log(`Desktop build skipped; using ${application}`);
    } else {
        const rigRoot = await rigRepositoryRootResolve();
        const kissopen2Root = await kissopen2RepositoryRootResolve(options.kissopen2Root, rigRoot);
        const contentHash = await desktopApplicationContentHash(rigRoot, kissopen2Root);
        const stamp = await desktopBuildStampRead(join(desktopRoot, "build-stamp.json"));
        const buildNeeded =
            options.forceBuild ||
            !application ||
            stamp?.contentHash !== contentHash ||
            stamp?.kissopen2Root !== kissopen2Root;

        if (buildNeeded) {
            application = await desktopApplicationBuild({
                contentHash,
                desktopRoot,
                kissopen2Root,
                rigRoot,
            });
        } else {
            console.log("KISSOPEN desktop is up to date (content stamp matches).");
        }
    }

    if (!application) {
        throw new KissopenTerminalUserError(
            "The KISSOPEN desktop build produced no runnable application.",
        );
    }
    if (options.buildOnly) {
        console.log(`KISSOPEN desktop is ready at ${application} (not launching; --build-only).`);
        return;
    }

    const executable = join(application, "Contents", "MacOS", desktopApplicationName);
    console.log(`Launching packaged KISSOPEN desktop: ${application}`);
    await new Promise<void>((resolvePromise, reject) => {
        const child = spawn(executable, [], {
            cwd: application,
            env: process.env,
            stdio: "inherit",
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolvePromise();
            else {
                reject(
                    new KissopenTerminalUserError(
                        `${desktopApplicationName} failed${signal ? ` with ${signal}` : ` with exit code ${code ?? 1}`}.`,
                    ),
                );
            }
        });
    });
}
