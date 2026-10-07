/*
What KISSOPEN may ask this session about its terminals.

The terminals themselves are the daemon's own: a real PTY and one canonical
emulator per terminal, held by the terminals module, with an attach protocol
that already solves ordering, resize barriers, replay and backpressure. None
of that is restated here, and deliberately so — a second terminal protocol
written for the relay would be a second thing to keep in step with the first.

So these four are only the lifecycle, and they are the same four the daemon's
own HTTP API offers. Attaching is not among them: it is a stream, not a
question, and it carries the daemon's attach bytes unchanged.
*/
import { Type, type Static } from "@sinclair/typebox";

/** The largest screen a caller may ask for; the module refuses beyond its own. */
const MAX_DIMENSION = 1000;

export const kissopenTerminalCreateRequestSchema = Type.Object(
    {
        cols: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIMENSION })),
        rows: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIMENSION })),
        /** Light or dark, fixed for this terminal's life; the emulator is built with it. */
        colorScheme: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])),
    },
    { additionalProperties: true },
);

export const kissopenTerminalListRequestSchema = Type.Object({}, { additionalProperties: true });

export const kissopenTerminalResizeRequestSchema = Type.Object(
    {
        terminalId: Type.String({ minLength: 1, maxLength: 128 }),
        cols: Type.Integer({ minimum: 1, maximum: MAX_DIMENSION }),
        rows: Type.Integer({ minimum: 1, maximum: MAX_DIMENSION }),
    },
    { additionalProperties: true },
);

export const kissopenTerminalStopRequestSchema = Type.Object(
    { terminalId: Type.String({ minLength: 1, maxLength: 128 }) },
    { additionalProperties: true },
);

export type KissopenTerminalCreateRequest = Static<typeof kissopenTerminalCreateRequestSchema>;
export type KissopenTerminalResizeRequest = Static<typeof kissopenTerminalResizeRequestSchema>;
export type KissopenTerminalStopRequest = Static<typeof kissopenTerminalStopRequestSchema>;

/*
One terminal, as a client needs to list and address it.

Deliberately less than the daemon's own record: what crosses the relay is what
a reader can act on — which terminal, how big, still running or not — and not
the module's internal bookkeeping.
*/
export interface KissopenTerminal {
    readonly id: string;
    readonly cols: number;
    readonly rows: number;
    readonly colorScheme: "light" | "dark";
    readonly status: "running" | "exited";
    /** Present once it has exited, when the daemon knows it. */
    readonly exitCode?: number;
}

export type KissopenTerminalResponse =
    | { readonly success: true; readonly terminal: KissopenTerminal }
    | KissopenTerminalFailure;

export type KissopenTerminalsResponse =
    | { readonly success: true; readonly terminals: readonly KissopenTerminal[] }
    | KissopenTerminalFailure;

/**
 * Why a terminal request did not happen.
 *
 * The same shape the file reads answer with, so a client has one way of
 * reading a refusal: `unsupported` is a daemon that does not do this at all,
 * and the rest are about this particular ask.
 */
export interface KissopenTerminalFailure {
    readonly success: false;
    readonly code: "invalid" | "missing" | "unavailable" | "unsupported" | "limit";
    readonly error: string;
}

/** What the terminals module can be asked, for one session's folder. */
export interface KissopenTerminalOperations {
    terminalCreate: (request: KissopenTerminalCreateRequest) => Promise<KissopenTerminalResponse>;
    terminalList: () => Promise<KissopenTerminalsResponse>;
    terminalResize: (request: KissopenTerminalResizeRequest) => Promise<KissopenTerminalResponse>;
    terminalStop: (request: KissopenTerminalStopRequest) => Promise<KissopenTerminalResponse>;
}

/*
A refusal this side raises before the terminals module is reached.

The module has its own error for the questions it can answer; this is for the
ones it never sees — a session with no folder, a project that is not active, a
daemon with no terminals at all.
*/
export class KissopenTerminalRefused extends Error {
    readonly code: KissopenTerminalFailure["code"];

    constructor(code: KissopenTerminalFailure["code"], message: string) {
        super(message);
        this.name = "KissopenTerminalRefused";
        this.code = code;
    }
}

/**
 * One of the daemon's terminals, as a client needs it.
 *
 * Less than the record it came from: the epoch, the version and the workspace
 * are the module's own bookkeeping, and a client that was given them would
 * start to depend on them.
 */
export function terminalView(terminal: {
    id: string;
    cols: number;
    rows: number;
    colorScheme: "light" | "dark";
    status: "running" | "exited";
    exitCode: number | null;
}): KissopenTerminal {
    return {
        id: terminal.id,
        cols: terminal.cols,
        rows: terminal.rows,
        colorScheme: terminal.colorScheme,
        status: terminal.status,
        ...(terminal.exitCode === null ? {} : { exitCode: terminal.exitCode }),
    };
}

/** The folder a bot's root stands in, as a terminal scope. */
export function terminalScopeOfRoot(root: { projectId: string; workspaceId?: string }): {
    projectId: string;
    workspaceId?: string;
} {
    return root.workspaceId === undefined
        ? { projectId: root.projectId }
        : { projectId: root.projectId, workspaceId: root.workspaceId };
}

/*
A terminal answer, or the reason there is none.

Failures come back as a value because the answer travels encrypted over the
relay: a thrown error would reach the client as "the request failed" and take
the reason with it.
*/
export async function terminalAnswer(
    work: () => Promise<KissopenTerminal>,
): Promise<KissopenTerminalResponse> {
    try {
        return { success: true, terminal: await work() };
    } catch (error) {
        return terminalFailure(error);
    }
}

export async function terminalsAnswer(
    work: () => Promise<readonly KissopenTerminal[]>,
): Promise<KissopenTerminalsResponse> {
    try {
        return { success: true, terminals: await work() };
    } catch (error) {
        return terminalFailure(error);
    }
}

/*
The module's own words for a refusal, in this contract's vocabulary.

`conflict` is the module saying a folder already holds as many terminals as it
will, which a reader acts on by closing one — so it is carried as `limit`
rather than folded into the general unavailable.
*/
function terminalFailure(error: unknown): KissopenTerminalFailure {
    if (error instanceof KissopenTerminalRefused)
        return { success: false, code: error.code, error: error.message };
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : "The terminal request failed.";
    if (code === "not_found") return { success: false, code: "missing", error: message };
    if (code === "invalid") return { success: false, code: "invalid", error: message };
    if (code === "conflict") return { success: false, code: "limit", error: message };
    return { success: false, code: "unavailable", error: message };
}
