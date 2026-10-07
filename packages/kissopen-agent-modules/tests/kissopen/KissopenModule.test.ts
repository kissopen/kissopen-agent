import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentConfig, AgentPermissionMode } from "@kissopen/kissopen-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
    createKissopenSyncDatabase,
    KissopenModule,
    kissopenProjectSyncMigrations,
    kissopenSyncMigrations,
    type KissopenSpawnRequest,
} from "../../sources/kissopen/index.js";
import { kissopenIntegrationMigrations } from "../../sources/kissopen/KissopenIntegrationDatabase.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import type { BotRecord } from "../../sources/bots/index.js";
import { HistoryModule } from "../../sources/history/index.js";
import { ProjectFileError } from "../../sources/files/index.js";

const kissopenConnection = vi.hoisted(() => ({
    configuration: {
        credentials: {
            encryption: { secret: new Uint8Array(32), type: "legacy" as const },
            token: "token",
        },
        credentialsPath: "/tmp/kissopen/access.key",
        kissopenHome: "/tmp/kissopen",
        imported: false,
        machineId: "machine-1",
        serverUrl: "https://api.kissopen.example",
    },
    socketFactory: undefined as
        | undefined
        | ((url: string, options: Record<string, unknown>) => unknown),
}));

vi.mock("../../sources/kissopen/credentials/importKissopenCredentials.js", () => ({
    importKissopenCredentials: async () => kissopenConnection.configuration,
}));

vi.mock("../../sources/kissopen/connectKissopenSocket.js", () => ({
    connectKissopenSocket: (url: string, options: Record<string, unknown>) => {
        if (kissopenConnection.socketFactory === undefined) {
            throw new Error("This test did not install a KISSOPEN socket.");
        }
        return kissopenConnection.socketFactory(url, options);
    },
}));

const SELECTION = {
    effort: "medium",
    modelId: "gpt-5.6-sol",
    permissionMode: "auto" as AgentPermissionMode,
    providerId: "codex",
};

const databases: ReturnType<typeof moduleDatabase>[] = [];
const temporaryDirectories: string[] = [];
const modules: KissopenModule[] = [];

afterEach(async () => {
    for (const module of modules.splice(0)) await module.stop();
    for (const database of databases.splice(0)) database.close();
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
    kissopenConnection.socketFactory = undefined;
    vi.unstubAllGlobals();
});

function targetRequest(
    target: Exclude<KissopenSpawnRequest, { cwd: string }>["target"],
): KissopenSpawnRequest {
    return {
        ...SELECTION,
        sessionId: "kissopen-session",
        target,
        workspaceId: "kissopen-workspace",
    };
}

