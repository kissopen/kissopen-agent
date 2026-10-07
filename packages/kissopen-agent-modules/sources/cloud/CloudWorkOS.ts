import {
    cloudEnvironmentSchema,
    cloudOrganizationSchema,
    createCloudOrganizationRequestSchema,
    type CloudEnvironment,
    type CloudOrganization,
} from "@kissopen/kissopen-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
    AuthenticationException,
    BadRequestException,
    ConflictException,
    GenericServerException,
    NotFoundException,
    OauthException,
    UnauthorizedException,
    UnprocessableEntityException,
    WorkOS,
    type PublicWorkOS,
    type WorkOSOptions,
} from "@workos-inc/node";

import {
    kissopenTeamEndpointInputSchema,
    kissopenTeamEndpointSchema,
    kissopenTeamSchema,
    normalizeKissopenTeamEndpoint,
    type KissopenTeam,
} from "./KissopenTeam.js";
import {
    kissopenTeamInvitationOrganizationIdSchema,
    kissopenTeamInvitationSchema,
    normalizeKissopenTeamInvitationEmail,
    type KissopenTeamInvitation,
} from "./KissopenTeamInvitation.js";

const WORKOS_TIMEOUT_MS = 15_000;
const MAX_WORKOS_RESPONSE_BYTES = 1024 * 1_024;
const CLOUD_REQUEST_TIMEOUT_MS = 15_000;
const MAX_CLOUD_RESPONSE_BYTES = 8 * 1_024;
const MAX_CLOUD_ORGANIZATIONS_RESPONSE_BYTES = 1 * 1_024 * 1_024;
const MAX_CLOUD_ORGANIZATIONS = 10_000;
const exact = { additionalProperties: false } as const;

/**
 * The environment variables naming each Cloud deployment. KissOpen operates no hosted Cloud, so
 * nothing is built in: a deployment exists only when both of its variables are set.
 */
export const CLOUD_DEPLOYMENT_VARIABLES = {
    production: {
        cloudUrl: "KISSOPEN_CLOUD_URL",
        workosClientId: "KISSOPEN_CLOUD_WORKOS_CLIENT_ID",
    },
    staging: {
        cloudUrl: "KISSOPEN_CLOUD_STAGING_URL",
        workosClientId: "KISSOPEN_CLOUD_STAGING_WORKOS_CLIENT_ID",
    },
} as const satisfies Record<
    CloudEnvironment,
    { readonly cloudUrl: string; readonly workosClientId: string }
>;

const cloudDeploymentSchema = Type.Object(
    {
        cloudUrl: Type.String({ maxLength: 2_048, minLength: 9, pattern: "^https://[^\\s/]+$" }),
        workosClientId: Type.String({
            maxLength: 160,
            minLength: 8,
            pattern: "^client_[A-Za-z0-9]+$",
        }),
    },
    exact,
);

/** The requested Cloud deployment has no configured origin and WorkOS client. */
export class CloudNotConfiguredError extends Error {}

function cloudDeployment(
    environment: CloudEnvironment,
    variables: NodeJS.ProcessEnv,
): Static<typeof cloudDeploymentSchema> {
    const names = CLOUD_DEPLOYMENT_VARIABLES[environment];
    const deployment = {
        cloudUrl: variables[names.cloudUrl]?.trim().replace(/\/+$/u, ""),
        workosClientId: variables[names.workosClientId]?.trim(),
    };
    if (!Value.Check(cloudDeploymentSchema, deployment)) {
        throw new CloudNotConfiguredError(
            `KissOpen Cloud is not configured. Set ${names.cloudUrl} to an HTTPS origin and ${names.workosClientId} to its WorkOS client ID to use Cloud sign-in.`,
        );
    }
    return deployment;
}

