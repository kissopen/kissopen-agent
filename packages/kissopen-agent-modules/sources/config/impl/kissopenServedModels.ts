import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * One model the KISSOPEN server offers from an upstream added in its console, as the server's
 * policy describes it (`catalog` in `GET {base_url}/policy`).
 *
 * These are the one deliberate exception to the curated catalog. The server's operator chooses
 * them from the upstream's own list, so no release of this Agent can name them in advance; what
 * the curated catalog would state — the name, the API, the context window and the output
 * ceiling — the server states instead, explicitly, for each one.
 */
export const kissopenServedModelSchema = Type.Object(
    {
        id: Type.String({ minLength: 3, maxLength: 256, pattern: "^[a-z][a-z0-9-]*/.+$" }),
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

export const kissopenServedModelsSchema = Type.Array(kissopenServedModelSchema, {
    maxItems: 512,
});

export type KissopenServedModel = Static<typeof kissopenServedModelSchema>;

/** What KissopenProvider needs to know to reach one served model. */
export type KissopenServedRoute = Pick<KissopenServedModel, "protocol" | "max_output_tokens">;

/**
 * The served models this Agent last heard of, kept on disk beside the generated runtime
 * configuration so a restarted Agent offers them — and can continue a conversation on one —
 * before the server has been asked again.
 */
export class KissopenServedModels {
    readonly #path: string;
    #models: readonly KissopenServedModel[] = [];
    readonly #listeners = new Set<() => void>();

    constructor(path: string) {
        this.#path = path;
    }

    get models(): readonly KissopenServedModel[] {
        return this.#models;
    }

    route(modelId: string | undefined): KissopenServedRoute | undefined {
        if (modelId === undefined) return undefined;
        return this.#models.find((model) => model.id === modelId);
    }

    /** Read the last saved list; a missing or unreadable file is an empty list. */
    async load(): Promise<void> {
        try {
            const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
            if (Value.Check(kissopenServedModelsSchema, parsed)) this.#models = parsed;
        } catch {
            this.#models = [];
        }
    }

    /**
     * Take the server's current list. Only a change is saved and announced, so the policy's
     * regular refresh does not rewrite the file or reload clients every few minutes.
     */
    async update(models: readonly KissopenServedModel[]): Promise<void> {
        const next = models.filter((model) => Value.Check(kissopenServedModelSchema, model));
        if (JSON.stringify(next) === JSON.stringify(this.#models)) return;
        this.#models = next;
        try {
            await mkdir(dirname(this.#path), { recursive: true });
            const temporary = `${this.#path}.${process.pid}.tmp`;
            await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
            await rename(temporary, this.#path);
        } catch {
            // The list still applies to this process; the next start asks the server again.
        }
        for (const listener of this.#listeners) listener();
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
}