async function fixture() {
    const database = moduleDatabase(
        [
            ...kissopenSyncMigrations,
            ...kissopenIntegrationMigrations,
            ...kissopenProjectSyncMigrations,
        ],
        "kissopen-module-test",
    );
    databases.push(database);
    await database.ready;

    const configs = new Map<string, AgentConfig>();
    const bots = new Map<string, BotRecord>();
    const archivedBots: string[] = [];
    let botReadContext: Context | undefined;
    const botArchiveScopes: { read: Context | undefined; write: Context }[] = [];
    const aborted: string[] = [];
    const archivedCompute: string[] = [];
    const activity: { questionAt?: number; textMessageAt?: number; working?: boolean } = {};
    const gitState: { snapshot?: Record<string, unknown>; tracked: Record<string, unknown>[] } = {
        tracked: [],
    };
    const projectAgents = new Map<string, string>();
    const workspaceAgents = new Map<string, string>();
    const trees: { root: string; path?: string; cursor?: string }[] = [];
    const pendingMessages: Record<string, unknown>[] = [];
    const steered: {
        agentId: string;
        message: Record<string, unknown>;
        options: Record<string, unknown>;
    }[] = [];
    const projects = new Map([
        [
            "project-1",
            {
                id: "project-1",
                kind: "regular" as const,
                name: "Rig",
                repositoryRef: "/projects/rig",
                status: "active" as const,
            },
        ],
    ]);
    const workspaces = new Map<
        string,
        {
            id: string;
            name: string;
            path: string;
            projectRef: string;
            status: "initializing" | "ready";
        }
    >([
        [
            "workspace-1",
            {
                id: "workspace-1",
                name: "RPC",
                path: "/projects/rig/rpc",
                projectRef: "project-1",
                status: "ready" as const,
            },
        ],
    ]);
    const createdWorkspaces: unknown[] = [];

    const agents = {
        abort: async (_ctx: unknown, agentId: string) => {
            aborted.push(agentId);
        },
        config: async (_ctx: unknown, agentId: string) => configs.get(agentId),
        create: async (_ctx: unknown, config: AgentConfig, options: { id: string }) => {
            configs.set(options.id, config);
            return options.id;
        },
        steer: async (
            _ctx: unknown,
            agentId: string,
            message: Record<string, unknown>,
            options: Record<string, unknown>,
        ) => {
            steered.push({ agentId, message, options });
            return { accepted: "created", delivery: "steer", id: options.id };
        },
        updateMetadata: async (
            _ctx: unknown,
            agentId: string,
            metadata: Record<string, unknown>,
        ) => {
            const current = configs.get(agentId);
            if (current === undefined) throw new Error("Missing agent config.");
            configs.set(agentId, {
                ...current,
                metadata: { ...current.metadata, ...metadata },
            } as AgentConfig);
        },
    };
    const projectModule = {
        attachAgent: async (_ctx: unknown, projectId: string, agentId: string) => {
            projectAgents.set(agentId, projectId);
        },
        get: async (_ctx: unknown, projectId: string) => projects.get(projectId),
        projectForAgent: async (_ctx: unknown, agentId: string) => {
            const projectId = projectAgents.get(agentId);
            return projectId === undefined ? undefined : projects.get(projectId);
        },
    };
    const workspaceModule = {
        attachAgent: async (_ctx: unknown, workspaceId: string, agentId: string) => {
            workspaceAgents.set(agentId, workspaceId);
        },
        createWorkspace: async (_ctx: unknown, projectId: string, request: unknown) => {
            createdWorkspaces.push({ projectId, request });
            const workspace = {
                id: "kissopen-workspace",
                name: "Workspace",
                path: "/projects/rig/kissopen-workspace",
                projectRef: projectId,
                status: "initializing" as const,
            };
            workspaces.set(workspace.id, workspace);
            return workspace;
        },
        get: async (_ctx: unknown, workspaceId: string) => workspaces.get(workspaceId),
        resolvePath: async (_ctx: unknown, cwd: string) => ({
            project: {
                id: "project-1",
                kind: "regular" as const,
                name: "Rig",
                repositoryRef: cwd,
                status: "active" as const,
            },
        }),
        workspaceForAgent: async (_ctx: unknown, agentId: string) => workspaceAgents.get(agentId),
    };
    const module = new KissopenModule(
        {
            configuration: {
                values: {
                    defaults: { permissionMode: "auto" },
                    settings: { kissopenIntegration: true },
                },
                version: "test",
            },
            kissopenMessageMode: <T>(mode: T) => mode,
            models: [
                {
                    defaultEffort: "medium",
                    effortLevels: ["low", "medium", "high"],
                    id: "gpt-5.6-sol",
                    name: "GPT-5.6 Sol",
                    providerId: "codex",
                },
            ],
        } as never,
        {
            archiveAgent: async (_ctx: unknown, agentId: string) => {
                archivedCompute.push(agentId);
            },
        } as never,
        {
            activeRunId: () => (activity.working === true ? "active-run" : undefined),
            observe: () => undefined,
        } as never,
        {
            topLevel: async () => {
                throw new Error("Not a Git repository.");
            },
            onSnapshot: () => () => undefined,
            track: (entity: Record<string, unknown>) => {
                gitState.tracked.push(entity);
            },
            trackedSnapshot: () => gitState.snapshot,
        } as never,
        {
            latestUserOrFinalAssistantTextMessageAt: async () => activity.textMessageAt,
            onCleared: () => () => undefined,
            inputBlocks: new HistoryModule().inputBlocks,
            queuePending: async (_ctx: unknown, message: Record<string, unknown>) => {
                pendingMessages.push(message);
            },
        } as never,
        projectModule as never,
        { list: () => [], onChanged: () => () => undefined } as never,
        { interruptWaits: () => undefined } as never,
        {
            latestQuestionAt: async () => activity.questionAt,
            supersedePending: async () => undefined,
        } as never,
        workspaceModule as never,
        {
            list: async () => [...bots.values()],
            forWorkspace: async (_ctx: unknown, workspaceId: string) =>
                [...bots.values()].find((bot) => bot.workspaceId === workspaceId),
            forAgent: async (ctx: Context, agentId: string) => {
                botReadContext = ctx;
                return [...bots.values()].find((bot) => bot.agentId === agentId);
            },
            archive: async (ctx: Context, botId: string, version: number) => {
                botArchiveScopes.push({ read: botReadContext, write: ctx });
                const bot = bots.get(botId)!;
                expect(version).toBe(bot.version);
                archivedBots.push(botId);
            },
        } as never,
        { enabled: false } as never,
        {
            resolveRoot: async (_ctx: Context, projectId: string, workspaceId?: string) => {
                if (workspaceId !== undefined && workspaces.get(workspaceId)?.status !== "ready")
                    throw new ProjectFileError(409, "conflict", "The workspace is not ready.");
                return {
                    projectId,
                    root:
                        workspaceId === undefined
                            ? projects.get(projectId)!.repositoryRef
                            : workspaces.get(workspaceId)!.path,
                };
            },
            read: async (root: { root: string }) => ({
                content: Buffer.from(root.root).toString("base64"),
                hash: "a".repeat(64),
            }),
            // Two pages, so a listing that pages through them is visible.
            tree: async (root: { root: string }, query: { path?: string; cursor?: string }) => {
                trees.push({ root: root.root, ...query });
                const folder = query.path ?? "";
                return query.cursor === undefined
                    ? {
                          entries: [
                              {
                                  name: "outputs",
                                  path: "outputs",
                                  type: "directory",
                                  size: 0,
                                  modified: 1,
                              },
                              { name: "link", path: "link", type: "symlink", size: 0, modified: 2 },
                          ],
                          nextCursor: "2",
                          path: folder,
                      }
                    : {
                          entries: [
                              {
                                  name: "deck.pptx",
                                  path: "deck.pptx",
                                  type: "file",
                                  size: 191_000,
                                  modified: 3,
                              },
                          ],
                          nextCursor: null,
                          path: folder,
                      };
            },
        } as never,
    );
    modules.push(module);
    module.beforeStart(database.context, agents as never);

    return {
        trees,
        activity,
        aborted,
        agents,
        archivedCompute,
        archivedBots,
        botArchiveScopes,
        bots,
        configs,
        createdWorkspaces,
        gitState,
        module,
        pendingMessages,
        projectAgents,
        projects,
        steered,
        workspaceAgents,
        workspaces,
    };
}

