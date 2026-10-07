import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    customProviderDiscoverySchema,
    customProviderSaveSchema,
    customModelSchema,
    type CustomProviderDiscovery,
    type CustomProviderSave,
    type CustomProviderUpdate,
    type CustomProviderExistingDiscovery,
    type CustomProviderReasoningUpdate,
} from "@kissopen/kissopen-agent-client";
import {
    BaseProvider,
    BaseSession,
    ChatCompletionsProvider,
    type SessionOptions,
    type SessionRunRequest,
    type SessionStream,
    type SessionCompactionOptions,
    type SessionCompaction,
} from "@kissopen/kissopen-providers";
import type { Context } from "@steve.kite/stdlib";
import { curatedCustomModelReasoning, type ConfiguredAgentModel } from "./agentCatalog.js";

const recordSchema = Type.Object({
    ...customProviderDiscoverySchema.properties,
    name: customProviderSaveSchema.properties.name,
    enabled: Type.Boolean(),
    models: Type.Array(customModelSchema, { minItems: 1, maxItems: 512 }),
});
const recordsSchema = Type.Record(Type.String({ pattern: "^custom-[a-f0-9]{24}$" }), recordSchema, {
    maxProperties: 64,
});
type RecordEntry = Static<typeof recordSchema>;

export class CustomProviderError extends Error {}

/** A user-supplied endpoint, never a page URL or a credential-bearing redirect. */
export function customProviderUrl(input: string): string {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        throw new CustomProviderError(
            "Enter a valid API base URL, for example https://example.com/v1.",
        );
    }
    if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        /\s/u.test(input)
    )
        throw new CustomProviderError(
            "Use an HTTP or HTTPS API URL without credentials, query parameters or fragments.",
        );
    return url.href.replace(/\/+$/u, "");
}