const workosAuthenticationSchema = Type.Object(
    {
        accessToken: Type.String({ minLength: 1, maxLength: 32_768 }),
        refreshToken: Type.String({ minLength: 1, maxLength: 32_768 }),
        user: Type.Object(
            {
                email: Type.String({ minLength: 1, maxLength: 320 }),
                firstName: Type.Union([Type.Null(), Type.String({ maxLength: 512 })]),
                id: Type.String({ minLength: 1, maxLength: 256 }),
                lastName: Type.Union([Type.Null(), Type.String({ maxLength: 512 })]),
            },
            { additionalProperties: true },
        ),
    },
    { additionalProperties: true },
);

const authorizationSchema = Type.Object(
    {
        codeVerifier: Type.String({ minLength: 43, maxLength: 256 }),
        state: Type.String({ minLength: 16, maxLength: 512 }),
        url: Type.String({ minLength: 1, maxLength: 16_384 }),
    },
    { additionalProperties: false },
);

const helloSchema = Type.Object(
    {
        message: Type.Literal("hello"),
        userId: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: true },
);

const cloudOrganizationsResponseSchema = Type.Object(
    {
        organizations: Type.Array(cloudOrganizationSchema, {
            maxItems: MAX_CLOUD_ORGANIZATIONS,
        }),
    },
    exact,
);
const remoteKissopenTeamSchema = Type.Object(
    {
        endpoint: kissopenTeamSchema.properties.endpoint,
        id: kissopenTeamSchema.properties.id,
        name: kissopenTeamSchema.properties.name,
    },
    { additionalProperties: true },
);
const kissopenTeamsResponseSchema = Type.Object(
    {
        organizations: Type.Array(remoteKissopenTeamSchema, {
            maxItems: MAX_CLOUD_ORGANIZATIONS,
        }),
    },
    exact,
);
const invalidOrganizationSchema = Type.Object(
    { error: Type.Literal("invalid_organization") },
    exact,
);
const organizationForbiddenSchema = Type.Object({ error: Type.Literal("forbidden") }, exact);
const invalidOrganizationEndpointSchema = Type.Object(
    { error: Type.Literal("invalid_endpoint") },
    exact,
);
const organizationEndpointResponseSchema = Type.Object(
    { endpoint: kissopenTeamEndpointSchema },
    exact,
);
const organizationNotFoundSchema = Type.Object({ error: Type.Literal("not_found") }, exact);
const organizationDeletedSchema = Type.Object({ status: Type.Literal("deleted") }, exact);
const invitationResponseSchema = Type.Object({ invitation: kissopenTeamInvitationSchema }, exact);
const invitationConflictSchema = Type.Object(
    { error: Type.Union([Type.Literal("already_member"), Type.Literal("pending_invitation")]) },
    exact,
);

export class CloudInvitationConflictError extends Error {
    constructor(readonly reason: Static<typeof invitationConflictSchema>["error"]) {
        super("The recipient already has membership or a pending invitation.");
        this.name = "CloudInvitationConflictError";
    }
}

const workOSParseErrorSchema = Type.Object(
    {
        name: Type.Literal("ParseError"),
        rawStatus: Type.Integer({ minimum: 100, maximum: 599 }),
    },
    { additionalProperties: true },
);

export type CloudAuthorizationSecret = Static<typeof authorizationSchema>;
export type CloudAuthentication = Static<typeof workosAuthenticationSchema>;

export class CloudCredentialsRejectedError extends Error {
    constructor() {
        super("WorkOS rejected the Cloud credentials.");
        this.name = "CloudCredentialsRejectedError";
    }
}

/** Kissopen Cloud accepted the token but associated it with a different WorkOS user. */
export class CloudIdentityMismatchError extends Error {
    constructor() {
        super("KissOpen Cloud returned a different authenticated user.");
        this.name = "CloudIdentityMismatchError";
    }
}

export class CloudOrganizationInvalidRequestError extends Error {
    constructor() {
        super("KissOpen Cloud rejected the organization request.");
        this.name = "CloudOrganizationInvalidRequestError";
    }
}

export class CloudOrganizationInvalidEndpointError extends Error {
    constructor() {
        super("KissOpen Cloud rejected the organization endpoint.");
        this.name = "CloudOrganizationInvalidEndpointError";
    }
}

