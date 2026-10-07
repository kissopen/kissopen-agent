/**
 * A failure the person running Kissopen Terminal can act on, such as a missing session or an unknown flag.
 * These are reported as a short explanation with an optional next step, never as a stack trace.
 */
export class KissopenTerminalUserError extends Error {
    readonly hint: string | undefined;

    constructor(message: string, options: { cause?: unknown; hint?: string } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "KissopenTerminalUserError";
        this.hint = options.hint;
    }
}

export function isKissopenTerminalUserError(error: unknown): error is KissopenTerminalUserError {
    return error instanceof KissopenTerminalUserError;
}
