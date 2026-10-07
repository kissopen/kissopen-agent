import { AsyncResource } from "node:async_hooks";
import { Type } from "@sinclair/typebox";
import type { BotAvatarAsset } from "../bots/index.js";
import type {
    BrowserControlRequest,
    BrowserControlResponse,
} from "@kissopen/kissopen-agent-client";
import {
    KissopenSessionAvatarClient,
    kissopenSessionAvatarSchema,
} from "./KissopenSessionAvatar.js";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";
import type { ProviderUsage } from "@kissopen/kissopen-providers";

import type { UserInputRequest } from "../userInput/index.js";
import {
    createKissopenAgentState,
    rememberKissopenResolvedCommunication,
    toKissopenCommunication,
    type KissopenResolvedCommunication,
} from "./createKissopenAgentState.js";
import {
    createKissopenSessionMetadata,
    MAX_KISSOPEN_ATTACHMENT_BYTES,
} from "./createKissopenSessionMetadata.js";
import { decryptKissopenBlob } from "./crypto/decryptKissopenBlob.js";
import {
    decryptKissopenPayload,
    encryptKissopenPayload,
    wrapKissopenDataKey,
} from "./crypto/kissopenEncryption.js";
import { connectKissopenSocket } from "./connectKissopenSocket.js";
import { KissopenTerminalStream } from "./KissopenTerminalStream.js";
import type { KissopenTerminalOperations } from "./KissopenTerminals.js";
import type { Duplex } from "node:stream";

/**
 * How long one chunk may wait for the far end to take it.
 *
 * Long, because the far end is a window on somebody's desk that may have just
 * woken up; bounded, because a stream nobody is reading has to end rather
 * than hold a terminal's output open for ever.
 */
const STREAM_ACK_MS = 30_000;

/**
 * This session's terminals, as an argument that is either there or absent.
 *
 * Absent rather than undefined: the handler asks whether there is a terminals
 * surface at all, and "explicitly nothing" is a different statement from "no
 * statement", which is what `exactOptionalPropertyTypes` is for.
 */
function terminalsOf(
    operations: KissopenSessionOperations,
    ctx: Context,
    agentId: string,
): { terminals?: KissopenTerminalOperations } {
    const terminals = operations.terminalOperations?.(ctx, agentId);
    return terminals === undefined ? {} : { terminals };
}
import {
    KISSOPEN_SESSION_RPC_METHODS,
    handleKissopenSessionRpc,
} from "./handleKissopenSessionRpc.js";
import type { KissopenConnectionConfiguration } from "./KissopenCredentials.js";
import {
    KissopenMessageRefused,
    type KissopenInboundImage,
    type KissopenInboundMessage,
    type KissopenModel,
    type KissopenSessionSnapshot,
} from "./KissopenSession.js";
import {
    kissopenRemoteMessageId,
    kissopenRemoteMessageSchema,
    type KissopenRemoteMessage,
    type KissopenSessionProtocolMessage,
} from "./KissopenProtocol.js";
import type { KissopenSyncSession } from "./KissopenSync.js";
import type { KissopenSyncDatabase } from "./KissopenSyncDatabase.js";
import { readKissopenRemoteInput } from "./readKissopenRemoteInput.js";
import { isAgentPermissionMode } from "@kissopen/kissopen-agent-base";
import {
    KISSOPEN_RPC_MAX_JSON_BYTES,
    kissopenReadFailure,
    type KissopenGitStateResponse,
    type KissopenReadFileRequest,
    type KissopenListDirectoryRequest,
    type KissopenListDirectoryResponse,
    type KissopenUploadFileRequest,
    type KissopenUploadFileResponse,
    type KissopenReadFileResponse,
    type KissopenReadFileAtRevisionRequest,
    type KissopenReadFileAtRevisionResponse,
} from "./KissopenWorkspaceRead.js";

const HTTP_TIMEOUT_MS = 15_000;
const RETRY_DELAY_MS = 2_000;
/*
How often a working session says so again when nothing else happens.

The keep-alive used to go out only when the session synchronized, which is when
something changed. A run parked on a question, or waiting on a slow model,
changes nothing for minutes, and the relay decides a session it has not heard
from in ten minutes has stopped: the desktop then showed it as not running and
the phone as offline, while the agent was still waiting to be answered.
*/
const WORKING_ALIVE_MS = 60_000;
const OUTBOX_BATCH = 50;
const INCOMING_PAGE = 100;

/** The socket surface this client needs, which is the part of Socket.IO it uses. */
export interface KissopenSocket {
    connected?: boolean;
    connect: () => void;
    disconnect: () => void;
    emit: (event: string, ...values: unknown[]) => void;
    on: (event: string, listener: (...values: any[]) => void) => void;
    /**
     * Sends and waits for the far end's acknowledgement.
     *
     * Only a stream needs this: a chunk is not sent until the far end has
     * taken the one before it, and that wait is the whole of the
     * backpressure. Optional so a test socket may leave it out, and so an
     * older factory still satisfies this interface.
     */
    emitWithAck?: (event: string, payload: unknown, timeoutMs: number) => Promise<unknown>;
}

/**
 * What this client asks of the module it belongs to.
 *
 * Everything a person does on the phone is an act on a conversation, and a conversation is the
 * module's business rather than the socket's. Naming that as a narrow contract is what lets the
 * wire handling here be exercised on its own, without a daemon behind it.
 */
export interface KissopenSessionOperations {
    browserControl?: (
        ctx: Context,
        agentId: string,
        request: BrowserControlRequest,
    ) => Promise<BrowserControlResponse>;
    /** Undefined for project sessions; null explicitly removes a bot's picture. */
    sessionAvatarAsset?: (
        ctx: Context,
        agentId: string,
    ) => Promise<BotAvatarAsset | null | undefined>;
    /** Stops whatever the agent is doing. */
    abort: (ctx: Context, agentId: string) => Promise<void>;

    /** Records what a person answered on the phone. */
    answerQuestion: (
        ctx: Context,
        agentId: string,
        requestId: string,
        answers: Record<string, unknown>,
    ) => Promise<void>;

    /** Ends a session, as the phone's kill switch does. */
    archiveSession: (ctx: Context, sessionId: string) => Promise<void>;
    /** Clears the agent's whole conversation; refused while it works. */
    clearConversation: (ctx: Context, agentId: string) => Promise<void>;

    /** Dismisses a question the person chose not to answer. */
    cancelQuestion: (ctx: Context, agentId: string, requestId: string) => Promise<void>;

    /** The session workspace's changes since its merge base with origin/main. */
    gitState: (ctx: Context, agentId: string) => Promise<KissopenGitStateResponse>;

    /** Every model the phone may offer, across providers. */
    models: () => readonly KissopenModel[];

