import { isAbsolute, relative, resolve } from "node:path";

import type { ProjectFileRoot } from "../../files/index.js";

/**
 * The generated-files folder as a file root, when a path is inside it.
 *
 * Pictures a generation makes are published under the agent's own `Generated` folder, which is
 * outside every workspace. A client that wants the full picture — to enlarge it, to save it —
 * has only the file routes, and those are rooted at a workspace. So a read whose path is an
 * absolute path under that folder is served from this root instead, with the same containment
 * and size rules the workspace root gets; anything else answers `undefined` and takes the
 * workspace root as before. Reads only: nothing is ever written or listed here.
 */
export function generatedFileRoot(
    /** Absent on a daemon whose configuration is not loaded, which has no folder to serve. */
    generatedPath: string | undefined,
    path: string,
): ProjectFileRoot | undefined {
    if (generatedPath === undefined || !isAbsolute(path)) return undefined;
    const root = resolve(generatedPath);
    const inside = relative(root, resolve(path));
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) return undefined;
    return { projectId: "generated", root };
}
