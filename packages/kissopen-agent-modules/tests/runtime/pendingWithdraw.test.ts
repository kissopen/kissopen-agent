import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentProviders } from "@kissopen/kissopen-agent-base";
import { KissopenAgentClient, type MessageMode } from "@kissopen/kissopen-agent-client";
import type { SessionEvent } from "@kissopen/kissopen-providers";
import { afterEach, expect, it, vi } from "vitest";

import {
    startKissopenAgentRuntime,
    type KissopenAgentRuntime,
} from "../../sources/runtime/startKissopenAgentRuntime.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const mode: MessageMode = {
    providerId: "gym",
    modelId: "gym/model",
    effort: "medium",
    serviceTier: null,
    permissionMode: "full_access",
};
const done: SessionEvent[] = [
    { type: "text_start" },
    { type: "text_delta", delta: "Done." },
    { type: "text_end" },
    { type: "done", state: "normal", tokens: { input: 1, output: 1 } },
];

let runtime: KissopenAgentRuntime | undefined;
let server: Server | undefined;
let root: string | undefined;
let release: (() => void) | undefined;

afterEach(async () => {
    release?.();
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await runtime?.close();
    runtime = undefined;
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    root = undefined;
});

function userTexts(runs: readonly { readonly messages: readonly unknown[] }[]): string[] {
    return runs.flatMap((run) =>
        run.messages.flatMap((message) => {
            const typed = message as {
                readonly role: string;
                readonly content: readonly { readonly type: string; readonly text?: string }[];
            };
            return typed.role === "user"
                ? typed.content.flatMap((block) => (block.type === "text" ? [block.text!] : []))
                : [];
        }),
    );
}