export class CloudOrganizationForbiddenError extends Error {
    constructor() {
        super("KissOpen Cloud rejected the organization operation.");
        this.name = "CloudOrganizationForbiddenError";
    }
}

export type CloudServiceUnavailableReason =
    | "request-failed"
    | "request-timed-out"
    | "response-invalid"
    | "response-rejected";

export class CloudServiceUnavailableError extends Error {
    readonly reason: CloudServiceUnavailableReason;
    readonly status: number | undefined;

    constructor(reason: CloudServiceUnavailableReason = "response-invalid", status?: number) {
        super("Cloud authentication is temporarily unavailable.");
        this.name = "CloudServiceUnavailableError";
        this.reason = reason;
        this.status = status;
    }
}

/**
 * WorkOS's public-client factory currently constructs its environment-aware base class directly,
 * which both ignores `fetchFn` and may inherit `WORKOS_API_KEY`. The Node subclass has the bounded
 * fetch seam we need; clear the base constructor's ambient key before it builds that transport so
 * authentication remains PKCE-only even in a process that happens to export server credentials.
 */
class PublicCloudWorkOSClient extends WorkOS {
    override createHttpClient(options: WorkOSOptions, userAgent: string) {
        Object.defineProperty(this, "key", { configurable: true, value: undefined });
        return super.createHttpClient(options, userAgent);
    }
}

/** The bounded WorkOS public client and Kissopen Cloud verification boundary. */
export class CloudWorkOS {
    readonly #cloudUrl: string;
    readonly #workos: Pick<PublicWorkOS, "userManagement">;
    readonly workosClientId: string;