describe("KISSOPEN mobile messages", () => {
    it("reports a plain-folder Git view as unsupported rather than asking the phone to retry", async () => {
        const test = await fixture();
        test.configs.set("viewer", { metadata: {} });
        test.projectAgents.set("viewer", "project-1");
        await expect(
            test.module.gitState(databases.at(-1)!.context, "viewer"),
        ).rejects.toMatchObject({ code: "unsupported" });
    });

    it("resolves reads through fresh catalog ownership, never an agent's working directory", async () => {
        const test = await fixture();
        const ctx = databases.at(-1)!.context;
        test.configs.set("viewer", {
            metadata: {},
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/outside",
            },
        });
        await expect(
            test.module.readFile(ctx, "viewer", { path: "note.txt" }),
        ).rejects.toMatchObject({ code: "unsupported" });
        test.projectAgents.set("viewer", "project-1");
        expect(await test.module.readFile(ctx, "viewer", { path: "note.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("/projects/rig").toString("base64"),
        });
        test.workspaceAgents.set("viewer", "workspace-1");
        expect(await test.module.readFile(ctx, "viewer", { path: "note.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("/projects/rig/rpc").toString("base64"),
        });
        test.workspaces.get("workspace-1")!.status = "initializing";
        await expect(
            test.module.readFile(ctx, "viewer", { path: "note.txt" }),
        ).rejects.toMatchObject({ code: "conflict" });
        test.configs.set("viewer", { metadata: { archivedAt: 1 } });
        await expect(
            test.module.readFile(ctx, "viewer", { path: "note.txt" }),
        ).rejects.toMatchObject({ code: "missing" });
    });

    it("lists one folder of the session's workspace, paging through it, and nothing outside it", async () => {
        const test = await fixture();
        const ctx = databases.at(-1)!.context;
        test.configs.set("viewer", { metadata: {} });
        test.projectAgents.set("viewer", "project-1");
        expect(await test.module.listDirectory(ctx, "viewer", { path: "./outputs/" })).toEqual({
            success: true,
            path: "outputs",
            entries: [
                { name: "outputs", type: "directory", size: 0, modified: 1 },
                { name: "link", type: "other", size: 0, modified: 2 },
                { name: "deck.pptx", type: "file", size: 191_000, modified: 3 },
            ],
            truncated: false,
        });
        expect(test.trees.map(({ path, cursor }) => ({ path, cursor }))).toEqual([
            { path: "outputs", cursor: undefined },
            { path: "outputs", cursor: "2" },
        ]);
        // The workspace's own absolute path is its root; a path outside it is refused.
        await test.module.listDirectory(ctx, "viewer", { path: "/projects/rig" });
        expect(test.trees.at(-2)).toEqual({ root: "/projects/rig", limit: 500 });
        await expect(
            test.module.listDirectory(ctx, "viewer", { path: "/projects/other" }),
        ).rejects.toMatchObject({ code: "forbidden" });
        // Catalog ownership still decides whose folder this is.
        test.configs.set("viewer", { metadata: { archivedAt: 1 } });
        await expect(test.module.listDirectory(ctx, "viewer", { path: "" })).rejects.toMatchObject({
            code: "missing",
        });
    });

    it("appends personal storage migrations after the released module-wide prefix", async () => {
        const test = await fixture();
        expect(test.module.migrations.map(([key]) => key)).toEqual([
            "001-kissopen-sync",
            "002-kissopen-integration-state",
            "003-kissopen-project-sync",
            "004-personal-session-sync",
            "005-personal-integration-state",
            "006-personal-project-sync",
        ]);
    });

    it("queues the exact rich request without also injecting its display fallback", async () => {
        const test = await fixture();
        test.configs.set("agent-rich", { metadata: { kissopen: SELECTION } });
        const content = [{ type: "tool_call_request" as const, name: "list_skills" }];
        await test.module.submit(databases.at(-1)!.context, "agent-rich", {
            content,
            images: [],
            remoteMessageId: "kissopen:rich-1",
            selection: {},
            text: "Requested tool: list_skills",
        });
        expect(test.pendingMessages[0]).toMatchObject({ blocks: content });
        expect(test.steered[0]).toMatchObject({ message: { role: "user", content } });
    });

    it("publishes a pending steering message before delivering it to Agent Base", async () => {
        const test = await fixture();
        test.configs.set("agent-active", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { kissopen: SELECTION },
        });

        await test.module.submit(databases.at(-1)!.context, "agent-active", {
            images: [],
            remoteMessageId: "kissopen:mobile-message-1",
            selection: {},
            text: "Steer this active run.",
        });

        expect(test.pendingMessages).toEqual([
            expect.objectContaining({
                agentId: "agent-active",
                blocks: [{ text: "Steer this active run.", type: "text" }],
                delivery: "steer",
                role: "user",
                runId: null,
                status: "pending",
            }),
        ]);
        const pendingId = test.pendingMessages[0]?.id;
        expect(pendingId).toEqual(expect.any(String));
        expect(test.steered).toEqual([
            expect.objectContaining({
                agentId: "agent-active",
                message: {
                    content: [{ text: "Steer this active run.", type: "text" }],
                    role: "user",
                },
                options: expect.objectContaining({
                    id: pendingId,
                    metadata: expect.objectContaining({
                        kissopen: { remoteMessageId: "kissopen:mobile-message-1" },
                    }),
                }),
            }),
        ]);
    });
});

