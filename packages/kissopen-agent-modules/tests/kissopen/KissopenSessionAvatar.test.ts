import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
    KissopenSessionAvatarClient,
    type KissopenSessionAvatar,
} from "../../sources/kissopen/KissopenSessionAvatar.js";
import { decryptKissopenBlob } from "../../sources/kissopen/crypto/decryptKissopenBlob.js";
import { decryptKissopenPayload } from "../../sources/kissopen/crypto/kissopenEncryption.js";
import type {
    KissopenConnectionConfiguration,
    KissopenEncryptionVariant,
} from "../../sources/kissopen/KissopenCredentials.js";
import type { KissopenSyncSession } from "../../sources/kissopen/KissopenSync.js";

const key = new Uint8Array(32).fill(7);
const bytes = new Uint8Array([82, 73, 70, 70]);
const asset = {
    bytes,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    etag: '"hash"',
    thumbhash: "hash",
    width: 1,
    height: 1,
};
const configuration: KissopenConnectionConfiguration = {
    credentialFingerprint: "fingerprint",
    credentials: { token: "private-token", encryption: { type: "legacy", secret: key } },
    credentialsPath: "/unused",
    kissopenHome: "/unused",
    imported: false,
    serverUrl: "https://kissopen.test",
};
function state(variant: KissopenEncryptionVariant): KissopenSyncSession & { remoteSessionId: string } {
    return {
        agentId: "a",
        sessionId: "s",
        remoteSessionId: "remote",
        encryptionKeyBase64: Buffer.from(key).toString("base64"),
        encryptionVariant: variant,
        credentialFingerprint: "fingerprint",
        createdAt: 0,
        updatedAt: 0,
        lastRemoteSeq: 0,
        historyBackfilled: true,
        projectionStatus: "active",
        tag: "tag",
    };
}

describe("encrypted bot pictures on KISSOPEN sessions", () => {
    it("clears an image whose activation response was lost, even after an uncertain removal", async () => {
        let remote: unknown = null;
        let deletes = 0;
        const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("request-upload"))
                return Response.json({
                    ref: "sessions/remote/avatar/a.enc",
                    method: "PUT",
                    uploadUrl: "https://kissopen.test/upload",
                });
            if (String(input).endsWith("/upload")) return Response.json({ ok: true });
            if (init?.method === "PATCH") {
                remote = JSON.parse(String(init.body));
                throw new Error("Activation response lost");
            }
            deletes++;
            if (deletes === 1) throw new Error("Removal was not delivered");
            remote = null;
            return Response.json({ avatar: null });
        });
        const client = new KissopenSessionAvatarClient({
            configuration,
            state: state("legacy"),
            remote: null,
            fetch: http as typeof fetch,
            signal: new AbortController().signal,
            version: "test",
        });
        await expect(client.sync(asset)).rejects.toThrow("Activation response lost");
        expect(remote).not.toBeNull();
        await expect(client.sync(null)).rejects.toThrow("Removal was not delivered");
        await client.sync(null);
        expect(remote).toBeNull();
        expect(deletes).toBe(2);
    });

    it.each(["legacy", "dataKey"] as const)(
        "publishes private images and previews using %s session encryption, then reuses them after restart",
        async (variant) => {
            let remote: KissopenSessionAvatar | null = null;
            let uploaded: Uint8Array | undefined;
            const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                if (url.endsWith("request-upload"))
                    return Response.json({
                        ref: "sessions/remote/avatar/a.enc",
                        method: "PUT",
                        uploadUrl: "https://kissopen.test/upload",
                    });
                if (url.endsWith("/upload")) {
                    uploaded = init?.body as Uint8Array;
                    return Response.json({ ok: true });
                }
                if (init?.method === "DELETE") {
                    remote = null;
                    return Response.json({ avatar: null });
                }
                remote = { ...JSON.parse(String(init?.body)), version: 1 };
                return Response.json({ avatar: remote });
            });
            const options = {
                configuration,
                state: state(variant),
                fetch: http as typeof fetch,
                signal: new AbortController().signal,
                version: "test",
            };
            const client = new KissopenSessionAvatarClient({ ...options, remote });
            await client.sync(asset);
            expect(
                decryptKissopenBlob({
                    bundle: uploaded!,
                    encryptionKey: key,
                    encryptionVariant: variant,
                }),
            ).toEqual(bytes);
            const picture = remote as unknown as KissopenSessionAvatar;
            expect(
                decryptKissopenPayload(key, variant, Buffer.from(picture.preview, "base64")),
            ).toEqual({
                mimeType: "image/webp",
                thumbhash: "hash",
                contentHash: asset.contentHash,
            });
            expect(JSON.stringify(picture)).not.toContain(asset.contentHash);
            expect(http).toHaveBeenCalledTimes(3);
            await client.sync(asset);
            const restarted = new KissopenSessionAvatarClient({ ...options, remote });
            await restarted.sync(asset);
            expect(http).toHaveBeenCalledTimes(3);
            await restarted.sync(undefined);
            expect(http).toHaveBeenCalledTimes(3);
            await restarted.sync(null);
            await restarted.sync(null);
            expect(http).toHaveBeenCalledTimes(4);
            expect(remote).toBeNull();
        },
    );

    it("keeps bearer credentials off external uploads and reuses an uploaded blob after uncertain activation", async () => {
        let patchCount = 0;
        const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
            if (String(input).endsWith("request-upload"))
                return Response.json({
                    ref: "sessions/remote/avatar/a.enc",
                    method: "POST",
                    uploadUrl: "https://files.test/upload",
                    formFields: { policy: "opaque" },
                });
            if (String(input).startsWith("https://files.test")) {
                expect(new Headers(init?.headers).has("Authorization")).toBe(false);
                expect(init?.body).toBeInstanceOf(FormData);
                return Response.json({ ok: true });
            }
            patchCount++;
            if (patchCount === 1) throw new Error("Response lost");
            return Response.json({ avatar: { ...JSON.parse(String(init?.body)), version: 1 } });
        });
        const client = new KissopenSessionAvatarClient({
            configuration,
            state: state("legacy"),
            remote: null,
            fetch: http as typeof fetch,
            signal: new AbortController().signal,
            version: "test",
        });
        await expect(client.sync(asset)).rejects.toThrow("Response lost");
        await client.sync(asset);
        expect(http).toHaveBeenCalledTimes(4);
        expect(
            http.mock.calls.filter(([url]) => String(url).endsWith("request-upload")),
        ).toHaveLength(1);
    });
});