    /** The questions this agent is waiting on right now. */
    pendingQuestions: (ctx: Context, agentId: string) => Promise<readonly UserInputRequest[]>;

    /** Latest advisory account quota for a provider, when one has been reported. */
    providerUsage: (providerId: string) => ProviderUsage | null;

    /** One bounded current file inside the session's workspace. */
    readFile: (
        ctx: Context,
        agentId: string,
        request: KissopenReadFileRequest,
    ) => Promise<KissopenReadFileResponse>;

    /** One folder of the session's workspace, bounded to its first entries. */
    listDirectory: (
        ctx: Context,
        agentId: string,
        request: KissopenListDirectoryRequest,
    ) => Promise<KissopenListDirectoryResponse>;

    /** One part of a file sent into the session's workspace. */
    uploadFile: (
        ctx: Context,
        agentId: string,
        request: KissopenUploadFileRequest,
    ) => Promise<KissopenUploadFileResponse>;

    /** One bounded historical file at the phone's pinned comparison revision. */
    readFileAtRevision: (
        ctx: Context,
        agentId: string,
        request: KissopenReadFileAtRevisionRequest,
    ) => Promise<KissopenReadFileAtRevisionResponse>;

    /** One session as KISSOPEN needs to describe it, or nothing when it is gone. */
    session: (ctx: Context, agentId: string) => Promise<KissopenSessionSnapshot | undefined>;

    /** Delivers what a person said on the phone, and what they chose to say it with. */
    submit: (ctx: Context, agentId: string, message: KissopenInboundMessage) => Promise<void>;

    /**
     * What may be asked about the terminals standing in this session's folder.
     *
     * Undefined on a daemon that offers none, which is answered as
     * unsupported rather than as an empty list: a reader told there are no
     * terminals would start one, and there would be nowhere to start it.
     */
    terminalOperations?: (ctx: Context, agentId: string) => KissopenTerminalOperations | undefined;

    /**
     * Attaches one stream to a terminal, answering how to detach it.
     *
     * The stream carries the daemon's own attach protocol unchanged, which is
     * the point of routing it rather than re-describing it.
     */
    terminalAttach?: (
        ctx: Context,
        agentId: string,
        terminalId: string,
        stream: Duplex,
    ) => Promise<() => void>;
}

export interface KissopenSessionClientOptions {
    readonly agentId: string;
    readonly configuration: KissopenConnectionConfiguration;
    /** The lifetime this client's own work runs on; it outlives whoever created it. */
    readonly context: Context;
    readonly fetch?: typeof fetch;
    readonly operations: KissopenSessionOperations;
    /** Account-scoped Kissopen project identity, when project reconciliation succeeded. */
    readonly projectId?: () => Promise<string | undefined>;
    readonly sessionId: string;
    /** Only a test supplies this; left out, the client opens its own connection to Kissopen. */
    readonly socketFactory?: (url: string, options: Record<string, unknown>) => KissopenSocket;
    readonly sync: KissopenSyncDatabase;
    readonly version: string;
}

