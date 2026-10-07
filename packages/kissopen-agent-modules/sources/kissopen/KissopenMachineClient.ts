import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { connectKissopenSocket } from "./connectKissopenSocket.js";
import {
    createKissopenMachineMetadata,
    type KissopenMachineMetadata,
} from "./createKissopenMachineMetadata.js";
import { readKissopenCliMachineId } from "./credentials/readKissopenCliMachineId.js";
import {
    decryptKissopenPayload,
    encryptKissopenPayload,
    wrapKissopenDataKey,
} from "./crypto/kissopenEncryption.js";
import {
    handleKissopenSpawnSession,
    type KissopenSpawnOperations,
    type KissopenSpawnResult,
} from "./handleKissopenSpawnSession.js";
import type {
    KissopenConnectionConfiguration,
    KissopenEncryptionVariant,
} from "./KissopenCredentials.js";
import type { KissopenModel } from "./KissopenSession.js";
import type { KissopenSocket } from "./KissopenSessionClient.js";
import { readKissopenProjectFile } from "./readKissopenProjectFile.js";

const HTTP_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 5_000;
const KEEP_ALIVE_INTERVAL_MS = 20_000;

/** How long a spawned session is given to be published before the phone is told to wait. */
const SPAWN_PUBLISH_TIMEOUT_MS = 10_000;

export interface KissopenMachineClientOptions {
    readonly configuration: KissopenConnectionConfiguration;
    /** The lifetime this client's own work runs on; it outlives whoever created it. */
    readonly context: Context;
    readonly fetch?: typeof fetch;
    readonly operations: KissopenSpawnOperations;
    readonly models: () => readonly KissopenModel[];
    readonly onConnectionChanged?: (event: KissopenMachineConnectionEvent) => void;
    /** The session KISSOPEN should open, once KISSOPEN Agent has published it. */
    readonly remoteSessionId: (agentId: string) => Promise<string | undefined>;
    /**
     * Archives the conversation a KISSOPEN session belongs to, by the session's id there.
     * Asked through the machine rather than the session, so it works for a conversation
     * this agent holds no live connection for — one it archived itself, or one past the
     * connection limit — which KISSOPEN would otherwise list and never be able to close.
     */
    readonly archiveRemoteSession?: (remoteSessionId: string) => Promise<boolean>;
    /** Only a test supplies this; left out, the client opens its own connection to KISSOPEN. */
    readonly socketFactory?: (url: string, options: Record<string, unknown>) => KissopenSocket;
    readonly version: string;
}

export type KissopenMachineConnectionEvent =
    | { readonly status: "connected" }
    | { readonly status: "connecting" }
    | {
          readonly message: string;
          readonly reason: "credentials_rejected" | "kissopen_unavailable";
          readonly status: "disconnected";
      };

class KissopenMachineRegistrationError extends Error {
    readonly credentialsRejected: boolean;

    constructor(credentialsRejected: boolean) {
        super(
            credentialsRejected
                ? "KissOpen rejected the saved credentials."
                : "The KissOpen machine connection is unavailable.",
        );
        this.name = "KissopenMachineRegistrationError";
        this.credentialsRejected = credentialsRejected;
    }
}

