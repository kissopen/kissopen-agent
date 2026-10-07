import {
    ensureAgentDatabaseConnection,
    type AgentModel,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@kissopen/kissopen-agent-base";
import { withLifetime, type Context } from "@steve.kite/stdlib";
import { afterEach, describe, expect, it } from "vitest";

import { AUTONOMY_LIMIT_NOTICE, type AutonomyBudget } from "../../sources/autonomy/index.js";
import type { CollaborationModule } from "../../sources/collaboration/index.js";
import { ComputeModule, type HostCompute } from "../../sources/compute/index.js";
import type { ConfigModule } from "../../sources/config/index.js";
import {
    ASK_EXPERT_TOOL_NAME,
    ExpertModule,
    type AskExpertResult,
    type ExpertPolicyResponse,
} from "../../sources/expert/index.js";
import { SecretsModule } from "../../sources/secrets/index.js";
import { FixedAutonomy, UnboundedAutonomy } from "../support/autonomy.js";
import { testConfig } from "../support/computeModule.js";
import { temporaryTestConfig } from "../support/configModule.js";
import { moduleDatabase } from "../support/moduleDatabase.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";

const PARENT = "parent";

/** An installation whose KISSOPEN provider is configured, so the policy is actually read. */
const kissopenConfig = await temporaryTestConfig(
    [
        "[providers.kissopen]",
        'type = "codex"',
        'api_key = "device-key"',
        'base_url = "https://api.example.test/api/agent/v1"',
        "",
    ].join("\n"),
);
const EXPERT_MODEL = "openai/gpt-5.6-sol";
const EVERYDAY_MODEL = "deepseek/deepseek-flash";

const MODELS: readonly AgentModel[] = [
    {
        providerId: "kissopen",
        id: EXPERT_MODEL,
        name: "GPT-5.6 Sol",
        effortLevels: ["low", "medium", "high", "xhigh"],
        defaultEffort: "medium",
    },
    {
        providerId: "kissopen",
        id: "openai/gpt-6-astra",
        name: "GPT-6 Astra",
        effortLevels: ["low", "medium", "high"],
        defaultEffort: "high",
    },
    {
        providerId: "kissopen",
        id: EVERYDAY_MODEL,
        name: "DeepSeek V4.1 Flash",
        effortLevels: ["off", "high"],
        defaultEffort: "high",
    },
];

/** A policy the console could send, with one task kind switched off. */
function serverPolicy(
    overrides: Partial<ExpertPolicyResponse["policy"]> = {},
): ExpertPolicyResponse {
    return {
        models: [EXPERT_MODEL, "openai/gpt-6-astra", EVERYDAY_MODEL],
        policy: {
            default_model: EVERYDAY_MODEL,
            default_effort: "high",
            expert_model: EXPERT_MODEL,
            expert_effort: "high",
            expert_tasks: [
                { id: "slides", name: "演示文稿", description: "制作 PPT、幻灯片", enabled: true },
                { id: "plan", name: "计划与方案", description: "制定计划", enabled: false },
                { id: "analysis", name: "数据分析", description: "分析表格或数据", enabled: true },
            ],
            escalate_after_failures: 3,
            hide_model_picker: false,
            ...overrides,
        },
    };
}

interface Created {
    readonly actingAgentId: string;
    readonly agentId: string;
    readonly input: {
        readonly title: string;
        readonly model: string;
        readonly effort: string;
        readonly provider?: string;
        readonly text: string;
    };
    readonly options: {
        readonly reportToCreator?: boolean;
        readonly metadata?: Record<string, unknown>;
    };
}

/** The part of collaboration the module uses: the subagent list, creation, and interruption. */
class Collaborators {
    models: readonly AgentModel[] = MODELS;
    readonly created: Created[] = [];
    readonly interrupted: Array<{
        readonly actingAgentId: string;
        readonly targetAgentId: string;
    }> = [];
    readonly #waiting: (() => void)[] = [];

    subagentModels(): readonly AgentModel[] {
        return this.models;
    }

    /** Agents this fake created have a parent; every other agent started a conversation. */
    readonly children = new Set<string>();

    async isRoot(_ctx: Context, agentId: string): Promise<boolean> {
        return !this.children.has(agentId) && !this.created.some((c) => c.agentId === agentId);
    }

    async createAgent(
        _ctx: Context,
        actingAgentId: string,
        input: Created["input"],
        agentId: string,
        options: Created["options"] = {},
    ): Promise<{ readonly agentId: string }> {
        this.created.push({ actingAgentId, agentId, input, options });
        for (const wake of this.#waiting.splice(0)) wake();
        return { agentId };
    }

    async interruptAgent(_ctx: Context, actingAgentId: string, targetAgentId: string) {
        this.interrupted.push({ actingAgentId, targetAgentId });
    }

    async waitForCreation(): Promise<Created> {
        await this.waitFor(1);
        return this.created[0]!;
    }

    /** Wait until this many experts have been created. */
    async waitFor(count: number): Promise<void> {
        while (this.created.length < count) {
            await new Promise<void>((resolve) => {
                this.#waiting.push(resolve);
            });
        }
    }

    asModule(): CollaborationModule {
        return this as unknown as CollaborationModule;
    }
}

/** An in-memory store with the four operations the module uses. */
class MemoryKV {
    readonly values = new Map<string, unknown>();

    async read(_ctx: Context, key: string): Promise<unknown> {
        return structuredClone(this.values.get(key));
    }

    async write(_ctx: Context, key: string, value: unknown): Promise<void> {
        this.values.set(key, structuredClone(value));
    }

    async delete(_ctx: Context, key: string): Promise<void> {
        this.values.delete(key);
    }

    async list(_ctx: Context, prefix = "") {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value: structuredClone(value) }));
    }
}

