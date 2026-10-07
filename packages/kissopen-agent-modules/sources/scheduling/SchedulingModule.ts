import {
    type AgentModule,
    type AgentModuleHooks,
    type AgentModuleScope,
    type AgentSystemRef,
    type AnyAgentTool,
} from "@kissopen/kissopen-agent-base";
import { type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { afterCommit, type Context } from "@steve.kite/stdlib";

import {
    schedulingAgentIdSchema,
    schedulingTimestampSchema,
    schedulingWaitIdSchema,
    schedulingWaitInputSchema,
    schedulingWaitUntilInputSchema,
    type SchedulingWaitInput,
    type SchedulingWaitRecord,
    type SchedulingWaitResult,
    type SchedulingWaitUntilInput,
    type SchedulingWaitingRecord,
} from "./Scheduling.js";
import {
    schedulingEventListenerSchema,
    schedulingEventSchema,
    type SchedulingEvent,
    type SchedulingEventListener,
    type SchedulingUnsubscribe,
} from "./SchedulingEvent.js";
import {
    assertSchedulingWaitRecord,
    assertSchedulingWaitResult,
    type SchedulingStore,
} from "./SchedulingStore.js";
import { SchedulingSuspensions } from "./SchedulingSuspensions.js";
import { waitText } from "./schedulingFormat.js";
import { durationMilliseconds, humanDuration, instantMilliseconds } from "./schedulingTime.js";
import { createSqliteSchedulingStorage, schedulingMigrations } from "./SqliteSchedulingStorage.js";
import { waitTool } from "./tools/wait.js";
import { waitUntilTool } from "./tools/wait_until.js";

const DAY = 24 * 60 * 60 * 1_000;

/** The longest a single `wait` or `wait_until` may hold an agent. */
export const MAX_SCHEDULING_WAIT_DURATION = DAY;

/**
 * Waiting, and handing later work to Scheduled tasks.
 *
 * A wait holds an agent for a while inside the task it is already doing. The row says what is
 * being waited for and until when; the suspension holding the tool call is ephemeral. Any message
 * into the agent's chat ends the wait early, and the model is told how much time really passed
 * rather than how much it asked for.
 *
 * Nothing here makes anything happen later. That belongs to Scheduled tasks, which the business
 * server holds and the person can see, change and cancel. An agent sets one up with the KISSOPEN
 * module's `create_scheduled_task`.
 */
export class SchedulingModule implements AgentModule {
    readonly name = "scheduling";
    readonly migrations = schedulingMigrations;

    readonly #store: SchedulingStore = createSqliteSchedulingStorage();
    readonly #suspensions = new SchedulingSuspensions();
    /** Other waits that a person writing should end too (see `onInterruptWaits`). */
    readonly #interruptListeners = new Set<(agentId: string) => void>();

    /** Subscribers taken after construction, inside and after the committing transaction. */
    readonly #transactionalListeners = new Set<SchedulingEventListener>();
    readonly #postCommitListeners = new Set<SchedulingEventListener>();

    #agents: AgentSystemRef | undefined;

    /** Take the agent collection, which is how the module tells a subagent from a root agent. */
    readonly beforeStart = async (
        _ctx: Context,
        agents: AgentSystemRef,
    ): Promise<AgentModuleHooks> => {
        this.#agents = agents;
        return this.#hooks;
    };

    readonly #hooks: AgentModuleHooks = {
        tools: async (ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            this.#assertAgentId(scope.agent.id, "tool agent");
            // Later work is a KISSOPEN scheduled task, which the KISSOPEN module sets up.
            const tools: AnyAgentTool[] = [
                waitTool(this, scope.agent.id),
                waitUntilTool(this, scope.agent.id),
            ];
            return tools;
        },
        // A message this agent has taken into its conversation is the plainest possible proof that
        // it is no longer idle, so any wait it is still holding ends here.
        messageAccepted: (_ctx: Context, scope: AgentModuleScope): void => {
            this.#suspensions.interrupt(scope.agent.id);
        },
    };

    /**
     * Watch scheduling inside the transaction that commits the change.
     *
     * A transactional subscriber runs before the commit, so throwing from one rejects the mutation
     * that produced the event. Returns the function that ends the subscription.
     */
    onEventTransactional(listener: SchedulingEventListener): SchedulingUnsubscribe {
        return this.#subscribe(this.#transactionalListeners, listener);
    }

    /**
     * Watch scheduling after the outermost transaction has committed.
     *
     * A post-commit subscriber cannot undo anything, so a failure in one is logged and the
     * remaining subscribers still see the event. Returns the function that ends the subscription.
     */
    onEvent(listener: SchedulingEventListener): SchedulingUnsubscribe {
        return this.#subscribe(this.#postCommitListeners, listener);
    }

    /** Pause an agent for a bounded duration. */
    async wait(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitInput,
    ): Promise<SchedulingWaitResult> {
        this.#assertInput(schedulingWaitInputSchema, input, "wait input");
        return await this.#wait(ctx, agentId, input.id, "wait", (startedAt) =>
            this.#dueFromDuration(startedAt, durationMilliseconds(input.duration)),
        );
    }

    /** Pause an agent until a bounded date, resolving immediately for a date already past. */
    async waitUntil(
        ctx: Context,
        agentId: string,
        input: SchedulingWaitUntilInput,
    ): Promise<SchedulingWaitResult> {
        this.#assertInput(schedulingWaitUntilInputSchema, input, "wait until input");
        return await this.#wait(ctx, agentId, input.id, "wait_until", (startedAt) =>
            this.#dueFromInstant(startedAt, instantMilliseconds(input.at)),
        );
    }

    /**
     * End every wait this agent is holding, because something has arrived for it.
     *
     * KISSOPEN Agent calls this when a person submits or steers a message into a session: a queued message
     * does not reach the agent's conversation until its current turn ends, and its current turn is
     * exactly what the wait is holding open.
     */
    interruptWaits(_ctx: Context, agentId: string): void {
        this.#assertAgentId(agentId, "acting agent");
        this.#suspensions.interrupt(agentId);
        for (const listener of this.#interruptListeners) {
            try {
                listener(agentId);
            } catch {
                // One module's wait failing to end must not keep the others waiting.
            }
        }
    }

    /**
     * Be told whenever a person writes into a session, to end another kind of wait there the way
     * this module ends its own. Returns the function that stops it.
     */
    onInterruptWaits(listener: (agentId: string) => void): () => void {
        this.#interruptListeners.add(listener);
        return () => {
            this.#interruptListeners.delete(listener);
        };
    }

    /** Wake every suspended wait, for a process that is shutting down. */
    stop(): void {
        this.#suspensions.interruptAll();
    }

    formatWaitForModel(result: SchedulingWaitResult): string {
        assertSchedulingWaitResult(result);
        return waitText(result);
    }

    /**
     * Claim the durable wait, hold the tool call outside every transaction, then settle it.
     *
     * The two transactions are deliberately short and the suspension sits between them: a wait may
     * last a day, and no database write lock survives one.
     */
    async #wait(
        ctx: Context,
        agentId: string,
        requestedId: string | undefined,
        kind: "wait" | "wait_until",
        dueAtFrom: (startedAt: number) => number,
    ): Promise<SchedulingWaitResult> {
        this.#assertAgentId(agentId, "acting agent");
        const id = requestedId ?? this.#newId();
        this.#assertId(id, "wait");
        const claimed = await ctx.inTx(async (txCtx) => {
            const existing = await this.#readWait(txCtx, agentId, id);
            if (existing !== undefined) {
                if (existing.kind !== kind) {
                    throw new Error("That wait identity belongs to another kind of wait.");
                }
                return structuredClone(existing);
            }
            const startedAt = this.#now();
            const claimed: SchedulingWaitingRecord = {
                id,
                agentId,
                kind,
                status: "waiting",
                dueAt: dueAtFrom(startedAt),
                createdAt: startedAt,
                updatedAt: startedAt,
                startedAt,
            };
            await this.#writeWait(txCtx, claimed);
            await this.#announce(
                txCtx,
                this.#event({ type: "wait_started", agentId, wait: claimed }),
            );
            return claimed;
        });
        if (claimed.status !== "waiting") return waitResult(claimed);
        const outcome = await this.#suspensions.suspend(agentId, claimed.dueAt, ctx.lifetime);
        return await ctx.inTx(async (txCtx) => {
            const before = await this.#readRequiredWait(txCtx, agentId, id);
            if (before.status !== "waiting") return waitResult(before);
            const finishedAt =
                outcome === "elapsed"
                    ? Math.max(this.#now(), before.dueAt)
                    : Math.max(this.#now(), before.startedAt);
            const settled: SchedulingWaitRecord = {
                ...before,
                status: outcome,
                updatedAt: finishedAt,
                finishedAt,
                elapsedMs: finishedAt - before.startedAt,
            };
            await this.#writeWait(txCtx, settled);
            const result = waitResult(settled);
            await this.#announce(
                txCtx,
                this.#event({
                    type: "wait_finished",
                    agentId,
                    wait: settled,
                    result,
                }),
            );
            return result;
        });
    }

    async #readWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord | undefined> {
        const wait = await this.#store.readWait(ctx, agentId, id);
        if (wait === undefined) return undefined;
        assertSchedulingWaitRecord(wait);
        if (wait.id !== id || wait.agentId !== agentId) {
            throw new Error("Scheduling store returned a different durable wait identity.");
        }
        return wait;
    }

    async #readRequiredWait(
        ctx: Context,
        agentId: string,
        id: string,
    ): Promise<SchedulingWaitRecord> {
        const wait = await this.#readWait(ctx, agentId, id);
        if (wait === undefined) throw new Error("That durable wait no longer exists.");
        return wait;
    }

    async #writeWait(ctx: Context, wait: SchedulingWaitRecord): Promise<void> {
        assertSchedulingWaitRecord(wait);
        await this.#store.writeWait(ctx, structuredClone(wait));
    }

    #event(payload: SchedulingEventPayload): SchedulingEvent {
        const event = { ...payload, eventId: randomSchedulingId(), at: this.#now() };
        if (!Value.Check(schedulingEventSchema, event)) {
            throw new Error("Scheduling module created an invalid event.");
        }
        return deepFreeze(structuredClone(event as SchedulingEvent));
    }

    #subscribe(
        listeners: Set<SchedulingEventListener>,
        listener: SchedulingEventListener,
    ): SchedulingUnsubscribe {
        if (!Value.Check(schedulingEventListenerSchema, listener)) {
            throw new Error("A scheduling subscriber must be a function.");
        }
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }

    async #announce(ctx: Context, event: SchedulingEvent): Promise<void> {
        // A snapshot, so subscribing or unsubscribing from inside a subscriber cannot change who
        // this event goes to.
        for (const listener of [...this.#transactionalListeners]) await listener(ctx, event);
        afterCommit(ctx, (postCommitCtx) => this.#notifyPostCommit(postCommitCtx, event));
    }

    async #notifyPostCommit(ctx: Context, event: SchedulingEvent): Promise<void> {
        for (const listener of [...this.#postCommitListeners]) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                // Nothing here can undo a scheduling change the database has already committed,
                // and one failing subscriber must not hide the event from the rest.
                ctx.log.error(
                    { error, eventId: event.eventId, type: event.type },
                    "A scheduling subscriber failed after the change was committed.",
                );
            }
        }
    }

    #dueFromDuration(now: number, amount: number, horizon = MAX_SCHEDULING_WAIT_DURATION): number {
        if (amount > horizon) {
            throw new Error(`That is longer than the ${humanDuration(horizon)} limit.`);
        }
        return this.#dueAt(now + amount);
    }

    #dueFromInstant(
        now: number,
        requested: number,
        horizon = MAX_SCHEDULING_WAIT_DURATION,
    ): number {
        const dueAt = Math.max(now, requested);
        if (dueAt - now > horizon) {
            throw new Error(`That is further away than the ${humanDuration(horizon)} limit.`);
        }
        return this.#dueAt(dueAt);
    }

    #dueAt(value: number): number {
        if (!Value.Check(schedulingTimestampSchema, value)) {
            throw new Error("That resolves to a time scheduling cannot represent.");
        }
        return value;
    }

    #now(): number {
        const now = Date.now();
        if (!Value.Check(schedulingTimestampSchema, now)) {
            throw new Error("The clock returned a time scheduling cannot represent.");
        }
        return now;
    }

    #newId(): string {
        return randomSchedulingId();
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined) {
            throw new Error("Scheduling has not been started by an agent system yet.");
        }
        return this.#agents;
    }

    #assertAgentId(value: unknown, label: string): asserts value is string {
        if (!Value.Check(schedulingAgentIdSchema, value)) {
            throw new Error(`The ${label} ID is not a valid agent identity.`);
        }
    }

    #assertId(value: unknown, label: string): asserts value is string {
        if (!Value.Check(schedulingWaitIdSchema, value)) {
            throw new Error(`The ${label} ID is not a valid scheduling identity.`);
        }
    }

    #assertInput(schema: TSchema, value: unknown, label: string): void {
        if (!Value.Check(schema, value)) throw new Error(`The ${label} is invalid.`);
    }
}

type SchedulingEventPayload =
    | {
          readonly type: "wait_started";
          readonly agentId: string;
          readonly wait: SchedulingWaitRecord;
      }
    | {
          readonly type: "wait_finished";
          readonly agentId: string;
          readonly wait: SchedulingWaitRecord;
          readonly result: SchedulingWaitResult;
      };

function waitResult(wait: SchedulingWaitRecord): SchedulingWaitResult {
    if (wait.status === "waiting") throw new Error("A waiting record has no final result.");
    const result: SchedulingWaitResult = {
        waitId: wait.id,
        agentId: wait.agentId,
        outcome: wait.status,
        kind: wait.kind,
        dueAt: wait.dueAt,
        startedAt: wait.startedAt,
        endedAt: wait.finishedAt,
        elapsedMs: wait.elapsedMs,
    };
    assertSchedulingWaitResult(result);
    return result;
}

/** A cuid2-shaped identity, the shape every durable scheduling record carries. */
function randomSchedulingId(): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(23));
    let id = "s";
    for (const byte of bytes) id += alphabet[byte % alphabet.length];
    return id;
}

function deepFreeze<ValueType>(value: ValueType): ValueType {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    return Object.freeze(value);
}
