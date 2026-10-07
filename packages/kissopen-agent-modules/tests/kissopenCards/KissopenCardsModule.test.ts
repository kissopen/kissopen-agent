import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRootContext } from "@steve.kite/stdlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    KissopenCardsModule,
    PROJECT_SETUP_CARD_ID,
    kissopenCardAgentId,
} from "../../sources/kissopenCards/index.js";

let folder: string;

beforeEach(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), "kissopen-cards-")));
    await mkdir(join(folder, ".kissopen"));
});

afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
});

function instructionsFor(agentId: string): Promise<unknown> {
    const compute = { resolve: async () => ({ cwd: folder }) };
    const module = new KissopenCardsModule(compute as never);
    const hooks = module.beforeStart(createRootContext(), {} as never);
    return Promise.resolve(
        hooks.instructions?.(createRootContext(), { agent: { id: agentId } } as never),
    );
}

describe("a project's setup conversation", () => {
    it("is recognised with no board at all and given the setup rules", async () => {
        const text = await instructionsFor(kissopenCardAgentId(folder, PROJECT_SETUP_CARD_ID));
        expect(text).toContain("build_project_board");
        expect(text).not.toContain("cards[");
    });
});

describe("a board card's conversation", () => {
    it("derives the same conversation id as the server and the desktop", () => {
        expect(kissopenCardAgentId("/Users/me/launch/", "k7m2q9x")).toBe(
            "k8158a31162b205dab62b652",
        );
    });

    it("is given its card's rules as instructions", async () => {
        await writeFile(
            join(folder, ".kissopen", "board.json"),
            JSON.stringify({ focus: { cards: [{ id: "k7m2q9x", title: "生成周报" }] } }),
        );
        const agentId = kissopenCardAgentId(folder, "k7m2q9x");
        const text = await instructionsFor(agentId);
        expect(text).toContain('cards["k7m2q9x"]');
        expect(text).toContain(`agent=${agentId}`);
    });

    it("finds a card named only in project.json, or only by its title", async () => {
        await writeFile(
            join(folder, ".kissopen", "project.json"),
            JSON.stringify({ cards: { w1: { state: "todo" } } }),
        );
        await writeFile(
            join(folder, ".kissopen", "board.json"),
            JSON.stringify({ lists: [{ items: [{ title: "招募用户" }] }] }),
        );
        expect(await instructionsFor(kissopenCardAgentId(folder, "w1"))).toContain('cards["w1"]');
        expect(await instructionsFor(kissopenCardAgentId(folder, "td61ceb78"))).toContain(
            'cards["td61ceb78"]',
        );
    });

    it("finds the card project.json names it for, whatever path made its id", async () => {
        const agentId = kissopenCardAgentId("/somewhere/else", "k7m2q9x");
        await writeFile(
            join(folder, ".kissopen", "project.json"),
            JSON.stringify({ cards: { k7m2q9x: { agent: agentId, state: "in_progress" } } }),
        );
        expect(await instructionsFor(agentId)).toContain('cards["k7m2q9x"]');
    });

    it("leaves every other conversation alone", async () => {
        await writeFile(
            join(folder, ".kissopen", "board.json"),
            JSON.stringify({ focus: { cards: [{ id: "k7m2q9x", title: "生成周报" }] } }),
        );
        expect(await instructionsFor("abcdefghijklmnopqrstuvwx")).toBe("");
        expect(await instructionsFor(kissopenCardAgentId(folder, "someone-else"))).toBe("");
    });
});
