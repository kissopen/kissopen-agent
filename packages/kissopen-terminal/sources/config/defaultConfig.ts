import type { KissopenTerminalConfig } from "./types.js";

export const DEFAULT_KISSOPEN_TERMINAL_CONFIG: KissopenTerminalConfig = {
    defaults: {
        modelId: "openai/gpt-5.6-sol",
        permissionMode: "auto",
    },
    settings: {
        compactCompletedTurns: false,
        completionChime: false,
        showReasoning: false,
        showUsage: false,
    },
    theme: {
        accent: "#9184D9",
        brand: "#9184D9",
        error: "red",
        primary: "default",
        secondary: "dim",
        success: "green",
        warning: "yellow",
    },
};
