import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type } from "@sinclair/typebox";

import type { KissopenTeamsModule } from "../KissopenTeamsModule.js";

export const mintKissopenWorkOSTokenInputSchema = Type.Object(
    {
        team_id: Type.String({ minLength: 5, maxLength: 160, pattern: "^org_[A-Za-z0-9]+$" }),
    },
    { additionalProperties: false },
);
export const mintKissopenWorkOSTokenResultSchema = Type.Object(
    {
        access_token: Type.String({ minLength: 1, maxLength: 32_768 }),
        expires_at: Type.Integer({
            minimum: 0,
            description: "Actual token expiry as Unix milliseconds.",
        }),
        team_id: mintKissopenWorkOSTokenInputSchema.properties.team_id,
    },
    { additionalProperties: false },
);

export function mintKissopenWorkOSTokenTool(module: KissopenTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "mint_kissopen_workos_token",
        defer: true,
        capabilities: ["List and manage WorPar teams."],
        searchKeywords: [
            "WorkOS authentication",
            "short-lived token",
            "connect to team node",
            "bearer token",
        ],
        description:
            "Mint a WorkOS bearer token for direct requests to a WorPar Agent team node. Only an active admin bot may call this tool. Requires team_id (the WorkOS organization ID). The token acts as the connected WorPar Cloud user in that organization, not as a separate bot identity, and expires within five minutes. WorkOS must have Access token duration set to five minutes or less; longer-lived tokens are withheld. Use Authorization: Bearer <access_token> only with the intended trusted node. This is a sensitive credential: do not echo it to the user, write it to files, or send it to unrelated endpoints. No refresh token is returned. Token expiry prevents new authenticated requests; it does not undo work already started.",
        parameters: mintKissopenWorkOSTokenInputSchema,
        returnType: mintKissopenWorkOSTokenResultSchema,
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ team_id }) =>
            `minting and exposing a bearer credential for team ${team_id}, valid for at most five minutes, to this admin bot. It carries the connected user's organization permissions. Access: external WorkOS authentication and WorPar Cloud verification; the credential will appear in the tool result`,
        execute: async (ctx, { team_id }) => {
            const token = await module.mintWorkOSToken(ctx, actingAgentId, team_id);
            return { access_token: token.accessToken, expires_at: token.expiresAt, team_id };
        },
        toLLM: ({ access_token, expires_at, team_id }) => [
            {
                type: "text",
                text: JSON.stringify({ access_token, expires_at, team_id }),
            },
        ],
    });
}
