import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { createId } from "@paralleldrive/cuid2";
import type { ExpertModule } from "../expert/index.js";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { messageDisplayMetadata } from "@kissopen/kissopen-agent-client";
import type {
    KissopenIntegration,
    KissopenIntegrationError,
} from "@kissopen/kissopen-agent-client";
import type {
    BrowserControlRequest,
    BrowserControlResponse,
    BrowserOperation,
    BrowserResult,
} from "@kissopen/kissopen-agent-client";
import { KissopenBrowser } from "./KissopenBrowser.js";
import { browserTool } from "./browserTool.js";
import { generatePasswordTool } from "./generatePasswordTool.js";
import {
    agentDatabase,
    agentPermissionModeSchema,
    currentAgentEnvironment,
    withAgentDatabase,
    type AgentBaseMessageOptions,
    type AgentConfig,
    type AgentModuleHooks,
    type AgentSystemRef,
} from "@kissopen/kissopen-agent-base";
import type { AgentEvent, EventsModuleListener } from "../events/index.js";
import { ComputeModule } from "../compute/index.js";
import { BotsModule } from "../bots/index.js";
import { EventsModule } from "../events/index.js";
import { ProjectFilesModule, type ProjectFileRoot } from "../files/index.js";
import { GitModule, type GitChangeSnapshot, type GitTrackedEntity } from "../git/index.js";
import {
    HistoryModule,
    type HistoryMessage,
    type HistoryMessageMode,
    type HistoryPendingMessage,
    type HistoryToolPresentation,
} from "../history/index.js";
import { generatedFileRoot } from "../impl/images/generatedFileRoot.js";
import { USER_MESSAGE_ORIGIN_METADATA } from "../impl/messageOrigin.js";
import { ProjectsModule, type Project } from "../projects/index.js";
import { ProviderUsageModule } from "../providerUsage/index.js";
import { SchedulingModule } from "../scheduling/index.js";
import { UserInputModule, type UserInputRequest } from "../userInput/index.js";
import { WorkspacesModule } from "../workspaces/index.js";
import { TeamModule, type TeamUser } from "../team/index.js";
import { ConfigModule } from "../config/index.js";
import type { SessionInputBlock, SessionUserMessage } from "@kissopen/kissopen-providers";
import { afterCommit, detach, mapAsyncLock, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import {
    importKissopenCredentials,
    inspectDaemonKissopenCredentials,
    readExternalKissopenCredentialFingerprint,
} from "./credentials/importKissopenCredentials.js";
import { getKissopenPaths } from "./credentials/getKissopenPaths.js";
import {
    resolveKissopenConnectionTarget,
    type KissopenConnectionTarget,
} from "./credentials/resolveKissopenConnectionTarget.js";
import { saveKissopenPairingCredentials } from "./credentials/saveKissopenPairingCredentials.js";
import { createKissopenIntegrationVersion } from "./createKissopenIntegrationVersion.js";
import { createKissopenIntegrationDatabase } from "./KissopenIntegrationDatabase.js";
import type {
    KissopenSpawnOperations,
    KissopenSpawnResult,
    KissopenSpawnStartResult,
} from "./handleKissopenSpawnSession.js";
import type { KissopenConnectionConfiguration } from "./KissopenCredentials.js";
import {
    KissopenMachineClient,
    type KissopenMachineConnectionEvent,
} from "./KissopenMachineClient.js";
import { KissopenPairing, KissopenPairingError } from "./KissopenPairing.js";
import { KissopenProjectClient } from "./KissopenProjectClient.js";
import {
    buildProjectBoardResultSchema,
    buildProjectBoardTool,
    type BuildProjectBoardResult,
} from "./buildProjectBoardTool.js";
import {
    KissopenMessageRefused,
    type KissopenInboundMessage,
    type KissopenModel,
    type KissopenSessionSnapshot,
    type KissopenSpawnRequest,
} from "./KissopenSession.js";
import { KissopenSessionClient, type KissopenSessionOperations } from "./KissopenSessionClient.js";
import {
    KissopenTerminalRefused,
    terminalAnswer,
    terminalScopeOfRoot,
    terminalView,
    terminalsAnswer,
    type KissopenTerminalOperations,
} from "./KissopenTerminals.js";
import type { TerminalScope, TerminalsModule } from "../terminals/index.js";
import type { Duplex } from "node:stream";
import { createKissopenSyncDatabase } from "./KissopenSyncDatabase.js";
import { createKissopenProjectSyncDatabase } from "./KissopenProjectSyncDatabase.js";
import { KissopenMessageMapper, kissopenToolEndRun } from "./mapKissopenMessages.js";
import { kissopenAuthorOf, type KissopenAuthor } from "./KissopenProtocol.js";
import { resolveKissopenUserInputAnswers } from "./resolveKissopenUserInputAnswers.js";
import {
    KISSOPEN_READ_MAX_BYTES,
    KISSOPEN_READ_PART_MAX_BYTES,
    KISSOPEN_READ_PARTS_MAX_FILE_BYTES,
    KissopenReadRefused,
    type KissopenGitStateResponse,
    type KissopenReadFileRequest,
    type KissopenDirectoryEntry,
    type KissopenListDirectoryRequest,
    type KissopenListDirectoryResponse,
    type KissopenUploadFileRequest,
    type KissopenUploadFileResponse,
    KISSOPEN_LIST_MAX_ENTRIES,
    type KissopenReadFileAtRevisionRequest,
    type KissopenReadFileResponse,
    type KissopenReadFileAtRevisionResponse,
} from "./KissopenWorkspaceRead.js";

/** How many agents one daemon keeps connected to Kissopen at once. */
const MAX_CONNECTED_AGENTS = 64;

/** How many archived messages a newly attached Kissopen session receives as its initial context. */
const KISSOPEN_BACKFILL_MESSAGES = 50;

/** Terminal RPC answers remembered for fast retries during one daemon lifetime. */
const MAX_SERVED_SPAWN_RESULTS = 1_024;

/** Old projections inspected on restart so an archive event missed while offline still converges. */
const MAX_REAPED_SYNC_SESSIONS = 4_096;

/** Keeps Kissopen-owned Git subscriptions inside GitModule's bounded lease. */
const GIT_TRACK_RENEWAL_MS = 60_000;

const kissopenSelectionSchema = Type.Object(
    {
        effort: Type.String({ minLength: 1, maxLength: 64 }),
        modelId: Type.String({ minLength: 1, maxLength: 256 }),
        permissionMode: agentPermissionModeSchema,
        providerId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);

const acceptedEventPayloadSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 256 }),
        kind: Type.String({ minLength: 1, maxLength: 256 }),
        runId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: true },
);

type KissopenSelection = Static<typeof kissopenSelectionSchema>;
type WithoutIntegrationSnapshotFields<Value> = Value extends unknown
    ? Omit<Value, "updatedAt" | "version">
    : never;
type KissopenIntegrationValue = WithoutIntegrationSnapshotFields<KissopenIntegration>;

interface KissopenSelectionModel {
    readonly effortLevels: readonly string[];
    readonly id: string;
    readonly providerId: string;
}

const kissopenMetadataSchema = Type.Object(
    { kissopen: kissopenSelectionSchema },
    { additionalProperties: true },
);

interface ConnectedAgent {
    readonly client: KissopenSessionClient;
    readonly mapper: KissopenMessageMapper;
}

export type KissopenIntegrationListener = (
    ctx: Context,
    integration: KissopenIntegration,
    ownerId?: string,
) => Promise<void> | void;

export class KissopenIntegrationStartError extends Error {
    readonly code: "kissopen_unavailable" | "unsupported";
    readonly integration: KissopenIntegration;

    constructor(
        code: "kissopen_unavailable" | "unsupported",
        message: string,
        integration: KissopenIntegration,
    ) {
        super(message);
        this.name = "KissopenIntegrationStartError";
        this.code = code;
        this.integration = integration;
    }
}

/**
 * The connection between this daemon and KISSOPEN, the mobile app.
 *
 * KISSOPEN speaks directly in Agent Base identities: a KISSOPEN session ID is its agent ID. It keeps no
 * second conversation catalog. Project and workspace ownership stays in those catalogs, while the
 * agent configuration is the durable source for its working directory and selected model.
 */
/** The provider whose credential reaches the KISSOPEN business server. */
const SCHEDULE_PROVIDER_ID = "kissopen";
/** Long enough for the server to read the sentence with a model and save it. */
const SCHEDULE_REQUEST_TIMEOUT_MS = 45_000;

export class KissopenConnection implements KissopenSessionOperations, KissopenSpawnOperations {
    readonly #browser = new KissopenBrowser();

    async browserControl(
        _ctx: Context,
        agentId: string,
        request: BrowserControlRequest,
    ): Promise<BrowserControlResponse> {
        return this.#browser.control(agentId, request);
    }

    async browserExecute(
        _ctx: Context,
        agentId: string,
        operation: BrowserOperation,
    ): Promise<BrowserResult> {
        return this.#browser.execute(agentId, operation);
    }
    readonly #agents = new Map<string, ConnectedAgent>();
    readonly #config: ConfigModule;
    readonly #expert: ExpertModule | undefined;
    readonly #bots: BotsModule;
    readonly #botUpdates = mapAsyncLock<string>();
    readonly #compute: ComputeModule;
    readonly #events: EventsModule;
    readonly #files: ProjectFilesModule;
    /*
     * The daemon's own terminals. Optional because a build without them is a
     * build that answers "this session does not offer terminals", which is a
     * different thing from a session that happens to have none open.
     */
    readonly #terminals: TerminalsModule | undefined;
    readonly #git: GitModule;
    readonly #history: HistoryModule;
    readonly #scheduling: SchedulingModule;
    readonly #projects: ProjectsModule;
    readonly #providerUsage: ProviderUsageModule;
    readonly #userInput: UserInputModule;
    readonly #workspaces: WorkspacesModule;
    readonly #sync: ReturnType<typeof createKissopenSyncDatabase>;
    readonly #projectSync: ReturnType<typeof createKissopenProjectSyncDatabase>;
    readonly #integrationDatabase: ReturnType<typeof createKissopenIntegrationDatabase>;
    readonly #connectionOwner: TeamUser | undefined;
    readonly #team: TeamModule | undefined;
    readonly #integrationListeners = new Set<KissopenIntegrationListener>();
    readonly #served = new Map<string, KissopenSpawnResult>();
    readonly #tasks = new Set<Promise<void>>();
    readonly #archivingAgents = new Map<string, Promise<void>>();
    readonly #retiredAgents = new Set<string>();
    readonly #gitEntityByAgent = new Map<string, GitTrackedEntity>();
    readonly #gitAgentsByEntity = new Map<string, Set<string>>();
    #agentSystem: AgentSystemRef<LibSQLDatabase> | undefined;
    #configuration: KissopenConnectionConfiguration | undefined;
    #context: Context | undefined;
    #fingerprint = "";
    #integration: KissopenIntegration;
    #pairing: KissopenPairing | undefined;
    #pairingGeneration = 0;
    #projectClient: KissopenProjectClient | undefined;
    #integrationStart: Promise<KissopenIntegration> | undefined;
    #integrationUpdates: Promise<void> = Promise.resolve();
    #lifecycleUpdates: Promise<void> = Promise.resolve();
    #gitRenewalTimer: NodeJS.Timeout | undefined;
    #machine: KissopenMachineClient | undefined;
    #reconcilePromise: Promise<void> | undefined;
    #stopping = false;
    readonly #unwatchCatalog: (() => void)[] = [];