it("withdraws a pending message over HTTP so it never runs, and spends its ID", async () => {
    root = await mkdtemp(join(tmpdir(), "kissopen-pending-withdraw-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
        started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const provider = new ScriptedProvider([
        async function* () {
            started();
            await gate;
            yield* done;
        },
        done,
        done,
    ]);
    const providers = new AgentProviders();
    providers.add("gym", provider, "codex");
    let endpoint = "";
    runtime = await startKissopenAgentRuntime({
        kissopenHome: join(root, ".kissopen"),
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
        onPrepared: async (prepared) => {
            server = createServer((request, response) => {
                void prepared.api.handleRequest(
                    prepared.context("withdraw-test.http"),
                    request,
                    response,
                );
            });
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("No address.");
            endpoint = `http://127.0.0.1:${address.port}`;
        },
    });
    const client = new KissopenAgentClient({ endpoint, token: runtime.api.token()! });
    expect((await client.getHealth()).version.protocol).toBe(27);

    const { project } = await client.registerProject({ path: workspace });
    const { agent } = await client.createAgent({ workspaceId: project.id, title: "Withdraw" });
    await client.sendMessage(agent.id, { id: "firstmessage", text: "first", mode });
    await began;

    await client.sendMessage(agent.id, {
        id: "withdrawnmessage",
        text: "withdraw me",
        mode,
        delivery: "steer",
    });
    await client.sendMessage(agent.id, { id: "staysmessage", text: "stays", mode });
    expect((await client.getAgentBootstrap(agent.id)).pending.map(({ id }) => id)).toEqual([
        "withdrawnmessage",
        "staysmessage",
    ]);

    const withdrawn = await client.withdrawPendingMessage(agent.id, "withdrawnmessage");
    expect(withdrawn.message).toMatchObject({
        id: "withdrawnmessage",
        status: "pending",
        delivery: "steer",
        runId: null,
        content: [{ type: "text", text: "withdraw me" }],
    });
    expect((await client.getAgentBootstrap(agent.id)).pending.map(({ id }) => id)).toEqual([
        "staysmessage",
    ]);
    const events = await client.getEvents({ after: withdrawn.cursor });
    expect(events.events).toContainEqual(
        expect.objectContaining({
            type: "message.withdrawn",
            payload: { agentId: agent.id, messageId: "withdrawnmessage" },
        }),
    );

    // Gone, and its ID is spent.
    await expect(client.withdrawPendingMessage(agent.id, "withdrawnmessage")).rejects.toMatchObject(
        { status: 404 },
    );
    await expect(
        client.sendMessage(agent.id, { id: "withdrawnmessage", text: "again", mode }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await client.getAgentBootstrap(agent.id)).pending.map(({ id }) => id)).toEqual([
        "staysmessage",
    ]);
    await expect(client.withdrawPendingMessage(agent.id, "nevermessage")).rejects.toMatchObject({
        status: 404,
    });

    release?.();
    await vi.waitFor(
        async () => expect((await client.getAgent(agent.id)).agent.status).toBe("idle"),
        { timeout: 5000 },
    );
    const history = await client.getMessages(agent.id);
    expect(userTexts(history.runs)).toEqual(["first", "stays"]);
    expect((await client.getAgentBootstrap(agent.id)).pending).toEqual([]);

    // An accepted message is not withdrawable; the answer carries it as it now stands.
    await expect(client.withdrawPendingMessage(agent.id, "firstmessage")).rejects.toMatchObject({
        status: 409,
        body: { message: { id: "firstmessage", status: "accepted" } },
    });
});

it("clears an idle agent's conversation over HTTP, refuses while it works, and starts afresh", async () => {
    root = await mkdtemp(join(tmpdir(), "kissopen-conversation-clear-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
        started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const provider = new ScriptedProvider([
        done,
        async function* () {
            started();
            await gate;
            yield* done;
        },
        done,
    ]);
    const providers = new AgentProviders();
    providers.add("gym", provider, "codex");
    let endpoint = "";
    runtime = await startKissopenAgentRuntime({
        kissopenHome: join(root, ".kissopen"),
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
        onPrepared: async (prepared) => {
            server = createServer((request, response) => {
                void prepared.api.handleRequest(
                    prepared.context("clear-test.http"),
                    request,
                    response,
                );
            });
            await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            if (address === null || typeof address === "string") throw new Error("No address.");
            endpoint = `http://127.0.0.1:${address.port}`;
        },
    });
    const client = new KissopenAgentClient({ endpoint, token: runtime.api.token()! });
    const { project } = await client.registerProject({ path: workspace });
    const { agent } = await client.createAgent({ workspaceId: project.id, title: "Clear" });
    const idle = async () =>
        await vi.waitFor(
            async () => expect((await client.getAgent(agent.id)).agent.status).toBe("idle"),
            { timeout: 5000 },
        );

    const settledWith = async (texts: string[]) =>
        await vi.waitFor(
            async () => {
                const history = await client.getMessages(agent.id);
                expect(userTexts(history.runs)).toEqual(texts);
                expect(history.runs.every((run) => run.status !== "running")).toBe(true);
            },
            { timeout: 5000 },
        );

    await client.sendMessage(agent.id, { id: "beforeclear", text: "before", mode });
    await settledWith(["before"]);
    await idle();

    const cleared = await client.clearAgentConversation(agent.id);
    expect((await client.getMessages(agent.id)).runs).toEqual([]);
    expect((await client.getAgentBootstrap(agent.id)).pending).toEqual([]);
    expect((await client.getEvents({ after: cleared.cursor })).events).toContainEqual(
        expect.objectContaining({
            type: "agent.history.cleared",
            payload: { agentId: agent.id },
        }),
    );

    // Working: refused, and the conversation stays as it is.
    await client.sendMessage(agent.id, { id: "whileworking", text: "working", mode });
    await began;
    await expect(client.clearAgentConversation(agent.id)).rejects.toMatchObject({ status: 409 });
    release?.();
    await settledWith(["working"]);
    await idle();

    // The next message after a clear sees only itself.
    await client.clearAgentConversation(agent.id);
    await client.sendMessage(agent.id, { id: "afterclear", text: "after", mode });
    await settledWith(["after"]);
    const lastRequest = provider.sessions.at(-1)!.requests.at(-1)!;
    expect(lastRequest.context.messages.filter((message) => message.role === "user")).toHaveLength(
        1,
    );
});
