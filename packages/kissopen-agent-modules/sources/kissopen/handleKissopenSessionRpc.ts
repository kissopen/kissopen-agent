import { Type } from "@sinclair/typebox";
import {
    browserControlRequestSchema,
    type BrowserControlRequest,
    type BrowserControlResponse,
} from "@kissopen/kissopen-agent-client";
import { normalizeKissopenAnswers } from "./resolveKissopenUserInputAnswers.js";
import { Value } from "@sinclair/typebox/value";
import {
    kissopenTerminalCreateRequestSchema,
    kissopenTerminalListRequestSchema,
    kissopenTerminalResizeRequestSchema,
    kissopenTerminalStopRequestSchema,
    type KissopenTerminalFailure,
    type KissopenTerminalOperations,
} from "./KissopenTerminals.js";
import {
    kissopenGitStateRequestSchema,
    kissopenReadFileRequestSchema,
    kissopenReadFileAtRevisionRequestSchema,
    kissopenListDirectoryRequestSchema,
    kissopenUploadFileRequestSchema,
    type KissopenListDirectoryRequest,
    type KissopenListDirectoryResponse,
    type KissopenUploadFileRequest,
    type KissopenUploadFileResponse,
    type KissopenReadFailure,
    type KissopenGitStateResponse,
    type KissopenReadFileRequest,
    type KissopenReadFileAtRevisionRequest,
    type KissopenReadFileResponse,
    type KissopenReadFileAtRevisionResponse,
} from "./KissopenWorkspaceRead.js";

/** What Kissopen may ask this session to do. */
export const KISSOPEN_SESSION_RPC_METHODS = [
    "browserControl",
    "abort",
    "communication",
    "killSession",
    /** Clears the whole conversation at the person's request; the agent stays. */
    "clearConversation",
    "gitState",
    "readFile",
    "readFileAtRevision",
    /** One folder of the session's workspace, for a phone or desktop browsing its files. */
    "listDirectory",
    /** A file sent into the session's workspace in parts, from a desktop or phone. */
    "uploadFile",
    /*
     * The terminals standing in this session's folder. Attaching to one is
     * not here: it is a stream of the daemon's own attach bytes, not a
     * question with an answer.
     */
    "terminalCreate",
    "terminalList",
    "terminalResize",
    "terminalStop",
] as const;

const communicationSchema = Type.Object(
    {
        answers: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        id: Type.String({ minLength: 1 }),
        status: Type.Optional(Type.String()),
    },
    { additionalProperties: true },
);

/**
 * Carries out one thing the phone asked of this session.
 *
 * Everything here is something a person did with their thumb: stop this, answer
 * that, end the session. The answer goes back encrypted, so a failure is
 * reported as a message rather than thrown away.
 */