/** The module with its three seams answered without a network or a real clock. */
class ScriptedExpertModule extends ExpertModule {
    readonly requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    reply: ExpertPolicyResponse | undefined;
    clock = 1_000_000;
    waitMs = 60_000;

    protected override transport(): typeof fetch {
        return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            this.requests.push({
                url: String(input),
                authorization: new Headers(init?.headers).get("authorization"),
            });
            if (this.reply === undefined) return new Response("{}", { status: 503 });
            return new Response(JSON.stringify(this.reply), { status: 200 });
        }) as typeof fetch;
    }

    protected override now(): number {
        return this.clock;
    }

    protected override get timeoutMs(): number {
        return this.waitMs;
    }
}

/**
 * A machine whose only files are the ones a test names, working in `/work`. Nothing else of the
 * compute module is reached: the expert module only looks files up.
 */
class FilesCompute extends ComputeModule {
    readonly #files: ReadonlySet<string> | undefined;

    constructor(files: ReadonlySet<string> | undefined) {
        super(testConfig, new SecretsModule());
        this.#files = files;
    }

    override async resolve(): Promise<HostCompute | undefined> {
        const files = this.#files;
        if (files === undefined) return undefined;
        return {
            cwd: "/work",
            fs: {
                cwd: "/work",
                home: "/home/person",
                stat: async (_permissions: unknown, path: string) => {
                    if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
                    return {
                        isFile: true,
                        isDirectory: false,
                        isSymbolicLink: false,
                        size: 1,
                        mtimeMs: 0,
                    };
                },
            },
        } as unknown as HostCompute;
    }

    override permissionsForContext(): never {
        return {} as never;
    }
}

/** What the module told an agent through the agent system. */
interface Steered {
    readonly agentId: string;
    readonly id: string | undefined;
    readonly text: string;
    readonly content: unknown;
    readonly metadata: unknown;
}

interface World {
    readonly module: ScriptedExpertModule;
    readonly autonomy: AutonomyBudget;
    /** Messages the module steered into conversations, in order. */
    readonly steered: Steered[];
    readonly hooks: AgentModuleHooks;
    readonly ctx: Context;
    readonly collaborators: Collaborators;
    readonly sharedKV: MemoryKV;
    /** The parent's scope on a given provider and model. */
    scope(provider?: string, model?: string): AgentModuleScope;
    tools(provider?: string, model?: string): Promise<readonly AnyAgentTool[]>;
    /** The scope Agent Base hands this module's hooks for the created expert. */
    expertScope(created: Created): AgentModuleScope;
    /** Rebuild the module over the same stores, as a restarted process would. */
    restart(): Promise<World>;
}

const worlds: World[] = [];

afterEach(() => {
    for (const world of worlds.splice(0)) world.module.close();
});

async function world(
    options: {
        readonly policy?: ExpertPolicyResponse;
        readonly config?: ConfigModule;
        /** The files the machine has; no machine at all when absent. */
        readonly files?: ReadonlySet<string>;
        readonly autonomy?: AutonomyBudget;
        readonly shared?: {
            readonly sharedKV: MemoryKV;
            readonly database: ReturnType<typeof moduleDatabase>;
        };
    } = {},
): Promise<World> {
    const database = options.shared?.database ?? moduleDatabase([], "expert-test");
    ensureAgentDatabaseConnection(database.database);
    const sharedKV = options.shared?.sharedKV ?? new MemoryKV();
    const collaborators = new Collaborators();
    const autonomy = options.autonomy ?? new UnboundedAutonomy(testConfig);
    const module = new ScriptedExpertModule(
        options.config ?? kissopenConfig,
        collaborators.asModule(),
        new FilesCompute(options.files),
        autonomy,
    );
    module.reply = options.policy;
    const steered: Steered[] = [];
    const agents = {
        parentOf: async (_ctx: Context, agentId: string) =>
            (await collaborators.isRoot(database.context, agentId)) ? null : PARENT,
        steer: async (
            _ctx: Context,
            agentId: string,
            message: { readonly content: readonly { readonly text?: string }[] },
            messageOptions?: { readonly id?: string; readonly metadata?: unknown },
        ) => {
            // Agent Base keeps one message per ID, so a repeated delivery is the same message.
            if (!steered.some((known) => known.id === messageOptions?.id)) {
                steered.push({
                    agentId,
                    id: messageOptions?.id,
                    text: message.content.map((block) => block.text ?? "").join(""),
                    content: message.content,
                    metadata: messageOptions?.metadata,
                });
            }
            return { id: messageOptions?.id };
        },
    } as unknown as AgentSystemRef;
    const hooks = await resolveModuleHooks(database.context, module, agents);
    await resolveModuleHooks(database.context, autonomy, agents);
    if (options.policy !== undefined) await module.policy.refresh();
    const historyKV = new MemoryKV();
    const expertRunKVs = new Map<string, MemoryKV>();
    const built: World = {
        module,
        autonomy,
        steered,
        hooks,
        ctx: database.context,
        collaborators,
        sharedKV,
        scope: (provider = "kissopen", model = EVERYDAY_MODEL) =>
            ({
                agent: { id: PARENT, provider, model, metadata: undefined },
                sharedKV,
                historyKV,
                runKV: new MemoryKV(),
                kv: new MemoryKV(),
            }) as never,
        tools: async (provider, model) =>
            (await hooks.tools?.(database.context, built.scope(provider, model))) ?? [],
        expertScope: (created) => {
            const runKV = expertRunKVs.get(created.agentId) ?? new MemoryKV();
            expertRunKVs.set(created.agentId, runKV);
            return {
                agent: {
                    id: created.agentId,
                    provider: "kissopen",
                    model: created.input.model,
                    metadata: created.options.metadata,
                },
                sharedKV,
                historyKV: new MemoryKV(),
                runKV,
                kv: new MemoryKV(),
            } as never;
        },
        restart: async () => await world({ ...options, shared: { sharedKV, database } }),
    };
    worlds.push(built);
    return built;
}

