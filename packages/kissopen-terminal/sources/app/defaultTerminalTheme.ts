import { DEFAULT_KISSOPEN_TERMINAL_CONFIG } from "../config/index.js";
import { resolveTerminalTheme } from "./resolveTerminalTheme.js";

export const DEFAULT_TERMINAL_THEME = resolveTerminalTheme(DEFAULT_KISSOPEN_TERMINAL_CONFIG.theme);
