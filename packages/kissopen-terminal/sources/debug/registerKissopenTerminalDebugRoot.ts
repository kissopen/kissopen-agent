export interface KissopenTerminalDebugRoot {
    kind: "daemon" | "tui";
    [name: string]: unknown;
}

export function registerKissopenTerminalDebugRoot(root: KissopenTerminalDebugRoot): void {
    Object.defineProperty(globalThis, "__kissopenTerminalDebug", {
        configurable: true,
        enumerable: false,
        value: root,
        writable: true,
    });
}
