import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The packaged open-source Desktop and CLI share one per-user Agent installation. */
export function getKissopenHome(
    environment: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
    platform: NodeJS.Platform = process.platform,
): string {
    const path = platform === "win32" ? win32 : posix;
    const configured = environment.KISSOPEN_HOME_DIR?.trim();
    if (configured) {
        const expanded = configured.startsWith("~")
            ? path.join(homeDirectory, configured.slice(1))
            : configured;
        return path.isAbsolute(expanded) ? expanded : path.join(homeDirectory, expanded);
    }

    // Matches Electron app.getPath("appData") and communityUserDataDirectory().
    const configuredAppData =
        platform === "win32" ? environment.APPDATA : environment.XDG_CONFIG_HOME;
    const appData =
        platform === "darwin"
            ? path.join(homeDirectory, "Library", "Application Support")
            : configuredAppData && path.isAbsolute(configuredAppData)
              ? configuredAppData
              : platform === "win32"
                ? path.join(homeDirectory, "AppData", "Roaming")
                : path.join(homeDirectory, ".config");
    return path.join(appData, "kissopen-oss", "runtime", ".kissopen");
}