/** Discovery is read-only and only performed after explicit local user input. */
export async function discoverCustomModels(input: CustomProviderDiscovery, signal?: AbortSignal) {
    const baseUrl = customProviderUrl(input.baseUrl);
    const timeout = AbortSignal.timeout(15_000);
    try {
        const response = await fetch(`${baseUrl}/models`, {
            headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
            redirect: "error",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (response.status === 401 || response.status === 403)
            throw new CustomProviderError(
                "The API Key was rejected. Check the key and its model access permissions.",
            );
        if (!response.ok)
            throw new CustomProviderError(
                response.status === 404
                    ? "No models endpoint was found. Check the API base URL, including /v1 when required."
                    : "The model service could not return its model list. Try again later.",
            );
        if (Number(response.headers.get("content-length")) > 1_048_576)
            throw new CustomProviderError("The model list is too large.");
        const reader = response.body?.getReader();
        if (!reader) throw new CustomProviderError("The model service returned an empty response.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 1_048_576) throw new CustomProviderError("The model list is too large.");
                chunks.push(value);
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const envelope = Type.Object({
            data: Type.Array(
                Type.Object({
                    id: customModelSchema.properties.id,
                    name: Type.Optional(customModelSchema.properties.name),
                    reasoning: Type.Optional(Type.Unknown()),
                }),
                { maxItems: 512 },
            ),
        });
        if (!Value.Check(envelope, parsed))
            throw new CustomProviderError(
                "This service did not return an OpenAI-compatible model list.",
            );
        const unique = new Map(
            parsed.data.map((m) => {
                const declared = m.reasoning;
                const valid =
                    declared !== undefined &&
                    Value.Check(customModelSchema.properties.discoveredReasoning, declared) &&
                    (declared === null ||
                        declared.efforts.some((level) => level === declared.defaultEffort));
                return [
                    m.id,
                    {
                        id: m.id,
                        name: m.name ?? m.id,
                        ...(valid ? { discoveredReasoning: declared } : {}),
                    },
                ];
            }),
        );
        return { models: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    } catch (error) {
        if (error instanceof CustomProviderError) throw error;
        throw new CustomProviderError(
            timeout.aborted
                ? "Loading models timed out. Check the URL or network and try again."
                : "Could not connect to the model service. Check the URL, network and OpenAI API compatibility.",
        );
    }
}

/** Config-owned private records; writes commit before publishing live routes. */
export class CustomProviders {
    #records: Static<typeof recordsSchema> = {};
    constructor(readonly path: string) {}
    async load(): Promise<void> {
        try {
            if ((await stat(this.path)).size > 4_194_304)
                throw new Error("Custom provider configuration is too large.");
            const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
            if (!Value.Check(recordsSchema, value))
                throw new Error("Custom provider configuration is invalid.");
            for (const entry of Object.values(value)) {
                customProviderUrl(entry.baseUrl);
                reasoningValidate(entry);
            }
            this.#records = value;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw new Error("Unable to read the private custom model configuration.");
        }
    }
    get ids(): readonly string[] {
        return Object.keys(this.#records);
    }
    has(id: string): boolean {
        return this.#records[id] !== undefined;
    }
    enabled(id: string): boolean {
        return this.#records[id]?.enabled === true;
    }
    name(id: string): string | undefined {
        const entry = this.#records[id];
        return entry ? (entry.name ?? new URL(entry.baseUrl).host) : undefined;
    }
    details(id: string) {
        const entry = this.#entry(id);
        return {
            provider: {
                name: this.name(id)!,
                baseUrl: entry.baseUrl,
                models: structuredClone(entry.models),
            },
        };
    }
    connection(id: string, input: CustomProviderExistingDiscovery): CustomProviderDiscovery {
        const entry = this.#entry(id);
        const baseUrl =
            input.baseUrl === undefined ? entry.baseUrl : customProviderUrl(input.baseUrl);
        if (baseUrl !== entry.baseUrl && !input.apiKey)
            throw new CustomProviderError(
                "Enter a new API Key when changing the API URL. Your existing key will not be sent to another endpoint.",
            );
        return { baseUrl, apiKey: input.apiKey ?? entry.apiKey };
    }
    async update(id: string, input: CustomProviderUpdate): Promise<void> {
        const entry = this.#entry(id);
        const connection = this.connection(id, input);
        if (
            Object.entries(this.#records).some(
                ([otherId, other]) => otherId !== id && other.baseUrl === connection.baseUrl,
            )
        )
            throw new CustomProviderError(
                "Another provider already uses this API URL. Edit that connection instead.",
            );
        await this.#write({
            ...this.#records,
            [id]: {
                ...entry,
                ...connection,
                ...(input.name === undefined ? {} : { name: input.name.trim() }),
                ...(input.models === undefined
                    ? {}
                    : { models: [...new Map(input.models.map((m) => [m.id, m])).values()] }),
            },
        });
    }
    async remove(id: string): Promise<void> {
        const next = { ...this.#records };
        delete next[id];
        await this.#write(next);
    }
    #entry(id: string): RecordEntry {
        const entry = this.#records[id];
        if (!entry) throw new CustomProviderError("This custom provider is no longer available.");
        return entry;
    }
    catalog(): ConfiguredAgentModel[] {
        return Object.entries(this.#records).flatMap(([providerId, entry]) =>
            entry.models.map((m) => {
                const reasoning = customModelReasoning(m);
                return {
                    providerId,
                    id: `${providerId}/${m.id}`,
                    name: m.name,
                    effortLevels: reasoning?.efforts ?? ["off" as const],
                    defaultEffort: reasoning?.defaultEffort ?? "off",
                    customReasoning: reasoning,
                    contextWindow: null,
                    enabled: entry.enabled,
                };
            }),
        );
    }
    provider(id: string): BaseProvider {
        return new StoredCustomProvider(() => ({
            revision: this.#records[id],
            provider: this.#endpoint(id),
        }));
    }
    #endpoint(id: string): ChatCompletionsProvider {
        const entry = this.#records[id];
        if (!entry) throw new Error("Custom provider is unavailable.");
        return new ChatCompletionsProvider({
            apiKey: entry.apiKey,
            baseUrl: entry.baseUrl,
            service: new URL(entry.baseUrl).host,
            structuredOutputMode: "json_object",
            resolveModel: (model) => {
                const selected = entry.models.find((m) => `${id}/${m.id}` === model);
                if (!selected)
                    throw new Error("This model is not selected for the custom provider.");
                const reasoning = customModelReasoning(selected);
                return {
                    wireModel: selected.id,
                    ...(reasoning
                        ? {
                              thinkingControl: reasoning.mode,
                              ...(reasoning.mode === "deepseek"
                                  ? { reasoningReplay: "all" as const }
                                  : {}),
                          }
                        : {}),
                };
            },
        });
    }
    async save(input: CustomProviderSave): Promise<string> {
        const baseUrl = customProviderUrl(input.baseUrl);
        const existingId = Object.entries(this.#records).find(
            ([, entry]) => entry.baseUrl === baseUrl,
        )?.[0];
        const derivedId = `custom-${createHash("sha256").update(baseUrl).digest("hex").slice(0, 24)}`;
        // A connection may have moved away from the URL that originally produced its ID.
        // Adding that old URL must not overwrite the moved connection.
        const id =
            existingId ??
            (this.has(derivedId)
                ? `custom-${randomUUID().replaceAll("-", "").slice(0, 24)}`
                : derivedId);
        const models = [...new Map(input.models.map((m) => [m.id, m])).values()];
        const name = input.name === undefined ? this.#records[id]?.name : input.name.trim();
        await this.#write({
            ...this.#records,
            [id]: {
                baseUrl,
                apiKey: input.apiKey,
                models,
                enabled: true,
                ...(name === undefined ? {} : { name }),
            },
        });
        return id;
    }
    async setEnabled(id: string, enabled: boolean): Promise<void> {
        const entry = this.#records[id];
        if (!entry) throw new Error("Custom provider is unavailable.");
        await this.#write({ ...this.#records, [id]: { ...entry, enabled } });
    }
    async setReasoning(id: string, input: CustomProviderReasoningUpdate): Promise<void> {
        const entry = this.#records[id];
        if (!entry || !entry.models.some((model) => `${id}/${model.id}` === input.modelId))
            throw new CustomProviderError(
                "This custom model is no longer available. Open Providers and choose an existing model.",
            );
        await this.#write({
            ...this.#records,
            [id]: {
                ...entry,
                models: entry.models.map((model) =>
                    `${id}/${model.id}` === input.modelId
                        ? { ...model, reasoning: input.reasoning }
                        : model,
                ),
            },
        });
    }
    async #write(next: Record<string, RecordEntry>): Promise<void> {
        if (!Value.Check(recordsSchema, next))
            throw new CustomProviderError(
                "The custom provider configuration is invalid or has too many connections.",
            );
        for (const entry of Object.values(next)) reasoningValidate(entry);
        const contents = JSON.stringify(next);
        if (Buffer.byteLength(contents) > 4_194_304)
            throw new CustomProviderError(
                "The custom provider configuration is invalid or has too many connections.",
            );
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
            await rename(temporary, this.path);
            this.#records = next;
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

