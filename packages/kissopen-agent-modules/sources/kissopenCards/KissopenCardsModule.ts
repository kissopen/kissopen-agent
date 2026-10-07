import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
} from "@kissopen/kissopen-agent-base";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeModule } from "../compute/index.js";

/*
A board card's conversation has one id wherever it is started — desktop, phone
or server — derived from the project folder and the card:
"k" + the first 23 hex of sha256("kissopen-card\0" + folder + "\0" + card id).
That derivation is the contract this module reads; it is not guessed from what
the conversation says.
*/
const CARD_AGENT_ID = /^k[0-9a-f]{23}$/u;
/**
 * The card a project's setup conversation is started under — 初始化项目 on an empty board. Not on
 * any board: its conversation is known by the id derived from it alone.
 */
export const PROJECT_SETUP_CARD_ID = "project-setup";
/** How long a conversation found not to be a card's is not looked at again. */
const NOT_A_CARD_RECHECK_MS = 10 * 60_000;
/** The project's own files are small; a larger one is not read for this. */
const PROJECT_FILE_MAX_CHARS = 1024 * 1024;

export function kissopenCardAgentId(folder: string, cardId: string): string {
    const digest = createHash("sha256")
        .update(`kissopen-card\0${folder.replace(/\/+$/u, "")}\0${cardId}`)
        .digest("hex");
    return `k${digest.slice(0, 23)}`;
}

/** A card without an id is named by its title, as the board readers name it. */
function titleCardId(title: string): string {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(title)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `t${hash.toString(16).padStart(8, "0")}`;
}

/** Every card id the board and project.json name: ids on cards, and project.json's card keys. */
function cardIdsOf(board: unknown, project: unknown): Set<string> {
    const ids = new Set<string>();
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }
        if (value === null || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        // Both: a board reader falls back to the title's id when a card's own id is malformed.
        if (typeof record.id === "string" && record.id.length > 0) ids.add(record.id);
        if (typeof record.title === "string" && record.title.trim().length > 0)
            ids.add(titleCardId(record.title.trim()));
        for (const child of Object.values(record)) visit(child);
    };
    visit(board);
    const cards = (project as { cards?: unknown } | null)?.cards;
    if (cards !== null && typeof cards === "object" && !Array.isArray(cards))
        for (const id of Object.keys(cards)) ids.add(id);
    return ids;
}

async function readJson(path: string): Promise<unknown> {
    try {
        const text = await readFile(path, "utf8");
        return text.length > PROJECT_FILE_MAX_CHARS ? undefined : (JSON.parse(text) as unknown);
    } catch {
        return undefined;
    }
}

/**
 * How a card's conversation works. The person sees only what the card asks for; these rules are
 * the agent's, and are said here rather than in the conversation so they never appear in it.
 * Fixed for the conversation's whole life, so the provider's prompt cache keeps serving it.
 */
export function kissopenCardInstructions(cardId: string, agentId: string): string {
    return [
        "# This conversation owns one card on the project's board",
        `卡片 id：${cardId}；你的对话 id：${agentId}。用户每次点这张卡片都会回到这个对话。`,
        "- 开始前先读 .kissopen/project.json（goal、direction、decisions、cards）和 .kissopen/board.json 里这张卡片；需要时用 read_agent_history 读 cards 里其他卡片的 agent。",
        "- 能自己做就直接做；可以用 ask_expert、协作者、工作流，但有次数上限，到上限时先问用户。",
        "- 需要用户拍板或补资料时，用提问工具提问并给 2–4 个选项，不要猜。",
        `- 每次停下前，重新读一遍 project.json，只改 cards["${cardId}"]：agent=${agentId}、state、note、question（needs_decision 时）、files（相对路径）、verified、updated；用户做出选择后，在 decisions 末尾追加 {at,card,question,choice}。不要改 board.json。`,
        "- 这些规则、卡片 id、对话 id 和 project.json 的字段是你自己的工作方式，不要写进给用户的回复。",
    ].join("\n");
}

/**
 * How a project's setup conversation works: a few rounds of questions to learn what the project
 * is, the answers kept in project.json, then the first board built. The person sees only the
 * questions; like a card's, these rules are instructions and never part of the conversation.
 */
