import { KissopenTerminalUserError } from "../KissopenTerminalUserError.js";
import type { RunDesktopOptions } from "./runDesktop.js";

export function parseDesktopCommand(arguments_: readonly string[]): RunDesktopOptions {
    let buildOnly = false;
    let forceBuild = false;
    let kissopen2Root: string | undefined;
    let skipBuild = false;

    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index]!;
        if (argument === "--build-only") {
            buildOnly = true;
            continue;
        }
        if (argument === "--force-build") {
            forceBuild = true;
            continue;
        }
        if (argument === "--skip-build") {
            skipBuild = true;
            continue;
        }
        if (argument === "--kissopen2-root") {
            kissopen2Root = arguments_[index + 1];
            if (!kissopen2Root) {
                throw new KissopenTerminalUserError(
                    "The --kissopen2-root option needs a directory.",
                    {
                        hint: "Usage: kissopen desktop --kissopen2-root /path/to/kissopen2",
                    },
                );
            }
            index += 1;
            continue;
        }
        if (argument.startsWith("--kissopen2-root=")) {
            kissopen2Root = argument.slice("--kissopen2-root=".length);
            if (!kissopen2Root) {
                throw new KissopenTerminalUserError(
                    "The --kissopen2-root option needs a directory.",
                    {
                        hint: "Usage: kissopen desktop --kissopen2-root /path/to/kissopen2",
                    },
                );
            }
            continue;
        }
        throw new KissopenTerminalUserError(`Unknown kissopen desktop option '${argument}'.`, {
            hint: "Usage: kissopen desktop [--build-only] [--skip-build | --force-build] [--kissopen2-root PATH]",
        });
    }

    if (skipBuild && forceBuild) {
        throw new KissopenTerminalUserError(
            "KISSOPEN Terminal cannot skip and force the desktop build at the same time.",
            {
                hint: "Use either --skip-build or --force-build.",
            },
        );
    }

    return {
        buildOnly,
        forceBuild,
        ...(kissopen2Root === undefined ? {} : { kissopen2Root }),
        skipBuild,
    };
}