const remoteSessionSchema = Type.Object(
    {
        session: Type.Object(
            {
                agentState: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                agentStateVersion: Type.Optional(Type.Number()),
                avatar: Type.Optional(Type.Unknown()),
                id: Type.String({ minLength: 1 }),
                metadata: Type.Optional(Type.String()),
                metadataVersion: Type.Number(),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const messagePageSchema = Type.Object(
    { hasMore: Type.Optional(Type.Boolean()), messages: Type.Array(Type.Unknown()) },
    { additionalProperties: true },
);

const acknowledgementSchema = Type.Object(
    {
        metadata: Type.Optional(Type.String()),
        result: Type.Optional(Type.String()),
        version: Type.Optional(Type.Number()),
    },
    { additionalProperties: true },
);

const downloadSchema = Type.Object(
    { downloadUrl: Type.String({ minLength: 1 }) },
    { additionalProperties: true },
);

const recordSchema = Type.Record(Type.String(), Type.Unknown());

const rpcRequestSchema = Type.Object(
    { method: Type.String(), params: Type.String() },
    { additionalProperties: true },
);

/**
 * One Kissopen Agent session as it appears on the phone.
 *
 * Everything Kissopen knows about a session goes through here: the session is
 * created, its messages are delivered, what the person sends comes back, and
 * what Kissopen Agent is doing is published as it changes. The loop is deliberately dull —
 * do everything owed, then wait to be told there is more — because that is what
 * makes it safe to interrupt at any point and pick up where it stopped.
 */
export class KissopenSessionClient {
    readonly #options: KissopenSessionClientOptions;
    readonly #closeController = new AbortController();
    readonly #completedQuestions = new Map<string, KissopenResolvedCommunication>();
    readonly #questionFirstSeen = new Map<string, number>();
    readonly #pendingAttachments = new Map<string, Promise<KissopenInboundImage | undefined>>();
    #agentStateVersion: number | undefined;
    #avatarClient: KissopenSessionAvatarClient | undefined;
    #avatarSync: Promise<void> | undefined;
    #avatarRequestedVersion = -1;
    #avatarCompletedVersion = -1;
    #avatarFailures = 0;
    #avatarRetryTimer: NodeJS.Timeout | undefined;
    #workingAliveTimer: NodeJS.Timeout | undefined;
    #archiveStartedAt: number | undefined;
    #archiving = false;
    #closed = false;
    // A new session is created with no agent state, so nothing is owed until a question arrives.
    #lastAgentState: string | undefined = "null";
    #lastMetadata: string | undefined;
    #metadataBase: Record<string, unknown> = {};
    #metadataVersion: number | undefined;
    #projectIdSent: string | undefined;
    #needsAnotherSync = false;
    #retryTimer: NodeJS.Timeout | undefined;
    #sentSessionEnd = false;
    #socket: KissopenSocket | undefined;
    #started = false;
    #summaryTitle: string | undefined;
    #summaryUpdatedAt = Date.now();
    #syncPromise: Promise<void> | undefined;

    constructor(options: KissopenSessionClientOptions) {
        this.#options = options;
    }

    /** Begins keeping this session in step with Kissopen. */
    start(): void {
        if (this.#closed || this.#started) return;
        this.#started = true;
        this.kick();
    }

    /**
     * Says there is something new to send, without waiting for it to be sent.
     *
     * The sending runs outside the caller's asynchronous context. A kick can
     * come from inside the agent's own turn — a question the agent just asked,
     * announced after it was saved — and the sync loop writes the agent's
     * metadata, which the agent refuses from within its own loop. That refusal
     * is about the caller, not the work: the same write from anywhere else
     * goes through, so the loop is started from the context this module was
     * loaded in, where no turn is running.
     */
    kick(): void {
        if (this.#closed) return;
        if (this.#syncPromise !== undefined) {
            this.#needsAnotherSync = true;
            return;
        }
        this.#clearRetry();
        this.#syncPromise = outsideAnyTurn
            .runInAsyncScope(() => this.#runSyncLoop())
            .finally(() => {
                this.#syncPromise = undefined;
            });
    }

    /** Sends everything owed and waits for it, which is what a test or a shutdown needs. */
    async settle(): Promise<void> {
        this.kick();
        await this.#syncPromise;
        await this.#avatarSync;
    }

    /** Tells Kissopen the session has ended, and stops. */
    async archive(): Promise<void> {
        if (this.#closed || this.#archiving) return;
        this.#archiving = true;
        this.#clearRetry();
        this.#clearAvatarRetry();
        try {
            this.kick();
            await this.#syncPromise;
            await this.#sendSessionEnd();
            const remoteSessionId = await this.#remoteSessionId();
            if (remoteSessionId !== undefined) {
                await this.#request(
                    `${this.#options.configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}/archive`,
                    { method: "POST" },
                );
            }
        } catch (error) {
            // Kissopen is optional; the session ends in Kissopen Agent whatever the server says.
            this.#options.context.log.debug("KISSOPEN did not accept the archive.", {}, error);
        } finally {
            await this.close();
        }
    }

    /**
     * Deletes this conversation's copy on KISSOPEN — its messages and files — and stops. It is
     * how a cleared conversation starts over there: the next copy is created from what the agent
     * now holds, which is nothing. A copy KISSOPEN no longer has is already gone; any other
     * refusal is thrown, so the caller does not start a new copy beside an old one.
     */
    async discardRemote(): Promise<void> {
        if (this.#closed) return;
        this.#archiving = true;
        this.#clearRetry();
        this.#clearAvatarRetry();
        try {
            await this.#syncPromise?.catch(() => undefined);
            const remoteSessionId = await this.#remoteSessionId();
            if (remoteSessionId === undefined) return;
            const response = await (this.#options.fetch ?? fetch)(
                `${this.#options.configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}`,
                {
                    method: "DELETE",
                    headers: {
                        Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                        "X-KISSOPEN-Client": `rig/${this.#options.version}`,
                    },
                    signal: this.#signal(),
                },
            );
            if (!response.ok && response.status !== 404) {
                throw new Error(`KissOpen answered with HTTP ${String(response.status)}.`);
            }
        } finally {
            await this.close();
        }
    }

    /** Stops talking to Kissopen and releases everything held for it. */
    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#clearRetry();
        this.#clearAvatarRetry();
        this.#clearWorkingAlive();
        await this.#sendSessionEnd().catch(() => undefined);
        this.#closeController.abort();
        // The attachments first: each holds a replica of a terminal, and the
        // terminal itself lives on without it.
        this.#streamsClose();
        this.#socket?.disconnect();
        this.#socket = undefined;
        await this.#syncPromise?.catch(() => undefined);
        await this.#avatarSync?.catch(() => undefined);
    }

    async #runSyncLoop(): Promise<void> {
        do {
            this.#needsAnotherSync = false;
            try {
                const state = await this.#ensureRemoteSession();
                if (state?.remoteSessionId === undefined || this.#closed) return;
                this.#ensureSocket(state.remoteSessionId);
                await this.#flushOutbox(state);
                if (!this.#archiving) await this.#fetchIncoming(state);
                const snapshot = await this.#session();
                await this.#syncMetadata(state, snapshot);
                this.#sendKeepAlive(state.remoteSessionId, snapshot);
                await this.#syncAgentState(state, snapshot);
                this.#kickAvatar(snapshot);
            } catch (error) {
                this.#options.context.log.debug("KISSOPEN synchronization will retry.", {}, error);
                this.#scheduleRetry();
                return;
            }
        } while (this.#needsAnotherSync && !this.#closed);
    }

    #kickAvatar(snapshot: KissopenSessionSnapshot): void {
        const read = this.#options.operations.sessionAvatarAsset;
        const client = this.#avatarClient;
        if (
            this.#closed ||
            this.#archiving ||
            snapshot.bot === undefined ||
            snapshot.avatarVersion === undefined ||
            client === undefined ||
            read === undefined
        )
            return;
        if (this.#avatarRequestedVersion !== snapshot.avatarVersion) {
            this.#avatarRequestedVersion = snapshot.avatarVersion;
            this.#avatarFailures = 0;
            this.#clearAvatarRetry();
        }
        if (
            this.#avatarSync !== undefined ||
            this.#avatarRetryTimer !== undefined ||
            this.#avatarFailures > 5 ||
            this.#avatarCompletedVersion === this.#avatarRequestedVersion
        )
            return;
        // Image HTTP never holds up message delivery, keepalives, questions, or metadata.
        this.#avatarSync = (async () => {
            while (!this.#closed && this.#avatarCompletedVersion !== this.#avatarRequestedVersion) {
                const activeClient = this.#avatarClient;
                if (this.#archiving || activeClient === undefined) return;
                const version = this.#avatarRequestedVersion;
                const asset = await read.call(
                    this.#options.operations,
                    this.#options.context,
                    this.#options.agentId,
                );
                if (this.#closed) return;
                await activeClient.sync(asset);
                if (this.#avatarClient !== activeClient) continue;
                this.#avatarCompletedVersion = version;
                this.#avatarFailures = 0;
            }
        })()
            .catch((error: unknown) => {
                if (!this.#closed && !this.#archiving) {
                    this.#options.context.log.debug(
                        "KissOpen could not synchronize the session picture.",
                        {},
                        error,
                    );
                    // Optional artwork has its own finite backoff. It never polls chat.
                    this.#avatarFailures++;
                    if (this.#avatarFailures <= 5) {
                        this.#avatarRetryTimer = setTimeout(
                            () => {
                                this.#avatarRetryTimer = undefined;
                                this.#kickAvatar({
                                    ...snapshot,
                                    avatarVersion: this.#avatarRequestedVersion,
                                });
                            },
                            2_000 * 2 ** (this.#avatarFailures - 1),
                        );
                        this.#avatarRetryTimer.unref();
                    }
                }
            })
            .finally(() => {
                this.#avatarSync = undefined;
            });
    }

    #clearAvatarRetry(): void {
        if (this.#avatarRetryTimer !== undefined) clearTimeout(this.#avatarRetryTimer);
        this.#avatarRetryTimer = undefined;
    }

    async #ensureRemoteSession(): Promise<KissopenSyncSession | undefined> {
        const ctx = this.#options.context;
        const current = await this.#options.sync.readSession(ctx, this.#options.agentId);
        if (current === undefined) return undefined;
        const projectId =
            this.#options.projectId === undefined ? undefined : await this.#options.projectId();
        if (
            this.#metadataVersion !== undefined &&
            current.remoteSessionId !== undefined &&
            projectId === this.#projectIdSent
        ) {
            return current;
        }
        const metadata = await this.#metadata();
        const encoded = this.#encode(current, metadata);
        const credentials = this.#options.configuration.credentials;
        const wrappedKey =
            credentials.encryption.type === "dataKey"
                ? Buffer.from(
                      wrapKissopenDataKey(
                          decodeKey(current.encryptionKeyBase64),
                          credentials.encryption.publicKey,
                      ),
                  ).toString("base64")
                : null;
        const response = await this.#request(
            `${this.#options.configuration.serverUrl}/v1/sessions`,
            {
                body: JSON.stringify({
                    agentState: null,
                    dataEncryptionKey: wrappedKey,
                    metadata: encoded,
                    ...(this.#options.projectId === undefined ? {} : { projectId }),
                    tag: current.tag,
                }),
                method: "POST",
            },
        );
        const body: unknown = await response.json();
        if (!Value.Check(remoteSessionSchema, body)) {
            throw new Error("KissOpen returned a session KissOpen Agent could not read.");
        }
        const remote = body.session;
        // Old relays omit avatar entirely. Missing/invalid optional artwork must not break chat.
        if (remote.avatar === null || Value.Check(kissopenSessionAvatarSchema, remote.avatar)) {
            this.#avatarClient = new KissopenSessionAvatarClient({
                configuration: this.#options.configuration,
                state: { ...current, remoteSessionId: remote.id },
                remote: remote.avatar,
                ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
                signal: this.#closeController.signal,
                version: this.#options.version,
            });
            this.#avatarCompletedVersion = -1;
        }
        this.#metadataVersion = remote.metadataVersion;
        this.#projectIdSent = projectId;
        this.#agentStateVersion = remote.agentStateVersion ?? 0;
        // Creating by tag may answer with a session that already existed. State it
        // already holds must be reconciled rather than assumed to match.
        this.#lastAgentState =
            remote.agentState === undefined || remote.agentState === null ? "null" : undefined;
        if (remote.metadata !== undefined) {
            const decoded = this.#decode(current, remote.metadata);
            if (Value.Check(recordSchema, decoded)) this.#metadataBase = decoded;
        }
        if (remote.metadata === encoded) {
            this.#lastMetadata = JSON.stringify(metadata);
            this.#metadataBase = { ...metadata };
        }
        await ctx.inTx(async (txCtx) => {
            await this.#options.sync.setRemoteSession(
                txCtx,
                this.#options.agentId,
                remote.id,
                Date.now(),
            );
        });
        return await this.#options.sync.readSession(ctx, this.#options.agentId);
    }

    #ensureSocket(remoteSessionId: string): void {
        if (this.#socket !== undefined) return;
        const socket = (this.#options.socketFactory ?? connectKissopenSocket)(
            this.#options.configuration.serverUrl,
            {
                auth: {
                    clientType: "session-scoped",
                    kissopenClient: `rig/${this.#options.version}`,
                    sessionId: remoteSessionId,
                    token: this.#options.configuration.credentials.token,
                },
                autoConnect: false,
                path: "/v1/updates",
                reconnection: true,
                transports: ["websocket"],
                withCredentials: true,
            },
        );
        socket.on("connect", () => {
            for (const method of KISSOPEN_SESSION_RPC_METHODS) {
                socket.emit("rpc-register", { method: `${remoteSessionId}:${method}` });
            }
            /*
             * Attaching is registered the same way a call is, because the
             * relay routes both by the same room. What differs is what
             * happens after: this one stays open and carries bytes.
             */
            if (this.#options.operations.terminalAttach)
                socket.emit("rpc-register", { method: `${remoteSessionId}:terminalAttach` });
            this.kick();
        });
        socket.on("update", () => {
            this.kick();
        });
        socket.on("rpc-request", (request: unknown, callback: (response: string) => void) => {
            void this.#handleRpcRequest(remoteSessionId, request, callback);
        });
        socket.on("stream-opened", (request: unknown, callback: (answer: unknown) => void) => {
            void this.#handleStreamOpened(socket, remoteSessionId, request, callback);
        });
        socket.on("stream-data", (payload: unknown, callback?: (answer: unknown) => void) => {
            const { id, chunk } = (payload ?? {}) as { id?: unknown; chunk?: unknown };
            const stream = typeof id === "string" ? this.#streams.get(id) : undefined;
            if (typeof id !== "string" || !stream || !(chunk instanceof Uint8Array)) {
                callback?.({ ok: false, error: "No such stream" });
                return;
            }
            const open = this.#streamOpen.get(id);
            if (open) {
                const plain = open(chunk);
                if (plain === undefined) {
                    // Not sealed under this session's key: not from the peer
                    // that opened it, or not what it agreed to send. The stream
                    // ends here rather than pass bytes of unknown provenance to
                    // a terminal.
                    callback?.({ ok: false, error: "Undecryptable terminal chunk" });
                    stream.finish(
                        "The terminal stream carried a chunk this session could not open.",
                    );
                    return;
                }
                stream.deliver(plain);
                callback?.({ ok: true });
                return;
            }
            stream.deliver(chunk);
            // Acknowledged once it is in the duplex, which is what lets the
            // far end's writer feel this end's pace.
            callback?.({ ok: true });
        });
        socket.on("stream-closed", (payload: unknown) => {
            const { id, error } = (payload ?? {}) as { id?: unknown; error?: unknown };
            if (typeof id !== "string") return;
            const stream = this.#streams.get(id);
            if (!stream) return;
            this.#streams.delete(id);
            stream.finish(typeof error === "string" ? error : undefined);
        });
        this.#socket = socket;
        socket.connect();
    }

    /*
    The terminal attachments this session is holding open.

    Each is one relay stream carrying the daemon's own attach protocol, so
    what is kept here is only the duplex end of it and the call that detaches.
    A socket that goes takes them with it: an attachment whose stream is gone
    is a replica nobody is watching, and the terminal itself lives on without
    it.
    */
    readonly #streams = new Map<string, KissopenTerminalStream>();
    readonly #streamDetach = new Map<string, () => void>();
    /**
     * How to open what arrives on a sealed stream, by stream id.
     *
     * A stream the far end asked to have sealed carries nothing readable: each
     * chunk is a bundle under this session's own key, the same key its calls
     * already travel under, so the relay carries terminal bytes it can no more
     * read than it can read a call. Absent for a stream opened plainly by an
     * older client, which is left as it was rather than broken.
     */
    readonly #streamOpen = new Map<string, (chunk: Uint8Array) => Uint8Array | undefined>();

    /**
     * Takes one attach stream, or says why not.
     *
     * The answer is the relay's: accepting is what makes the stream exist, so
     * a refusal here leaves no half-open thing behind on either side.
     */
    async #handleStreamOpened(
        socket: KissopenSocket,
        remoteSessionId: string,
        request: unknown,
        callback: (answer: unknown) => void,
    ): Promise<void> {
        const { id, method, params } = (request ?? {}) as {
            id?: unknown;
            method?: unknown;
            params?: unknown;
        };
        const attach = this.#options.operations.terminalAttach;
        const { terminalId, cipher } = (params ?? {}) as { terminalId?: unknown; cipher?: unknown };
        if (
            typeof id !== "string" ||
            method !== `${remoteSessionId}:terminalAttach` ||
            typeof terminalId !== "string" ||
            attach === undefined
        ) {
            callback({ ok: false, error: "This session does not attach terminals." });
            return;
        }
        /*
         * Sealing, when asked for. The client names the cipher so that an
         * older client, which names none, keeps the plain stream it expects,
         * and a client naming one this daemon does not speak is told rather
         * than served something it cannot read. What each chunk becomes is a
         * bundle under the session's own key — the same key, in the same
         * format, as every call between these two — carrying the bytes as a
         * base64 field, since the payload format is JSON.
         */
        let seal: ((chunk: Uint8Array) => Uint8Array) | undefined;
        let open: ((chunk: Uint8Array) => Uint8Array | undefined) | undefined;
        if (cipher === "session") {
            const state = await this.#options.sync.readSession(
                this.#options.context,
                this.#options.agentId,
            );
            if (state === undefined) {
                callback({ ok: false, error: "This session has no key to seal a terminal with." });
                return;
            }
            const key = decodeKey(state.encryptionKeyBase64);
            const variant = state.encryptionVariant;
            seal = (chunk) =>
                encryptKissopenPayload(key, variant, { b: Buffer.from(chunk).toString("base64") });
            open = (chunk) => {
                const value = decryptKissopenPayload(key, variant, chunk) as
                    | { b?: unknown }
                    | undefined;
                return typeof value?.b === "string"
                    ? new Uint8Array(Buffer.from(value.b, "base64"))
                    : undefined;
            };
        } else if (cipher !== undefined) {
            callback({ ok: false, error: "This daemon does not speak that terminal cipher." });
            return;
        }

        const stream = new KissopenTerminalStream({
            write: async (chunk) => {
                const send = socket.emitWithAck;
                if (!send) throw new Error("This connection cannot carry a terminal.");
                const sent = (await send.call(
                    socket,
                    "stream-data",
                    { id, chunk: seal ? seal(chunk) : chunk },
                    STREAM_ACK_MS,
                )) as {
                    ok?: boolean;
                    error?: string;
                };
                if (sent?.ok !== true) throw new Error(sent?.error ?? "The stream was refused.");
            },
            close: (error) => {
                socket.emit("stream-close", { id, ...(error ? { error } : {}) });
            },
        });

        try {
            /*
             * Called on the operations themselves, not as the loose function
             * it was read out as: the daemon answers this one from its own
             * terminals, and a call that dropped the receiver would reach for
             * them on nothing.
             */
            const detach = await attach.call(
                this.#options.operations,
                this.#options.context,
                this.#options.agentId,
                terminalId,
                stream,
            );
            this.#streams.set(id, stream);
            this.#streamDetach.set(id, detach);
            if (open) this.#streamOpen.set(id, open);
            stream.once("close", () => this.#streamForget(id));
            callback({ ok: true });
        } catch (error) {
            stream.destroy();
            callback({
                ok: false,
                error: error instanceof Error ? error.message : "The terminal could not be opened.",
            });
        }
    }

    /** Lets go of one attachment, however it ended. */
    #streamForget(id: string): void {
        this.#streams.delete(id);
        this.#streamOpen.delete(id);
        const detach = this.#streamDetach.get(id);
        this.#streamDetach.delete(id);
        detach?.();
    }

    /** Every attachment this session was holding, detached. */
    #streamsClose(): void {
        for (const id of [...this.#streams.keys()]) {
            this.#streams.get(id)?.finish();
            this.#streamForget(id);
        }
    }

    async #flushOutbox(state: KissopenSyncSession): Promise<void> {
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return;
        while (!this.#closed) {
            const pending = await this.#options.sync.pending(
                this.#options.context,
                this.#options.agentId,
                OUTBOX_BATCH,
            );
            if (pending.length === 0) return;
            await this.#request(
                `${this.#options.configuration.serverUrl}/v3/sessions/${encodeURIComponent(remoteSessionId)}/messages`,
                {
                    body: JSON.stringify({
                        messages: pending.map((message) => ({
                            content: this.#encode(state, message.payload),
                            localId: message.localId,
                        })),
                    }),
                    method: "POST",
                },
            );
            await this.#options.context.inTx(async (txCtx) => {
                await this.#options.sync.acknowledge(
                    txCtx,
                    this.#options.agentId,
                    pending.map((message) => message.localId),
                    Date.now(),
                );
            });
        }
    }

    async #fetchIncoming(state: KissopenSyncSession): Promise<void> {
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return;
        let after = state.lastRemoteSeq;
        while (!this.#closed) {
            const url = new URL(
                `${this.#options.configuration.serverUrl}/v3/sessions/${encodeURIComponent(remoteSessionId)}/messages`,
            );
            url.searchParams.set("after_seq", String(after));
            url.searchParams.set("limit", String(INCOMING_PAGE));
            const response = await this.#request(url.toString());
            const body: unknown = await response.json();
            if (!Value.Check(messagePageSchema, body)) {
                throw new Error("KissOpen returned a message page KissOpen Agent could not read.");
            }
            const messages = body.messages.filter((message): message is KissopenRemoteMessage =>
                Value.Check(kissopenRemoteMessageSchema, message),
            );
            let highest = after;
            for (const message of messages) {
                const settled = await this.#handleRemoteMessage(state, message);
                highest = Math.max(highest, message.seq);
                if (settled) await this.#advanceRemoteSequence(highest);
            }
            if (body.hasMore !== true || highest === after) return;
            after = highest;
        }
    }

    async #advanceRemoteSequence(seq: number): Promise<void> {
        await this.#options.context.inTx(async (txCtx) => {
            await this.#options.sync.advanceRemoteSequence(
                txCtx,
                this.#options.agentId,
                seq,
                Date.now(),
            );
        });
    }

    /**
     * Delivers one message from the phone, and says whether it may be marked read.
     *
     * An attachment arrives as its own message just before the words that go with
     * it, so an attachment is held rather than delivered, and the position is not
     * advanced until the message that claims it has been delivered too.
     */
    async #handleRemoteMessage(
        state: KissopenSyncSession,
        message: KissopenRemoteMessage,
    ): Promise<boolean> {
        if (this.#archiving) return false;
        const decrypted = this.#decode(state, message.content.c);
        const incoming = readKissopenRemoteInput(decrypted);
        if (incoming === undefined || incoming.kind === "echo") {
            return this.#pendingAttachments.size === 0;
        }
        if (incoming.kind === "attachment") {
            if (!this.#pendingAttachments.has(message.id)) {
                this.#pendingAttachments.set(
                    message.id,
                    this.#downloadAttachment(state, incoming).catch(() => undefined),
                );
            }
            return false;
        }
        const attachments = await Promise.all(this.#pendingAttachments.values());
        this.#pendingAttachments.clear();
        const permissionMode = incoming.selection.permissionMode;
        try {
            await this.#options.operations.submit(this.#options.context, this.#options.agentId, {
                images: attachments.filter(
                    (attachment): attachment is KissopenInboundImage => attachment !== undefined,
                ),
                remoteMessageId: kissopenRemoteMessageId(message.id),
                selection: {
                    ...(incoming.selection.effort === undefined
                        ? {}
                        : { effort: incoming.selection.effort }),
                    ...(incoming.selection.modelId === undefined
                        ? {}
                        : { modelId: incoming.selection.modelId }),
                    ...(isAgentPermissionMode(permissionMode) ? { permissionMode } : {}),
                    ...(incoming.selection.providerId === undefined
                        ? {}
                        : { providerId: incoming.selection.providerId }),
                },
                text: incoming.text,
                ...(incoming.content === undefined ? {} : { content: incoming.content }),
                ...(incoming.displayText === undefined
                    ? {}
                    : { displayText: incoming.displayText }),
            });
        } catch (error) {
            if (!(error instanceof KissopenMessageRefused)) throw error;
            // Nothing about this message will ever work, so saying why is the whole answer.
            // Leaving it unacknowledged would only have Kissopen redeliver it forever, and every
            // message queued behind it would wait on one this daemon can never take.
            await this.#reportRefusal(message, error.message);
        }
        return true;
    }

    /** Tells the phone, in the conversation, why a message of theirs went nowhere. */
    async #reportRefusal(message: KissopenRemoteMessage, text: string): Promise<void> {
        const id = `refused:${message.id}`;
        const payload: KissopenSessionProtocolMessage = {
            content: {
                ev: { t: "user-message-rejected", ref: message.id, reason: text },
                id,
                role: "agent",
                time: Date.now(),
            },
            localId: `rig:${id}`,
            meta: { sentFrom: "rig" },
            role: "session",
        };
        await this.#options.context.inTx(async (txCtx) => {
            await this.#options.sync.enqueue(
                txCtx,
                this.#options.agentId,
                [{ localId: payload.localId, payload }],
                Date.now(),
            );
        });
        this.kick();
    }

    async #downloadAttachment(
        state: KissopenSyncSession,
        attachment: { mimeType?: string; ref: string; size: number },
    ): Promise<KissopenInboundImage | undefined> {
        if (attachment.size < 0 || attachment.size > MAX_KISSOPEN_ATTACHMENT_BYTES)
            return undefined;
        const remoteSessionId = state.remoteSessionId;
        if (remoteSessionId === undefined) return undefined;
        const response = await this.#request(
            `${this.#options.configuration.serverUrl}/v1/sessions/${encodeURIComponent(remoteSessionId)}/attachments/request-download`,
            { body: JSON.stringify({ ref: attachment.ref }), method: "POST" },
        );
        const body: unknown = await response.json();
        if (!Value.Check(downloadSchema, body)) return undefined;
        const sameServer =
            new URL(body.downloadUrl).origin ===
            new URL(this.#options.configuration.serverUrl).origin;
        const download = await (this.#options.fetch ?? fetch)(body.downloadUrl, {
            ...(sameServer
                ? {
                      headers: {
                          Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                      },
                  }
                : {}),
            signal: this.#signal(),
        });
        if (!download.ok) return undefined;
        const encrypted = new Uint8Array(await download.arrayBuffer());
        if (encrypted.length > MAX_KISSOPEN_ATTACHMENT_BYTES + 64) return undefined;
        const decrypted = decryptKissopenBlob({
            bundle: encrypted,
            encryptionKey: decodeKey(state.encryptionKeyBase64),
            encryptionVariant: state.encryptionVariant,
        });
        if (decrypted === undefined || decrypted.length > MAX_KISSOPEN_ATTACHMENT_BYTES) {
            return undefined;
        }
        const mimeType = attachment.mimeType ?? "image/jpeg";
        // Kissopen Agent can put a picture in front of a model; it cannot do that with a spreadsheet.
        if (!mimeType.startsWith("image/")) return undefined;
        return { data: Buffer.from(decrypted).toString("base64"), mimeType };
    }

    async #handleRpcRequest(
        remoteSessionId: string,
        request: unknown,
        callback: (response: string) => void,
    ): Promise<void> {
        const { sync, context, agentId, sessionId, operations } = this.#options;
        const state = await sync.readSession(context, agentId);
        if (state === undefined) {
            callback("");
            return;
        }
        let answer: unknown;
        const validRequest = Value.Check(rpcRequestSchema, request);
        const workspaceRead =
            validRequest &&
            (request.method === `${remoteSessionId}:gitState` ||
                request.method === `${remoteSessionId}:readFile` ||
                request.method === `${remoteSessionId}:readFileAtRevision` ||
                request.method === `${remoteSessionId}:listDirectory` ||
                request.method === `${remoteSessionId}:uploadFile`);
        try {
            if (this.#archiving) {
                answer = workspaceRead
                    ? { success: false, code: "missing", error: "This session has ended." }
                    : { error: "This session has ended." };
            } else if (!validRequest) {
                answer = { error: "Invalid request" };
            } else {
                const prefix = `${remoteSessionId}:`;
                const params = this.#decode(state, request.params);
                answer = request.method.startsWith(prefix)
                    ? await handleKissopenSessionRpc({
                          ...(operations.browserControl
                              ? {
                                    browserControl: (input: BrowserControlRequest) =>
                                        operations.browserControl!(context, agentId, input),
                                }
                              : {}),
                          abort: () => operations.abort(context, agentId),
                          answerQuestion: (requestId, answers) =>
                              this.#answerQuestion(requestId, answers),
                          archive: () => operations.archiveSession(context, sessionId),
                          clear: () => operations.clearConversation(context, agentId),
                          cancelQuestion: (requestId) => this.#cancelQuestion(requestId),
                          gitState: () => operations.gitState(context, agentId),
                          readFile: (input) => operations.readFile(context, agentId, input),
                          listDirectory: (input) =>
                              operations.listDirectory(context, agentId, input),
                          uploadFile: (input) => operations.uploadFile(context, agentId, input),
                          readFileAtRevision: (input) =>
                              operations.readFileAtRevision(context, agentId, input),
                          ...terminalsOf(operations, context, agentId),
                          method: request.method.slice(prefix.length),
                          params,
                      })
                    : { error: "Invalid request" };
            }
        } catch (error) {
            answer = workspaceRead
                ? kissopenReadFailure(error)
                : { error: error instanceof Error ? error.message : "The request failed." };
        }
        if (Buffer.byteLength(JSON.stringify(answer)) > KISSOPEN_RPC_MAX_JSON_BYTES) {
            answer = {
                success: false,
                code: "too_large",
                error: "This preview is too large for the phone. Open the workspace on your computer.",
            };
        }
        callback(this.#encode(state, answer));
    }

    /**
     * Records an answer that came from the phone.
     *
     * The host validates the answer and refuses a malformed one, so the question
     * is remembered as settled only once it has actually been accepted. A refusal
     * goes back to the phone with the prompt still on screen.
     */
    async #answerQuestion(requestId: string, answers: Record<string, unknown>): Promise<void> {
        const request = await this.#pendingQuestion(requestId);
        if (request === undefined) return;
        const createdAt = this.#firstSeen(requestId);
        await this.#options.operations.answerQuestion(
            this.#options.context,
            this.#options.agentId,
            requestId,
            answers,
        );
        rememberKissopenResolvedCommunication(this.#completedQuestions, requestId, {
            // Echoed back so every phone shows the same answer, including one
            // that is only now catching up with it.
            answers,
            communication: toKissopenCommunication(request, createdAt),
            completedAt: Date.now(),
            status: "answered",
        });
        this.#questionFirstSeen.delete(requestId);
        this.kick();
    }

    async #cancelQuestion(requestId: string): Promise<void> {
        const request = await this.#pendingQuestion(requestId);
        if (request === undefined) return;
        const createdAt = this.#firstSeen(requestId);
        await this.#options.operations.cancelQuestion(
            this.#options.context,
            this.#options.agentId,
            requestId,
        );
        rememberKissopenResolvedCommunication(this.#completedQuestions, requestId, {
            communication: toKissopenCommunication(request, createdAt),
            completedAt: Date.now(),
            status: "cancelled",
        });
        this.#questionFirstSeen.delete(requestId);
        this.kick();
    }

    async #pendingQuestion(requestId: string): Promise<UserInputRequest | undefined> {
        const pending = await this.#options.operations.pendingQuestions(
            this.#options.context,
            this.#options.agentId,
        );
        return pending.find((request) => request.id === requestId);
    }

    async #syncMetadata(
        state: KissopenSyncSession,
        snapshot: KissopenSessionSnapshot,
    ): Promise<void> {
        if (this.#socket?.connected === false || this.#metadataVersion === undefined) return;
        const rigMetadata = this.#metadataFor(snapshot);
        // `activity` is dropped rather than merged forward: an older Kissopen Agent wrote a shape the
        // phone reserves for its own counters, and one key of the wrong shape fails the phone's
        // whole metadata parse.
        let metadata = composeSessionMetadata(this.#metadataBase, rigMetadata);
        let serialized = JSON.stringify(metadata);
        if (serialized === this.#lastMetadata) return;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const answer = await this.#emitWithAck("update-metadata", {
                expectedVersion: this.#metadataVersion,
                metadata: this.#encode(state, metadata),
                sid: state.remoteSessionId,
            });
            if (!Value.Check(acknowledgementSchema, answer)) {
                throw new Error(
                    "KissOpen returned a metadata answer KissOpen Agent could not read.",
                );
            }
            if (answer.result === "success" && answer.version !== undefined) {
                this.#metadataVersion = answer.version;
                this.#lastMetadata = serialized;
                this.#metadataBase = metadata;
                return;
            }
            // Somebody else wrote first. Take their version, put KISSOPEN Agent's own facts
            // back on top of it, and try again.
            if (answer.result === "version-mismatch" && answer.version !== undefined) {
                if (answer.metadata === undefined) {
                    throw new Error("KissOpen reported a metadata conflict without the metadata.");
                }
                const latest = this.#decode(state, answer.metadata);
                if (!Value.Check(recordSchema, latest)) {
                    throw new Error("KissOpen returned metadata KissOpen Agent could not read.");
                }
                this.#metadataVersion = answer.version;
                this.#metadataBase = latest;
                metadata = composeSessionMetadata(latest, rigMetadata);
                serialized = JSON.stringify(metadata);
                continue;
            }
            throw new Error("KissOpen refused the metadata update.");
        }
        throw new Error("KissOpen metadata kept changing underneath KissOpen Agent.");
    }

    /**
     * Publishes what this session is waiting to be told.
     *
     * Without this, a session that asks a question simply stops with nothing on
     * the phone to explain why.
     */
    async #syncAgentState(
        state: KissopenSyncSession,
        snapshot: KissopenSessionSnapshot,
    ): Promise<void> {
        if (this.#socket?.connected === false || this.#agentStateVersion === undefined) return;
        const pending = await this.#options.operations.pendingQuestions(
            this.#options.context,
            this.#options.agentId,
        );
        const pendingIds = new Set(pending.map((request) => request.id));
        for (const requestId of this.#questionFirstSeen.keys()) {
            if (!pendingIds.has(requestId)) this.#questionFirstSeen.delete(requestId);
        }
        const agentState = createKissopenAgentState({
            completed: this.#completedQuestions,
            createdAt: (requestId) => this.#firstSeen(requestId),
            pending,
            usage: this.#options.operations.providerUsage(snapshot.providerId),
        });
        const serialized = JSON.stringify(agentState);
        if (serialized === this.#lastAgentState) return;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const answer = await this.#emitWithAck("update-state", {
                agentState: agentState === null ? null : this.#encode(state, agentState),
                expectedVersion: this.#agentStateVersion,
                sid: state.remoteSessionId,
            });
            if (!Value.Check(acknowledgementSchema, answer)) {
                throw new Error(
                    "KissOpen returned an agent state answer KissOpen Agent could not read.",
                );
            }
            if (answer.result === "success" && answer.version !== undefined) {
                this.#agentStateVersion = answer.version;
                this.#lastAgentState = serialized;
                return;
            }
            // Kissopen owns the version, not the contents: Kissopen Agent is the only writer
            // of question state, so take the version and publish again.
            if (answer.result === "version-mismatch" && answer.version !== undefined) {
                this.#agentStateVersion = answer.version;
                continue;
            }
            throw new Error("KissOpen refused the agent state update.");
        }
        throw new Error("KissOpen agent state kept changing underneath KissOpen Agent.");
    }

    /** When a question was first published, held still so it does not republish forever. */
    #firstSeen(requestId: string): number {
        const existing = this.#questionFirstSeen.get(requestId);
        if (existing !== undefined) return existing;
        const now = Date.now();
        this.#questionFirstSeen.set(requestId, now);
        return now;
    }

    #sendKeepAlive(remoteSessionId: string, snapshot: KissopenSessionSnapshot): void {
        if (this.#archiving) return;
        this.#socket?.emit("session-alive", {
            sid: remoteSessionId,
            thinking: snapshot.working,
            time: Date.now(),
        });
        this.#clearWorkingAlive();
        if (!snapshot.working || this.#closed) return;
        this.#workingAliveTimer = setTimeout(() => {
            this.#workingAliveTimer = undefined;
            if (this.#closed || this.#archiving) return;
            this.#sendKeepAlive(remoteSessionId, snapshot);
        }, WORKING_ALIVE_MS);
        this.#workingAliveTimer.unref();
    }

    #clearWorkingAlive(): void {
        if (this.#workingAliveTimer !== undefined) clearTimeout(this.#workingAliveTimer);
        this.#workingAliveTimer = undefined;
    }

    async #sendSessionEnd(): Promise<void> {
        if (this.#sentSessionEnd || this.#socket === undefined) return;
        const remoteSessionId = await this.#remoteSessionId();
        if (remoteSessionId === undefined) return;
        this.#sentSessionEnd = true;
        this.#socket.emit("session-end", { sid: remoteSessionId, time: Date.now() });
    }

    async #remoteSessionId(): Promise<string | undefined> {
        const state = await this.#options.sync.readSession(
            this.#options.context,
            this.#options.agentId,
        );
        return state?.remoteSessionId;
    }

    async #metadata(): Promise<Record<string, unknown>> {
        return this.#metadataFor(await this.#session());
    }

    #metadataFor(session: KissopenSessionSnapshot): Record<string, unknown> {
        if (session.title !== this.#summaryTitle) {
            this.#summaryTitle = session.title;
            this.#summaryUpdatedAt = Date.now();
        }
        return {
            ...createKissopenSessionMetadata({
                configuration: this.#options.configuration,
                models: this.#options.operations.models(),
                session,
                summaryUpdatedAt: this.#summaryUpdatedAt,
                version: this.#options.version,
            }),
            ...(this.#archiving || session.archived
                ? {
                      archiveReason: "The session was ended in KissOpen Agent.",
                      archivedBy: "rig",
                      lifecycleState: "archived",
                      // Relay echoes must not turn this one transition into a
                      // new metadata write on every pass through the sync loop.
                      lifecycleStateSince: (this.#archiveStartedAt ??= Date.now()),
                  }
                : session.bot === undefined
                  ? {}
                  : { lifecycleState: "active" }),
        } as Record<string, unknown>;
    }

    async #session(): Promise<KissopenSessionSnapshot> {
        const session = await this.#options.operations.session(
            this.#options.context,
            this.#options.agentId,
        );
        if (session === undefined) throw new Error("The session KissOpen is publishing has gone.");
        return session;
    }

    #emitWithAck(event: string, value: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const socket = this.#socket;
            if (socket === undefined) {
                reject(new Error("KissOpen is not connected."));
                return;
            }
            const finish = (settle: () => void) => {
                clearTimeout(timer);
                this.#closeController.signal.removeEventListener("abort", onAbort);
                settle();
            };
            const onAbort = () =>
                finish(() => reject(new Error("KissOpen synchronization stopped.")));
            const timer = setTimeout(
                () => finish(() => reject(new Error("KissOpen did not answer in time."))),
                HTTP_TIMEOUT_MS,
            );
            timer.unref();
            this.#closeController.signal.addEventListener("abort", onAbort, { once: true });
            socket.emit(event, value, (answer: unknown) => finish(() => resolve(answer)));
        });
    }

    async #request(url: string, init: RequestInit = {}): Promise<Response> {
        const response = await (this.#options.fetch ?? fetch)(url, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                "Content-Type": "application/json",
                "X-KISSOPEN-Client": `rig/${this.#options.version}`,
                ...init.headers,
            },
            signal: this.#signal(),
        });
        if (!response.ok)
            throw new Error(`KissOpen answered with HTTP ${String(response.status)}.`);
        return response;
    }

    #signal(): AbortSignal {
        return AbortSignal.any([
            AbortSignal.timeout(HTTP_TIMEOUT_MS),
            this.#closeController.signal,
        ]);
    }

    #encode(state: KissopenSyncSession, value: unknown): string {
        return Buffer.from(
            encryptKissopenPayload(
                decodeKey(state.encryptionKeyBase64),
                state.encryptionVariant,
                value,
            ),
        ).toString("base64");
    }

    #decode(state: KissopenSyncSession, value: string): unknown {
        return decryptKissopenPayload(
            decodeKey(state.encryptionKeyBase64),
            state.encryptionVariant,
            new Uint8Array(Buffer.from(value, "base64")),
        );
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#archiving || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.kick();
        }, RETRY_DELAY_MS);
        this.#retryTimer.unref();
    }

    #clearRetry(): void {
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
    }
}