function reasoningValidate(entry: RecordEntry): void {
    for (const model of entry.models) {
        for (const reasoning of [model.reasoning, model.discoveredReasoning]) {
            if (reasoning && !reasoning.efforts.some((level) => level === reasoning.defaultEffort))
                throw new CustomProviderError(
                    "Choose a default reasoning effort from the supported levels.",
                );
        }
    }
}

/** One resolution path shared by public Effort choices and actual wire parameters. */
function customModelReasoning(model: RecordEntry["models"][number]) {
    if (model.reasoning !== undefined) return model.reasoning;
    if (model.discoveredReasoning !== undefined) return model.discoveredReasoning;
    return curatedCustomModelReasoning(model.id) ?? null;
}

/** Reuse the shared protocol; refresh credentials/selection at the next request after a save. */
class StoredCustomProvider extends BaseProvider {
    static override readonly name = "custom";
    static override readonly inputTypes = ChatCompletionsProvider.inputTypes;
    static override readonly outputTypes = ChatCompletionsProvider.outputTypes;
    constructor(
        readonly current: () => {
            revision: RecordEntry | undefined;
            provider: ChatCompletionsProvider;
        },
    ) {
        super();
    }
    async session(id: string, options: SessionOptions): Promise<BaseSession> {
        return new StoredCustomSession(id, options, this.current);
    }
}
class StoredCustomSession extends BaseSession {
    #revision: RecordEntry | undefined;
    #session: BaseSession | undefined;
    #destroyed = false;
    constructor(
        id: string,
        readonly options: SessionOptions,
        readonly current: StoredCustomProvider["current"],
    ) {
        super(id);
    }
    async #latest(): Promise<BaseSession> {
        if (this.#destroyed) throw new Error("The custom provider session is closed.");
        const current = this.current();
        if (!this.#session || this.#revision !== current.revision) {
            await this.#session?.destroy();
            this.#session = await current.provider.session(this.id, this.options);
            this.#revision = current.revision;
        }
        return this.#session;
    }
    async *run(ctx: Context, request: SessionRunRequest): SessionStream {
        yield* (await this.#latest()).run(ctx, request);
    }
    async compact(ctx: Context, options: SessionCompactionOptions): Promise<SessionCompaction> {
        return await (await this.#latest()).compact(ctx, options);
    }
    async destroy(): Promise<void> {
        this.#destroyed = true;
        await this.#session?.destroy();
        this.#session = undefined;
    }
}