export function kissopenProjectSetupInstructions(agentId: string): string {
    return [
        "# This conversation sets up a new project",
        `对话 id：${agentId}。这个项目刚建好，还没有看板。你的任务是用几轮简短的提问把项目弄清楚，然后开始创建看板。`,
        "- 先看 .kissopen/project.json、uploads/ 和 outputs/ 里已有的东西；已经能看出来的不要再问。",
        "- 每轮用提问工具问 1–3 个问题，尽量给 2–4 个选项，并允许用户自己写；问什么由这个项目决定，通常是：想达成的结果和怎么算成功、时间节点、范围和先做什么、手上已有和还缺的资料、相关的人或限制。",
        "- 一般 2–4 轮就够，最多 5 轮；每轮之后简短说一句你理解到的。用户说“差不多了”“直接开始”就马上收尾。",
        "- 信息够了时：重新读一遍 .kissopen/project.json，保留其他字段，只写入或更新 goal（一句话目标和成功标准）、direction（范围、时间、优先顺序），把用户在问答中做的选择按 {at,question,choice} 追加到 decisions 末尾；然后用两三句话告诉用户已经了解清楚、现在开始创建看板，再调用 build_project_board（需要时先用工具搜索找到它）。",
        "- build_project_board 没能开始时，照它返回的说明如实告诉用户。",
        "- 这些规则、对话 id 和 project.json 的字段是你自己的工作方式，不要写进给用户的回复。",
    ].join("\n");
}

/**
 * Gives a board card's conversation the rules of working on that card.
 *
 * They used to be the conversation's first message, so every device showed the person a page of
 * instructions meant for the agent. Now the first message is only what the card asks for, and the
 * rules arrive as instructions: the conversation is recognised by its id, which is derived from its
 * folder and its card, and the card is the one on the board whose derived id matches.
 */
export class KissopenCardsModule implements AgentModule {
    readonly name = "kissopen-cards";
    readonly #compute: ComputeModule;
    /** What each conversation turned out to be: its card id, or null with when that was found. */
    readonly #known = new Map<string, { cardId: string } | { cardId: null; at: number }>();

    constructor(compute: ComputeModule) {
        this.#compute = compute;
    }

    async #cardOf(ctx: Context, agentId: string): Promise<string | null> {
        if (!CARD_AGENT_ID.test(agentId)) return null;
        const known = this.#known.get(agentId);
        if (known?.cardId) return known.cardId;
        if (known && "at" in known && Date.now() - known.at < NOT_A_CARD_RECHECK_MS) return null;
        const compute = await this.#compute.resolve(ctx, agentId).catch(() => undefined);
        const folder = compute?.cwd;
        if (!folder) return null;
        if (kissopenCardAgentId(folder, PROJECT_SETUP_CARD_ID) === agentId) {
            this.#known.set(agentId, { cardId: PROJECT_SETUP_CARD_ID });
            return PROJECT_SETUP_CARD_ID;
        }
        const [board, project] = await Promise.all([
            readJson(join(folder, ".kissopen", "board.json")),
            readJson(join(folder, ".kissopen", "project.json")),
        ]);
        // The card project.json already names this conversation for, first: it holds even when the
        // folder is reached by another path than the one the conversation's id was made from.
        const cards = (project as { cards?: unknown } | null)?.cards;
        if (cards !== null && typeof cards === "object" && !Array.isArray(cards))
            for (const [cardId, card] of Object.entries(cards as Record<string, unknown>))
                if ((card as { agent?: unknown } | null)?.agent === agentId) {
                    this.#known.set(agentId, { cardId });
                    return cardId;
                }
        for (const cardId of cardIdsOf(board, project)) {
            if (kissopenCardAgentId(folder, cardId) !== agentId) continue;
            this.#known.set(agentId, { cardId });
            return cardId;
        }
        this.#known.set(agentId, { cardId: null, at: Date.now() });
        return null;
    }

    readonly #hooks: AgentModuleHooks = {
        instructions: async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
            const cardId = await this.#cardOf(ctx, scope.agent.id).catch(() => null);
            if (cardId === PROJECT_SETUP_CARD_ID)
                return kissopenProjectSetupInstructions(scope.agent.id);
            return cardId ? kissopenCardInstructions(cardId, scope.agent.id) : "";
        },
    };

    readonly beforeStart = (_ctx: Context, _agents: AgentSystemRef): AgentModuleHooks =>
        this.#hooks;
}