    constructor(
        config: ConfigModule,
        compute: ComputeModule,
        events: EventsModule,
        git: GitModule,
        history: HistoryModule,
        projects: ProjectsModule,
        providerUsage: ProviderUsageModule,
        scheduling: SchedulingModule,
        userInput: UserInputModule,
        workspaces: WorkspacesModule,
        bots: BotsModule,
        files: ProjectFilesModule,
        team?: TeamModule,
        owner?: TeamUser,
        /*
         * Last, and optional, because this constructor is positional and
         * every caller of it would otherwise have to be rewritten to add one
         * capability. A daemon that has terminals passes them.
         */
        terminals?: TerminalsModule,
        expert?: ExpertModule,
    ) {
        this.#team = team;
        this.#expert = expert;
        this.#connectionOwner = owner;
        this.#sync = createKissopenSyncDatabase(owner?.id);
        this.#projectSync = createKissopenProjectSyncDatabase(owner?.id);
        this.#integrationDatabase = createKissopenIntegrationDatabase(owner?.id);
        this.#config = config;
        this.#compute = compute;
        this.#events = events;
        this.#files = files;
        this.#git = git;
        this.#history = history;
        this.#projects = projects;
        this.#providerUsage = providerUsage;
        this.#scheduling = scheduling;
        this.#userInput = userInput;
        this.#workspaces = workspaces;
        this.#bots = bots;
        this.#terminals = terminals;
        const now = Date.now();
        this.#integration = {
            authorization: null,
            configured: false,
            error: null,
            status: config.configuration.values.settings.kissopenIntegration
                ? "disconnected"
                : "disabled",
            updatedAt: now,
            version: createKissopenIntegrationVersion(undefined, () => now),
        };
    }

    /** Projects every durable agent event into KISSOPEN's outbox. */
    readonly eventsListener: EventsModuleListener = {
        onEvent: (_ctx: Context, event: AgentEvent): void => {
            if (event.agentId === undefined) return;
            this.#agents.get(event.agentId)?.client.kick();
        },
        onEventTransactional: async (ctx: Context, event: AgentEvent): Promise<void> => {
            if (event.agentId === undefined) return;
            if (this.#configuration === undefined) return;
            const attached = await this.#attach(ctx, event.agentId);
            if (attached === undefined) return;
            const accepted =
                event.type !== "message.accepted" ||
                !Value.Check(acceptedEventPayloadSchema, event.payload)
                    ? undefined
                    : await this.#history.message(ctx, event.agentId, event.payload.id);
            const author = accepted === undefined ? undefined : await this.#authorOf(ctx, accepted);
            /*
             * What the run's tools produced, as History recorded it. The live tool-end event
             * names its call and how it displays; the picture a generation made is in the
             * durable result, which is written in this same transaction, so it is read here
             * rather than carried on the event.
             */
            const toolEnd = kissopenToolEndRun(event);
            const presentations =
                toolEnd === undefined
                    ? undefined
                    : historyToolPresentations(
                          await this.#history.assistantMessage(ctx, event.agentId, toolEnd.runId),
                      );
            await this.#sync.projectEvent(ctx, {
                agentId: event.agentId,
                eventId: event.id,
                messages: attached.mapper
                    .map(event, accepted, author, presentations)
                    .map((message) => ({
                        localId: message.localId,
                        payload: message,
                    })),
                now: Date.now(),
            });
        },
    };

    /**
     * Names who wrote a user message, for the phone to attribute it.
     *
     * Only a team deployment has more than one person in a session, and only then does History
     * record which team user submitted a message. Standalone installations have no author to
     * name, so nothing is attached and the phone shows the message as its own — which it is.
     * The owner flag compares against the team user this connection publishes through, because
     * that user's own phone is the one reading the session.
     */
    async #authorOf(ctx: Context, message: HistoryMessage): Promise<KissopenAuthor | undefined> {
        if (message.role !== "user" || message.userId === undefined) return undefined;
        if (this.#team === undefined) return undefined;
        const user = await this.#team.getUser(ctx, message.userId);
        if (user === undefined) return undefined;
        return kissopenAuthorOf(user, this.#connectionOwner);
    }

    /**
     * Resolves authors for a page of history at once, so a backfill does not ask the team store
     * once per message. Absent users, and everything in a standalone installation, stay unnamed.
     */
    async #historyAuthors(
        ctx: Context,
        messages: readonly HistoryMessage[],
    ): Promise<(message: HistoryMessage) => KissopenAuthor | undefined> {
        if (this.#team === undefined) return () => undefined;
        const ids = new Set<string>();
        for (const message of messages) {
            if (message.role === "user" && message.userId !== undefined) ids.add(message.userId);
        }
        if (ids.size === 0) return () => undefined;
        const users = await this.#team.getUsers(ctx, [...ids]);
        const authors = new Map(
            users.map((user) => [user.id, kissopenAuthorOf(user, this.#connectionOwner)] as const),
        );
        return (message) =>
            message.role === "user" && message.userId !== undefined
                ? authors.get(message.userId)
                : undefined;
    }

    start(ctx: Context, agents: AgentSystemRef<LibSQLDatabase>): AgentModuleHooks {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("KissOpen was started without an agent database.");
        }
        this.#context = withAgentDatabase(detach(ctx).named("kissopen"), database);
        if (this.#connectionOwner !== undefined && this.#team !== undefined) {
            this.#context = this.#team.connectionContext(this.#context, this.#connectionOwner);
        }
        this.#agentSystem = agents;
        return {
            afterStart: async (startedCtx) => await this.#connect(startedCtx),
            // A subagent answers whoever created it and then stops; it has no person to set a
            // task up for.
            tools: async (toolsCtx, scope) =>
                (await agents.parentOf(toolsCtx, scope.agent.id)) === null
                    ? [
                          browserTool((callCtx, operation) =>
                              this.browserExecute(callCtx, scope.agent.id, operation),
                          ),
                          generatePasswordTool(),
                          buildProjectBoardTool(
                              async (callCtx) =>
                                  await this.buildProjectBoard(callCtx, scope.agent.id),
                          ),
                      ]
                    : [],
        };
    }

    /**
     * Starts the building of the board of the project this agent works in, as the board page's
     * 生成看板 does. Asked of the business server with the agent's own credential, like a scheduled
     * task; the build runs where the project is. Never throws.
     */
    async buildProjectBoard(ctx: Context, agentId: string): Promise<BuildProjectBoardResult> {
        const provider = this.#config.configuration.values.providers[SCHEDULE_PROVIDER_ID];
        const baseUrl = provider?.type === "codex" ? provider.baseUrl?.trim() : undefined;
        const apiKey = provider?.type === "codex" ? provider.apiKey?.trim() : undefined;
        if (!baseUrl || !apiKey)
            return { status: "failed", error: "这台设备还没有连接 一起卷 账号。" };
        const cwd = (await this.#compute.resolve(ctx, agentId).catch(() => undefined))?.cwd ?? "";
        const project = (await this.#owner(ctx, agentId).catch(() => undefined))?.project;
        if (project?.kind !== "regular" || cwd === "")
            return { status: "failed", error: "只有项目里的对话能构建看板。" };
        let url: string;
        try {
            const parsed = new URL(baseUrl);
            parsed.search = "";
            parsed.hash = "";
            parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/boards/build`;
            url = parsed.toString();
        } catch {
            return { status: "failed", error: "一起卷 服务地址不正确。" };
        }
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    accept: "application/json",
                    "content-type": "application/json",
                    authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    machine_id: this.#configuration?.machineId ?? "",
                    project_path: cwd,
                    project_name: project.name || basename(cwd),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                }),
                signal: AbortSignal.timeout(SCHEDULE_REQUEST_TIMEOUT_MS),
            });
            const body = (await response.json().catch(() => undefined)) as
                | Record<string, unknown>
                | undefined;
            if (response.ok && Value.Check(buildProjectBoardResultSchema, body)) return body;
            const error =
                typeof body?.error === "string" ? body.error : `服务返回 ${response.status}`;
            return { status: "failed", error };
        } catch (error) {
            ctx.log.warn("The project board could not be started.", {}, error);
            return { status: "failed", error: "现在连不上 一起卷，稍后再试。" };
        }
    }

    async #connect(ctx: Context): Promise<void> {
        const context = this.#context;
        if (context === undefined) return;
        await this.#initializeIntegration(context);
        const blockedCredentialFingerprints = new Set(
            (await this.#integrationDatabase.read(context)).blockedCredentialFingerprints,
        );
        if (!this.#config.configuration.values.settings.kissopenIntegration) {
            const configuration = await inspectDaemonKissopenCredentials({
                blockedCredentialFingerprints,
                dataDirectory: this.#dataDirectory,
                environment: this.#config.kissopenEnvironment,
            });
            this.#configuration = configuration;
            await this.#setIntegration(context, {
                authorization: null,
                configured: configuration !== undefined,
                error: null,
                status: "disabled",
            });
            ctx.log.debug("KISSOPEN synchronization is turned off in the configuration.");
            return;
        }
        const configuration = await importKissopenCredentials({
            adoptExternalCredentials: this.#connectionOwner === undefined,
            blockedCredentialFingerprints,
            dataDirectory: this.#dataDirectory,
            environment: this.#config.kissopenEnvironment,
        });
        if (configuration === undefined) {
            this.#configuration = undefined;
            await this.#setIntegration(context, {
                authorization: null,
                configured: false,
                error: null,
                status: "disconnected",
            });
            ctx.log.debug("KISSOPEN is not connected on this machine.");
            return;
        }
        await this.#activate(context, configuration);
    }

    async #initializeIntegration(ctx: Context): Promise<void> {
        const updatedAt = Date.now();
        const version = await this.#integrationDatabase.reserveVersion(ctx, () => updatedAt);
        this.#integration = { ...this.#integration, updatedAt, version };
    }

    /**
     * Keeps what the phone has been told about these sessions true as work is renamed and put away.
     *
     * Where a session may start is not published here. The phone reads that from the sessions
     * themselves, so a project is only ever described by the sessions that belong to it.
     */
    #watchCatalog(ctx: Context): void {
        this.#unwatchCatalog.push(
            this.#bots.onEvent((_eventCtx, event) => {
                // Re-read after earlier archival finishes. An event can already be stale by the
                // time the network catches up, especially when a bot is immediately restored.
                this.#runTask(
                    async () =>
                        await this.#botUpdates.runInLock(ctx, event.bot.agentId, async () => {
                            await this.#archivingAgents.get(event.bot.agentId);
                            const bot = await this.#bots.forAgent(ctx, event.bot.agentId);
                            if (bot === undefined) return;
                            if (bot.status === "archived") {
                                const archive = await this.#archiveRemoteProjection(
                                    ctx,
                                    bot.agentId,
                                );
                                await archive?.completion;
                                return;
                            }
                            this.#retiredAgents.delete(bot.agentId);
                            const attached = await ctx.inTx(
                                async (txCtx) => await this.#attach(txCtx, bot.agentId),
                            );
                            attached?.client.kick();
                        }),
                );
            }),
        );
        this.#unwatchCatalog.push(
            this.#git.onSnapshot((_eventCtx, entity) => {
                for (const agentId of this.#gitAgentsByEntity.get(gitEntityKey(entity)) ?? []) {
                    this.#agents.get(agentId)?.client.kick();
                }
            }),
        );
        this.#gitRenewalTimer ??= setInterval(() => {
            for (const entity of this.#gitEntityByAgent.values()) this.#git.track(entity);
        }, GIT_TRACK_RENEWAL_MS);
        this.#gitRenewalTimer.unref();
        this.#unwatchCatalog.push(
            this.#projects.onEvent((_eventCtx, event) => {
                this.#runTask(async () => {
                    await this.#syncProjectEvent(ctx, event.project);
                    if (event.type === "project_archived") {
                        await this.#archiveRemoteAgents(
                            ctx,
                            await this.#projects.listAgentIds(ctx, event.project.id),
                        );
                    }
                    await this.#reapArchived(ctx);
                    await this.#republishAttached(ctx);
                });
            }),
        );
        this.#unwatchCatalog.push(
            this.#workspaces.onEvent((_eventCtx, event) => {
                this.#runTask(async () => {
                    if (
                        (event.type === "workspace_updated" && event.change === "begin_archive") ||
                        event.type === "workspace_archived"
                    ) {
                        await this.#archiveRemoteAgents(
                            ctx,
                            await this.#workspaces.listAgentIds(ctx, event.workspace.id),
                        );
                    }
                    await this.#reapArchived(ctx);
                    await this.#republishAttached(ctx);
                });
            }),
        );
        this.#unwatchCatalog.push(
            this.#userInput.onEvent((_eventCtx, event) => {
                this.#agents.get(event.request.askingAgentId)?.client.kick();
            }),
        );
        // A conversation cleared anywhere — here, the desktop, the phone — starts over on
        // KISSOPEN too, or its old messages would stay there for every client to read.
        this.#unwatchCatalog.push(
            this.#history.onCleared((_clearedCtx, agentId) => {
                void this.#runTask(async () => await this.#restartRemoteConversation(agentId));
            }),
        );
        this.#unwatchCatalog.push(
            this.#providerUsage.onChanged(() => {
                for (const connected of this.#agents.values()) connected.client.kick();
            }),
        );
    }

    /** Stops talking to KISSOPEN, which the daemon does as it shuts down. */
    async stop(): Promise<void> {
        this.#browser.close();
        this.#stopping = true;
        this.#pairingGeneration += 1;
        this.#integrationStart = undefined;
        const pairing = this.#pairing;
        this.#pairing = undefined;
        pairing?.close();
        // Cleanup must run after any lifecycle transition that already passed its stopping check.
        // Otherwise an authorization settling concurrently with shutdown could create a machine
        // client after the direct cleanup had already finished.
        await this.#withLifecycleUpdate(async () => await this.#closeKissopenClients());
        await this.#integrationUpdates;
    }

    /** Reads this owner's Kissopen mobile integration snapshot. */
    async integration(_ctx: Context): Promise<KissopenIntegration> {
        return this.#integration;
    }

    /** Watches complete integration snapshot replacements. */
    onIntegrationUpdated(listener: KissopenIntegrationListener): () => void {
        this.#integrationListeners.add(listener);
        return () => {
            this.#integrationListeners.delete(listener);
        };
    }

    /** Starts or joins Kissopen authorization and connection work. */
    async startIntegration(ctx: Context): Promise<KissopenIntegration> {
        if (!this.#config.configuration.values.settings.kissopenIntegration) {
            throw new KissopenIntegrationStartError(
                "unsupported",
                "The KissOpen integration is disabled in this daemon.",
                this.#integration,
            );
        }
        const existing = this.#integrationStart;
        if (existing !== undefined) return await existing;
        const generation = this.#pairingGeneration;
        const started = this.#startIntegration(this.#context ?? ctx, generation);
        this.#integrationStart = started;
        try {
            return await started;
        } finally {
            if (this.#integrationStart === started) this.#integrationStart = undefined;
        }
    }

    async #startIntegration(ctx: Context, generation: number): Promise<KissopenIntegration> {
        if (this.#stopping || generation !== this.#pairingGeneration) return this.#integration;
        if (this.#pairing !== undefined) return this.#integration;
        if (this.#configuration !== undefined) {
            if (this.#machine === undefined) {
                const outcome = await this.#withLifecycleUpdate(async () => {
                    if (this.#stopping || generation !== this.#pairingGeneration) return "stale";
                    if (this.#pairing !== undefined) return "activated";
                    if (this.#configuration === undefined) return "pair";
                    if (this.#machine !== undefined) {
                        this.#machine.start();
                        return "activated";
                    }
                    const blockedCredentialFingerprints = new Set(
                        (await this.#integrationDatabase.read(ctx)).blockedCredentialFingerprints,
                    );
                    const refreshed = await importKissopenCredentials({
                        adoptExternalCredentials: this.#connectionOwner === undefined,
                        blockedCredentialFingerprints,
                        dataDirectory: this.#dataDirectory,
                        environment: this.#config.kissopenEnvironment,
                    });
                    if (this.#stopping || generation !== this.#pairingGeneration) return "stale";
                    if (refreshed === undefined) {
                        this.#configuration = undefined;
                        return "pair";
                    }
                    await this.#activate(ctx, refreshed);
                    return "activated";
                });
                if (outcome !== "pair") return this.#integration;
            } else {
                if (this.#stopping || generation !== this.#pairingGeneration) {
                    return this.#integration;
                }
                this.#machine.start();
                await this.#machine.refreshSibling();
                return this.#integration;
            }
        }
        if (this.#stopping || generation !== this.#pairingGeneration) return this.#integration;
        return await this.#beginPairing(ctx, generation);
    }

    /** Cancels the current QR attempt without changing durable credentials. */
    async cancelIntegration(ctx: Context): Promise<KissopenIntegration> {
        this.#pairingGeneration += 1;
        this.#integrationStart = undefined;
        const pairing = this.#pairing;
        this.#pairing = undefined;
        pairing?.close();
        return await this.#withLifecycleUpdate(async () => {
            if (this.#integration.status !== "pairing") return this.#integration;
            return await this.#setIntegration(this.#context ?? ctx, {
                authorization: null,
                configured: false,
                error: null,
                status: "disconnected",
            });
        });
    }

    /** Unlinks the daemon-owned Kissopen account without changing the external Kissopen CLI. */
    async disconnectIntegration(ctx: Context): Promise<KissopenIntegration> {
        // A real unlink cancels control immediately, even while earlier lifecycle
        // work settles. An already-unlinked reconciliation is not a user stop.
        if (this.#pairing !== undefined || !isUnlinkedIntegration(this.#integration))
            this.#browser.close();
        this.#pairingGeneration += 1;
        this.#integrationStart = undefined;
        const pairing = this.#pairing;
        const hadActivePairing = pairing !== undefined;
        this.#pairing = undefined;
        pairing?.close();
        return await this.#withLifecycleUpdate(async () => {
            // Idempotence covers credential suppression too. Once this daemon is already
            // unlinked, a repeated request must not tombstone a genuinely new external login.
            if (!hadActivePairing && isUnlinkedIntegration(this.#integration)) {
                return this.#integration;
            }
            // Only an actual account transition revokes desktop capabilities. Account
            // reconciliation may repeat unlink after the desktop acquired a fresh local
            // lease; that idempotent no-op must not tear down unrelated browser work.
            this.#browser.close();
            const context = this.#context ?? ctx;
            await this.#rememberUnlinkedCredentials(context, true);
            await this.#closeKissopenClients();
            this.#configuration = undefined;
            this.#fingerprint = "";
            const credentialsPath = getKissopenPaths(this.#dataDirectory).credentialsPath;
            await rm(credentialsPath, { force: true }).catch((error: unknown) => {
                context.log.debug(
                    "KissOpen credentials could not be removed while unlinking.",
                    {},
                    error,
                );
            });
            return await this.#setIntegration(context, {
                authorization: null,
                configured: false,
                error: null,
                status: this.#config.configuration.values.settings.kissopenIntegration
                    ? "disconnected"
                    : "disabled",
            });
        });
    }

    /** Replaces any current Kissopen authorization with a fresh QR attempt. */
    async rePairIntegration(ctx: Context): Promise<KissopenIntegration> {
        if (!this.#config.configuration.values.settings.kissopenIntegration) {
            throw new KissopenIntegrationStartError(
                "unsupported",
                "The KissOpen integration is disabled in this daemon.",
                this.#integration,
            );
        }
        await this.disconnectIntegration(ctx);
        return await this.startIntegration(ctx);
    }

    async #beginPairing(ctx: Context, generation: number): Promise<KissopenIntegration> {
        const database = agentDatabase(ctx);
        if (database === undefined) {
            throw new Error("KissOpen pairing was started without an agent database.");
        }
        const target = await resolveKissopenConnectionTarget({
            adoptExternalSettings: this.#connectionOwner === undefined,
            dataDirectory: this.#dataDirectory,
            environment: this.#config.kissopenEnvironment,
        });
        let pairing: KissopenPairing;
        try {
            pairing = await KissopenPairing.start({
                serverUrl: target.serverUrl,
                version: this.#config.configuration.version,
            });
            // Ownership can be invalidated before the lifecycle queue accepts this pairing.
            // Mark rejection as observed immediately; #settlePairing still handles the original
            // promise whenever this attempt becomes the module's active pairing.
            void pairing.result.catch(() => undefined);
        } catch (error: unknown) {
            if (generation !== this.#pairingGeneration || this.#stopping) {
                return this.#integration;
            }
            ctx.log.debug("KISSOPEN authorization could not be started.", {}, error);
            throw new KissopenIntegrationStartError(
                "kissopen_unavailable",
                "KissOpen is unavailable. Please try again.",
                this.#integration,
            );
        }
        return await this.#withLifecycleUpdate(async () => {
            if (this.#stopping || generation !== this.#pairingGeneration) {
                pairing.close();
                return this.#integration;
            }
            this.#pairing = pairing;
            await this.#setIntegration(ctx, {
                authorization: pairing.authorization,
                configured: false,
                error: null,
                status: "pairing",
            });
            let pairingContext = withAgentDatabase(detach(ctx).named("kissopen-pairing"), database);
            if (this.#team !== undefined && this.#connectionOwner !== undefined) {
                pairingContext = this.#team.connectionContext(
                    pairingContext,
                    this.#connectionOwner,
                );
            }
            void this.#settlePairing(pairingContext, pairing, target);
            return this.#integration;
        });
    }

    async #settlePairing(
        ctx: Context,
        pairing: KissopenPairing,
        target: KissopenConnectionTarget,
    ): Promise<void> {
        try {
            const credentials = await pairing.result;
            await this.#withLifecycleUpdate(async () => {
                if (this.#pairing !== pairing || this.#stopping) return;
                await saveKissopenPairingCredentials(target, credentials);
                await this.#integrationDatabase.clearBlockedCredentialFingerprints(ctx);
                const configuration = await importKissopenCredentials({
                    adoptExternalCredentials: false,
                    includeExternalCliHome: this.#connectionOwner === undefined,
                    dataDirectory: this.#dataDirectory,
                    environment: this.#config.kissopenEnvironment,
                });
                if (configuration === undefined) {
                    throw new KissopenPairingError(
                        "invalid_response",
                        "The saved KissOpen credentials could not be loaded.",
                    );
                }
                this.#pairing = undefined;
                await this.#activate(this.#context ?? ctx, configuration);
            });
        } catch (error: unknown) {
            await this.#withLifecycleUpdate(async () => {
                if (this.#pairing !== pairing || this.#stopping) return;
                this.#pairing = undefined;
                const projected = pairingError(error);
                ctx.log.debug(
                    "KissOpen authorization did not complete.",
                    { code: projected.code },
                    error,
                );
                await this.#setIntegration(ctx, {
                    authorization: null,
                    configured: false,
                    error: projected,
                    status: "failed",
                });
            });
        }
    }

    async #activate(ctx: Context, configuration: KissopenConnectionConfiguration): Promise<void> {
        await this.#closeKissopenClients();
        this.#configuration = configuration;
        this.#fingerprint = fingerprint(configuration);
        await this.#setIntegration(ctx, {
            authorization: null,
            configured: true,
            error: null,
            status: "connecting",
        });
        if (configuration.machineId === undefined) {
            await this.#setIntegration(ctx, {
                authorization: null,
                configured: true,
                error: {
                    code: "invalid_response",
                    message: "KissOpen Agent could not create its KissOpen machine identity.",
                },
                status: "failed",
            });
            return;
        }
        let machine!: KissopenMachineClient;
        machine = new KissopenMachineClient({
            configuration,
            context: ctx,
            models: () => this.models(),
            onConnectionChanged: (event) => {
                void this.#handleMachineConnection(ctx, machine, event).catch((error: unknown) => {
                    ctx.log.error("KISSOPEN connection state could not be recorded.", {}, error);
                });
            },
            operations: this,
            remoteSessionId: async (agentId) =>
                (await this.#sync.readSession(ctx, agentId))?.remoteSessionId,
            archiveRemoteSession: async (remoteSessionId) => {
                const agentId = await this.#sync.agentForRemoteSession(ctx, remoteSessionId);
                if (agentId === undefined) return false;
                await this.archiveSession(ctx, agentId);
                return true;
            },
            version: this.#config.configuration.version,
        });
        this.#machine = machine;
        this.#projectClient = new KissopenProjectClient({
            ...(this.#connectionOwner === undefined ? {} : { ownerId: this.#connectionOwner.id }),
            avatarAsset: async (assetCtx, projectId) =>
                await this.#projects.avatarAsset(assetCtx, projectId),
            configuration,
            context: ctx,
            sync: this.#projectSync,
            version: this.#config.configuration.version,
        });
        machine.start();
        this.#watchCatalog(ctx);
        const reconcile = (async () => {
            await this.#reconcileProjects(ctx);
            await this.#reapArchived(ctx);
            await this.#reconcile(ctx);
        })().catch((error: unknown) => {
            ctx.log.debug("KISSOPEN could not restore its visible sessions.", {}, error);
        });
        this.#reconcilePromise = reconcile;
        void reconcile.finally(() => {
            if (this.#reconcilePromise === reconcile) this.#reconcilePromise = undefined;
        });
    }

    async #handleMachineConnection(
        ctx: Context,
        machine: KissopenMachineClient,
        event: KissopenMachineConnectionEvent,
    ): Promise<void> {
        if (this.#machine !== machine || this.#stopping) return;
        if (event.status === "connected") {
            await this.#setIntegration(ctx, {
                authorization: null,
                configured: true,
                error: null,
                status: "connected",
            });
            return;
        }
        if (event.status === "connecting") {
            // Registration retries remain one stable disconnected snapshot until they succeed.
            if (this.#integration.status === "disconnected") return;
            await this.#setIntegration(ctx, {
                authorization: null,
                configured: true,
                error: null,
                status: "connecting",
            });
            return;
        }
        if (event.reason === "credentials_rejected") {
            await this.#withLifecycleUpdate(
                async () => await this.#invalidateCredentials(ctx, machine, event.message),
            );
            return;
        }
        await this.#setIntegration(ctx, {
            authorization: null,
            configured: true,
            error: { code: "kissopen_unavailable", message: event.message },
            status: "disconnected",
        });
    }

    async #invalidateCredentials(
        ctx: Context,
        machine: KissopenMachineClient,
        message: string,
    ): Promise<void> {
        if (this.#machine !== machine) return;
        const credentialsPath = this.#configuration?.credentialsPath;
        await this.#rememberUnlinkedCredentials(ctx, false);
        await this.#closeKissopenClients();
        this.#configuration = undefined;
        this.#fingerprint = "";
        if (credentialsPath !== undefined) {
            await rm(credentialsPath, { force: true }).catch((error: unknown) => {
                ctx.log.debug("Rejected KISSOPEN credentials could not be removed.", {}, error);
            });
        }
        await this.#setIntegration(ctx, {
            authorization: null,
            configured: false,
            error: { code: "credentials_rejected", message },
            status: "failed",
        });
    }

    async #setIntegration(
        ctx: Context,
        value: KissopenIntegrationValue,
    ): Promise<KissopenIntegration> {
        return await this.#withIntegrationUpdate(async () => {
            if (sameIntegration(this.#integration, value, this.#configuration?.machineId ?? null))
                return this.#integration;
            const updatedAt = Date.now();
            const version = await this.#integrationDatabase.reserveVersion(
                this.#context ?? ctx,
                () => updatedAt,
            );
            // The registered machine id rides on every snapshot: a client next
            // to this daemon needs it to tell this machine from the others in
            // the account's roster, and only the daemon knows it.
            const machineId = this.#configuration?.machineId ?? null;
            const integration = { ...value, machineId, updatedAt, version } as KissopenIntegration;
            this.#integration = integration;
            await Promise.all(
                [...this.#integrationListeners].map(
                    async (listener) => await listener(ctx, integration, this.#connectionOwner?.id),
                ),
            );
            return integration;
        });
    }

    async #rememberUnlinkedCredentials(
        ctx: Context,
        suppressCurrentExternalCredential: boolean,
    ): Promise<void> {
        const owned = await inspectDaemonKissopenCredentials({
            dataDirectory: this.#dataDirectory,
            environment: this.#config.kissopenEnvironment,
        });
        const external =
            this.#connectionOwner === undefined
                ? await readExternalKissopenCredentialFingerprint({
                      environment: this.#config.kissopenEnvironment,
                  })
                : undefined;
        const ownedFingerprints = [
            this.#configuration?.credentialFingerprint,
            owned?.credentialFingerprint,
        ].filter((value): value is string => value !== undefined);
        const fingerprints = [
            ...ownedFingerprints,
            ...(external !== undefined &&
            (suppressCurrentExternalCredential || ownedFingerprints.includes(external))
                ? [external]
                : []),
        ];
        if (fingerprints.length === 0) return;
        await this.#integrationDatabase.addBlockedCredentialFingerprints(ctx, fingerprints);
    }

    async #closeKissopenClients(): Promise<void> {
        if (this.#gitRenewalTimer !== undefined) clearInterval(this.#gitRenewalTimer);
        this.#gitRenewalTimer = undefined;
        for (const unwatch of this.#unwatchCatalog.splice(0)) unwatch();
        this.#projectClient = undefined;
        this.#machine?.close();
        this.#machine = undefined;
        await this.#reconcilePromise?.catch(() => undefined);
        await this.#settleTasks();
        const connected = [...this.#agents.values()];
        this.#agents.clear();
        this.#served.clear();
        this.#archivingAgents.clear();
        this.#retiredAgents.clear();
        this.#gitEntityByAgent.clear();
        this.#gitAgentsByEntity.clear();
        await Promise.all(connected.map(async (agent) => await agent.client.close()));
    }

    async #withIntegrationUpdate<Value>(operation: () => Promise<Value>): Promise<Value> {
        const run = this.#integrationUpdates.then(operation);
        this.#integrationUpdates = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    async #withLifecycleUpdate<Value>(operation: () => Promise<Value>): Promise<Value> {
        const run = this.#lifecycleUpdates.then(operation);
        this.#lifecycleUpdates = run.then(
            () => undefined,
            () => undefined,
        );
        return await run;
    }

    /** Sends everything owed and waits for it, which is what a shutdown and a test need. */
    async settle(): Promise<void> {
        await this.#reconcilePromise;
        await this.#settleTasks();
        await Promise.all(
            [...this.#agents.values()].map(async (agent) => await agent.client.settle()),
        );
    }

    async #settleTasks(): Promise<void> {
        while (this.#tasks.size > 0) {
            await Promise.allSettled([...this.#tasks]);
        }
    }

    #runTask(work: () => Promise<void>): Promise<void> {
        if (this.#stopping) return Promise.resolve();
        const task = work()
            .catch((error: unknown) => {
                this.#context?.log.debug("KISSOPEN catalog synchronization failed.", {}, error);
            })
            .finally(() => {
                this.#tasks.delete(task);
            });
        this.#tasks.add(task);
        return task;
    }

    /** Configuration owns the private storage location for each mobile connection. */
    get #dataDirectory(): string {
        return this.#connectionOwner === undefined
            ? this.#config.configuration.paths.agentHome
            : this.#config.kissopenMobileDataDirectory(this.#connectionOwner.id);
    }

    /** Every model the phone may offer, across providers. */
    models(): readonly KissopenModel[] {
        return this.#config.models.map((model) => ({
            defaultEffort: model.defaultEffort,
            effortLevels: [...model.effortLevels],
            id: model.id,
            name: model.name,
            providerId: model.providerId,
            serviceTiers: model.serviceTiers === undefined ? [] : [...model.serviceTiers],
        }));
    }

    /** Latest advisory account quota for the provider selected by a KISSOPEN session. */
    providerUsage(providerId: string) {
        return (
            this.#providerUsage.list().find((entry) => entry.providerId === providerId)?.usage ??
            null
        );
    }

    /** A bot's existing image; project sessions have no independently published artwork. */
    async sessionAvatarAsset(ctx: Context, agentId: string) {
        return await ctx.inTx(async (txCtx) => {
            const bot = await this.#bots.forAgent(txCtx, agentId);
            if (bot === undefined) return undefined;
            if (bot.avatar === undefined) return null;
            const asset = await this.#bots.avatar(txCtx, bot.id);
            if (asset === undefined)
                throw new Error("The bot picture metadata has no stored image.");
            return asset;
        });
    }

    /** The same branch comparison the workspace API and the phone's badge describe. */
    async gitState(ctx: Context, agentId: string): Promise<KissopenGitStateResponse> {
        const root = await this.#readRoot(ctx, agentId);
        const topLevel = await this.#git.topLevel(root.root).catch(() => undefined);
        if (topLevel !== root.root) {
            throw new KissopenReadRefused(
                "unsupported",
                "Changes require a workspace at the root of an available Git repository.",
            );
        }
        return { success: true, git: this.#git.resource(await this.#git.snapshot(root.root)) };
    }

    async readFile(
        ctx: Context,
        agentId: string,
        request: KissopenReadFileRequest,
    ): Promise<KissopenReadFileResponse> {
        const root = await this.#readRoot(ctx, agentId);
        // A picture the agent generated lives outside every workspace; it is read from its
        // own folder, under the same rules, whichever session asked.
        const readRoot =
            generatedFileRoot(this.#config.configuration?.paths?.generatedPath, request.path) ??
            root;
        // A part of a larger file, for a reader that takes it in parts; the whole file
        // otherwise, as every reader always could.
        if (request.offset !== undefined || request.length !== undefined)
            return {
                success: true,
                ...(await this.#files.read(
                    readRoot,
                    { path: request.path },
                    KISSOPEN_READ_PARTS_MAX_FILE_BYTES,
                    {
                        offset: request.offset ?? 0,
                        length: request.length ?? KISSOPEN_READ_PART_MAX_BYTES,
                    },
                )),
            };
        return {
            success: true,
            ...(await this.#files.read(readRoot, { path: request.path }, KISSOPEN_READ_MAX_BYTES)),
        };
    }

    /**
     * One folder of the session's workspace, as the phone's and desktop's file browsers list it:
     * the same contained, watched folder reader the workspace file tree uses, paged through up to
     * a bound so one answer stays within the relay's message ceiling.
     */
    async listDirectory(
        ctx: Context,
        agentId: string,
        request: KissopenListDirectoryRequest,
    ): Promise<KissopenListDirectoryResponse> {
        const root = await this.#readRoot(ctx, agentId);
        let path = request.path
            .trim()
            .replace(/^\.\/?/u, "")
            .replace(/\/+$/u, "");
        if (isAbsolute(path)) {
            const inside = relative(root.root, path);
            if (inside.startsWith("..") || isAbsolute(inside))
                throw new KissopenReadRefused("forbidden", "The folder is outside this workspace.");
            path = inside.split(sep).join("/");
        }
        const entries: KissopenDirectoryEntry[] = [];
        let cursor: string | undefined;
        let truncated = false;
        for (;;) {
            const page = await this.#files.tree(root, {
                ...(path === "" ? {} : { path }),
                limit: 500,
                ...(cursor === undefined ? {} : { cursor }),
            });
            for (const entry of page.entries) {
                if (entries.length >= KISSOPEN_LIST_MAX_ENTRIES) {
                    truncated = true;
                    break;
                }
                entries.push({
                    name: entry.name,
                    type:
                        entry.type === "directory"
                            ? "directory"
                            : entry.type === "file"
                              ? "file"
                              : "other",
                    size: entry.size,
                    modified: entry.modified,
                });
            }
            if (truncated || page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        return { success: true, path, entries, truncated };
    }

    /**
     * One part of a file a desktop or phone is uploading into the session's workspace. The path
     * is the one the person chose — normally `uploads/<name>` — and the file lands under a free
     * name beside anything already there; the answer says where.
     */
    async uploadFile(
        ctx: Context,
        agentId: string,
        request: KissopenUploadFileRequest,
    ): Promise<KissopenUploadFileResponse> {
        const root = await this.#readRoot(ctx, agentId);
        let path = request.path.trim().replace(/^\.\//u, "");
        if (isAbsolute(path)) {
            const inside = relative(root.root, path);
            if (inside.startsWith("..") || isAbsolute(inside))
                throw new KissopenReadRefused("forbidden", "The folder is outside this workspace.");
            path = inside.split(sep).join("/");
        }
        const result = await this.#files.upload(root, {
            path,
            uploadId: request.uploadId,
            offset: request.offset,
            content: request.content,
            done: request.done,
        });
        return { success: true, ...result };
    }

    async readFileAtRevision(
        ctx: Context,
        agentId: string,
        request: KissopenReadFileAtRevisionRequest,
    ): Promise<KissopenReadFileAtRevisionResponse> {
        const root = await this.#readRoot(ctx, agentId);
        const file = await this.#files.readRevision(root, request, {
            maximumBytes: KISSOPEN_READ_MAX_BYTES,
            strict: true,
        });
        if (file.content === null)
            throw new KissopenReadRefused("missing", "The file was not found at this revision.");
        return { success: true, content: file.content };
    }

    /** Catalog ownership is authority. Metadata and caller-supplied working directories are not. */
    async #readRoot(ctx: Context, agentId: string): Promise<ProjectFileRoot> {
        const config = await this.#system().config(ctx, agentId);
        if (
            config === undefined ||
            typeof config.metadata?.archivedAt === "number" ||
            this.#retiredAgents.has(agentId)
        ) {
            throw new KissopenReadRefused("missing", "This session is no longer available.");
        }
        const bot = await this.#bots.forAgent(ctx, agentId);
        if (bot !== undefined) return await this.#files.resolveBotRoot(ctx, bot.workspaceId);
        const workspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
        const workspace =
            workspaceId === undefined ? undefined : await this.#workspaces.get(ctx, workspaceId);
        if (workspaceId !== undefined && workspace === undefined)
            throw new KissopenReadRefused("unavailable", "This workspace is not available.");
        const project =
            workspace === undefined
                ? await this.#projects.projectForAgent(ctx, agentId)
                : await this.#projects.get(ctx, workspace.projectRef);
        if (project === undefined)
            throw new KissopenReadRefused(
                "unsupported",
                "This session has no workspace available for file reads.",
            );
        if (project.status !== "active")
            throw new KissopenReadRefused(
                "unavailable",
                "This project is not available to read right now.",
            );
        return await this.#files.resolveRoot(ctx, project.id, workspaceId);
    }

    /*
    The folder whose terminals belong to this session.

    Resolved the way a file read resolves its root, because it is the same
    question: a bot's workspace, this agent's worktree, or the project it sits
    in. Two answers to "which folder is this session's" would put a terminal
    in one place and the diff beside it in another.
    */
    async #terminalScope(ctx: Context, agentId: string): Promise<TerminalScope> {
        const bot = await this.#bots.forAgent(ctx, agentId);
        if (bot !== undefined) {
            const root = await this.#files.resolveBotRoot(ctx, bot.workspaceId);
            return terminalScopeOfRoot(root);
        }
        const workspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
        const workspace =
            workspaceId === undefined ? undefined : await this.#workspaces.get(ctx, workspaceId);
        const project =
            workspace === undefined
                ? await this.#projects.projectForAgent(ctx, agentId)
                : await this.#projects.get(ctx, workspace.projectRef);
        if (project === undefined)
            throw new KissopenTerminalRefused(
                "unsupported",
                "This session has no folder to run a terminal in.",
            );
        if (project.status !== "active")
            throw new KissopenTerminalRefused(
                "unavailable",
                "This project is not available right now.",
            );
        return workspaceId === undefined
            ? { projectId: project.id }
            : { projectId: project.id, workspaceId };
    }

    /** What KISSOPEN may ask about this session's terminals. */
    terminalOperations(ctx: Context, agentId: string): KissopenTerminalOperations | undefined {
        const terminals = this.#terminals;
        if (terminals === undefined) return undefined;
        const scope = () => this.#terminalScope(ctx, agentId);
        return {
            terminalCreate: async (request) =>
                await terminalAnswer(async () =>
                    terminalView(
                        await terminals.create(ctx, await scope(), {
                            ...(request.cols === undefined ? {} : { cols: request.cols }),
                            ...(request.rows === undefined ? {} : { rows: request.rows }),
                            ...(request.colorScheme === undefined
                                ? {}
                                : { colorScheme: request.colorScheme }),
                        }),
                    ),
                ),
            terminalList: async () =>
                await terminalsAnswer(async () =>
                    (await terminals.list(ctx, await scope())).map(terminalView),
                ),
            terminalResize: async (request) =>
                await terminalAnswer(async () =>
                    terminalView(
                        await terminals.resize(ctx, await scope(), request.terminalId, {
                            cols: request.cols,
                            rows: request.rows,
                        }),
                    ),
                ),
            terminalStop: async (request) =>
                await terminalAnswer(async () =>
                    terminalView(await terminals.stop(ctx, await scope(), request.terminalId)),
                ),
        };
    }

    /**
     * Attaches one stream to a terminal, answering how to detach it.
     *
     * The stream carries the daemon's own attach protocol, unchanged. That is
     * the point of routing it rather than re-describing it: ordering, resize
     * barriers, replay and backpressure are already solved on it, and a
     * second telling of that story would be a second one to keep true.
     */
    async terminalAttach(
        ctx: Context,
        agentId: string,
        terminalId: string,
        stream: Duplex,
    ): Promise<() => void> {
        const terminals = this.#terminals;
        if (terminals === undefined)
            throw new KissopenTerminalRefused(
                "unsupported",
                "This session does not offer terminals.",
            );
        return await terminals.attach(
            ctx,
            await this.#terminalScope(ctx, agentId),
            terminalId,
            stream,
        );
    }

    /** One agent as KISSOPEN needs to describe it, or nothing when it is gone. */
    async session(ctx: Context, agentId: string): Promise<KissopenSessionSnapshot | undefined> {
        const config = await this.#system().config(ctx, agentId);
        if (config === undefined) return undefined;
        return await this.#snapshot(ctx, agentId, config);
    }

    /** Delivers what a person said on the phone, and what they chose to say it with. */
    async prepareHostedMessage(
        ctx: Context,
        agentId: string,
        provider: string,
        model: string,
        message: SessionUserMessage,
    ): Promise<SessionUserMessage> {
        return (
            (await this.#expert?.prepareMessage(ctx, agentId, provider, model, message)) ?? message
        );
    }

    async submit(ctx: Context, agentId: string, message: KissopenInboundMessage): Promise<void> {
        const system = this.#system();
        const config = await system.config(ctx, agentId);
        if (config === undefined) {
            throw new Error(`No agent exists for KissOpen session "${agentId}".`);
        }
        const current = selectionFromConfig(config, this.#defaultSelection());
        let next: KissopenSelection;
        try {
            next = checkedSelection(
                this.#config.models,
                this.#config.kissopenMessageMode({
                    effort: message.selection.effort ?? current.effort,
                    modelId: message.selection.modelId ?? current.modelId,
                    permissionMode: message.selection.permissionMode ?? current.permissionMode,
                    providerId: message.selection.providerId ?? current.providerId,
                }),
            );
        } catch (cause) {
            throw new KissopenMessageRefused(
                cause instanceof Error ? cause.message : "That model selection is not available.",
                { cause },
            );
        }
        const messageOptions = messageOptionsFor(next);
        const content = await this.prepareHostedMessage(
            ctx,
            agentId,
            next.providerId,
            next.modelId,
            messageFrom(message),
        );
        if (next.providerId === "kissopen")
            ctx.log.info("Hosted relay message routing", {
                agentId,
                model: next.modelId,
                effort: next.effort,
                route: content.content.some(
                    (block) => block.type === "tool_call_request" && block.name === "ask_expert",
                )
                    ? "expert_request"
                    : "default",
            });
        const id = createId();
        const pending: HistoryPendingMessage = {
            ...(this.#connectionOwner === undefined ? {} : { userId: this.#connectionOwner.id }),
            agentId,
            blocks: this.#history.inputBlocks(content.content),
            createdAt: Date.now(),
            delivery: "steer",
            id,
            mode: modeForSelection(next),
            role: "user",
            runId: null,
            status: "pending",
            // Kept with the message, so every surface shows the label rather than the text.
            ...(message.displayText === undefined
                ? {}
                : { clientMetadata: messageDisplayMetadata(message.displayText) }),
        };
        try {
            await ctx.inTx(async (txCtx) => {
                const bot = await this.#bots.forAgent(txCtx, agentId);
                if (bot?.status === "archived") {
                    throw new KissopenMessageRefused(
                        "This bot is archived. Restore it in KissOpen Agent before sending a message.",
                    );
                }
                await this.#history.queuePending(txCtx, pending);
                await system.steer(txCtx, agentId, content, {
                    ...messageOptions,
                    id,
                    metadata: {
                        ...messageOptions.metadata,
                        kissopen: { remoteMessageId: message.remoteMessageId },
                        ...(this.#connectionOwner === undefined
                            ? {}
                            : { userId: this.#connectionOwner.id }),
                    },
                });
                // The phone answers a question it shows before sending; one it never showed
                // would otherwise hold this message behind it for as long as the person is online.
                await this.#userInput.supersedePending(txCtx, agentId);
            });
        } catch (cause) {
            if (cause instanceof KissopenMessageRefused) throw cause;
            throw new Error("KissOpen Agent rejected the phone's message.", { cause });
        }
        this.#scheduling.interruptWaits(ctx, agentId);
        await system.updateMetadata(ctx, agentId, { kissopen: next });
    }

    /** Stops whatever the agent is doing. */
    async abort(ctx: Context, agentId: string): Promise<void> {
        await this.#system().abort(ctx, agentId);
    }

    /** Clears the agent's whole conversation when the person asks from a KISSOPEN client. */
    async clearConversation(ctx: Context, agentId: string): Promise<void> {
        await this.#system().clear(ctx, agentId);
    }

    /**
     * Gives a cleared conversation a fresh copy on KISSOPEN. The old copy is deleted there, the
     * local record of it is forgotten, and the agent is attached again, which creates a new copy
     * from what the agent now holds. A copy that cannot be deleted is left attached as it is,
     * rather than creating a second copy under the same identity beside it.
     */
    async #restartRemoteConversation(agentId: string): Promise<void> {
        this.#browser.revoke(agentId);
        const context = this.#context;
        if (context === undefined || this.#stopping) return;
        const attached = this.#agents.get(agentId);
        if (attached === undefined) {
            await context.inTx(async (txCtx) => await this.#sync.removeSession(txCtx, agentId));
            return;
        }
        this.#agents.delete(agentId);
        try {
            await attached.client.discardRemote();
        } catch (error) {
            context.log.warn(
                "KissOpen kept the copy of a cleared conversation.",
                { agentId },
                error,
            );
            await context.inTx(async (txCtx) => await this.#attach(txCtx, agentId));
            return;
        }
        await context.inTx(async (txCtx) => {
            await this.#sync.removeSession(txCtx, agentId);
            await this.#attach(txCtx, agentId);
        });
    }

    /** Archives the local agent when the person archives its KISSOPEN session. */
    async archiveSession(ctx: Context, agentId: string): Promise<void> {
        const archivedBot = await ctx.inTx(async (txCtx) => {
            const bot = await this.#bots.forAgent(txCtx, agentId);
            if (bot === undefined) return false;
            await this.#bots.archive(txCtx, bot.id, bot.version);
            await this.#archiveRemoteProjection(txCtx, agentId);
            return true;
        });
        if (archivedBot) return;
        const system = this.#system();
        const config = await system.config(ctx, agentId);
        if (config === undefined) return;
        if (typeof config.metadata?.archivedAt !== "number") {
            await system.abort(ctx, agentId);
            await this.#compute.archiveAgent(ctx, agentId);
            const now = Date.now();
            await system.updateMetadata(ctx, agentId, {
                archivedAt: now,
                updatedAt: now,
                version:
                    typeof config.metadata?.version === "number" ? config.metadata.version + 1 : 1,
            });
        }
        await this.#archiveRemoteProjection(ctx, agentId);
    }

    /** The questions this agent is waiting on right now. */
    async pendingQuestions(ctx: Context, agentId: string): Promise<readonly UserInputRequest[]> {
        return await this.#userInput.list(ctx, agentId, { status: "pending" });
    }

    /** Records what a person answered on the phone. */
    async answerQuestion(
        ctx: Context,
        agentId: string,
        requestId: string,
        answers: Record<string, unknown>,
    ): Promise<void> {
        const pending = await this.#userInput.list(ctx, agentId, { status: "pending" });
        const request = pending.find((candidate) => candidate.id === requestId);
        if (request === undefined) {
            throw new Error(`Question "${requestId}" is no longer waiting for an answer.`);
        }
        await this.#userInput.answer(
            ctx,
            agentId,
            resolveKissopenUserInputAnswers(request, answers),
        );
    }

    /** Dismisses a question the person chose not to answer. */
    async cancelQuestion(ctx: Context, agentId: string, requestId: string): Promise<void> {
        await this.#userInput.cancel(ctx, agentId, {
            reason: "Dismissed from the phone.",
            requestId,
        });
    }

    defaultSpawnPermissionMode(): KissopenSelection["permissionMode"] {
        return this.#config.configuration.values.defaults.permissionMode;
    }

    readSpawnResult(clientRequestId: string): KissopenSpawnResult | undefined {
        return this.#served.get(clientRequestId);
    }

    rememberSpawnResult(clientRequestId: string, result: KissopenSpawnResult): void {
        if (result.type === "pending") return;
        this.#served.delete(clientRequestId);
        this.#served.set(clientRequestId, result);
        while (this.#served.size > MAX_SERVED_SPAWN_RESULTS) {
            const oldest = this.#served.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            this.#served.delete(oldest);
        }
    }

    /** Starts the deterministic local agent behind either KISSOPEN spawn request. */
    async spawnSession(
        ctx: Context,
        request: KissopenSpawnRequest,
    ): Promise<KissopenSpawnStartResult> {
        const system = this.#system();
        const owner = await this.#resolveSpawnOwner(ctx, request);
        if (owner === undefined) return { type: "pending" };
        const cwd = owner.workspaceId === undefined ? owner.projectPath : owner.workspacePath;
        const existing = await system.config(ctx, request.sessionId);
        const selection = checkedSelection(this.#config.models, {
            effort: request.effort,
            modelId: request.modelId,
            permissionMode: request.permissionMode,
            providerId: request.providerId,
        });
        // Creating the agent and placing it in its folder are one decision. The catalog refuses a
        // folder that is being archived, and this is the retry key's only durable record, so a
        // refusal must leave no agent behind: an existing configuration is what a later retry reads
        // to decide the session is already made.
        if (existing === undefined) {
            await ctx.inTx(async (txCtx) => {
                await system.create(txCtx, agentConfigFor(cwd, selection, owner), {
                    id: request.sessionId,
                });
                await this.#attachSpawnOwner(txCtx, request.sessionId, owner);
            });
        } else if (typeof existing.metadata?.archivedAt === "number") {
            throw new Error("That KissOpen Agent session is archived.");
        } else {
            await this.#attachSpawnOwner(ctx, request.sessionId, owner);
        }
        await this.#attach(ctx, request.sessionId);
        return { agentId: request.sessionId, type: "ready" };
    }

    async #resolveSpawnOwner(
        ctx: Context,
        request: KissopenSpawnRequest,
    ): Promise<
        | {
              projectId: string;
              projectPath: string;
              workspaceId?: string;
              workspacePath: string;
          }
        | undefined
    > {
        const requestedPath =
            "cwd" in request
                ? request.cwd
                : request.target.kind === "projectFolder"
                  ? request.target.projectPath
                  : undefined;
        const requestedWorkspace =
            "target" in request && request.target.kind === "workspace"
                ? request.target.id
                : undefined;
        if (
            (requestedWorkspace !== undefined &&
                (await this.#bots.forWorkspace(ctx, requestedWorkspace)) !== undefined) ||
            (requestedPath !== undefined &&
                (await this.#bots.list(ctx)).some(
                    (bot) => resolve(bot.path) === resolve(requestedPath),
                ))
        ) {
            throw new Error(
                "A bot has one continuous conversation. Open the existing bot instead.",
            );
        }
        if ("cwd" in request) {
            const owner = await this.#workspaces.resolvePath(ctx, request.cwd);
            return {
                projectId: owner.project.id,
                projectPath: owner.project.repositoryRef,
                ...(owner.workspace === undefined
                    ? { workspacePath: owner.project.repositoryRef }
                    : {
                          workspaceId: owner.workspace.id,
                          workspacePath: owner.workspace.path,
                      }),
            };
        }

        const target = request.target;
        if (target.kind === "project") {
            const project = await this.#projects.get(ctx, target.id);
            if (project === undefined || project.status === "archived") {
                throw new Error("That project is not available in KissOpen Agent.");
            }
            return {
                projectId: project.id,
                projectPath: project.repositoryRef,
                workspacePath: project.repositoryRef,
            };
        }
        if (target.kind === "workspace") {
            const workspace = await this.#workspaces.get(ctx, target.id);
            if (workspace === undefined || workspace.status !== "ready") {
                throw new Error("That workspace is not ready in KissOpen Agent.");
            }
            const project = await this.#projects.get(ctx, workspace.projectRef);
            if (project === undefined || project.status === "archived") {
                throw new Error("That workspace's project is not available in KissOpen Agent.");
            }
            return {
                projectId: project.id,
                projectPath: project.repositoryRef,
                workspaceId: workspace.id,
                workspacePath: workspace.path,
            };
        }
        if (target.kind === "projectFolder") {
            await mkdir(target.projectPath, { recursive: true });
            const owner = await this.#workspaces.resolvePath(ctx, target.projectPath);
            return {
                projectId: owner.project.id,
                projectPath: owner.project.repositoryRef,
                ...(owner.workspace === undefined
                    ? { workspacePath: owner.project.repositoryRef }
                    : {
                          workspaceId: owner.workspace.id,
                          workspacePath: owner.workspace.path,
                      }),
            };
        }

        const project = await this.#projects.get(ctx, target.projectId);
        if (project === undefined || project.status === "archived") {
            throw new Error("That project is not available in KissOpen Agent.");
        }
        let workspace = await this.#workspaces.get(ctx, request.workspaceId);
        if (workspace === undefined) {
            workspace = await this.#workspaces.createWorkspace(ctx, project.id, {
                id: request.workspaceId,
                name: "Workspace",
                nameConfigured: false,
                parentId: project.id,
            });
        }
        if (workspace === undefined) {
            throw new Error("KissOpen Agent could not create that workspace.");
        }
        if (workspace.projectRef !== project.id) {
            throw new Error("That workspace belongs to another project.");
        }
        if (workspace.status === "initializing") return undefined;
        if (workspace.status !== "ready") {
            throw new Error("That workspace could not be prepared.");
        }
        return {
            projectId: project.id,
            projectPath: project.repositoryRef,
            workspaceId: workspace.id,
            workspacePath: workspace.path,
        };
    }

    async #attachSpawnOwner(
        ctx: Context,
        agentId: string,
        owner: { readonly projectId: string; readonly workspaceId?: string },
    ): Promise<void> {
        const currentWorkspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
        const currentProject = await this.#projects.projectForAgent(ctx, agentId);
        if (owner.workspaceId !== undefined) {
            if (currentWorkspaceId === owner.workspaceId) return;
            if (currentWorkspaceId !== undefined || currentProject !== undefined) {
                throw new Error("That session already belongs to another project or workspace.");
            }
            await this.#workspaces.attachAgent(ctx, owner.workspaceId, agentId);
            return;
        }
        if (currentProject?.id === owner.projectId && currentWorkspaceId === undefined) return;
        if (currentWorkspaceId !== undefined || currentProject !== undefined) {
            throw new Error("That session already belongs to another project or workspace.");
        }
        await this.#projects.attachAgent(ctx, owner.projectId, agentId);
    }

    /**
     * Whether a person can still open this agent, which is whether the place it lives is still
     * somewhere they navigate to.
     *
     * A hidden subagent belongs to the agent that spawned it and to no place a person navigates to.
     * Giving it a session of its own would put work nobody started at the top of the phone's list,
     * and a busy delegating agent would fill that list on its own.
     *
     * Archiving keeps the association, so belonging to a workspace is not the same as being
     * reachable through one: an archived owner is asked about here rather than assumed live, or a
     * session put away on the desktop would come back the moment its agent said anything.
     */
    async #userVisible(ctx: Context, agentId: string): Promise<boolean> {
        const config = await this.#system().config(ctx, agentId);
        if (config === undefined || typeof config.metadata?.archivedAt === "number") return false;
        const bot = await this.#bots.forAgent(ctx, agentId);
        if (bot !== undefined) return bot.status === "active";
        const workspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
        if (workspaceId !== undefined) {
            const workspace = await this.#workspaces.get(ctx, workspaceId);
            if (workspace === undefined) return false;
            if (workspace.status === "archived" || workspace.archivedAt !== undefined) return false;
            const parent = await this.#projects.get(ctx, workspace.projectRef);
            return parent !== undefined && parent.status !== "archived";
        }
        const project = await this.#projects.projectForAgent(ctx, agentId);
        return project !== undefined && project.status !== "archived";
    }

    /**
     * Asks every live session to describe itself again, because where it lives has changed.
     *
     * Renaming a workspace or a project renames it on the phone: the session's own metadata is
     * what the phone groups and labels by, so it is republished rather than left saying the old
     * name until something else happens to move it.
     */
    async #republishAttached(_ctx: Context): Promise<void> {
        for (const attached of this.#agents.values()) attached.client.kick();
    }

    /** Project sync is best effort and never participates in session event transactions. */
    async #syncProjectEvent(
        ctx: Context,
        project: Project,
        options: { readonly verifyRemote?: boolean } = {},
    ): Promise<void> {
        const client = this.#projectClient;
        if (client === undefined) return;
        try {
            await client.sync(project, options);
        } catch (error) {
            ctx.log.debug(
                "KissOpen could not synchronize a project.",
                { projectId: project.id },
                error,
            );
        }
    }

    async #remoteProjectId(ctx: Context, localProjectId: string): Promise<string | undefined> {
        const client = this.#projectClient;
        if (client === undefined) return undefined;
        try {
            return await client.remoteProjectId(localProjectId);
        } catch (error) {
            ctx.log.debug(
                "KissOpen could not read a project's remote identity.",
                {
                    projectId: localProjectId,
                },
                error,
            );
            return undefined;
        }
    }

    /** Walks every local catalog page with one bounded remote request in flight at a time. */
    async #reconcileProjects(ctx: Context): Promise<void> {
        const client = this.#projectClient;
        if (client === undefined) return;
        let cursor: string | undefined;
        do {
            const page = await this.#projects.listCatalogPage(ctx, {
                includeArchived: true,
                ...(cursor === undefined ? {} : { cursor }),
            });
            for (const project of page.projects) {
                try {
                    await client.sync(project, { verifyRemote: true });
                } catch (error) {
                    ctx.log.debug(
                        "KissOpen could not synchronize a project during startup.",
                        {
                            projectId: project.id,
                        },
                        error,
                    );
                }
            }
            cursor = page.nextCursor;
        } while (cursor !== undefined);
    }

    /**
     * Puts away every session whose place has been archived since it was published.
     *
     * Archiving on the desktop is the same decision as ending the session on the phone, so the
     * phone is told in the same words rather than left holding a session pointing at a checkout
     * that may no longer be on disk.
     */
    async #reapArchived(ctx: Context): Promise<void> {
        const agentIds = new Set([
            ...this.#agents.keys(),
            ...(this.#fingerprint.length === 0
                ? []
                : await this.#sync.listAgentIds(ctx, this.#fingerprint, MAX_REAPED_SYNC_SESSIONS)),
        ]);
        for (const agentId of agentIds) {
            try {
                if (await this.#userVisible(ctx, agentId)) continue;
                this.#browser.revoke(agentId);
                await this.#archiveRemoteProjection(ctx, agentId);
            } catch (error) {
                ctx.log.debug("Kissopen could not retire an archived session.", { agentId }, error);
            }
        }
    }

    async #attach(ctx: Context, agentId: string): Promise<ConnectedAgent | undefined> {
        if (this.#stopping) return undefined;
        if (this.#archivingAgents.has(agentId)) return undefined;
        const existing = this.#agents.get(agentId);
        if (existing !== undefined) return existing;
        const configuration = this.#configuration;
        const context = this.#context;
        if (configuration === undefined || context === undefined) return undefined;
        if (this.#agents.size >= MAX_CONNECTED_AGENTS) return undefined;
        if (!(await this.#userVisible(ctx, agentId))) return undefined;
        const session = await this.session(ctx, agentId);
        if (session === undefined) return undefined;
        const localProjectId = session.project?.id;
        await this.#sync.ensureSession(
            ctx,
            {
                agentId,
                credentialFingerprint: this.#fingerprint,
                encryptionKeyBase64: this.#sessionKey(),
                encryptionVariant: configuration.credentials.encryption.type,
                sessionId: session.sessionId,
            },
            Date.now(),
        );
        const mapper = new KissopenMessageMapper(this.#connectionOwner?.id);
        await this.#backfill(ctx, agentId, mapper);
        const attached: ConnectedAgent = {
            client: new KissopenSessionClient({
                agentId,
                configuration,
                context,
                operations: this,
                ...(localProjectId === undefined
                    ? {}
                    : {
                          projectId: async () =>
                              await this.#remoteProjectId(context, localProjectId),
                      }),
                sessionId: session.sessionId,
                sync: this.#sync,
                version: this.#config.configuration.version,
            }),
            mapper,
        };
        if (this.#stopping) {
            await attached.client.close();
            return undefined;
        }
        this.#agents.set(agentId, attached);
        afterCommit(ctx, () => {
            attached.client.start();
            if (localProjectId !== undefined) {
                this.#runTask(async () => {
                    const project = await this.#projects.get(context, localProjectId);
                    if (project === undefined) return;
                    await this.#syncProjectEvent(context, project, { verifyRemote: true });
                    attached.client.kick();
                });
            }
        });
        return attached;
    }

    /**
     * Puts the conversation a session already had onto the phone, once.
     *
     * A session that has been running all week is not new to the person who started it, and
     * without this it arrives on the phone as an empty room: the projection only carries what
     * happens from the moment KISSOPEN attaches, so everything said before that is simply missing.
     *
     * The projection cursor is moved to the newest event this agent has recorded, so the live
     * stream picks up immediately after what was replayed rather than repeating it. The archive
     * is the source rather than the journal because the journal's live window is bounded and a
     * cold start begins with it empty — the very case this exists for.
     *
     * Failing to read the past is not a reason to refuse the present. A session that cannot be
     * backfilled still attaches and still streams; it just opens empty, which is what it did
     * before this existed.
     */
    async #backfill(ctx: Context, agentId: string, mapper: KissopenMessageMapper): Promise<void> {
        const existing = await this.#sync.readSession(ctx, agentId);
        if (existing?.historyBackfilled !== false) return;
        try {
            const page = await this.#history.read(ctx, agentId, {
                from: "end",
                limit: KISSOPEN_BACKFILL_MESSAGES,
            });
            const latest = await this.#events.latestAgentEvent(ctx, agentId);
            const messages = page.messages.map((record) => record.message);
            // One archived record may contain several structured tool events. The phone's initial
            // payload is still bounded to 50 protocol messages, keeping the newest visible context
            // while preserving chronological order within that window.
            const history = mapper.mapHistory(
                messages,
                KISSOPEN_BACKFILL_MESSAGES,
                await this.#historyAuthors(ctx, messages),
            );
            await this.#sync.backfillHistory(
                ctx,
                agentId,
                history.map((message) => ({
                    localId: message.localId,
                    payload: message,
                })),
                latest?.cursor,
                Date.now(),
            );
        } catch (error) {
            ctx.log.debug(
                "KissOpen could not replay what this session already said.",
                { agentId },
                error,
            );
        }
    }

    /**
     * Attaches every session a person can still open, because this daemon has just started.
     *
     * Sessions attach on their own when they next record something, which is enough for a busy
     * agent and no use at all for a quiet one: before this, a conversation nobody had touched
     * since the restart stayed off the phone until somebody went to the desktop and prodded it.
     * A person expects to reopen their laptop and find their work where they left it.
     *
     * Walked through the places a person navigates to rather than through every agent that
     * exists, because those places are exactly what makes a session reachable — the same
     * question `#userVisible` asks one agent at a time. A hidden subagent belongs to no such
     * place and is passed over here for the reason it is refused there.
     *
     * Archived projects and workspaces are left out by the listings themselves, which is the
     * same answer a person gets when they go looking for their work. The durable attachment lists
     * may still name locally archived agents, so `#attach` checks Agent Base metadata before
     * spending one of the bounded session connections on them.
     */
    async #reconcile(ctx: Context): Promise<void> {
        const attach = async (agentId: string): Promise<boolean> => {
            if (this.#stopping || this.#agents.size >= MAX_CONNECTED_AGENTS) return false;
            try {
                await ctx.inTx(async (txCtx) => await this.#attach(txCtx, agentId));
            } catch (error) {
                ctx.log.debug("Kissopen could not restore a session.", { agentId }, error);
            }
            return true;
        };
        try {
            // Bots have no project/workspace placement. Give their small persistent catalog
            // first access to the existing connection budget so busy projects cannot hide it.
            for (const bot of await this.#bots.list(ctx)) {
                if (bot.status === "active" && !(await attach(bot.agentId))) return;
            }
            let workspaceCursor: number | undefined;
            do {
                const page = await this.#workspaces.listCatalogPage(ctx, {
                    ...(workspaceCursor === undefined ? {} : { cursor: workspaceCursor }),
                });
                for (const workspace of page.workspaces) {
                    for (const agentId of await this.#workspaces.listAgentIds(ctx, workspace.id)) {
                        if (!(await attach(agentId))) return;
                    }
                }
                workspaceCursor = page.nextCursor;
            } while (workspaceCursor !== undefined);

            let projectCursor: string | undefined;
            do {
                const page = await this.#projects.listCatalogPage(ctx, {
                    ...(projectCursor === undefined ? {} : { cursor: projectCursor }),
                });
                for (const project of page.projects) {
                    for (const agentId of await this.#projects.listAgentIds(ctx, project.id)) {
                        if (!(await attach(agentId))) return;
                    }
                }
                projectCursor = page.nextCursor;
            } while (projectCursor !== undefined);
        } catch (error) {
            ctx.log.debug("Kissopen could not read the sessions on this computer.", {}, error);
        }
    }

    async #archiveRemoteAgents(ctx: Context, agentIds: readonly string[]): Promise<void> {
        for (const agentId of agentIds) {
            try {
                await this.#archiveRemoteProjection(ctx, agentId);
            } catch (error) {
                ctx.log.debug("Kissopen could not retire an archived session.", { agentId }, error);
            }
        }
    }

    /** Schedules after commit; callers may await completion only outside their transaction. */
    async #archiveRemoteProjection(
        ctx: Context,
        agentId: string,
    ): Promise<{ readonly completion: Promise<void> } | undefined> {
        const current = this.#archivingAgents.get(agentId);
        if (current !== undefined) return { completion: current };
        if (this.#retiredAgents.has(agentId)) return;
        const attached = this.#agents.get(agentId);
        const existing = await this.#sync.readSession(ctx, agentId);
        if (attached === undefined && existing?.remoteSessionId === undefined) return;
        const configuration = this.#configuration;
        const context = this.#context;
        if (configuration === undefined || context === undefined) return;
        const client =
            attached?.client ??
            new KissopenSessionClient({
                agentId,
                configuration,
                context,
                operations: this,
                sessionId: existing?.sessionId ?? agentId,
                sync: this.#sync,
                version: this.#config.configuration.version,
            });
        // Return the actual completion even before afterCommit has registered the task. A
        // restore must not mistake a missing map entry for an archive that already finished.
        let complete!: (value: void | PromiseLike<void>) => void;
        const completion = new Promise<void>((resolve) => {
            complete = resolve;
        });
        afterCommit(ctx, () => {
            const pending = this.#archivingAgents.get(agentId);
            if (pending !== undefined || this.#retiredAgents.has(agentId)) {
                if (attached === undefined) void client.close();
                complete(pending);
                return;
            }
            if (this.#stopping) {
                if (attached === undefined) void client.close();
                complete();
                return;
            }
            this.#agents.delete(agentId);
            this.#browser.revoke(agentId);
            this.#forgetGitAgent(agentId);
            const archiving = this.#runTask(async () => {
                try {
                    await client.archive();
                    this.#retiredAgents.add(agentId);
                } finally {
                    this.#archivingAgents.delete(agentId);
                }
            });
            this.#archivingAgents.set(agentId, archiving);
            complete(archiving);
        });
        return { completion };
    }

    /** One session, described in the terms KISSOPEN publishes it. */
    async #snapshot(
        ctx: Context,
        agentId: string,
        config: AgentConfig,
    ): Promise<KissopenSessionSnapshot> {
        const cwd = config.environment?.workingDirectory;
        if (cwd === undefined) {
            throw new Error(`Agent "${agentId}" has no working directory.`);
        }
        const selection = selectionFromConfig(config, this.#defaultSelection());
        const owner = await this.#owner(ctx, agentId);
        const git =
            owner.project === undefined
                ? (this.#forgetGitAgent(agentId), undefined)
                : this.#gitSummary(agentId, {
                      path: cwd,
                      projectId: owner.project.id,
                      ...(owner.workspace === undefined ? {} : { workspaceId: owner.workspace.id }),
                  });
        let lastUserOrFinalAssistantTextMessageAt: number | undefined;
        try {
            lastUserOrFinalAssistantTextMessageAt =
                await this.#history.latestUserOrFinalAssistantTextMessageAt(ctx, agentId);
        } catch (error) {
            // Session ordering is enrichment. A broken history read must not take the live
            // conversation or the rest of its metadata off the phone.
            ctx.log.debug(
                "KissOpen could not read the latest conversation timestamp.",
                { agentId },
                error,
            );
        }
        let lastQuestionAt: number | undefined;
        try {
            lastQuestionAt = await this.#userInput.latestQuestionAt(ctx, agentId);
        } catch (error) {
            ctx.log.debug(
                "KissOpen could not read the latest question timestamp.",
                { agentId },
                error,
            );
        }
        const lastMeaningfulMessageAt = latestTimestamp(
            lastUserOrFinalAssistantTextMessageAt,
            lastQuestionAt,
        );
        return {
            agentId,
            ...(owner.bot === undefined ? {} : { bot: owner.bot }),
            ...(owner.avatarVersion === undefined ? {} : { avatarVersion: owner.avatarVersion }),
            archived: typeof config.metadata?.archivedAt === "number",
            cwd,
            effort: selection.effort,
            ...(git === undefined ? {} : { git }),
            ...(owner.gitBranch === undefined ? {} : { gitBranch: owner.gitBranch }),
            ...(lastMeaningfulMessageAt === undefined ? {} : { lastMeaningfulMessageAt }),
            modelId: selection.modelId,
            permissionMode: selection.permissionMode,
            ...(owner.project === undefined ? {} : { project: owner.project }),
            projectName: owner.project?.name ?? basename(cwd) ?? cwd,
            providerId: selection.providerId,
            sessionId: agentId,
            status: "idle",
            // An unnamed chat says nothing rather than inventing a name: KISSOPEN has its own
            // words for one, and a placeholder here would overwrite them on the phone.
            ...(typeof config.metadata?.title === "string" ? { title: config.metadata.title } : {}),
            tools: [],
            // Events owns the live run edge and restores it from durable state after restart.
            // Its post-commit listener kicks this session on both start and completion.
            working: this.#events.activeRunId(agentId) !== undefined,
            ...(owner.workspace === undefined ? {} : { workspace: owner.workspace }),
        };
    }

    /** Tracks one checkout and returns its latest complete branch comparison, when ready. */
    #gitSummary(
        agentId: string,
        entity: GitTrackedEntity,
    ):
        | {
              changedFiles: number;
              countsExact: boolean;
              deletions: number;
              insertions: number;
          }
        | undefined {
        this.#rememberGitEntity(agentId, entity);
        this.#git.track(entity);
        const snapshot = this.#git.trackedSnapshot(entity);
        if (snapshot?.comparison !== "ready") return undefined;
        return gitSummary(snapshot);
    }

    #rememberGitEntity(agentId: string, entity: GitTrackedEntity): void {
        const previous = this.#gitEntityByAgent.get(agentId);
        if (previous !== undefined && sameGitEntity(previous, entity)) return;
        this.#forgetGitAgent(agentId);
        this.#gitEntityByAgent.set(agentId, entity);
        const key = gitEntityKey(entity);
        const agents = this.#gitAgentsByEntity.get(key) ?? new Set<string>();
        agents.add(agentId);
        this.#gitAgentsByEntity.set(key, agents);
    }

    #forgetGitAgent(agentId: string): void {
        const previous = this.#gitEntityByAgent.get(agentId);
        if (previous === undefined) return;
        this.#gitEntityByAgent.delete(agentId);
        const key = gitEntityKey(previous);
        const agents = this.#gitAgentsByEntity.get(key);
        agents?.delete(agentId);
        if (agents?.size === 0) this.#gitAgentsByEntity.delete(key);
    }

    /**
     * Where this agent lives, in the terms the phone groups by.
     *
     * A workspace names its own project, so a session in a worktree gathers with the sessions in
     * the checkout it came from rather than sitting alone. An agent belonging to neither is a
     * session somewhere this daemon does not keep, and says so by describing no owner at all.
     */
    async #owner(
        ctx: Context,
        agentId: string,
    ): Promise<{
        bot?: KissopenSessionSnapshot["bot"];
        avatarVersion?: number;
        gitBranch?: string;
        project?: { id: string; kind: "home" | "regular"; name: string };
        workspace?: { id: string; name: string };
    }> {
        try {
            const bot = await this.#bots.forAgent(ctx, agentId);
            if (bot !== undefined) {
                return {
                    avatarVersion: bot.version,
                    bot: {
                        id: bot.id,
                        name: bot.name,
                        username: bot.username,
                        workspaceId: bot.workspaceId,
                        orderKey: bot.orderKey,
                    },
                };
            }
            const workspaceId = await this.#workspaces.workspaceForAgent(ctx, agentId);
            if (workspaceId !== undefined) {
                const workspace = await this.#workspaces.get(ctx, workspaceId);
                if (workspace !== undefined) {
                    const project = await this.#projects.get(ctx, workspace.projectRef);
                    return {
                        ...(workspace.branch === undefined ? {} : { gitBranch: workspace.branch }),
                        ...(project === undefined
                            ? {}
                            : {
                                  project: {
                                      id: project.id,
                                      kind: project.kind,
                                      name: project.name,
                                  },
                              }),
                        workspace: { id: workspace.id, name: workspace.name },
                    };
                }
            }
            const project = await this.#projects.projectForAgent(ctx, agentId);
            if (project === undefined) return {};
            return {
                ...(project.gitBranch === undefined ? {} : { gitBranch: project.gitBranch }),
                project: { id: project.id, kind: project.kind, name: project.name },
            };
        } catch (error) {
            // Describing a session is never worth failing to publish it over: without an owner
            // it still reaches the phone, grouped by itself rather than with its neighbours.
            ctx.log.debug("Kissopen could not read where an agent lives.", { agentId }, error);
            return {};
        }
    }

    #defaultSelection(): KissopenSelection {
        const model = this.#config.models[0];
        if (model === undefined) {
            throw new Error("KissOpen cannot start a session without an available model.");
        }
        return {
            effort: model.defaultEffort,
            modelId: model.id,
            permissionMode: this.#config.configuration.values.defaults.permissionMode,
            providerId: model.providerId,
        };
    }

    #system(): AgentSystemRef<LibSQLDatabase> {
        if (this.#agentSystem === undefined) {
            throw new Error("KissOpen was asked to act before its agents had started.");
        }
        return this.#agentSystem;
    }

    #sessionKey(): string {
        const encryption = this.#configuration?.credentials.encryption;
        if (encryption?.type === "legacy") {
            return Buffer.from(encryption.secret).toString("base64");
        }
        return randomBytes(32).toString("base64");
    }
}