describe("KissopenModule spawn ownership", () => {
    it("starts at a project root and attaches there", async () => {
        const test = await fixture();

        await expect(
            test.module.spawnSession(
                databases.at(-1)!.context,
                targetRequest({ id: "project-1", kind: "project" }),
            ),
        ).resolves.toEqual({ agentId: "kissopen-session", type: "ready" });
        expect(test.configs.get("kissopen-session")?.environment?.workingDirectory).toBe(
            "/projects/rig",
        );
        expect(test.projectAgents.get("kissopen-session")).toBe("project-1");
    });

    it("starts in a ready workspace and attaches there", async () => {
        const test = await fixture();

        await test.module.spawnSession(
            databases.at(-1)!.context,
            targetRequest({ id: "workspace-1", kind: "workspace" }),
        );

        expect(test.configs.get("kissopen-session")?.environment?.workingDirectory).toBe(
            "/projects/rig/rpc",
        );
        expect(test.workspaceAgents.get("kissopen-session")).toBe("workspace-1");
    });

    it("returns pending until its deterministic new workspace is ready", async () => {
        const test = await fixture();
        const request = targetRequest({ kind: "newWorkspace", projectId: "project-1" });

        await expect(test.module.spawnSession(databases.at(-1)!.context, request)).resolves.toEqual(
            { type: "pending" },
        );
        expect(test.createdWorkspaces).toEqual([
            {
                projectId: "project-1",
                request: {
                    id: "kissopen-workspace",
                    name: "Workspace",
                    nameConfigured: false,
                    parentId: "project-1",
                },
            },
        ]);
        test.workspaces.set("kissopen-workspace", {
            id: "kissopen-workspace",
            name: "Workspace",
            path: "/projects/rig/kissopen-workspace",
            projectRef: "project-1",
            status: "ready",
        });

        await expect(test.module.spawnSession(databases.at(-1)!.context, request)).resolves.toEqual(
            { agentId: "kissopen-session", type: "ready" },
        );
        expect(test.workspaceAgents.get("kissopen-session")).toBe("kissopen-workspace");
    });

    it("creates a missing project folder silently before resolving it", async () => {
        const test = await fixture();
        const root = await mkdtemp(join(tmpdir(), "kissopen-project-folder-"));
        temporaryDirectories.push(root);
        const projectPath = join(root, "new", "project");

        await test.module.spawnSession(
            databases.at(-1)!.context,
            targetRequest({ kind: "projectFolder", projectPath }),
        );

        expect((await stat(projectPath)).isDirectory()).toBe(true);
        expect(test.configs.get("kissopen-session")?.environment?.workingDirectory).toBe(
            projectPath,
        );
        expect(test.projectAgents.get("kissopen-session")).toBe("project-1");
    });
});

