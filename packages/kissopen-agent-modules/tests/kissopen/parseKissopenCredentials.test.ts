import { describe, expect, it } from "vitest";

import { parseKissopenCredentials } from "../../sources/kissopen/credentials/parseKissopenCredentials.js";

const machineKey = Buffer.alloc(32, 1).toString("base64");
const publicKey = Buffer.alloc(32, 2).toString("base64");
const secret = Buffer.alloc(32, 3).toString("base64");

describe("parseKissopenCredentials", () => {
    it("reads a data-key account and keeps the stored form untouched", () => {
        const parsed = parseKissopenCredentials({
            encryption: { machineKey, publicKey },
            token: "kissopen-token",
        });

        expect(parsed.credentials).toEqual({
            encryption: {
                machineKey: new Uint8Array(32).fill(1),
                publicKey: new Uint8Array(32).fill(2),
                type: "dataKey",
            },
            token: "kissopen-token",
        });
        expect(parsed.stored).toEqual({
            encryption: { machineKey, publicKey },
            token: "kissopen-token",
        });
    });

    it("reads a legacy account secret", () => {
        const parsed = parseKissopenCredentials({ secret, token: "kissopen-token" });

        expect(parsed.credentials).toEqual({
            encryption: { secret: new Uint8Array(32).fill(3), type: "legacy" },
            token: "kissopen-token",
        });
        expect(parsed.stored).toEqual({ secret, token: "kissopen-token" });
    });

    it("ignores fields KISSOPEN added that KISSOPEN Agent does not use", () => {
        const parsed = parseKissopenCredentials({
            createdAt: 12,
            secret,
            token: "kissopen-token",
        });

        expect(parsed.stored).toEqual({ secret, token: "kissopen-token" });
    });

    it("rejects a file that claims both encryption formats", () => {
        expect(() =>
            parseKissopenCredentials({
                encryption: { machineKey, publicKey },
                secret,
                token: "kissopen-token",
            }),
        ).toThrow("exactly one encryption format");
    });

    it("rejects a file that claims neither encryption format", () => {
        expect(() => parseKissopenCredentials({ token: "kissopen-token" })).toThrow(
            "exactly one encryption format",
        );
    });

    it("rejects a key that is not 32 base64 bytes", () => {
        expect(() =>
            parseKissopenCredentials({ secret: Buffer.alloc(16, 3).toString("base64"), token: "t" }),
        ).toThrow("32-byte base64");
    });

    it("rejects a file with no token", () => {
        expect(() => parseKissopenCredentials({ secret })).toThrow("format WorPar Agent understands");
    });
});
