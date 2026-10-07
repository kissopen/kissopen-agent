import { Value } from "@sinclair/typebox/value";

import {
    DEFAULT_EXPERT_POLICY,
    expertPolicyResponseSchema,
    type ExpertPolicySnapshot,
} from "./ExpertPolicy.js";

/** How often the policy is read again while the daemon runs. */
export const EXPERT_POLICY_REFRESH_MS = 60 * 1_000;

/** How long one policy request may take before it counts as a failure. */
export const EXPERT_POLICY_REQUEST_TIMEOUT_MS = 15_000;

/** The `kissopen` provider's own endpoint and device credential. */
export interface ExpertPolicySource {
    /** The provider's `base_url`, such as `https://api.firstcache.cc/api/agent/v1`. */
    readonly baseUrl: string;
    /** The provider's `api_key`: the device credential the model calls use. Never logged. */
    readonly apiKey: string;
}

/** Where a refresh failure is reported. Only the endpoint and the reason are ever passed. */
export type ExpertPolicyLog = (message: string, fields: Record<string, unknown>) => void;

export interface ExpertPolicyClientOptions {
    /**
     * Read on every refresh, so a device key the person reconnected with is used without a
     * restart. Undefined means there is no configured KISSOPEN provider and nothing is fetched.
     */
    readonly source: () => ExpertPolicySource | undefined;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly refreshMs?: number;
    readonly requestTimeoutMs?: number;
    readonly log?: ExpertPolicyLog;
    /** Told about every policy that comes into force, the built-in one first. */
    readonly onChange?: (snapshot: ExpertPolicySnapshot) => void;
}

/**
 * Keeps the server's routing policy in memory.
 *
 * The policy only ever adds to what an agent can do, so being late or wrong must never stop one:
 * nothing waits for the first reading, a failed reading keeps the last good one, and before any
 * reading has succeeded the built-in default (the server's own default) is in force. One request
 * is in flight at a time; a refresh asked for meanwhile shares it.
 */
export class ExpertPolicyClient {
    readonly #source: () => ExpertPolicySource | undefined;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #refreshMs: number;
    readonly #requestTimeoutMs: number;
    readonly #log: ExpertPolicyLog;
    readonly #onChange: (snapshot: ExpertPolicySnapshot) => void;
    #snapshot: ExpertPolicySnapshot = DEFAULT_EXPERT_POLICY;
    #inFlight: Promise<boolean> | undefined;
    #timer: ReturnType<typeof setInterval> | undefined;

    constructor(options: ExpertPolicyClientOptions) {
        this.#source = options.source;
        this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
        this.#now = options.now ?? Date.now;
        this.#refreshMs = options.refreshMs ?? EXPERT_POLICY_REFRESH_MS;
        this.#requestTimeoutMs = options.requestTimeoutMs ?? EXPERT_POLICY_REQUEST_TIMEOUT_MS;
        this.#log = options.log ?? (() => undefined);
        this.#onChange = options.onChange ?? (() => undefined);
        this.#onChange(this.#snapshot);
    }

    /** The policy in force: the last good server reading, or the built-in default. */
    current(): ExpertPolicySnapshot {
        return this.#snapshot;
    }

    /** Read now and every `refreshMs` afterwards, without holding the process open. */
    start(): void {
        if (this.#timer !== undefined) return;
        void this.refresh();
        this.#timer = setInterval(() => {
            void this.refresh();
        }, this.#refreshMs);
        this.#timer.unref?.();
    }

    stop(): void {
        if (this.#timer !== undefined) clearInterval(this.#timer);
        this.#timer = undefined;
    }

    /**
     * Ask the server once. Resolves true when a valid policy was stored and false otherwise;
     * it never rejects, because no caller could do anything about a failure but keep going.
     */
    refresh(): Promise<boolean> {
        this.#inFlight ??= this.#read().finally(() => {
            this.#inFlight = undefined;
        });
        return this.#inFlight;
    }

    async #read(): Promise<boolean> {
        const source = this.#source();
        if (source === undefined) return false;
        const url = policyUrl(source.baseUrl);
        if (url === undefined) {
            this.#log("The KISSOPEN routing policy endpoint is not a valid URL.", {});
            return false;
        }
        try {
            const response = await this.#fetch(url, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${source.apiKey}`,
                },
                signal: AbortSignal.timeout(this.#requestTimeoutMs),
            });
            if (!response.ok) {
                // The body may echo the request; only the status is worth keeping.
                await response.body?.cancel().catch(() => undefined);
                this.#log("The KISSOPEN routing policy could not be read.", {
                    url,
                    status: response.status,
                });
                return false;
            }
            const body: unknown = await response.json();
            if (!Value.Check(expertPolicyResponseSchema, body)) {
                this.#log("The KISSOPEN routing policy was not in the expected shape.", { url });
                return false;
            }
            this.#snapshot = {
                models: [...body.models],
                ...(body.catalog === undefined ? {} : { catalog: structuredClone(body.catalog) }),
                policy: structuredClone(body.policy),
                origin: "server",
                fetchedAt: this.#now(),
            };
            this.#onChange(this.#snapshot);
            return true;
        } catch (error: unknown) {
            this.#log("The KISSOPEN routing policy could not be read.", {
                url,
                reason: redact(describe(error), source.apiKey),
            });
            return false;
        }
    }
}

/** `{base_url}/policy`, or undefined when the base URL is not an http(s) URL. */
export function policyUrl(baseUrl: string): string | undefined {
    try {
        const parsed = new URL(baseUrl.trim());
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
        // A credential or query in the configured URL would otherwise reach the log with it.
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/policy`;
        return parsed.toString();
    } catch {
        return undefined;
    }
}

function describe(error: unknown): string {
    if (error instanceof Error && error.message !== "") return error.message.slice(0, 300);
    return String(error).slice(0, 300);
}

/** A transport error has no business quoting the key, but make sure it cannot. */
function redact(text: string, secret: string): string {
    return secret === "" ? text : text.split(secret).join("[redacted]");
}