function agentConfigFor(
    cwd: string,
    selection: KissopenSelection,
    owner: { readonly projectId: string; readonly workspaceId?: string },
): AgentConfig {
    return {
        environment: { ...currentAgentEnvironment(), workingDirectory: cwd },
        metadata: { kissopen: selection },
        modules: {
            compute: {
                cwd,
                providerId: "host",
                secretScope: {
                    projectId: owner.projectId,
                    workspaceId: owner.workspaceId ?? owner.projectId,
                },
            },
        },
    };
}

function latestTimestamp(
    first: number | undefined,
    second: number | undefined,
): number | undefined {
    if (first === undefined) return second;
    if (second === undefined) return first;
    return Math.max(first, second);
}

function gitEntityKey(entity: Pick<GitTrackedEntity, "projectId" | "workspaceId">): string {
    return entity.workspaceId === undefined
        ? `project:${entity.projectId}`
        : `workspace:${entity.workspaceId}`;
}

function sameGitEntity(left: GitTrackedEntity, right: GitTrackedEntity): boolean {
    return (
        left.path === right.path &&
        left.projectId === right.projectId &&
        left.workspaceId === right.workspaceId
    );
}

function gitSummary(snapshot: GitChangeSnapshot): {
    changedFiles: number;
    countsExact: boolean;
    deletions: number;
    insertions: number;
} {
    return {
        changedFiles: snapshot.changedFiles,
        countsExact: snapshot.countsExact,
        deletions: snapshot.deletions,
        insertions: snapshot.insertions,
    };
}