describe("KISSOPEN session activity metadata", () => {
    it("marks the session working exactly while its durable run is active", async () => {
        const test = await fixture();
        test.configs.set("agent-activity", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 1 },
        });

        test.activity.working = true;
        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ working: true });

        test.activity.working = false;
        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ working: false });
    });

    it("uses the newest visible text message or user-facing question", async () => {
        const test = await fixture();
        test.configs.set("agent-activity", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 1 },
        });
        test.activity.textMessageAt = 1_000;
        test.activity.questionAt = 2_000;

        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ lastMeaningfulMessageAt: 2_000 });

        test.activity.textMessageAt = 3_000;
        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({ lastMeaningfulMessageAt: 3_000 });
    });

    it("publishes the tracked project Git snapshot using the canonical line counts", async () => {
        const test = await fixture();
        test.configs.set("agent-activity", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 1 },
        });
        test.projectAgents.set("agent-activity", "project-1");
        test.gitState.snapshot = {
            changedFiles: 39,
            comparison: "ready",
            countsExact: true,
            deletions: 180,
            insertions: 3_032,
        };

        await expect(
            test.module.session(databases.at(-1)!.context, "agent-activity"),
        ).resolves.toMatchObject({
            git: {
                changedFiles: 39,
                countsExact: true,
                deletions: 180,
                insertions: 3_032,
            },
        });
        expect(test.gitState.tracked).toContainEqual({
            path: "/projects/rig",
            projectId: "project-1",
        });
    });
});

