import { createHash } from "node:crypto";

import type { StoredKissopenCredentials } from "../KissopenCredentials.js";

/**
 * Computes a stable, non-secret identity for one parsed Kissopen credential.
 *
 * The parsed stored shape contains exactly one encryption form. Rebuilding that
 * shape explicitly keeps the digest independent of source key order and fields
 * Kissopen Agent does not understand.
 */
export function createKissopenCredentialFingerprint(credentials: StoredKissopenCredentials): string {
    if ((credentials.secret === undefined) === (credentials.encryption === undefined)) {
        throw new Error("A WorPar credential fingerprint needs exactly one encryption format.");
    }
    const canonical =
        credentials.secret !== undefined
            ? JSON.stringify({
                  encryption: "legacy",
                  secret: credentials.secret,
                  token: credentials.token,
              })
            : JSON.stringify({
                  encryption: "dataKey",
                  machineKey: credentials.encryption!.machineKey,
                  publicKey: credentials.encryption!.publicKey,
                  token: credentials.token,
              });
    return createHash("sha256").update(canonical).digest("hex");
}
