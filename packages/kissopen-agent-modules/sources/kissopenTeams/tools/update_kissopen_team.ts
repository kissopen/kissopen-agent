import { cloudOrganizationSchema } from "@kissopen/kissopen-agent-client";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { kissopenTeamEndpointInputSchema, kissopenTeamEndpointSchema } from "../../cloud/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { KissopenTeamsModule } from "../KissopenTeamsModule.js";

const updateKissopenTeamInputSchema = Type.Object(
    {
        endpoint: kissopenTeamEndpointInputSchema,
        team_id: cloudOrganizationSchema.properties.id,
    },
    { additionalProperties: false },
);
type UpdateKissopenTeamInput = Static<typeof updateKissopenTeamInputSchema>;

const updateKissopenTeamResultSchema = Type.Object(
    {
        endpoint: kissopenTeamEndpointSchema,
        team_id: cloudOrganizationSchema.properties.id,
    },
    { additionalProperties: false },
);

/** Update the mutable Kissopen metadata stored on one WorkOS organization. */
export function updateKissopenTeamTool(module: KissopenTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "update_kissopen_team",
        defer: true,
        capabilities: ["List and manage WorPar teams."],
        searchKeywords: ["change team", "team server URL", "organization endpoint"],
        description:
            "Update one WorPar team. For now, endpoint is the only mutable field and must be an absolute HTTP, HTTPS, Tailcat, WS, or WSS WorPar Agent server endpoint. WorPar Cloud permits the write only when the connected WorkOS user is an active administrator of that organization. Human-owned root agents and admin bots may call this tool; non-admin bots are refused.",
        parameters: updateKissopenTeamInputSchema,
        returnType: updateKissopenTeamResultSchema,
        // A remote metadata write may have committed before an interruption and is not replayed.
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ team_id, endpoint }: UpdateKissopenTeamInput) =>
            `updating WorPar team ${quoteVisibleExact(team_id)} endpoint to ${quoteVisibleExact(endpoint)}. Access: external WorPar Cloud API and WorkOS organization metadata write`,
        execute: async (ctx, { team_id, endpoint }: UpdateKissopenTeamInput) => ({
            endpoint: await module.update(ctx, actingAgentId, team_id, endpoint),
            team_id,
        }),
        toLLM: ({ team_id, endpoint }) => [
            {
                type: "text",
                text: `WorPar team ${team_id} now advertises ${endpoint}.`,
            },
        ],
    });
}

export { updateKissopenTeamInputSchema, updateKissopenTeamResultSchema };