describe("archiving a KISSOPEN session", () => {
    it("does not spawn a second conversation in a bot's workspace or folder", async () => {
        const test = await fixture();
        test.bots.set("bot-1", {
            id: "bot-1",
            agentId: "bot-agent",
            workspaceId: "bot-workspace",
            path: "/bots/assistant",
        } as BotRecord);
        for (const request of [
            targetRequest({ kind: "workspace", id: "bot-workspace" }),
            targetRequest({ kind: "projectFolder", projectPath: "/bots/assistant" }),
            { ...SELECTION, sessionId: "another-agent", cwd: "/bots/assistant" },
        ]) {
            await expect(
                test.module.spawnSession(databases.at(-1)!.context, request),
            ).rejects.toThrow("one continuous conversation");
        }
        expect(test.configs.size).toBe(0);
        expect(test.createdWorkspaces).toEqual([]);
    });

    it("archives a bot through its catalog, never by independently archiving its agent", async () => {
        const test = await fixture();
        test.bots.set("bot-1", {
            id: "bot-1",
            agentId: "agent-1",
            version: 7,
            status: "active",
        } as BotRecord);
        test.configs.set("agent-1", { metadata: { version: 4 } });
        await test.module.archiveSession(databases.at(-1)!.context, "agent-1");
        expect(test.archivedBots).toEqual(["bot-1"]);
        expect(test.archivedCompute).toEqual([]);
        expect(test.configs.get("agent-1")?.metadata).toEqual({ version: 4 });
        const scope = test.botArchiveScopes[0]!;
        expect(scope.read).toBe(scope.write);
        // A real transaction facade expires after commit; the root context does not.
        expect(() => scope.write.db).toThrow("transaction carried by this context has ended");
    });

    it("refuses a late phone message to an archived bot", async () => {
        const test = await fixture();
        test.bots.set("bot-1", {
            id: "bot-1",
            agentId: "agent-1",
            version: 7,
            status: "archived",
        } as BotRecord);
        test.configs.set("agent-1", { metadata: { version: 4 } });
        await expect(
            test.module.submit(databases.at(-1)!.context, "agent-1", {
                text: "Do not resurrect this bot",
                images: [],
                remoteMessageId: "late-message",
                selection: {},
            }),
        ).rejects.toThrow("archived");
        expect(test.steered).toEqual([]);
        expect(test.pendingMessages).toEqual([]);
    });

    it("archives the durable local agent instead of only stopping and detaching it", async () => {
        const test = await fixture();
        test.configs.set("agent-1", {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: "/projects/rig",
            },
            metadata: { version: 4 },
        });

        await test.module.archiveSession(databases.at(-1)!.context, "agent-1");

        expect(test.aborted).toEqual(["agent-1"]);
        expect(test.archivedCompute).toEqual(["agent-1"]);
        expect(test.configs.get("agent-1")?.metadata).toMatchObject({
            archivedAt: expect.any(Number),
            updatedAt: expect.any(Number),
            version: 5,
        });
    });

    it("archives a workspace session that never occupied an attached-client slot", async () => {
        const database = moduleDatabase(
            [...kissopenSyncMigrations, ...kissopenIntegrationMigrations],
            "kissopen-unattached-archive-test",
        );
        databases.push(database);
        await database.ready;

        class AutomaticSocket {
            connected = true;
            readonly #listeners = new Map<string, (...values: any[]) => void>();

            connect(): void {
                this.#listeners.get("connect")?.();
            }

            disconnect(): void {
                this.connected = false;
            }

            emit(_event: string, ...values: unknown[]): void {
                const callback = values[1];
                if (typeof callback === "function") {
                    (callback as (answer: unknown) => void)({ result: "success", version: 1 });
                }
            }

            on(event: string, listener: (...values: any[]) => void): void {
                this.#listeners.set(event, listener);
            }
        }

        kissopenConnection.socketFactory = () => new AutomaticSocket();
        const requests: string[] = [];
        vi.stubGlobal("fetch", (async (input: string | URL, init: RequestInit = {}) => {
            const url = new URL(typeof input === "string" ? input : input.toString());
            requests.push(`${init.method ?? "GET"} ${url.pathname}`);
            if (url.pathname === "/v1/machines") {
                return Response.json({
                    machine: { daemonStateVersion: 1, id: "machine-1", metadataVersion: 1 },
                });
            }
            if (url.pathname === "/v1/sessions") {
                return Response.json({
                    session: {
                        agentState: null,
                        agentStateVersion: 0,
                        id: "remote-unattached",
                        metadataVersion: 1,
                    },
                });
            }
            if (url.pathname === "/v1/sessions/remote-unattached/archive") {
                return Response.json({ ok: true });
            }
            throw new Error(`Unexpected KISSOPEN request: ${url.pathname}`);
        }) as typeof fetch);

        let workspaceListener:
            | undefined
            | ((ctx: typeof database.context, event: Record<string, unknown>) => void);
        const archivedWorkspace = {
            archivedAt: 2,
            id: "workspace-archived",
            name: "Archived workspace",
            path: "/projects/rig/archived",
            projectRef: "project-1",
            status: "archived" as const,
        };
        const project = {
            id: "project-1",
            kind: "regular" as const,
            name: "Rig",
            repositoryRef: "/projects/rig",
            status: "active" as const,
        };
        const config: AgentConfig = {
            environment: {
                osVersion: "test",
                platform: "darwin",
                shell: "/bin/zsh",
                workingDirectory: archivedWorkspace.path,
            },
            metadata: { version: 1 },
        };
        const agents = {
            abort: async () => undefined,
            config: async (_ctx: unknown, agentId: string) =>
                agentId === "agent-unattached" ? config : undefined,
            updateMetadata: async () => undefined,
        };
        const projects = {
            get: async () => project,
            listCatalogPage: async () => ({ projects: [] }),
            onEvent: () => () => undefined,
            projectForAgent: async () => undefined,
        };
        const workspaces = {
            get: async () => archivedWorkspace,
            listAgentIds: async () => ["agent-unattached"],
            listCatalogPage: async () => ({ workspaces: [] }),
            onEvent: (
                listener: (ctx: typeof database.context, event: Record<string, unknown>) => void,
            ) => {
                workspaceListener = listener;
                return () => undefined;
            },
            workspaceForAgent: async () => "workspace-archived",
        };
        const module = new KissopenModule(
            {
                configuration: {
                    paths: { agentHome: "/tmp/kissopen-agent-test" },
                    values: {
                        defaults: { permissionMode: "auto" },
                        settings: { kissopenIntegration: true },
                    },
                    version: "test",
                },
                models: [
                    {
                        defaultEffort: "medium",
                        effortLevels: ["medium"],
                        id: "gpt-5.6-sol",
                        name: "GPT-5.6 Sol",
                        providerId: "codex",
                        serviceTiers: [],
                    },
                ],
            } as never,
            { archiveAgent: async () => undefined } as never,
            { latestAgentEvent: async () => undefined, observe: () => undefined } as never,
            {
                onSnapshot: () => () => undefined,
                track: () => undefined,
                trackedSnapshot: () => undefined,
            } as never,
            {
                latestUserOrFinalAssistantTextMessageAt: async () => undefined,
                onCleared: () => () => undefined,
            } as never,
            projects as never,
            { list: () => [], onChanged: () => () => undefined } as never,
            { interruptWaits: () => undefined } as never,
            {
                latestQuestionAt: async () => undefined,
                list: async () => [],
                onEvent: () => () => undefined,
            } as never,
            workspaces as never,
            {
                forAgent: async () => undefined,
                list: async () => [],
                onEvent: () => () => undefined,
            } as never,
            { enabled: false } as never,
            {} as never,
        );
        modules.push(module);
        const hooks = module.beforeStart(database.context, agents as never);
        await hooks.afterStart?.(database.context, agents as never);
        await module.settle();

        const sync = createKissopenSyncDatabase();
        await sync.ensureSession(
            database.context,
            {
                agentId: "agent-unattached",
                credentialFingerprint: "test",
                encryptionKeyBase64: Buffer.alloc(32).toString("base64"),
                encryptionVariant: "legacy",
                sessionId: "agent-unattached",
            },
            1,
        );
        await sync.setRemoteSession(database.context, "agent-unattached", "remote-unattached", 2);

        if (workspaceListener === undefined) throw new Error("KISSOPEN did not watch workspaces.");
        workspaceListener(database.context, {
            at: 3,
            eventId: "event-1",
            previousWorkspace: { ...archivedWorkspace, archivedAt: undefined, status: "ready" },
            type: "workspace_archived",
            workspace: archivedWorkspace,
        });
        await module.settle();

        expect(
            requests.filter((request) => request === "POST /v1/sessions/remote-unattached/archive"),
        ).toEqual(["POST /v1/sessions/remote-unattached/archive"]);
    });
});