function askExpert(tools: readonly AnyAgentTool[]): AnyAgentTool {
    const tool = tools.find((candidate) => candidate.name === ASK_EXPERT_TOOL_NAME);
    if (tool === undefined) throw new Error("ask_expert was not offered.");
    return tool;
}

/** A tool call whose committed result the test can read. */
function toolCall(id: string) {
    const committed: AskExpertResult[] = [];
    return {
        committed,
        call: {
            id,
            kv: undefined,
            commit: async (_ctx: Context, result: AskExpertResult) => {
                committed.push(result);
                return result;
            },
        } as never,
    };
}

function textEnd(text: string) {
    return { type: "text_end", block: { type: "text", text } } as never;
}

function errorDone(message: string) {
    return { type: "done", state: "error", kind: "internal_error", message } as never;
}

function settlement(id: string, error?: string) {
    return { loopId: "loop", settlementId: id, ...(error === undefined ? {} : { error }) } as never;
}

/**
 * Say what the expert finally said and settle it, the way Agent Base does: the settling
 * transaction, then — unless a test stops the process in between — the hook after it commits.
 */
async function answer(
    world: World,
    created: Created,
    text: string,
    options: { readonly crashBeforeCommitHooks?: boolean } = {},
): Promise<void> {
    const scope = world.expertScope(created);
    await world.ctx.inTx(async (txCtx) => {
        await world.hooks.onEventTransact?.(txCtx, scope, textEnd(text));
    });
    await world.ctx.inTx(async (txCtx) => {
        await world.hooks.afterAgentSettledTransact?.(txCtx, scope, settlement(created.agentId));
    });
    if (options.crashBeforeCommitHooks === true) return;
    await world.hooks.afterAgentSettled?.(world.ctx, scope, settlement(created.agentId));
}

function text(result: readonly { readonly type: string; readonly text?: string }[]): string {
    return result.map((block) => block.text ?? "").join("");
}

describe("expert routing: when ask_expert is offered", () => {
    it("is offered to an everyday model on the KISSOPEN provider, with instructions", async () => {
        const w = await world();

        expect((await w.tools()).map((tool) => tool.name)).toEqual([ASK_EXPERT_TOOL_NAME]);
        const instructions = await w.hooks.instructions?.(w.ctx, w.scope());
        expect(instructions).toContain("ask_expert");
        // The model's name never reaches text the person could be shown.
        expect(instructions).not.toContain("GPT-5.6 Sol");
    });

    it("is offered only to the conversation itself, not to agents created under it", async () => {
        const w = await world();
        const scope = w.scope();
        w.collaborators.children.add(scope.agent.id);

        expect(await w.hooks.tools?.(w.ctx, scope)).toEqual([]);
        expect(await w.hooks.instructions?.(w.ctx, scope)).toBe("");
    });

    it("is not offered on another provider", async () => {
        const w = await world();

        expect(await w.tools("codex", EVERYDAY_MODEL)).toEqual([]);
        expect(await w.hooks.instructions?.(w.ctx, w.scope("codex", EVERYDAY_MODEL))).toBe("");
    });

    it("is not offered to the expert model itself", async () => {
        const w = await world();

        expect(await w.tools("kissopen", EXPERT_MODEL)).toEqual([]);
        expect(await w.hooks.instructions?.(w.ctx, w.scope("kissopen", EXPERT_MODEL))).toBe("");
    });

    it("is not offered when the server does not serve the expert model", async () => {
        const w = await world({
            policy: { ...serverPolicy(), models: [EVERYDAY_MODEL, "openai/gpt-6-astra"] },
        });

        expect(await w.tools()).toEqual([]);
    });

    it("is not offered when a collaborator may not use the expert model", async () => {
        const w = await world();
        w.collaborators.models = MODELS.filter((model) => model.id !== EXPERT_MODEL);

        expect(await w.tools()).toEqual([]);
    });

    it("follows the expert model the console names", async () => {
        const w = await world({ policy: serverPolicy({ expert_model: "openai/gpt-6-astra" }) });

        expect(await w.tools("kissopen", "openai/gpt-6-astra")).toEqual([]);
        expect((await w.tools("kissopen", EXPERT_MODEL)).map((tool) => tool.name)).toEqual([
            ASK_EXPERT_TOOL_NAME,
        ]);
    });

    it("lists only the enabled task kinds in the instructions", async () => {
        const w = await world({ policy: serverPolicy() });

        const instructions = (await w.hooks.instructions?.(w.ctx, w.scope())) ?? "";

        expect(instructions).toContain("- slides (演示文稿): 制作 PPT、幻灯片");
        expect(instructions).toContain("- analysis (数据分析): 分析表格或数据");
        expect(instructions).not.toContain("plan");
        expect(instructions).not.toContain("计划与方案");
        expect(instructions).toContain("failed repeatedly");
    });

    it("keeps the repeated-failure rule when no kind is enabled", async () => {
        const w = await world({ policy: serverPolicy({ expert_tasks: [] }) });

        const instructions = (await w.hooks.instructions?.(w.ctx, w.scope())) ?? "";

        expect(instructions).not.toContain("Hand these kinds");
        expect(instructions).toContain("failed repeatedly");
    });

    it("reads the policy from the configured KISSOPEN provider with its device key", async () => {
        const w = await world({ policy: serverPolicy() });

        expect(w.module.requests).toContainEqual({
            url: "https://api.example.test/api/agent/v1/policy",
            authorization: "Bearer device-key",
        });
        expect(w.module.policy.current().origin).toBe("server");
    });

    it("asks for no policy when no KISSOPEN provider is configured", async () => {
        const w = await world({ config: testConfig, policy: serverPolicy() });

        expect(w.module.requests).toEqual([]);
        expect(w.module.policy.current().origin).toBe("default");
    });
});

