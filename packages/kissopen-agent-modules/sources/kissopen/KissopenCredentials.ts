import { Type, type Static } from "@sinclair/typebox";

/**
 * Which envelope Kissopen uses for this account.
 *
 * `legacy` accounts encrypt every payload directly with the account secret.
 * `dataKey` accounts encrypt with a per-scope AES key that is wrapped to the
 * account public key, so the account secret never leaves the phone.
 */
export const kissopenEncryptionVariantSchema = Type.Union([
    Type.Literal("dataKey"),
    Type.Literal("legacy"),
]);
export type KissopenEncryptionVariant = Static<typeof kissopenEncryptionVariantSchema>;

/** The `access.key` file as Kissopen writes it. Unknown fields are preserved by Kissopen and ignored here. */
export const kissopenCredentialsFileSchema = Type.Object({
    encryption: Type.Optional(
        Type.Object({
            machineKey: Type.String({ minLength: 1 }),
            publicKey: Type.String({ minLength: 1 }),
        }),
    ),
    secret: Type.Optional(Type.String({ minLength: 1 })),
    token: Type.String({ minLength: 1 }),
});
export type KissopenCredentialsFile = Static<typeof kissopenCredentialsFileSchema>;

/** The credentials exactly as they are stored back to disk, with keys still base64. */
export const storedKissopenCredentialsSchema = Type.Object({
    encryption: Type.Optional(
        Type.Object({
            machineKey: Type.String({ minLength: 1 }),
            publicKey: Type.String({ minLength: 1 }),
        }),
    ),
    secret: Type.Optional(Type.String({ minLength: 1 })),
    token: Type.String({ minLength: 1 }),
});
export type StoredKissopenCredentials = Static<typeof storedKissopenCredentialsSchema>;

/** The credentials in the form the clients use, with keys decoded to raw bytes. */
export type KissopenCredentials =
    | {
          encryption: { secret: Uint8Array; type: "legacy" };
          token: string;
      }
    | {
          encryption: { machineKey: Uint8Array; publicKey: Uint8Array; type: "dataKey" };
          token: string;
      };

/** Everything the Kissopen clients need to reach the account this machine is signed in to. */
export interface KissopenConnectionConfiguration {
    /** Standalone-only external CLI home; absent for isolated team connections. */
    cliHome?: string;
    /** Canonical SHA-256 identity of the stored credentials, safe to compare and persist. */
    credentialFingerprint: string;
    credentials: KissopenCredentials;
    credentialsPath: string;
    /** The directory holding this agent's copy of the Kissopen credentials, settings and machine identity. */
    kissopenHome: string;
    /** Whether the credentials were just copied in from a Kissopen CLI installation. */
    imported: boolean;
    machineId?: string;
    serverUrl: string;
}