const machineSchema = Type.Object(
    {
        machine: Type.Object(
            {
                daemonStateVersion: Type.Number(),
                metadata: Type.Optional(Type.String()),
                metadataVersion: Type.Number(),
            },
            { additionalProperties: true },
        ),
    },
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

const rpcRequestSchema = Type.Object(
    { method: Type.String(), params: Type.String() },
    { additionalProperties: true },
);

const recordSchema = Type.Record(Type.String(), Type.Unknown());

/**
 * This computer, as it appears in KISSOPEN.
 *
 * A machine is what a person picks before there is any session to pick: it says
 * this KISSOPEN Agent is here, what it can run, and that it will start something new when
 * asked. It keeps itself registered and reachable for as long as the daemon runs.
 */
export class KissopenMachineClient {
    readonly #options: KissopenMachineClientOptions;
    readonly #closeController = new AbortController();
    readonly #machineId: string;
    #closed = false;
    #keepAliveTimer: NodeJS.Timeout | undefined;
    #metadataBase: Record<string, unknown> = {};
    #metadataVersion = 0;
    #retryTimer: NodeJS.Timeout | undefined;
    #siblingMachineId: string | undefined;
    #socket: KissopenSocket | undefined;
    #connectionKey = "";
    /**
     * Which socket the client is currently living with.
     *
     * A socket cannot be unsubscribed from, so a torn-down one keeps its
     * listeners and its in-flight acknowledgements. Every handler and callback
     * carries the generation it was created under and does nothing once that
     * generation has passed.
     */
    #generation = 0;
    /** A registration request is in flight, so a second `start` would duplicate it. */
    #registering = false;

    constructor(options: KissopenMachineClientOptions) {
        const machineId = options.configuration.machineId;
        if (machineId === undefined) {
            throw new Error("KissOpen Agent has no KissOpen machine identity to register.");
        }
        this.#machineId = machineId;
        this.#options = options;
    }

    /** Registers this computer with KISSOPEN and keeps it reachable. */
    start(): void {
        if (
            this.#closed ||
            this.#registering ||
            this.#socket !== undefined ||
            this.#retryTimer !== undefined
        ) {
            return;
        }
        this.#registering = true;
        this.#announce({ status: "connecting" });
        void this.#registerAndConnect().then(
            () => {
                this.#registering = false;
            },
            (error: unknown) => {
                this.#registering = false;
                const credentialsRejected =
                    error instanceof KissopenMachineRegistrationError && error.credentialsRejected;
                this.#announce({
                    message: credentialsRejected
                        ? "KissOpen rejected the saved credentials."
                        : "The KissOpen machine connection is unavailable.",
                    reason: credentialsRejected ? "credentials_rejected" : "kissopen_unavailable",
                    status: "disconnected",
                });
                if (credentialsRejected) {
                    this.#options.context.log.debug(
                        "KissOpen machine registration rejected the saved credentials.",
                        {},
                        error,
                    );
                } else {
                    this.#options.context.log.debug(
                        "KissOpen machine registration will retry.",
                        {},
                        error,
                    );
                    this.#scheduleRetry();
                }
            },
        );
    }

    /** Stops appearing in KISSOPEN and releases everything held for it. */
    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#closeController.abort();
        if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
        this.#teardownSocket();
    }

    /** Refreshes a CLI linked after the desktop QR, without restarting any Agent work. */
    async refreshSibling(): Promise<void> {
        const sibling = await this.#readSibling();
        if (this.#closed) return;
        this.#siblingMachineId = sibling;
        const socket = this.#socket;
        if (socket?.connected && this.#metadataBase.siblingMachineId !== sibling) {
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(
                    () =>
                        reject(
                            new Error(
                                "KissOpen could not confirm the CLI machine link. Try again.",
                            ),
                        ),
                    HTTP_TIMEOUT_MS,
                );
                this.#syncMetadata(socket, this.#generation, this.#metadataVersion, 0, (error) => {
                    clearTimeout(timeout);
                    if (error) reject(error);
                    else resolve();
                });
            });
        }
        // An absent CLI is normal for Agent-only setups. An existing but unverified CLI
        // must not make an explicit desktop refresh look like successful dual linking.
        const cliHome = this.#options.configuration.cliHome;
        if (
            sibling === undefined &&
            cliHome !== undefined &&
            (await readKissopenCliMachineId(cliHome)) !== undefined
        ) {
            throw new Error(
                "KissOpen CLI must use the same V2 account and server as KissOpen Agent. Existing sign-ins were kept.",
            );
        }
    }

    #readSibling(): Promise<string | undefined> {
        const configuration = this.#options.configuration;
        return configuration.cliHome === undefined
            ? Promise.resolve(undefined)
            : readKissopenCliMachineId(configuration.cliHome, configuration);
    }

    async #registerAndConnect(): Promise<void> {
        // KISSOPEN CLI may have been installed since this daemon last registered, so who this
        // machine is paired with is read again every time the pairing is published.
        this.#siblingMachineId = await this.#readSibling();
        const metadata = this.#metadata();
        const encryption = this.#options.configuration.credentials.encryption;
        const dataEncryptionKey =
            encryption.type === "dataKey"
                ? Buffer.from(
                      wrapKissopenDataKey(encryption.machineKey, encryption.publicKey),
                  ).toString("base64")
                : undefined;
        const response = await (this.#options.fetch ?? fetch)(
            `${this.#options.configuration.serverUrl}/v1/machines`,
            {
                body: JSON.stringify({
                    daemonState: this.#encode(this.#daemonState()),
                    ...(dataEncryptionKey === undefined ? {} : { dataEncryptionKey }),
                    id: this.#machineId,
                    metadata: this.#encode(metadata),
                }),
                headers: {
                    Authorization: `Bearer ${this.#options.configuration.credentials.token}`,
                    "Content-Type": "application/json",
                    "X-KISSOPEN-Client": `rig-daemon/${this.#options.version}`,
                },
                method: "POST",
                signal: AbortSignal.any([
                    AbortSignal.timeout(HTTP_TIMEOUT_MS),
                    this.#closeController.signal,
                ]),
            },
        );
        if (!response.ok) {
            throw new KissopenMachineRegistrationError(
                response.status === 401 || response.status === 403,
            );
        }
        const body: unknown = await response.json();
        if (!Value.Check(machineSchema, body)) {
            throw new Error("KissOpen returned a machine KissOpen Agent could not read.");
        }
        if (this.#closed) return;
        const remote = this.#decode(body.machine.metadata);
        if (Value.Check(recordSchema, remote)) this.#metadataBase = remote;
        this.#connect(body.machine.metadataVersion, body.machine.daemonStateVersion);
    }

    #connect(metadataVersion: number, daemonStateVersion: number): void {
        this.#metadataVersion = metadataVersion;
        const generation = ++this.#generation;
        const socket = (this.#options.socketFactory ?? connectKissopenSocket)(
            this.#options.configuration.serverUrl,
            {
                auth: {
                    clientType: "machine-scoped",
                    kissopenClient: `rig-daemon/${this.#options.version}`,
                    machineId: this.#machineId,
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
            if (!this.#isCurrent(generation)) return;
            this.#announce({ status: "connected" });
            socket.emit("rpc-register", { method: `${this.#machineId}:spawn-kissopen-session` });
            if (this.#options.archiveRemoteSession !== undefined) {
                socket.emit("rpc-register", {
                    method: `${this.#machineId}:archive-kissopen-session`,
                });
            }
            // A project's board is drawn on other devices from here too, since
            // no conversation in that project may be connected when they look.
            socket.emit("rpc-register", {
                method: `${this.#machineId}:read-kissopen-project-file`,
            });
            this.#syncMetadata(socket, generation, metadataVersion, 0);
            this.#syncDaemonState(socket, generation, daemonStateVersion, 0);
            this.#sendAlive(socket);
        });
        socket.on("rpc-request", (request: unknown, callback: (response: string) => void) => {
            if (!this.#isCurrent(generation)) return;
            void this.#handleRpcRequest(request, callback);
        });
        socket.on("disconnect", () => {
            if (!this.#isCurrent(generation)) return;
            // Socket.IO reconnects a dropped connection itself, and the machine
            // registration it was built on is still good, so this only reports.
            this.#announce({
                message: "The connection to KissOpen was lost.",
                reason: "kissopen_unavailable",
                status: "disconnected",
            });
        });
        socket.on("connect_error", () => {
            if (!this.#isCurrent(generation)) return;
            this.#announce({
                message: "The KissOpen machine connection is unavailable.",
                reason: "kissopen_unavailable",
                status: "disconnected",
            });
            // A connection that never opened may have been refused by the
            // registration behind it, so the socket is abandoned and the whole
            // registration is made again rather than reconnected blindly.
            this.#teardownSocket();
            this.#scheduleRetry();
        });
        this.#socket = socket;
        this.#keepAliveTimer = setInterval(() => this.#sendAlive(socket), KEEP_ALIVE_INTERVAL_MS);
        this.#keepAliveTimer.unref();
        socket.connect();
    }

    /** Abandons the current socket, so nothing it says afterwards is acted on. */
    #teardownSocket(): void {
        if (this.#keepAliveTimer !== undefined) clearInterval(this.#keepAliveTimer);
        this.#keepAliveTimer = undefined;
        this.#generation += 1;
        const socket = this.#socket;
        this.#socket = undefined;
        socket?.disconnect();
    }

    /** Whether the socket a handler belongs to is still the one in use. */
    #isCurrent(generation: number): boolean {
        return !this.#closed && generation === this.#generation;
    }

    async #handleRpcRequest(request: unknown, callback: (response: string) => void): Promise<void> {
        if (
            Value.Check(rpcRequestSchema, request) &&
            request.method === `${this.#machineId}:read-kissopen-project-file`
        ) {
            callback(this.#encode(await readKissopenProjectFile(this.#decode(request.params))));
            return;
        }
        if (
            Value.Check(rpcRequestSchema, request) &&
            request.method === `${this.#machineId}:archive-kissopen-session` &&
            this.#options.archiveRemoteSession !== undefined
        ) {
            const params = this.#decode(request.params) as { sessionId?: unknown } | undefined;
            const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
            let archived = false;
            try {
                archived =
                    sessionId !== "" && (await this.#options.archiveRemoteSession(sessionId));
            } catch {
                archived = false;
            }
            callback(
                this.#encode(
                    archived
                        ? { success: true }
                        : { success: false, message: "That conversation is not on this machine." },
                ),
            );
            return;
        }
        let answer: KissopenSpawnResult;
        if (
            !Value.Check(rpcRequestSchema, request) ||
            request.method !== `${this.#machineId}:spawn-kissopen-session`
        ) {
            answer = {
                errorMessage: "KissOpen sent a request KissOpen Agent does not serve.",
                type: "error",
            };
        } else {
            answer = await handleKissopenSpawnSession({
                ctx: this.#options.context,
                operations: this.#options.operations,
                machineId: this.#machineId,
                models: this.#options.models(),
                params: this.#decode(request.params),
                remoteSessionId: (agentId) => this.#awaitRemoteSession(agentId),
                signal: this.#closeController.signal,
            });
        }
        callback(this.#encode(answer));
    }

    /**
     * Waits briefly for a freshly started session to reach KISSOPEN.
     *
     * Publishing takes a round trip of its own, and the phone is holding a
     * request open, so this waits only as long as is reasonable and then tells
     * the phone to ask again rather than leaving it hanging.
     */
    async #awaitRemoteSession(agentId: string): Promise<string | undefined> {
        const deadline = Date.now() + SPAWN_PUBLISH_TIMEOUT_MS;
        while (Date.now() < deadline && !this.#closed) {
            const remoteSessionId = await this.#options.remoteSessionId(agentId);
            if (remoteSessionId !== undefined) return remoteSessionId;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 250);
                timer.unref();
            });
        }
        return undefined;
    }

    #metadata(): KissopenMachineMetadata {
        return createKissopenMachineMetadata({
            configuration: this.#options.configuration,
            models: this.#options.models(),
            ...(this.#siblingMachineId === undefined
                ? {}
                : { siblingMachineId: this.#siblingMachineId }),
            version: this.#options.version,
        });
    }

    #syncMetadata(
        socket: KissopenSocket,
        generation: number,
        version: number,
        attempt: number,
        settled?: (error?: Error) => void,
    ): void {
        if (!this.#isCurrent(generation) || attempt >= 3) {
            settled?.(new Error("KissOpen could not update the CLI machine link. Try again."));
            return;
        }
        const { siblingMachineId: _previousSibling, ...base } = this.#metadataBase;
        const metadata = {
            ...base,
            ...this.#metadata(),
            // The name is the person's to choose, so Kissopen Agent never writes over it.
            ...(typeof this.#metadataBase.displayName === "string"
                ? { displayName: this.#metadataBase.displayName }
                : {}),
        };
        socket.emit(
            "machine-update-metadata",
            {
                expectedVersion: version,
                machineId: this.#machineId,
                metadata: this.#encode(metadata),
            },
            (answer: unknown) => {
                if (!this.#isCurrent(generation)) return;
                if (!Value.Check(acknowledgementSchema, answer)) return;
                if (answer.result === "success") {
                    this.#metadataBase = metadata;
                    this.#metadataVersion = answer.version ?? version + 1;
                    settled?.();
                    return;
                }
                if (answer.result === "version-mismatch" && answer.version !== undefined) {
                    const latest = this.#decode(answer.metadata);
                    if (Value.Check(recordSchema, latest)) this.#metadataBase = latest;
                    this.#syncMetadata(socket, generation, answer.version, attempt + 1, settled);
                } else {
                    settled?.(
                        new Error("KissOpen did not accept the CLI machine link. Try again."),
                    );
                }
            },
        );
    }

    #syncDaemonState(
        socket: KissopenSocket,
        generation: number,
        version: number,
        attempt: number,
    ): void {
        if (!this.#isCurrent(generation) || attempt >= 3) return;
        socket.emit(
            "machine-update-state",
            {
                daemonState: this.#encode(this.#daemonState()),
                expectedVersion: version,
                machineId: this.#machineId,
            },
            (answer: unknown) => {
                if (!this.#isCurrent(generation)) return;
                if (
                    Value.Check(acknowledgementSchema, answer) &&
                    answer.result === "version-mismatch" &&
                    answer.version !== undefined
                ) {
                    this.#syncDaemonState(socket, generation, answer.version, attempt + 1);
                }
            },
        );
    }

    #sendAlive(socket: KissopenSocket): void {
        socket.emit("machine-alive", { machineId: this.#machineId, time: Date.now() });
    }

    #daemonState(): Record<string, unknown> {
        return { pid: process.pid, startedAt: Date.now(), status: "running" };
    }

    #scheduleRetry(): void {
        if (this.#closed || this.#retryTimer !== undefined) return;
        this.#retryTimer = setTimeout(() => {
            this.#retryTimer = undefined;
            this.start();
        }, RETRY_INTERVAL_MS);
        this.#retryTimer.unref();
    }

    #announce(event: KissopenMachineConnectionEvent): void {
        if (this.#closed) return;
        const key =
            event.status === "disconnected"
                ? `${event.status}:${event.reason}:${event.message}`
                : event.status;
        if (this.#connectionKey === key) return;
        this.#connectionKey = key;
        this.#options.onConnectionChanged?.(event);
    }

    #encode(value: unknown): string {
        return Buffer.from(encryptKissopenPayload(this.#key(), this.#variant(), value)).toString(
            "base64",
        );
    }

    #decode(value: string | undefined): unknown {
        if (value === undefined) return undefined;
        return decryptKissopenPayload(
            this.#key(),
            this.#variant(),
            new Uint8Array(Buffer.from(value, "base64")),
        );
    }

    #key(): Uint8Array {
        const encryption = this.#options.configuration.credentials.encryption;
        return encryption.type === "dataKey" ? encryption.machineKey : encryption.secret;
    }

    #variant(): KissopenEncryptionVariant {
        return this.#options.configuration.credentials.encryption.type;
    }
}