function decodeKey(value: string): Uint8Array {
    return new Uint8Array(Buffer.from(value, "base64"));
}

/**
 * Puts this daemon's facts on top of whatever else the session metadata carries.
 *
 * `activity` is dropped rather than kept, because an older KISSOPEN Agent wrote a shape the phone
 * reserves for its own counters, and one key of the wrong shape fails the phone's whole metadata
 * parse. `git` and `lastMeaningfulMessageAt` are also daemon-owned: keeping older values when local
 * history and user input have none would make an empty session sort as though it still had that
 * activity, or show a diff the checkout no longer has. The immediately superseded field name is
 * removed instead of leaking into metadata.
 */
function composeSessionMetadata(
    base: Record<string, unknown>,
    rigMetadata: Record<string, unknown>,
): Record<string, unknown> {
    const kept = { ...base };
    delete kept.activity;
    delete kept.lastUserOrAgentTextMessageAt;
    const composed = { ...kept, ...rigMetadata };
    if (rigMetadata.bot !== undefined) {
        delete composed.project;
        delete composed.workspace;
        delete composed.git;
        delete composed.gitBranch;
        if (rigMetadata.lifecycleState === "active") {
            delete composed.archivedBy;
            delete composed.archiveReason;
            delete composed.lifecycleStateSince;
        }
    }
    if (rigMetadata.git === undefined) delete composed.git;
    if (rigMetadata.lastMeaningfulMessageAt === undefined) {
        delete composed.lastMeaningfulMessageAt;
    }
    return composed;
}

/** The asynchronous context this module was loaded in: outside every agent's turn. */
const outsideAnyTurn = new AsyncResource("kissopen-session-sync");