describe("expert routing: ask_expert", () => {
    it("creates a KISSOPEN collaborator on the expert model, waits, and returns its answer", async () => {
        const w = await world({ policy: serverPolicy() });
        const { call, committed } = toolCall("expertcall1");

        const running = askExpert(await w.tools()).execute(
            w.ctx,
            {
                task: "Make a 10-slide deck from /work/report.md into /work/deck.pptx.",
                kind: "slides",
            },
            call,
        );
        const created = await w.collaborators.waitForCreation();
        await answer(w, created, "Done. The deck is at /work/deck.pptx.");
        const result = (await running) as AskExpertResult;

        expect(created.actingAgentId).toBe(PARENT);
        expect(created.agentId).toBe("expertcall1");
        expect(created.input).toMatchObject({
            model: EXPERT_MODEL,
            effort: "high",
            provider: "kissopen",
        });
        expect(created.input.title).toBe("Expert: 演示文稿");
        expect(created.input.text).toContain("/work/report.md");
        expect(created.input.text).toContain("absolute path of every file");
        expect(created.options).toEqual({
            reportToCreator: false,
            metadata: { expert: { kind: "slides" } },
        });
        expect(result).toEqual({
            status: "answered",
            expertId: "expertcall1",
            model: EXPERT_MODEL,
            modelName: "GPT-5.6 Sol",
            answer: "Done. The deck is at /work/deck.pptx.",
        });
        expect(committed).toEqual([result]);
        expect(w.sharedKV.values.size).toBe(0);
        const rendered = text(askExpert(await w.tools()).toLLM(result));
        expect(rendered).toContain("/work/deck.pptx");
        expect(rendered).toContain("links to the files");
    });

    it("falls back to the model's default effort when the policy's is not offered", async () => {
        const w = await world({ policy: serverPolicy({ expert_effort: "max" }) });
        const { call } = toolCall("expertcall2");

        const running = askExpert(await w.tools()).execute(w.ctx, { task: "Plan it." }, call);
        const created = await w.collaborators.waitForCreation();
        await answer(w, created, "The plan.");
        await running;

        expect(created.input.effort).toBe("medium");
        expect(created.options.metadata).toEqual({ expert: { kind: null } });
    });

    it("reports why an expert stopped without answering", async () => {
        const w = await world();
        const { call } = toolCall("expertcall3");

        const running = askExpert(await w.tools()).execute(w.ctx, { task: "Analyse." }, call);
        const created = await w.collaborators.waitForCreation();
        const scope = w.expertScope(created);
        await w.hooks.onEvent?.(w.ctx, scope, errorDone("Usage limit reached."));
        await w.ctx.inTx(async (txCtx) => {
            await w.hooks.afterAgentSettledTransact?.(txCtx, scope, settlement(created.agentId));
        });
        const result = (await running) as AskExpertResult;

        expect(result).toMatchObject({ status: "failed", reason: "Usage limit reached." });
        const tool = askExpert(await w.tools());
        expect(tool.isError?.(result)).toBe(true);
        expect(text(tool.toLLM(result))).toContain("Usage limit reached.");
    });

    it("stops the expert and says so when it runs out of time", async () => {
        const w = await world();
        w.module.waitMs = 30;
        const { call, committed } = toolCall("expertcall4");

        const result = (await askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Write the long report." },
            call,
        )) as AskExpertResult;

        expect(result).toMatchObject({ status: "timed_out", expertId: "expertcall4" });
        expect(w.collaborators.interrupted).toEqual([
            { actingAgentId: PARENT, targetAgentId: "expertcall4" },
        ]);
        expect(committed).toEqual([result]);
        expect(w.sharedKV.values.size).toBe(0);

        // The interrupted expert settles afterwards; nothing waits for it any more.
        await answer(w, w.collaborators.created[0]!, "Late progress note.");
        expect(w.sharedKV.values.size).toBe(0);
    });

    it("stops only waiting when the call is cancelled, leaving the expert to its tree", async () => {
        const w = await world();
        const { call, committed } = toolCall("expertcall5");
        const controller = new AbortController();

        const running = askExpert(await w.tools()).execute(
            withLifetime(w.ctx, controller.signal),
            { task: "Make slides." },
            call,
        );
        await w.collaborators.waitForCreation();
        controller.abort();

        await expect(running).rejects.toThrow("cancelled");
        expect(w.collaborators.interrupted).toEqual([]);
        expect(committed).toEqual([]);
        // The note stays, so a call executed again (a drain) re-attaches to the same expert.
        expect([...w.sharedKV.values.keys()]).toEqual(["pending.expertcall5"]);
    });

    it("re-attaches after a restart and returns an answer that arrived meanwhile", async () => {
        const first = await world();
        const { call: firstCall } = toolCall("expertcall6");
        const controller = new AbortController();
        const running = askExpert(await first.tools()).execute(
            withLifetime(first.ctx, controller.signal),
            { task: "Make slides." },
            firstCall,
        );
        const created = await first.collaborators.waitForCreation();
        controller.abort();
        await expect(running).rejects.toThrow();

        const second = await first.restart();
        await answer(second, created, "Slides are at /work/deck.pptx.");
        const { call, committed } = toolCall("expertcall6");
        const result = (await askExpert(await second.tools()).execute(
            second.ctx,
            { task: "Make slides." },
            call,
        )) as AskExpertResult;

        expect(second.collaborators.created).toEqual([]);
        expect(result).toMatchObject({
            status: "answered",
            answer: "Slides are at /work/deck.pptx.",
        });
        expect(committed).toEqual([result]);
        expect(second.sharedKV.values.size).toBe(0);
    });

    it("keeps waiting on the same expert after a restart until it settles", async () => {
        const first = await world();
        const controller = new AbortController();
        const running = askExpert(await first.tools()).execute(
            withLifetime(first.ctx, controller.signal),
            { task: "Analyse." },
            toolCall("expertcall7").call,
        );
        const created = await first.collaborators.waitForCreation();
        controller.abort();
        await expect(running).rejects.toThrow();

        const second = await first.restart();
        const { call } = toolCall("expertcall7");
        const resumed = askExpert(await second.tools()).execute(
            second.ctx,
            { task: "Analyse." },
            call,
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        await answer(second, created, "The analysis.");

        await expect(resumed).resolves.toMatchObject({
            status: "answered",
            answer: "The analysis.",
        });
        expect(second.collaborators.created).toEqual([]);
    });

    it("measures the deadline from the first execution, across a restart", async () => {
        const first = await world();
        const controller = new AbortController();
        const running = askExpert(await first.tools()).execute(
            withLifetime(first.ctx, controller.signal),
            { task: "Analyse." },
            toolCall("expertcall8").call,
        );
        await first.collaborators.waitForCreation();
        controller.abort();
        await expect(running).rejects.toThrow();

        const second = await first.restart();
        second.module.clock = first.module.clock + second.module.waitMs + 1;
        const result = await askExpert(await second.tools()).execute(
            second.ctx,
            { task: "Analyse." },
            toolCall("expertcall8").call,
        );

        expect(result).toMatchObject({ status: "timed_out" });
        expect(second.collaborators.interrupted).toEqual([
            { actingAgentId: PARENT, targetAgentId: "expertcall8" },
        ]);
    });

    it("sweeps notes left by calls abandoned long ago", async () => {
        const w = await world();
        w.sharedKV.values.set("pending.oldcall", {
            parentId: PARENT,
            model: EXPERT_MODEL,
            modelName: "GPT-5.6 Sol",
            effort: "medium",
            startedAt: w.module.clock - 3 * 24 * 60 * 60 * 1_000,
        });
        w.sharedKV.values.set("answer.oldcall", { output: "stale" });
        const { call } = toolCall("expertcall9");

        const running = askExpert(await w.tools()).execute(w.ctx, { task: "Plan." }, call);
        const created = await w.collaborators.waitForCreation();
        expect(w.sharedKV.values.has("pending.oldcall")).toBe(false);
        expect(w.sharedKV.values.has("answer.oldcall")).toBe(false);
        await answer(w, created, "Plan.");
        await running;
    });
});

