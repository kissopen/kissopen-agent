import { randomBytes } from "node:crypto";
import type {
    BrowserCommand,
    BrowserControlRequest,
    BrowserControlResponse,
    BrowserOperation,
    BrowserResult,
} from "@kissopen/kissopen-agent-client";

type Pending = {
    command: BrowserCommand;
    claimed: boolean;
    finish: (result: BrowserResult) => void;
};
type Lease = {
    id: string;
    tabId: string;
    expiresAt: number;
    paused: boolean;
    capabilities: readonly ("batch" | "wait")[];
    timer: ReturnType<typeof setTimeout>;
    pending?: Pending;
};
const LEASE_MS = 45000;
const failed = (text: string): BrowserResult => ({ ok: false, text });

/** One personal connection's transient browser leases. Never restores or replays page actions. */
export class KissopenBrowser {
    readonly #leases = new Map<string, Lease>();
    // Keep bounded tombstones for this connection's lifetime; fail closed at capacity.
    readonly #used = new Set<string>();

    control(agentId: string, request: BrowserControlRequest): BrowserControlResponse {
        let lease = this.#leases.get(agentId);
        if (lease && lease.expiresAt <= Date.now()) {
            this.#revoke(agentId, lease);
            lease = undefined;
        }
        if (request.action === "attach") {
            if (lease && (lease.id !== request.leaseId || lease.tabId !== request.tabId))
                return {
                    ok: false,
                    error: "Another desktop owns this conversation's browser. Close it there first.",
                };
            if (!lease) {
                if (this.#used.has(request.leaseId))
                    return {
                        ok: false,
                        error: "This browser lease was already used. Open a fresh attachment.",
                    };
                if (this.#used.size >= 10000)
                    return {
                        ok: false,
                        error: "Browser attachment capacity reached. Reconnect the desktop.",
                    };
                if (this.#leases.size >= 32)
                    return { ok: false, error: "Too many attached browsers." };
                this.#used.add(request.leaseId);
                lease = {
                    id: request.leaseId,
                    tabId: request.tabId,
                    paused: false,
                    capabilities: request.capabilities ?? [],
                    expiresAt: Date.now() + LEASE_MS,
                    timer: setTimeout(() => this.#expire(agentId), LEASE_MS),
                };
                lease.timer.unref();
                this.#leases.set(agentId, lease);
            }
            return { ok: true, paused: lease.paused };
        }
        // A revoke may beat its attach over the network; don't allow that delayed
        // attach to recreate a capability the desktop has already discarded.
        if (!lease && request.action === "revoke" && this.#used.size < 10000)
            this.#used.add(request.leaseId);
        if (!lease || lease.id !== request.leaseId)
            return { ok: false, error: "This browser lease is no longer active." };
        if (request.action === "revoke") {
            this.#revoke(agentId, lease);
            return { ok: true, paused: true };
        }
        if (request.action === "pause") {
            lease.paused = true;
            lease.pending?.finish(
                failed("The user took over. Stop browser work and wait for them to resume."),
            );
        }
        if (request.action === "resume") lease.paused = false;
        if (request.action === "complete") {
            if (!lease.pending?.claimed || lease.pending.command.id !== request.commandId)
                return {
                    ok: false,
                    error: "This command is no longer pending. Do not execute it again.",
                };
            const progress = request.result.batch;
            const operation = lease.pending.command.operation;
            if (
                progress &&
                (operation.action !== "batch" ||
                    progress.totalSteps !== operation.steps.length ||
                    progress.completedSteps > progress.totalSteps)
            )
                return { ok: false, error: "Batch progress does not match the pending command." };
            lease.pending.finish(request.result);
        }
        lease.expiresAt = Date.now() + LEASE_MS;
        clearTimeout(lease.timer);
        lease.timer = setTimeout(() => this.#expire(agentId), LEASE_MS);
        lease.timer.unref();
        const pending = lease.pending;
        if (request.action === "poll" && !lease.paused && pending && !pending.claimed) {
            pending.claimed = true;
            return { ok: true, paused: false, command: pending.command };
        }
        return { ok: true, paused: lease.paused };
    }

    async execute(agentId: string, operation: BrowserOperation): Promise<BrowserResult> {
        const lease = this.#leases.get(agentId);
        if (!lease || lease.expiresAt <= Date.now())
            return failed(
                "The desktop browser connection is unavailable for this conversation. This operation was not queued or executed. Browser operations cannot establish or repair the desktop transport; do not claim to reconnect or read a page without a successful tool result. The right-side panel does not need to be opened manually: an attached desktop opens it automatically on navigate. For a temporary connection outage, keep an active goal waiting with a bounded recheck rather than immediately declaring it blocked. Waiting schedules another observation; it does not repair the connection. Use another already-available browser tool for the authorized task if it has its own session and permission checks. Otherwise report the actual connection blocker and saved progress. Do not invent browser capabilities or bypass user takeover, explicit user closure or a denied action.",
            );
        if (lease.paused)
            return failed(
                "The user is controlling the browser. Wait for them to resume; do not use another browser.",
            );
        if (
            (operation.action === "batch" || operation.action === "wait") &&
            !lease.capabilities.includes(operation.action)
        )
            return failed(
                `This desktop did not advertise ${operation.action} support. Use individually observed browser operations; do not retry this unsupported operation.`,
            );
        if (
            operation.action === "batch" &&
            operation.steps.reduce(
                (sum, step) => sum + (step.action === "fill" ? step.text.length : 0),
                0,
            ) > 12000
        )
            return failed(
                "A browser batch accepts at most 12000 total fill characters. No steps were executed.",
            );
        if (lease.pending)
            return failed(
                "A browser action is already pending. Wait for its result before continuing.",
            );
        return new Promise((resolve) => {
            const timer = setTimeout(
                () =>
                    pending.finish(
                        failed(
                            "Browser action timed out; its outcome may be unknown. Do not repeat it. Read the current page before deciding what to do next.",
                        ),
                    ),
                25000,
            );
            const pending: Pending = {
                command: {
                    id: randomBytes(24).toString("base64url"),
                    tabId: lease.tabId,
                    expiresAt: Date.now() + 25000,
                    operation,
                },
                claimed: false,
                finish: (result) => {
                    clearTimeout(timer);
                    if (lease.pending === pending) delete lease.pending;
                    resolve(result);
                },
            };
            lease.pending = pending;
        });
    }

    close(): void {
        for (const [id, lease] of this.#leases) this.#revoke(id, lease);
    }
    revoke(agentId: string): void {
        const lease = this.#leases.get(agentId);
        if (lease) this.#revoke(agentId, lease);
    }
    #expire(agentId: string): void {
        const lease = this.#leases.get(agentId);
        if (lease && lease.expiresAt <= Date.now()) this.#revoke(agentId, lease);
    }
    #revoke(agentId: string, lease: Lease): void {
        clearTimeout(lease.timer);
        lease.pending?.finish(
            failed("Browser control was revoked. Stop; do not retry page actions."),
        );
        this.#leases.delete(agentId);
    }
}
