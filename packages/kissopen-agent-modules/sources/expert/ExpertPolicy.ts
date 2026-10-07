import { Type, type Static } from "@sinclair/typebox";

/**
 * One kind of work the server's console hands to the expert model rather than the everyday one.
 *
 * `id` is what `ask_expert` is called with, `name` and `description` are what the model is told
 * the kind covers, and a disabled kind stays in the console without reaching any agent.
 */
export const expertTaskSchema = Type.Object(
    {
        id: Type.String({ minLength: 1, maxLength: 64 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        description: Type.String({ maxLength: 2_000 }),
        enabled: Type.Boolean(),
        match_any: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
        ),
        require_any: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
        ),
        exclude_any: Type.Optional(
            Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 }),
        ),
    },
    { additionalProperties: true },
);

/**
 * The routing policy exactly as `GET {kissopen base_url}/policy` returns it (the server's
 * `AgentPolicy`). Unknown fields are tolerated so the server can add some before every Agent
 * knows them; a field this Agent relies on that is missing or mistyped rejects the whole reading,
 * and the last good copy stays in force.
 */
export const expertPolicySchema = Type.Object(
    {
        default_model: Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" }),
        default_effort: Type.String({ maxLength: 32 }),
        expert_model: Type.String({ minLength: 1, maxLength: 256, pattern: "\\S" }),
        expert_effort: Type.String({ maxLength: 32 }),
        expert_tasks: Type.Array(expertTaskSchema, { maxItems: 64 }),
        escalate_after_failures: Type.Integer({ minimum: 0, maximum: 1_000 }),
        hide_model_picker: Type.Boolean(),
    },
    { additionalProperties: true },
);

/**
 * One model the server serves from an upstream added in its console: the Agent's name for it,
 * what to show, the API it answers on and its limits. The config module is what takes these in.
 */
export const expertServedModelSchema = Type.Object(
    {
        id: Type.String({ minLength: 3, maxLength: 256 }),
        name: Type.String({ minLength: 1, maxLength: 256 }),
        protocol: Type.Union([
            Type.Literal("chat"),
            Type.Literal("responses"),
            Type.Literal("messages"),
        ]),
        context_window: Type.Integer({ minimum: 8_000, maximum: 10_000_000 }),
        max_output_tokens: Type.Integer({ minimum: 256, maximum: 1_000_000 }),
    },
    { additionalProperties: true },
);

/** The whole response: which models the server serves, and the policy over them. */
export const expertPolicyResponseSchema = Type.Object(
    {
        models: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 512 }),
        policy: expertPolicySchema,
        /**
         * The models the server serves from upstreams added in its console, with what the Agent
         * needs to offer and reach them. A server that has none, or predates them, omits it.
         */
        catalog: Type.Optional(Type.Array(expertServedModelSchema, { maxItems: 512 })),
    },
    { additionalProperties: true },
);

export type ExpertTask = Static<typeof expertTaskSchema>;
export type ExpertServedModel = Static<typeof expertServedModelSchema>;
export type ExpertPolicy = Static<typeof expertPolicySchema>;
export type ExpertPolicyResponse = Static<typeof expertPolicyResponseSchema>;

/** Where the policy in force came from. */
export type ExpertPolicyOrigin = "server" | "default";

/** The policy an agent is routed by right now, and whether the server said so. */
export interface ExpertPolicySnapshot {
    readonly models: readonly string[];
    /** The server's description of the models it serves from console upstreams. */
    readonly catalog?: readonly ExpertServedModel[];
    readonly policy: ExpertPolicy;
    readonly origin: ExpertPolicyOrigin;
    /** When the server last answered with a valid policy; absent for the built-in default. */
    readonly fetchedAt?: number;
}

/**
 * What an Agent routes by before the server has ever answered, and whenever it has never
 * answered with anything usable. It is the server's own `defaultAgentPolicy()` so a machine that
 * cannot reach the policy route behaves the way a fresh console would tell it to. `models` lists
 * the two models that policy names, since the server's full list is only known once it answers.
 */
export const DEFAULT_EXPERT_POLICY: ExpertPolicySnapshot = Object.freeze({
    models: Object.freeze(["openai/gpt-5.6-sol", "deepseek/deepseek-flash"]),
    origin: "default" as const,
    policy: Object.freeze({
        default_model: "deepseek/deepseek-flash",
        default_effort: "high",
        expert_model: "openai/gpt-5.6-sol",
        expert_effort: "medium",
        expert_tasks: Object.freeze([
            Object.freeze({
                id: "slides",
                match_any: ["ppt", "幻灯片", "演示文稿", "presentation", "slide deck"],
                require_any: [
                    "制作",
                    "生成",
                    "做",
                    "美化",
                    "修改",
                    "create",
                    "make",
                    "build",
                    "design",
                ],
                exclude_any: [
                    "是什么",
                    "什么意思",
                    "不用做",
                    "不要做",
                    "不要制作",
                    "what is",
                    "don't",
                    "do not",
                ],
                name: "演示文稿",
                description: "制作 PPT、幻灯片、演示文稿，或重做、美化已有的演示文稿",
                enabled: true,
            }),
            Object.freeze({
                id: "plan",
                match_any: [
                    "计划",
                    "方案",
                    "路线图",
                    "项目拆解",
                    "策略",
                    "plan",
                    "roadmap",
                    "strategy",
                ],
                require_any: [
                    "制定",
                    "做",
                    "写",
                    "设计",
                    "拆解",
                    "规划",
                    "create",
                    "make",
                    "develop",
                    "draft",
                    "design",
                ],
                exclude_any: ["是什么", "什么意思", "不要制定", "what is", "don't", "do not"],
                name: "计划与方案",
                description: "制定计划、方案、路线图、项目拆解、策略建议",
                enabled: true,
            }),
            Object.freeze({
                id: "document",
                match_any: [
                    "报告",
                    "方案书",
                    "长文",
                    "白皮书",
                    "report",
                    "white paper",
                    "long article",
                ],
                require_any: [
                    "写",
                    "撰写",
                    "生成",
                    "整理",
                    "制作",
                    "write",
                    "draft",
                    "create",
                    "prepare",
                ],
                exclude_any: ["是什么", "什么意思", "不要写", "what is", "don't", "do not"],
                name: "长文档",
                description: "撰写报告、方案书、长文章、正式文档（超过一页的成品）",
                enabled: true,
            }),
            Object.freeze({
                id: "analysis",
                match_any: [
                    "数据",
                    "表格",
                    "销售",
                    "营收",
                    "趋势",
                    "data",
                    "spreadsheet",
                    "sales",
                    "revenue",
                ],
                require_any: ["分析", "预测", "建模", "analyze", "analyse", "forecast", "predict"],
                exclude_any: ["是什么", "什么意思", "不要分析", "what is", "don't", "do not"],
                name: "数据分析",
                description: "分析表格或数据、复杂计算与推理、得出结论和建议",
                enabled: true,
            }),
        ]) as ExpertTask[],
        escalate_after_failures: 3,
        hide_model_picker: true,
    }),
}) as ExpertPolicySnapshot;

/** The kinds of work currently routed to the expert, in the console's order. */
export function enabledExpertTasks(policy: ExpertPolicy): readonly ExpertTask[] {
    return policy.expert_tasks.filter((task) => task.enabled);
}
