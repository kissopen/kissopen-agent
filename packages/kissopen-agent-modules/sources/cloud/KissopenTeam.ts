import { cloudOrganizationSchema } from "@kissopen/kissopen-agent-client";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const KISSOPEN_TEAM_ENDPOINT_MAX_INPUT_CHARACTERS = 2_048;
const KISSOPEN_TEAM_ENDPOINT_MAX_CHARACTERS = 600;
const allowedKissopenTeamEndpointProtocols = new Set(["http:", "https:", "tailcat:", "ws:", "wss:"]);

export const kissopenTeamEndpointSchema = Type.String({
    minLength: 1,
    maxLength: KISSOPEN_TEAM_ENDPOINT_MAX_CHARACTERS,
    pattern: "^(?:http|https|tailcat|ws|wss)://[\\x20-\\x7e]+$",
});

/** One Kissopen Cloud WorkOS organization and the Kissopen Agent server it advertises. */
export const kissopenTeamSchema = Type.Object(
    {
        endpoint: Type.Union([Type.Null(), kissopenTeamEndpointSchema]),
        id: cloudOrganizationSchema.properties.id,
        name: cloudOrganizationSchema.properties.name,
    },
    { additionalProperties: false },
);
export type KissopenTeam = Static<typeof kissopenTeamSchema>;

export const kissopenTeamEndpointInputSchema = Type.String({
    minLength: 1,
    maxLength: KISSOPEN_TEAM_ENDPOINT_MAX_INPUT_CHARACTERS,
    pattern: "^[\\x20-\\x7e]+$",
});

/** Normalize exactly the URL forms Kissopen Cloud accepts for an organization endpoint. */
export function normalizeKissopenTeamEndpoint(value: string): string | undefined {
    if (!Value.Check(kissopenTeamEndpointInputSchema, value)) return undefined;
    try {
        const url = new URL(value);
        if (
            !allowedKissopenTeamEndpointProtocols.has(url.protocol) ||
            url.hostname.length === 0 ||
            url.username.length !== 0 ||
            url.password.length !== 0 ||
            url.hash.length !== 0 ||
            url.href.length > KISSOPEN_TEAM_ENDPOINT_MAX_CHARACTERS ||
            !Value.Check(kissopenTeamEndpointSchema, url.href)
        ) {
            return undefined;
        }
        return url.href;
    } catch {
        return undefined;
    }
}
