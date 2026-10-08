export function formatCliHelp(): string {
    return [
        "Usage: kissopen [session options]",
        "       kissopen desktop [--build-only] [--skip-build | --force-build] [--kissopen2-root PATH]",
        "       kissopen exec [options] [prompt]",
        "       kissopen resume [--last | --all | SESSION_ID]",
        "       kissopen fork [--last | --all | SESSION_ID]",
        "       kissopen inspect [--json]",
        "       kissopen upgrade",
        "       kissopen daemon <start|stop|kill|status|reload>",
        "       kissopen monit",
        "",
        "Run KISSOPEN Terminal without a command to start an interactive session.",
        "Use 'kissopen desktop' to build and launch the KISSOPEN desktop app.",
        "Use 'kissopen inspect --json' to inspect this installation without starting the daemon.",
        "Use 'kissopen upgrade' to update KISSOPEN Agent and restart its daemon.",
        "",
        "Options:",
        "  -h, --help       Show this help.",
        "  -v, --version    Show the installed KISSOPEN Terminal version.",
    ].join("\n");
}

export function formatDesktopCliHelp(): string {
    return [
        "Usage: kissopen desktop [options]",
        "",
        "Build KISSOPEN 2's local macOS shell with the current KISSOPEN Terminal runtime embedded, then launch it.",
        "",
        "Options:",
        "  --build-only       Build the app without launching it.",
        "  --skip-build       Launch the existing packaged app.",
        "  --force-build      Rebuild even when the content stamp matches.",
        "  --kissopen2-root PATH  Use this local KISSOPEN 2 source checkout.",
        "  -h, --help          Show this help.",
    ].join("\n");
}
