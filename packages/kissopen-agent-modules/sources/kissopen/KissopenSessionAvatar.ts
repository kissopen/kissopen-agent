import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BotAvatarAsset } from "../bots/index.js";
import type { KissopenConnectionConfiguration } from "./KissopenCredentials.js";
import type { KissopenSyncSession } from "./KissopenSync.js";
import { encryptKissopenBlob } from "./crypto/decryptKissopenBlob.js";
import { decryptKissopenPayload, encryptKissopenPayload } from "./crypto/kissopenEncryption.js";

export const kissopenSessionAvatarSchema = Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 1024 }),
    preview: Type.String({ minLength: 1, maxLength: 4096 }),
    version: Type.Integer({ minimum: 1 }),
});
export type KissopenSessionAvatar = Static<typeof kissopenSessionAvatarSchema>;
const resultSchema = Type.Object({
    avatar: Type.Union([kissopenSessionAvatarSchema, Type.Null()]),
});
const previewSchema = Type.Object({
    mimeType: Type.Literal("image/webp"),
    thumbhash: Type.String({ minLength: 4, maxLength: 128 }),
    contentHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
});
const uploadSchema = Type.Object({
    ref: Type.String({ minLength: 1, maxLength: 1024 }),
    uploadUrl: Type.String({ minLength: 1, maxLength: 8192 }),
    method: Type.Union([Type.Literal("PUT"), Type.Literal("POST")]),
    formFields: Type.Optional(Type.Record(Type.String(), Type.String())),
});

/** Optional image synchronization, owned by one session connection and its encryption key. */
export class KissopenSessionAvatarClient {
    #remote: KissopenSessionAvatar | null;
    #pending: { hash: string; ref: string; preview: string } | undefined;

    constructor(
        private readonly options: {
            configuration: KissopenConnectionConfiguration;
            state: KissopenSyncSession & { remoteSessionId: string };
            remote: KissopenSessionAvatar | null;
            fetch?: typeof fetch;
            signal: AbortSignal;
            version: string;
        },
    ) {
        this.#remote = options.remote;
    }

    /** The caller serializes this operation. No asset means no authority over this session. */
    async sync(asset: BotAvatarAsset | null | undefined): Promise<void> {
        if (asset === undefined) return;
        const base = `${this.options.configuration.serverUrl}/v1/sessions/${encodeURIComponent(this.options.state.remoteSessionId)}/avatar`;
        if (asset === null) {
            // A lost PATCH response may already have activated the pending upload remotely.
            if (this.#remote === null && this.#pending === undefined) return;
            await this.#activate(base, "DELETE");
            this.#pending = undefined;
            return;
        }
        const key = new Uint8Array(Buffer.from(this.options.state.encryptionKeyBase64, "base64"));
        const variant = this.options.state.encryptionVariant;
        if (this.#pending === undefined && this.#remote !== null) {
            const preview = decryptKissopenPayload(
                key,
                variant,
                new Uint8Array(Buffer.from(this.#remote.preview, "base64")),
            );
            if (Value.Check(previewSchema, preview) && preview.contentHash === asset.contentHash)
                return;
        }
        if (this.#pending?.hash !== asset.contentHash) {
            const bytes = encryptKissopenBlob({
                bytes: asset.bytes,
                encryptionKey: key,
                encryptionVariant: variant,
            });
            if (bytes.byteLength > 10 * 1024 * 1024)
                throw new Error("The encrypted session picture is too large.");
            const response = await this.#request(`${base}/request-upload`, "POST", {
                size: bytes.byteLength,
            });
            const upload: unknown = await response.json();
            if (!Value.Check(uploadSchema, upload))
                throw new Error("WorPar returned invalid session picture upload instructions.");
            if (!upload.ref.startsWith(`sessions/${this.options.state.remoteSessionId}/avatar/`))
                throw new Error("WorPar returned a picture reference for another session.");
            const url = new URL(upload.uploadUrl);
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
                throw new Error("WorPar returned an invalid picture upload URL.");
            const sameServer = url.origin === new URL(this.options.configuration.serverUrl).origin;
            let body: RequestInit["body"];
            if (upload.method === "POST") {
                if (upload.formFields === undefined)
                    throw new Error("WorPar omitted the picture upload form.");
                const form = new FormData();
                for (const [name, value] of Object.entries(upload.formFields))
                    form.append(name, value);
                form.append(
                    "file",
                    new Blob([bytes], { type: "application/octet-stream" }),
                    "avatar.enc",
                );
                body = form;
            } else {
                body = bytes;
            }
            const uploaded = await (this.options.fetch ?? fetch)(url.toString(), {
                method: upload.method,
                body,
                headers: {
                    ...(sameServer ? this.#authHeaders() : {}),
                    ...(upload.method === "PUT"
                        ? { "Content-Type": "application/octet-stream" }
                        : {}),
                },
                redirect: "error",
                signal: this.#signal(),
            });
            if (!uploaded.ok)
                throw new Error(`WorPar picture upload failed (${uploaded.status}).`);
            this.#pending = {
                hash: asset.contentHash,
                ref: upload.ref,
                // The hash stays encrypted. It avoids re-uploading unchanged pictures after restart.
                preview: Buffer.from(
                    encryptKissopenPayload(key, variant, {
                        mimeType: "image/webp",
                        thumbhash: asset.thumbhash,
                        contentHash: asset.contentHash,
                    }),
                ).toString("base64"),
            };
        }
        await this.#activate(base, "PATCH", {
            ref: this.#pending.ref,
            preview: this.#pending.preview,
        });
        this.#pending = undefined;
    }

    async #activate(url: string, method: string, body?: Record<string, unknown>): Promise<void> {
        const response = await this.#request(url, method, body);
        const value: unknown = await response.json();
        if (!Value.Check(resultSchema, value))
            throw new Error("WorPar returned an invalid session picture response.");
        this.#remote = value.avatar;
    }

    #authHeaders(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.options.configuration.credentials.token}`,
            "X-KISSOPEN-Client": `rig/${this.options.version}`,
        };
    }

    #signal(): AbortSignal {
        return AbortSignal.any([this.options.signal, AbortSignal.timeout(15_000)]);
    }

    async #request(url: string, method: string, body?: Record<string, unknown>): Promise<Response> {
        const response = await (this.options.fetch ?? fetch)(url, {
            method,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: { ...this.#authHeaders(), "Content-Type": "application/json" },
            redirect: "error",
            signal: this.#signal(),
        });
        if (!response.ok)
            throw new Error(`WorPar session picture request failed (${response.status}).`);
        return response;
    }
}