    constructor(environment: CloudEnvironment, variables: NodeJS.ProcessEnv = process.env) {
        if (!Value.Check(cloudEnvironmentSchema, environment)) {
            throw new Error("The Cloud environment is invalid.");
        }
        const deployment = cloudDeployment(environment, variables);
        this.#cloudUrl = deployment.cloudUrl;
        this.workosClientId = deployment.workosClientId;
        this.#workos = new PublicCloudWorkOSClient({
            clientId: this.workosClientId,
            fetchFn: boundedWorkOSFetch,
            maxRetries: 0,
            timeout: WORKOS_TIMEOUT_MS,
        });
    }

    async authorization(redirectUri: string): Promise<CloudAuthorizationSecret> {
        try {
            const authorization = await this.#workos.userManagement.getAuthorizationUrlWithPKCE({
                provider: "authkit",
                redirectUri,
            });
            if (!Value.Check(authorizationSchema, authorization)) {
                throw new CloudServiceUnavailableError();
            }
            return structuredClone(authorization) as CloudAuthorizationSecret;
        } catch (error: unknown) {
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw workOSUnavailable(error);
        }
    }

    async exchange(code: string, codeVerifier: string): Promise<CloudAuthentication> {
        try {
            return authentication(
                await this.#workos.userManagement.authenticateWithCode({ code, codeVerifier }),
            );
        } catch (error: unknown) {
            if (isTerminalCodeRejection(error)) throw new CloudCredentialsRejectedError();
            if (error instanceof CloudCredentialsRejectedError) throw error;
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw workOSUnavailable(error);
        }
    }

    async refresh(refreshToken: string, organizationId?: string): Promise<CloudAuthentication> {
        try {
            return authentication(
                await this.#workos.userManagement.authenticateWithRefreshToken({
                    refreshToken,
                    ...(organizationId === undefined ? {} : { organizationId }),
                }),
            );
        } catch (error: unknown) {
            if (error instanceof OauthException && error.error === "invalid_grant") {
                throw new CloudCredentialsRejectedError();
            }
            if (error instanceof CloudCredentialsRejectedError) throw error;
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw workOSUnavailable(error);
        }
    }

    /** Verifies the minted token against Kissopen Cloud without treating its 401 as revocation. */
    async verify(accessToken: string, expectedUserId: string): Promise<void> {
        const result = await this.#request("/v0/hello", accessToken, "GET");
        if (result.status < 200 || result.status >= 300) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(helloSchema, result.body)) throw new CloudServiceUnavailableError();
        if (result.body.userId !== expectedUserId) throw new CloudIdentityMismatchError();
    }

    async listOrganizations(accessToken: string): Promise<CloudOrganization[]> {
        const result = await this.#request(
            "/v0/organizations",
            accessToken,
            "GET",
            undefined,
            [],
            MAX_CLOUD_ORGANIZATIONS_RESPONSE_BYTES,
        );
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(cloudOrganizationsResponseSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
        return result.body.organizations.map(cloudOrganization);
    }

    async listTeams(accessToken: string): Promise<KissopenTeam[]> {
        const result = await this.#request(
            "/v0/organizations",
            accessToken,
            "GET",
            undefined,
            [],
            MAX_CLOUD_ORGANIZATIONS_RESPONSE_BYTES,
        );
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(kissopenTeamsResponseSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
        return result.body.organizations.map(projectKissopenTeam);
    }

    async createOrganization(accessToken: string, name: string): Promise<CloudOrganization> {
        if (!Value.Check(createCloudOrganizationRequestSchema.properties.name, name)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        const result = await this.#request(
            "/v0/organizations",
            accessToken,
            "POST",
            { name },
            [400],
        );
        if (result.status === 400 && Value.Check(invalidOrganizationSchema, result.body)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return cloudOrganization(result.body);
    }

    async createTeam(accessToken: string, name: string): Promise<KissopenTeam> {
        if (!Value.Check(createCloudOrganizationRequestSchema.properties.name, name)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        const result = await this.#request(
            "/v0/organizations",
            accessToken,
            "POST",
            { name },
            [400],
        );
        if (result.status === 400 && Value.Check(invalidOrganizationSchema, result.body)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        if (!result.ok || !Value.Check(remoteKissopenTeamSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        return projectKissopenTeam(result.body);
    }

    async setTeamEndpoint(
        accessToken: string,
        organizationId: string,
        endpoint: string,
    ): Promise<string> {
        const normalizedEndpoint = normalizeKissopenTeamEndpoint(endpoint);
        if (
            !Value.Check(cloudOrganizationSchema.properties.id, organizationId) ||
            !Value.Check(kissopenTeamEndpointInputSchema, endpoint) ||
            normalizedEndpoint === undefined
        ) {
            throw new CloudOrganizationInvalidEndpointError();
        }
        const result = await this.#request(
            `/v0/organizations/${encodeURIComponent(organizationId)}/endpoint`,
            accessToken,
            "PUT",
            { endpoint: normalizedEndpoint },
            [400, 403],
        );
        if (result.status === 400 && Value.Check(invalidOrganizationEndpointSchema, result.body)) {
            throw new CloudOrganizationInvalidEndpointError();
        }
        if (result.status === 403 && Value.Check(organizationForbiddenSchema, result.body)) {
            throw new CloudOrganizationForbiddenError();
        }
        if (!result.ok || !Value.Check(organizationEndpointResponseSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
        const returnedEndpoint = normalizeKissopenTeamEndpoint(result.body.endpoint);
        if (returnedEndpoint === undefined || returnedEndpoint !== normalizedEndpoint) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
        return returnedEndpoint;
    }

    async deleteOrganization(accessToken: string, organizationId: string): Promise<void> {
        if (!Value.Check(cloudOrganizationSchema.properties.id, organizationId)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        const result = await this.#request(
            `/v0/organizations/${encodeURIComponent(organizationId)}`,
            accessToken,
            "DELETE",
            undefined,
            [403, 404],
        );
        if (result.status === 403 && Value.Check(organizationForbiddenSchema, result.body)) {
            throw new CloudOrganizationForbiddenError();
        }
        if (result.status === 404 && Value.Check(organizationNotFoundSchema, result.body)) {
            throw new CloudOrganizationInvalidRequestError();
        }
        if (!result.ok) {
            throw new CloudServiceUnavailableError("response-rejected", result.status);
        }
        if (!Value.Check(organizationDeletedSchema, result.body)) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
    }

    async inviteTeamMember(
        accessToken: string,
        organizationId: string,
        email: string,
    ): Promise<KissopenTeamInvitation> {
        const normalizedEmail = normalizeKissopenTeamInvitationEmail(email);
        if (
            !Value.Check(kissopenTeamInvitationOrganizationIdSchema, organizationId) ||
            normalizedEmail === undefined
        ) {
            throw new CloudOrganizationInvalidRequestError();
        }
        const result = await this.#request(
            `/v0/organizations/${encodeURIComponent(organizationId)}/invitations`,
            accessToken,
            "POST",
            { email: normalizedEmail },
            [400, 403, 409],
        );
        if (result.status === 400) throw new CloudOrganizationInvalidRequestError();
        if (result.status === 403) throw new CloudOrganizationForbiddenError();
        if (result.status === 409 && Value.Check(invitationConflictSchema, result.body)) {
            throw new CloudInvitationConflictError(result.body.error);
        }
        if (
            result.status !== 201 ||
            !Value.Check(invitationResponseSchema, result.body) ||
            result.body.invitation.email !== normalizedEmail
        ) {
            throw new CloudServiceUnavailableError("response-invalid", result.status);
        }
        return structuredClone(result.body.invitation);
    }

    async #request(
        path: string,
        accessToken: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        body?: Readonly<Record<string, string>>,
        parsedErrorStatuses: readonly number[] = [],
        maximum = MAX_CLOUD_RESPONSE_BYTES,
    ): Promise<{ readonly body: unknown; readonly ok: boolean; readonly status: number }> {
        const { response, signal } = await this.#fetchResponse(
            path,
            accessToken,
            method,
            body === undefined ? undefined : JSON.stringify(body),
            body === undefined ? undefined : { "content-type": "application/json" },
        );
        if (!response.ok && !parsedErrorStatuses.includes(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            return { body: undefined, ok: response.ok, status: response.status };
        }
        if (response.status === 204) {
            await response.body?.cancel().catch(() => undefined);
            return { body: undefined, ok: response.ok, status: response.status };
        }
        try {
            const bytes = await readBounded(response, maximum, signal);
            return {
                body: JSON.parse(new TextDecoder().decode(bytes)) as unknown,
                ok: response.ok,
                status: response.status,
            };
        } catch (error: unknown) {
            if (signal.aborted) throw new CloudServiceUnavailableError("request-timed-out");
            if (error instanceof CloudServiceUnavailableError) throw error;
            throw new CloudServiceUnavailableError("response-invalid", response.status);
        }
    }

    async #fetchResponse(
        path: string,
        accessToken: string,
        method: "DELETE" | "GET" | "POST" | "PUT",
        body?: RequestInit["body"],
        extraHeaders?: RequestInit["headers"],
    ): Promise<{ readonly response: Response; readonly signal: AbortSignal }> {
        const signal = AbortSignal.timeout(CLOUD_REQUEST_TIMEOUT_MS);
        const headers = new Headers(extraHeaders);
        headers.set("authorization", `Bearer ${accessToken}`);
        try {
            const response = await fetch(`${this.#cloudUrl}${path}`, {
                ...(body === undefined ? {} : { body }),
                headers,
                method,
                signal,
            });
            return { response, signal };
        } catch {
            throw new CloudServiceUnavailableError(
                signal.aborted ? "request-timed-out" : "request-failed",
            );
        }
    }
}

function cloudOrganization(value: unknown): CloudOrganization {
    if (!Value.Check(cloudOrganizationSchema, value)) {
        throw new CloudServiceUnavailableError();
    }
    return { id: value.id, name: value.name };
}

function projectKissopenTeam(value: Static<typeof remoteKissopenTeamSchema>): KissopenTeam {
    const endpoint = value.endpoint === null ? null : normalizeKissopenTeamEndpoint(value.endpoint);
    if (endpoint === undefined || endpoint !== value.endpoint) {
        throw new CloudServiceUnavailableError();
    }
    return { endpoint, id: value.id, name: value.name };
}

function authentication(value: unknown): CloudAuthentication {
    if (!Value.Check(workosAuthenticationSchema, value)) {
        throw new CloudServiceUnavailableError();
    }
    return {
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        user: {
            email: value.user.email,
            firstName: value.user.firstName,
            id: value.user.id,
            lastName: value.user.lastName,
        },
    };
}

function isTerminalCodeRejection(error: unknown): boolean {
    return (
        error instanceof OauthException &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429 &&
        (error.error === "access_denied" || error.error === "invalid_grant")
    );
}

function workOSUnavailable(error: unknown): CloudServiceUnavailableError {
    const preserved = cloudUnavailableCause(error);
    if (preserved !== undefined) return preserved;
    const status = workOSResponseStatus(error);
    if (status === 408) return new CloudServiceUnavailableError("request-timed-out");
    if (status !== undefined) {
        return new CloudServiceUnavailableError("response-rejected", status);
    }
    return new CloudServiceUnavailableError("request-failed");
}

function cloudUnavailableCause(error: unknown): CloudServiceUnavailableError | undefined {
    let current = error;
    for (let depth = 0; depth < 4; depth += 1) {
        if (current instanceof CloudServiceUnavailableError) return current;
        if (!(current instanceof Error)) return undefined;
        if (Value.Check(workOSParseErrorSchema, current)) {
            const parsed = current as Static<typeof workOSParseErrorSchema>;
            return new CloudServiceUnavailableError("response-invalid", parsed.rawStatus);
        }
        current = current.cause;
    }
    return undefined;
}

function workOSResponseStatus(error: unknown): number | undefined {
    const status =
        error instanceof AuthenticationException ||
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof GenericServerException ||
        error instanceof NotFoundException ||
        error instanceof OauthException ||
        error instanceof UnauthorizedException ||
        error instanceof UnprocessableEntityException
            ? error.status
            : undefined;
    return status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
}

/** Internal WorkOS transport exported only for direct boundary tests. */
export const boundedWorkOSFetch: typeof fetch = async (input, init) => {
    const deadline = AbortSignal.timeout(WORKOS_TIMEOUT_MS);
    const signal =
        init?.signal === null || init?.signal === undefined
            ? deadline
            : AbortSignal.any([deadline, init.signal]);
    try {
        const response = await fetch(input, { ...init, signal });
        const body =
            response.body === null
                ? null
                : await readBounded(response, MAX_WORKOS_RESPONSE_BYTES, signal);
        return new Response(body, {
            headers: response.headers,
            status: response.status,
            statusText: response.statusText,
        });
    } catch (error: unknown) {
        if (signal.aborted) {
            throw new CloudServiceUnavailableError("request-timed-out");
        }
        throw error;
    }
};

async function readBounded(
    response: Response,
    maximum: number,
    signal?: AbortSignal,
): Promise<Uint8Array> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maximum) {
        await response.body?.cancel().catch(() => undefined);
        throw new CloudServiceUnavailableError();
    }
    if (response.body === null) throw new CloudServiceUnavailableError();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const cancelOnAbort = () => {
        void reader.cancel().catch(() => undefined);
    };
    signal?.addEventListener("abort", cancelOnAbort, { once: true });
    try {
        while (true) {
            if (isAborted(signal)) throw new CloudServiceUnavailableError();
            const result = await reader.read();
            if (isAborted(signal)) throw new CloudServiceUnavailableError();
            if (result.done) break;
            total += result.value.byteLength;
            if (total > maximum) throw new CloudServiceUnavailableError();
            chunks.push(result.value);
        }
    } catch (error: unknown) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        signal?.removeEventListener("abort", cancelOnAbort);
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function isAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}
