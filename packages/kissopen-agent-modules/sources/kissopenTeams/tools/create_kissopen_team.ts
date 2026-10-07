import { createCloudOrganizationRequestSchema } from "@kissopen/kissopen-agent-client";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { kissopenTeamEndpointInputSchema, kissopenTeamSchema } from "../../cloud/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { KissopenTeamsModule } from "../KissopenTeamsModule.js";

const createKissopenTeamInputSchema = Type.Object(
    {
        endpoint: kissopenTeamEndpointInputSchema,
        name: createCloudOrganizationRequestSchema.properties.name,
    },
    { additionalProperties: false },
);
type CreateKissopenTeamInput = Static<typeof createKissopenTeamInputSchema>;

/** Create one WorkOS organization and publish its Kissopen Agent endpoint. */
export function createKissopenTeamTool(module: KissopenTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "create_kissopen_team",
        defer: true,
        capabilities: ["List and manage WorPar teams."],
        searchKeywords: ["new team", "create organization", "WorPar Cloud team"],
        description:
            "Create one WorPar team as a WorkOS organization and publish its absolute HTTP, HTTPS, Tailcat, WS, or WSS WorPar Agent server endpoint. The endpoint is required. The connected WorPar Cloud user becomes its administrator. Human-owned root agents and admin bots may create teams; non-admin bots are refused.",
        parameters: createKissopenTeamInputSchema,
        returnType: kissopenTeamSchema,
        // A remote creation may have committed before an interruption, so it cannot be replayed.
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ endpoint, name }: CreateKissopenTeamInput) =>
            `creating WorPar team ${quoteVisibleExact(name)} at ${quoteVisibleExact(endpoint)} for the connected WorPar Cloud user. Access: external WorPar Cloud API and WorkOS organization write`,
        execute: async (ctx, { endpoint, name }: CreateKissopenTeamInput) =>
            await module.create(ctx, actingAgentId, name, endpoint),
        toLLM: (team) => [
            {
                type: "text",
                text: `WorPar team created: ${team.name} — id ${team.id}, endpoint ${team.endpoint}.`,
            },
        ],
    });
}

export { createKissopenTeamInputSchema };