describe("expert routing: escalation after repeated failures", () => {
    function toolResult(isError: boolean, message = "boom") {
        return {
            role: "tool",
            callId: "call",
            content: [{ type: "text", text: message }],
            isError,
        } as never;
    }

    async function runTool(
        w: World,
        scope: AgentModuleScope,
        name: string,
        isError: boolean,
        message?: string,
    ) {
        // Tool hooks see a run store scoped to the one call, as Agent Base hands them.
        const callScope = { ...scope, runKV: new MemoryKV() } as never;
        await w.ctx.inTx(async (txCtx) => {
            await w.hooks.beforeToolCallTransact?.(txCtx, callScope, {
                type: "toolCall",
                callId: "call",
                name,
                arguments: {},
            } as never);
            await w.hooks.afterToolCallTransact?.(txCtx, callScope, toolResult(isError, message));
        });
    }

    async function notices(w: World, scope: AgentModuleScope): Promise<string[]> {
        const returned = await w.ctx.inTx(
            async (txCtx) =>
                await w.hooks.systemNotificationsTransact?.(txCtx, scope, {
                    type: "inference",
                    inference: {},
                } as never),
        );
        return (returned ?? []).map((message) => text(message.content as never));
    }

    it("requests the expert tool after consecutive failures without an inference to choose it", async () => {
        const w = await world({ policy: serverPolicy({ escalate_after_failures: 3 }) });
        const scope = w.scope();

        await runTool(w, scope, "exec_command", true, "npm ERR! missing script: build");
        await runTool(w, scope, "exec_command", true, "npm ERR! missing script: build");
        expect(await notices(w, scope)).toEqual([]);
        await runTool(w, scope, "apply_patch", true, "patch does not apply");
        expect(w.steered).toHaveLength(1);
        expect(w.steered[0]!.content).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "tool_call_request",
                    name: ASK_EXPERT_TOOL_NAME,
                    arguments: expect.objectContaining({
                        task: expect.stringContaining("apply_patch: patch does not apply"),
                    }),
                }),
            ]),
        );
        expect(w.steered[0]!.metadata).toMatchObject({
            messageOrigin: "agent",
            hideFromUser: true,
        });
        // Said once; counting starts again.
        expect(await notices(w, scope)).toEqual([]);
    });

    it("starts counting again after a success", async () => {
        const w = await world({ policy: serverPolicy({ escalate_after_failures: 2 }) });
        const scope = w.scope();

        await runTool(w, scope, "exec_command", true);
        await runTool(w, scope, "read_file", false);
        await runTool(w, scope, "exec_command", true);

        expect(await notices(w, scope)).toEqual([]);
        expect(w.steered).toHaveLength(0);
        await runTool(w, scope, "exec_command", true);
        expect(w.steered).toHaveLength(1);
    });

    it("starts counting again when the person sends a new message", async () => {
        const w = await world({ policy: serverPolicy({ escalate_after_failures: 2 }) });
        const scope = w.scope();

        await runTool(w, scope, "exec_command", true);
        await w.ctx.inTx(async (txCtx) => {
            await w.hooks.messageAcceptedTransact?.(txCtx, scope, {
                id: "message",
                kind: "send",
                metadata: { messageOrigin: "user" },
                message: { role: "user", content: [{ type: "text", text: "try again" }] },
                profile: {},
            } as never);
        });
        await runTool(w, scope, "exec_command", true);

        expect(await notices(w, scope)).toEqual([]);
    });

    it("does not count ask_expert itself", async () => {
        const w = await world({ policy: serverPolicy({ escalate_after_failures: 2 }) });
        const scope = w.scope();

        await runTool(w, scope, "exec_command", true);
        await runTool(w, scope, ASK_EXPERT_TOOL_NAME, true);
        await runTool(w, scope, "exec_command", true);

        expect(await notices(w, scope)).toEqual([]);
    });

    it("never escalates when the policy turns it off or ask_expert is not offered", async () => {
        const off = await world({ policy: serverPolicy({ escalate_after_failures: 0 }) });
        for (let index = 0; index < 5; index += 1) {
            await runTool(off, off.scope(), "exec_command", true);
        }
        expect(await notices(off, off.scope())).toEqual([]);

        const elsewhere = await world();
        const codex = elsewhere.scope("codex", EVERYDAY_MODEL);
        for (let index = 0; index < 5; index += 1) {
            await runTool(elsewhere, codex, "exec_command", true);
        }
        expect(await notices(elsewhere, codex)).toEqual([]);
    });
});