export async function handleKissopenSessionRpc(options: {
    browserControl?: (request: BrowserControlRequest) => Promise<BrowserControlResponse>;
    abort: () => Promise<void>;
    answerQuestion: (requestId: string, answers: Record<string, unknown>) => Promise<void>;
    archive: () => Promise<void>;
    /** Clears the whole conversation at the person's request; refused while it works. */
    clear: () => Promise<void>;
    cancelQuestion: (requestId: string) => Promise<void>;
    gitState: () => Promise<KissopenGitStateResponse>;
    readFile: (request: KissopenReadFileRequest) => Promise<KissopenReadFileResponse>;
    listDirectory: (
        request: KissopenListDirectoryRequest,
    ) => Promise<KissopenListDirectoryResponse>;
    uploadFile: (request: KissopenUploadFileRequest) => Promise<KissopenUploadFileResponse>;
    readFileAtRevision: (
        request: KissopenReadFileAtRevisionRequest,
    ) => Promise<KissopenReadFileAtRevisionResponse>;
    /*
     * The terminals of this session's folder. Absent on a daemon that has
     * none to offer, which is answered as unsupported rather than as an empty
     * list: a reader told "no terminals" would start one.
     */
    terminals?: KissopenTerminalOperations;
    method: string;
    params: unknown;
}): Promise<unknown> {
    if (options.method === "browserControl") {
        if (!options.browserControl || !Value.Check(browserControlRequestSchema, options.params))
            return {
                ok: false,
                error: "Browser control is unavailable or the request is invalid.",
            };
        return options.browserControl(options.params);
    }
    if (options.method === "gitState") {
        if (!Value.Check(kissopenGitStateRequestSchema, options.params)) return invalidRead();
        return await options.gitState();
    }
    if (options.method === "readFile") {
        const request = options.params;
        if (!Value.Check(kissopenReadFileRequestSchema, request)) return invalidRead();
        return await options.readFile({
            path: request.path,
            ...(request.offset === undefined ? {} : { offset: request.offset }),
            ...(request.length === undefined ? {} : { length: request.length }),
        });
    }
    if (options.method === "listDirectory") {
        if (!Value.Check(kissopenListDirectoryRequestSchema, options.params)) return invalidRead();
        return await options.listDirectory({ path: options.params.path });
    }
    if (options.method === "uploadFile") {
        const request = options.params;
        if (!Value.Check(kissopenUploadFileRequestSchema, request)) return invalidRead();
        return await options.uploadFile({
            path: request.path,
            uploadId: request.uploadId,
            offset: request.offset,
            content: request.content,
            done: request.done,
        });
    }
    if (options.method === "terminalCreate") {
        if (!options.terminals) return terminalUnsupported();
        if (!Value.Check(kissopenTerminalCreateRequestSchema, options.params))
            return invalidTerminal();
        return await options.terminals.terminalCreate(options.params);
    }
    if (options.method === "terminalList") {
        if (!options.terminals) return terminalUnsupported();
        if (!Value.Check(kissopenTerminalListRequestSchema, options.params))
            return invalidTerminal();
        return await options.terminals.terminalList();
    }
    if (options.method === "terminalResize") {
        if (!options.terminals) return terminalUnsupported();
        if (!Value.Check(kissopenTerminalResizeRequestSchema, options.params))
            return invalidTerminal();
        return await options.terminals.terminalResize(options.params);
    }
    if (options.method === "terminalStop") {
        if (!options.terminals) return terminalUnsupported();
        if (!Value.Check(kissopenTerminalStopRequestSchema, options.params))
            return invalidTerminal();
        return await options.terminals.terminalStop(options.params);
    }
    if (options.method === "readFileAtRevision") {
        const request = options.params;
        if (!Value.Check(kissopenReadFileAtRevisionRequestSchema, request)) return invalidRead();
        return await options.readFileAtRevision({ path: request.path, revision: request.revision });
    }
    if (options.method === "abort") {
        await options.abort();
        return { success: true };
    }
    if (options.method === "killSession") {
        await options.archive();
        return { success: true };
    }
    /*
     * Clearing is answered rather than thrown: a conversation that is still
     * working is refused with a reason the person can act on — stop it first.
     */
    if (options.method === "clearConversation") {
        try {
            await options.clear();
            return { success: true };
        } catch (error) {
            return {
                success: false,
                message:
                    error instanceof Error ? error.message : "The conversation was not cleared.",
            };
        }
    }
    if (options.method === "communication") {
        if (!Value.Check(communicationSchema, options.params)) {
            return { error: "KissOpen sent an answer KissOpen Agent could not read." };
        }
        // A dismissal, including one from a phone that could not draw the form,
        // takes the question away rather than answering it with nothing.
        if (options.params.status !== "answered") {
            await options.cancelQuestion(options.params.id);
            return { success: true };
        }
        if (options.params.answers === undefined) {
            return { error: "KissOpen answered a question without any answers." };
        }
        // Normalised first: what is resolved and what is echoed back to every client
        // must both be the shape the clients read.
        await options.answerQuestion(
            options.params.id,
            normalizeKissopenAnswers(options.params.answers),
        );
        return { success: true };
    }
    return { error: "Method not found" };
}

function invalidTerminal(): KissopenTerminalFailure {
    return { success: false, code: "invalid", error: "The terminal request is invalid." };
}

/*
A daemon with no terminals to offer.

Said as unsupported rather than as an empty list: a reader told there are no
terminals would start one, and here there is nowhere to start it.
*/
function terminalUnsupported(): KissopenTerminalFailure {
    return {
        success: false,
        code: "unsupported",
        error: "This session does not offer terminals.",
    };
}

function invalidRead(): KissopenReadFailure {
    return { success: false, code: "invalid", error: "The workspace read request is invalid." };
}
