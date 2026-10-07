import { describe, expect, it } from "vitest";

import { createKissopenCredentialFingerprint } from "../../sources/kissopen/credentials/createKissopenCredentialFingerprint.js";
import { parseKissopenCredentials } from "../../sources/kissopen/credentials/parseKissopenCredentials.js";

const secret = Buffer.alloc(32, 3).toString("base64");

describe("createKissopenCredentialFingerprint", () => {
    it("is canonical for the parsed stored credential and exposes no credential material", () => {
        const first = parseKissopenCredentials({
            ignored: "first",
            secret,
            token: "kissopen-token",
        });
        const second = parseKissopenCredentials({
            token: "kissopen-token",
            secret,
            ignored: "second",
        });

        const fingerprint = createKissopenCredentialFingerprint(first.stored);
        expect(fingerprint).toBe(createKissopenCredentialFingerprint(second.stored));
        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/u);
        expect(fingerprint).not.toContain(secret);
        expect(fingerprint).not.toContain("kissopen-token");
    });

    it("changes when any credential-bearing field changes", () => {
        const first = parseKissopenCredentials({ secret, token: "first-token" });
        const second = parseKissopenCredentials({ secret, token: "second-token" });

        expect(createKissopenCredentialFingerprint(first.stored)).not.toBe(
            createKissopenCredentialFingerprint(second.stored),
        );
    });
});