describe("expert routing: program classifier", () => {
    it("clears retained routing context with the conversation", async () => {
        const w = await world();
        const scope = w.scope();
        await scope.kv.write(w.ctx, "routing.latest", "private old task");
        await scope.kv.write(w.ctx, "routing.escalationPending", true);
        await w.ctx.inTx((ctx) => w.hooks.conversationClearedTransact?.(ctx, scope));
        expect(await scope.kv.read(w.ctx, "routing.latest")).toBeUndefined();
        expect(await scope.kv.read(w.ctx, "routing.escalationPending")).toBeUndefined();
    });
    it("requests a durable expert tool once for a matching genuine user message", async () => {
        const policy = serverPolicy();
        policy.policy.expert_tasks[0]!.match_any = ["ppt"];
        policy.policy.expert_tasks[0]!.require_any = ["制作"];
        const w = await world({ policy });
        const scope = w.scope();
        const message = { role: "user", content: [{ type: "text", text: "制作 PPT" }] } as const;
        const prepared = await w.module.prepareMessage(
            w.ctx,
            PARENT,
            "kissopen",
            EVERYDAY_MODEL,
            message,
        );
        expect(prepared.content).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    type: "tool_call_request",
                    name: ASK_EXPERT_TOOL_NAME,
                    arguments: expect.objectContaining({
                        kind: "slides",
                        task: expect.stringContaining("制作 PPT"),
                    }),
                }),
            ]),
        );
        expect(
            await w.module.prepareMessage(w.ctx, PARENT, "kissopen", EVERYDAY_MODEL, prepared),
        ).toBe(prepared);
        expect(await w.module.prepareMessage(w.ctx, PARENT, "codex", EVERYDAY_MODEL, message)).toBe(
            message,
        );
        const ping = { role: "user", content: [{ type: "text", text: "ping" }] } as const;
        expect(await w.module.prepareMessage(w.ctx, PARENT, "kissopen", EVERYDAY_MODEL, ping)).toBe(
            ping,
        );
        await w.ctx.inTx(async (ctx) => {
            await w.hooks.messageAcceptedTransact?.(ctx, scope, {
                id: "synthetic",
                kind: "send",
                profile: null,
                metadata: { messageOrigin: "agent" },
                message,
            });
        });
        expect(w.steered).toHaveLength(0);
    });
});