function checkedSelection(
    models: readonly KissopenSelectionModel[],
    selection: KissopenSelection,
): KissopenSelection {
    if (!Value.Check(kissopenSelectionSchema, selection)) {
        throw new Error("The KissOpen model selection is invalid.");
    }
    const model = models.find(
        (candidate) =>
            candidate.id === selection.modelId && candidate.providerId === selection.providerId,
    );
    if (model === undefined) {
        throw new Error("That model is not available in this KissOpen Agent.");
    }
    if (!model.effortLevels.includes(selection.effort)) {
        throw new Error("That reasoning level is not available for this model.");
    }
    return selection;
}

function fingerprint(configuration: KissopenConnectionConfiguration): string {
    return createHash("sha256")
        .update(configuration.credentials.token)
        .update("\0")
        .update(configuration.serverUrl)
        .digest("hex")
        .slice(0, 32);
}

function pairingError(error: unknown): KissopenIntegrationError {
    if (error instanceof KissopenPairingError && error.code !== "cancelled") {
        return { code: error.code, message: error.message };
    }
    return {
        code: "invalid_response",
        message: "KissOpen authorization could not be completed.",
    };
}

function sameIntegration(
    current: KissopenIntegration,
    value: KissopenIntegrationValue,
    machineId: string | null,
): boolean {
    return (
        (current.machineId ?? null) === machineId &&
        current.status === value.status &&
        current.configured === value.configured &&
        current.authorization?.kind === value.authorization?.kind &&
        current.authorization?.data === value.authorization?.data &&
        current.authorization?.expiresAt === value.authorization?.expiresAt &&
        current.error?.code === value.error?.code &&
        current.error?.message === value.error?.message
    );
}

