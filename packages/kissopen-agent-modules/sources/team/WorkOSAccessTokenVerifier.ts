import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { Value } from "@sinclair/typebox/value";

import { workOSUserIdSchema } from "./TeamUser.js";

export interface WorkOSAccessTokenVerifierOptions {
    readonly clientId: string;
    readonly issuer?: string;
    readonly jwks?: JWTVerifyGetKey;
    readonly organizationId: string;
}

export interface WorkOSIdentity {
    readonly organizationId: string;
    readonly userId: string;
}

/** Verify a WorkOS access token locally, returning its user and organization identity. */
export class WorkOSAccessTokenVerifier {
    readonly #clientId: string;
    readonly #issuer: string;
    readonly #jwks: JWTVerifyGetKey;
    readonly #organizationId: string;

    constructor(options: WorkOSAccessTokenVerifierOptions) {
        this.#clientId = options.clientId;
        this.#issuer =
            options.issuer ??
            `https://api.workos.com/user_management/${encodeURIComponent(this.#clientId)}`;
        this.#jwks =
            options.jwks ??
            createRemoteJWKSet(
                new URL(`https://api.workos.com/sso/jwks/${encodeURIComponent(this.#clientId)}`),
            );
        this.#organizationId = options.organizationId;
    }

    async verify(accessToken: string): Promise<WorkOSIdentity> {
        const { payload } = await jwtVerify(accessToken, this.#jwks, {
            algorithms: ["RS256"],
            issuer: this.#issuer,
            requiredClaims: ["exp", "iat", "sub", "client_id", "sid", "org_id"],
        });
        if (
            payload.client_id !== this.#clientId ||
            payload.org_id !== this.#organizationId ||
            !Value.Check(workOSUserIdSchema, payload.sub) ||
            typeof payload.sid !== "string"
        ) {
            throw new Error("The WorkOS access token claims are invalid.");
        }
        return { organizationId: this.#organizationId, userId: payload.sub };
    }
}