describe("expert routing: the person writing while the expert works", () => {
    it("returns detached, then delivers the expert's result as a message when it finishes", async () => {
        const w = await world({ files: new Set(["/work/deck.pptx"]) });
        const { call, committed } = toolCall("expertdetach1");

        const running = askExpert(await w.tools()).execute(w.ctx, { task: "Make slides." }, call);
        const created = await w.collaborators.waitForCreation();
        w.module.interruptWaits(PARENT);
        const result = (await running) as AskExpertResult;

        expect(result).toEqual({
            status: "detached",
            expertId: "expertdetach1",
            model: EXPERT_MODEL,
            modelName: "GPT-5.6 Sol",
        });
        expect(committed).toEqual([result]);
        // Detached is not a failure, and says where the result will come from.
        const tool = askExpert(await w.tools());
        expect(tool.isError?.(result)).toBe(false);
        expect(text(tool.toLLM(result))).toContain("will arrive as a message");
        expect(w.collaborators.interrupted).toEqual([]);
        expect(w.sharedKV.values.get("pending.expertdetach1")).toMatchObject({
            detached: "awaiting",
        });

        await answer(
            w,
            created,
            "The deck.\n\nFiles:\n- /work/deck.pptx\nChecked: opened it\nOpen: none",
        );

        expect(w.steered).toHaveLength(1);
        expect(w.steered[0]).toMatchObject({ agentId: PARENT, id: "expertdetach1:finished" });
        expect(w.steered[0]!.text).toContain("The deck.");
        expect(w.steered[0]!.text).toContain("Verified: yes");
        expect(w.steered[0]!.text).not.toContain(AUTONOMY_LIMIT_NOTICE);
        expect(w.sharedKV.values.get("pending.expertdetach1")).toMatchObject({
            detached: "reported",
        });
        expect(w.sharedKV.values.has("answer.expertdetach1")).toBe(false);

        // Settling again (a retried settlement) delivers nothing more.
        await answer(w, created, "The deck again.");
        expect(w.steered).toHaveLength(1);
    });

    it("never starts a second expert when the detached call is executed again", async () => {
        const first = await world();
        const running = askExpert(await first.tools()).execute(
            first.ctx,
            { task: "Analyse." },
            toolCall("expertdetach2").call,
        );
        const created = await first.collaborators.waitForCreation();
        first.module.interruptWaits(PARENT);
        await expect(running).resolves.toMatchObject({ status: "detached" });

        const second = await first.restart();
        const again = await askExpert(await second.tools()).execute(
            second.ctx,
            { task: "Analyse." },
            toolCall("expertdetach2").call,
        );
        expect(again).toMatchObject({ status: "detached", expertId: "expertdetach2" });
        expect(second.collaborators.created).toEqual([]);

        // The expert settles in the restarted process and is delivered from there.
        await answer(second, created, "The analysis.");
        expect(second.steered.map((message) => message.id)).toEqual(["expertdetach2:finished"]);

        // Even after delivery, executing the call again does not start another expert.
        const late = await askExpert(await second.tools()).execute(
            second.ctx,
            { task: "Analyse." },
            toolCall("expertdetach2").call,
        );
        expect(late).toMatchObject({ status: "detached" });
        expect(second.collaborators.created).toEqual([]);
    });

    it("returns the answer instead when it landed before the wait ended", async () => {
        const w = await world();
        const { call } = toolCall("expertdetach3");
        const running = askExpert(await w.tools()).execute(w.ctx, { task: "Plan." }, call);
        const created = await w.collaborators.waitForCreation();
        await answer(w, created, "The plan.");
        w.module.interruptWaits(PARENT);

        await expect(running).resolves.toMatchObject({ status: "answered", answer: "The plan." });
        expect(w.steered).toEqual([]);
    });

    it("delivers a result whose delivery a crash cut short at the agent's next call", async () => {
        const w = await world();
        const detached = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Plan." },
            toolCall("expertdetach4").call,
        );
        const created = await w.collaborators.waitForCreation();
        w.module.interruptWaits(PARENT);
        await detached;
        await answer(w, created, "The plan.", { crashBeforeCommitHooks: true });
        expect(w.steered).toEqual([]);

        const next = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Something else." },
            toolCall("expertdetach5").call,
        );
        await w.collaborators.waitFor(2);
        expect(w.steered.map((message) => message.id)).toEqual(["expertdetach4:finished"]);
        await answer(w, w.collaborators.created[1]!, "Done.");
        await next;
    });

    it("only detaches calls made by the agent the person wrote to", async () => {
        const w = await world();
        const running = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Plan." },
            toolCall("expertdetach6").call,
        );
        const created = await w.collaborators.waitForCreation();
        w.module.interruptWaits("someone-else");
        await answer(w, created, "The plan.");

        await expect(running).resolves.toMatchObject({ status: "answered" });
    });
});

