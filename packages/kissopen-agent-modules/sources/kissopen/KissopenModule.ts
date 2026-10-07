import type {
    BrowserControlRequest,
    BrowserControlResponse,
    BrowserOperation,
    BrowserResult,
} from "@kissopen/kissopen-agent-client";
import { browserTool } from "./browserTool.js";
import { LocalThemeError, localThemeGenerate } from "./localTheme.js";
import type {
    LocalThemeCapability,
    LocalThemeGenerate,
    LocalThemeGenerated,
} from "@kissopen/kissopen-agent-client";
import {
    agentDatabase,
    withAgentDatabase,
    type AgentModule,
    type AgentModuleHooks,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@kissopen/kissopen-agent-base";
import type { KissopenIntegration } from "@kissopen/kissopen-agent-client";
import { detach, type Context } from "@steve.kite/stdlib";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import type { BotsModule } from "../bots/index.js";
import type { ComputeModule } from "../compute/index.js";
import type { ConfigModule } from "../config/index.js";
import type { EventsModule } from "../events/index.js";
import type { ExpertModule } from "../expert/index.js";
import type { ProjectFilesModule } from "../files/index.js";
import type { GitModule } from "../git/index.js";
import type { HistoryModule } from "../history/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { ProviderUsageModule } from "../providerUsage/index.js";
import type { SchedulingModule } from "../scheduling/index.js";
import { TeamAuthenticationError, type TeamModule, type TeamUser } from "../team/index.js";
import type { UserInputModule } from "../userInput/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import type { TerminalsModule } from "../terminals/index.js";
import { KissopenConnection, type KissopenIntegrationListener } from "./KissopenConnection.js";
import { kissopenSyncMigrations } from "./KissopenSyncDatabase.js";
import { kissopenIntegrationMigrations } from "./KissopenIntegrationDatabase.js";
import { kissopenProjectSyncMigrations } from "./KissopenProjectSyncDatabase.js";

export {
    KissopenIntegrationStartError,
    type KissopenIntegrationListener,
} from "./KissopenConnection.js";

/** One feature owns the standalone connection or all personal team connections. */
export class KissopenModule extends KissopenConnection implements AgentModule<AnyAgentTool> {
    readonly name = "kissopen";
    // Released module-wide order is 001, 002, 003. Per-store extensions come after that prefix.
    readonly migrations = [
        kissopenSyncMigrations[0]!,
        kissopenIntegrationMigrations[0]!,
        kissopenProjectSyncMigrations[0]!,
        ...kissopenSyncMigrations.slice(1),
        ...kissopenIntegrationMigrations.slice(1),
        ...kissopenProjectSyncMigrations.slice(1),
    ];
    readonly #team: TeamModule;
    readonly #themeConfig: ConfigModule;
    #themeGenerations = 0;
    readonly #scheduling: SchedulingModule;
    readonly #createConnection: (user: TeamUser) => KissopenConnection;
    readonly #connections = new Map<
        string,
        { connection: KissopenConnection; ready: Promise<void> }
    >();
    readonly #listeners = new Set<KissopenIntegrationListener>();
    #context: Context | undefined;
    #agents: AgentSystemRef<LibSQLDatabase> | undefined;
    #closed = false;

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
        team: TeamModule,
        files: ProjectFilesModule,
        /** The daemon's terminals, for the folder each session stands in. */
        terminals?: TerminalsModule,
        expert?: ExpertModule,
    ) {
        super(
            config,
            compute,
            events,
            git,
            history,
            projects,
            providerUsage,
            scheduling,
            userInput,
            workspaces,
            bots,
            files,
            undefined,
            undefined,
            terminals,
            expert,
        );
        this.#scheduling = scheduling;
        this.#themeConfig = config;
        this.#team = team;
        this.#createConnection = (user) =>
            new KissopenConnection(
                config,
                compute,
                events,
                git,
                history,
                projects,
                providerUsage,
                scheduling,
                userInput,
                workspaces,
                bots,
                files,
                team,
                user,
                terminals,
                expert,
            );
        events.observe({
            onEvent: async (ctx, event) => {
                if (!this.#team.enabled) return await this.eventsListener.onEvent?.(ctx, event);
                for (const { connection } of this.#connections.values()) {
                    await connection.eventsListener.onEvent?.(ctx, event);
                }
            },
            onEventTransactional: async (ctx, event) => {
                if (!this.#team.enabled)
                    return await this.eventsListener.onEventTransactional?.(ctx, event);
                // All durable projections participate in the original event's transaction.
                for (const { connection } of this.#connections.values()) {
                    await connection.eventsListener.onEventTransactional?.(ctx, event);
                }
            },
        });
    }

    /** The first enabled local model follows the installation's default-model ordering. */
    themeGeneration(): LocalThemeCapability {
        const model = this.#themeConfig.models.find((entry) => entry.providerId !== "kissopen");
        return {
            available: model !== undefined,
            model: model ? { providerId: model.providerId, modelId: model.id } : null,
        };
    }

    async generateTheme(ctx: Context, input: LocalThemeGenerate): Promise<LocalThemeGenerated> {
        if (this.#themeGenerations >= 2)
            throw new LocalThemeError(
                409,
                "theme_generation_busy",
                "Two themes are already being generated. Wait for them to finish and try again.",
            );
        this.#themeGenerations++;
        try {
            return await localThemeGenerate(ctx, this.#themeConfig, input);
        } finally {
            this.#themeGenerations--;
        }
    }

    /**
     * A person wrote into a session from outside the phone connection — the desktop's API: end
     * the waits that would otherwise hold the message back, exactly as a phone message does.
     */
    interruptWaits(ctx: Context, agentId: string): void {
        this.#scheduling.interruptWaits(ctx, agentId);
    }

    override async browserControl(
        ctx: Context,
        agentId: string,
        request: BrowserControlRequest,
    ): Promise<BrowserControlResponse> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).browserControl(ctx, agentId, request)
            : super.browserControl(ctx, agentId, request);
    }

    override async browserExecute(
        ctx: Context,
        agentId: string,
        operation: BrowserOperation,
    ): Promise<BrowserResult> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).browserExecute(ctx, agentId, operation)
            : super.browserExecute(ctx, agentId, operation);
    }

    readonly beforeStart = (
        ctx: Context,
        agents: AgentSystemRef<LibSQLDatabase>,
    ): AgentModuleHooks => {
        if (!this.#team.enabled) return this.start(ctx, agents);
        const database = agentDatabase(ctx);
        if (database === undefined) throw new Error("KissOpen requires its agent database.");
        this.#context = withAgentDatabase(
            detach(ctx).named("personal-mobile-connections"),
            database,
        );
        this.#agents = agents;
        return {
            tools: async (toolsCtx, scope) =>
                (await agents.parentOf(toolsCtx, scope.agent.id)) === null
                    ? [
                          browserTool((callCtx, operation) =>
                              this.browserExecute(callCtx, scope.agent.id, operation),
                          ),
                      ]
                    : [],
            afterStart: async () => {
                const users = await this.#team.listUsers(this.#context!);
                await Promise.all(
                    users.map(async (user) => {
                        await this.#personalConnection(user);
                    }),
                );
            },
        };
    };

    override onIntegrationUpdated(listener: KissopenIntegrationListener): () => void {
        const unsubscribe = super.onIntegrationUpdated(listener);
        this.#listeners.add(listener);
        return () => {
            unsubscribe();
            this.#listeners.delete(listener);
        };
    }

    override async integration(ctx: Context): Promise<KissopenIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).integration(ctx)
            : super.integration(ctx);
    }
    override async startIntegration(ctx: Context): Promise<KissopenIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).startIntegration(ctx)
            : super.startIntegration(ctx);
    }
    override async cancelIntegration(ctx: Context): Promise<KissopenIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).cancelIntegration(ctx)
            : super.cancelIntegration(ctx);
    }
    override async disconnectIntegration(ctx: Context): Promise<KissopenIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).disconnectIntegration(ctx)
            : super.disconnectIntegration(ctx);
    }
    override async rePairIntegration(ctx: Context): Promise<KissopenIntegration> {
        return this.#team.enabled
            ? (await this.#currentConnection(ctx)).rePairIntegration(ctx)
            : super.rePairIntegration(ctx);
    }
    override async settle(): Promise<void> {
        await super.settle();
        await Promise.all(
            [...this.#connections.values()].map(async ({ connection, ready }) => {
                await ready;
                await connection.settle();
            }),
        );
    }
    override async stop(): Promise<void> {
        this.#closed = true;
        await Promise.all([
            super.stop(),
            ...[...this.#connections.values()].map(async ({ connection, ready }) => {
                await ready.catch(() => undefined);
                await connection.stop();
            }),
        ]);
        this.#connections.clear();
    }

    async #currentConnection(ctx: Context): Promise<KissopenConnection> {
        const user = await this.#team.currentUser(ctx);
        if (user === undefined) throw new TeamAuthenticationError();
        return await this.#personalConnection(user);
    }

    async #personalConnection(user: TeamUser): Promise<KissopenConnection> {
        if (this.#closed || this.#context === undefined || this.#agents === undefined) {
            throw new Error("KissOpen mobile connections are not running.");
        }
        let entry = this.#connections.get(user.id);
        if (entry === undefined) {
            const connection = this.#createConnection(user);
            connection.onIntegrationUpdated(async (ctx, integration, ownerId) => {
                for (const listener of this.#listeners) await listener(ctx, integration, ownerId);
            });
            const hooks = connection.start(this.#context, this.#agents);
            const ready = Promise.resolve().then(async () => {
                await hooks.afterStart?.(this.#context!, this.#agents!);
            });
            entry = { connection, ready };
            this.#connections.set(user.id, entry);
            void ready.catch(() => undefined);
        }
        await entry.ready;
        return entry.connection;
    }
}