function isUnlinkedIntegration(integration: KissopenIntegration): boolean {
    return (
        integration.configured === false &&
        integration.authorization === null &&
        integration.error === null &&
        (integration.status === "disabled" || integration.status === "disconnected")
    );
}

function messageFrom(message: KissopenInboundMessage): SessionUserMessage {
    const content: SessionInputBlock[] = structuredClone(message.content ?? []);
    if (message.content === undefined && (message.text.length > 0 || message.images.length === 0)) {
        content.push({ text: message.text, type: "text" });
    }
    for (const image of message.images) {
        content.push({ data: image.data, mimeType: image.mimeType, type: "image" });
    }
    return { content, role: "user" };
}

function messageOptionsFor(selection: KissopenSelection): AgentBaseMessageOptions {
    return {
        effort: selection.effort as never,
        metadata: {
            ...USER_MESSAGE_ORIGIN_METADATA,
            // The composer selection this message runs with, stamped the way the API
            // stamps its own sends so history shows the phone's mode too.
            mode: modeForSelection(selection),
        },
        model: selection.modelId,
        permissionMode: selection.permissionMode,
        provider: selection.providerId,
        // The phone has no tier selector, and the stamped mode above says null. Send the explicit
        // clear so a stale persisted tier cannot outlive the mode the message claims to run with.
        serviceTier: null,
    };
}

function modeForSelection(selection: KissopenSelection): HistoryMessageMode {
    return {
        effort: selection.effort,
        modelId: selection.modelId,
        permissionMode: selection.permissionMode,
        providerId: selection.providerId,
        serviceTier: null,
    };
}

function selectionFromConfig(config: AgentConfig, fallback: KissopenSelection): KissopenSelection {
    const metadata = config.metadata;
    if (!Value.Check(kissopenMetadataSchema, metadata)) return fallback;
    return metadata.kissopen;
}

/** The presentations of one History message's tool results, by call id. */
function historyToolPresentations(
    message: HistoryMessage | undefined,
): ReadonlyMap<string, HistoryToolPresentation> {
    const presentations = new Map<string, HistoryToolPresentation>();
    for (const block of message?.blocks ?? []) {
        if (block.type === "tool_result" && block.presentation !== undefined) {
            presentations.set(block.callId, block.presentation);
        }
    }
    return presentations;
}