describe("expert routing: checking what the expert says it made", () => {
    it("looks up every listed file and reports the missing one", async () => {
        const w = await world({ files: new Set(["/work/deck.pptx"]) });
        const running = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Make slides." },
            toolCall("expertcheck1").call,
        );
        const created = await w.collaborators.waitForCreation();
        await answer(
            w,
            created,
            [
                "The deck is ready.",
                "",
                "**Files:**",
                "- `/work/deck.pptx` — the deck",
                "- charts/q3.png (the chart)",
                "**Checked:** opened the deck",
                "**Open:** none",
            ].join("\n"),
        );
        const result = (await running) as AskExpertResult;

        expect(result).toMatchObject({
            status: "answered",
            verification: {
                verified: false,
                files: [
                    { path: "/work/deck.pptx", exists: true },
                    { path: "charts/q3.png", exists: false },
                ],
                open: "none",
            },
        });
        const rendered = text(askExpert(await w.tools()).toLLM(result));
        expect(rendered).toContain("charts/q3.png — MISSING");
        expect(rendered).toContain("Verified: no");
        expect(rendered).toContain("rework (ask_expert again naming what is missing)");
        expect(rendered).toContain(".kissopen/project.json");
    });

    it("verifies an answer whose files all exist, relative to the workspace, with nothing open", async () => {
        const w = await world({ files: new Set(["/work/report.docx", "/work/charts/q3.png"]) });
        const running = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Write the report." },
            toolCall("expertcheck2").call,
        );
        const created = await w.collaborators.waitForCreation();
        await answer(
            w,
            created,
            "报告已完成。\n\n## 文件\n/work/report.docx, charts/q3.png\n## 已检查\n打开核对过\n## 遗留\n无",
        );

        await expect(running).resolves.toMatchObject({
            verification: { verified: true, open: "无" },
        });
    });

    it("does not verify an answer that lists no files or leaves something open", async () => {
        const w = await world({ files: new Set(["/work/a.md"]) });
        const noFiles = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Answer." },
            toolCall("expertcheck3").call,
        );
        await answer(w, await w.collaborators.waitForCreation(), "Just an answer, no files.");
        await expect(noFiles).resolves.toMatchObject({
            verification: { verified: false, files: [], open: "" },
        });

        const open = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Write." },
            toolCall("expertcheck4").call,
        );
        await w.collaborators.waitFor(2);
        await answer(
            w,
            w.collaborators.created[1]!,
            "Done.\nFiles: /work/a.md\nOpen: the appendix is not written yet",
        );
        await expect(open).resolves.toMatchObject({
            verification: {
                verified: false,
                files: [{ path: "/work/a.md", exists: true }],
                open: "the appendix is not written yet",
            },
        });
    });
});

describe("expert routing: the autonomy allowance", () => {
    it("refuses a new expert past the turn's allowance until the person writes", async () => {
        const autonomy = new FixedAutonomy(testConfig, { expert_call: 1 });
        const w = await world({ autonomy });
        const first = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Plan." },
            toolCall("expertbudget1").call,
        );
        await answer(w, await w.collaborators.waitForCreation(), "The plan.");
        await first;

        await expect(
            askExpert(await w.tools()).execute(
                w.ctx,
                { task: "More." },
                toolCall("expertbudget2").call,
            ),
        ).rejects.toThrow(AUTONOMY_LIMIT_NOTICE);
        expect(w.collaborators.created).toHaveLength(1);
        // The tool is still offered: the surface never changes from turn to turn.
        expect((await w.tools()).map((tool) => tool.name)).toEqual([ASK_EXPERT_TOOL_NAME]);

        autonomy.reset(PARENT);
        const third = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "More." },
            toolCall("expertbudget3").call,
        );
        await w.collaborators.waitFor(2);
        await answer(w, w.collaborators.created[1]!, "More.");
        await expect(third).resolves.toMatchObject({ status: "answered" });
    });

    it("delivers a detached result with the notice once the wake-ups are spent", async () => {
        const autonomy = new FixedAutonomy(testConfig, { auto_round: 0 });
        const w = await world({ autonomy });
        const running = askExpert(await w.tools()).execute(
            w.ctx,
            { task: "Plan." },
            toolCall("expertbudget4").call,
        );
        const created = await w.collaborators.waitForCreation();
        w.module.interruptWaits(PARENT);
        await running;
        await answer(w, created, "The plan.");

        expect(w.steered).toHaveLength(1);
        expect(w.steered[0]!.text).toContain(AUTONOMY_LIMIT_NOTICE);
        expect(w.steered[0]!.text).toContain("The plan.");
    });
});
