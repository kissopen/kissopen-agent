import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import { kissopenTeamSchema } from "../../cloud/index.js";
import type { KissopenTeamsModule } from "../KissopenTeamsModule.js";

const KISSOPEN_TEAMS_PAGE_ITEMS = 10;
const kissopenTeamsOffsetSchema = Type.Integer({ minimum: 0, maximum: 10_000 });
const listKissopenTeamsInputSchema = Type.Object(
    { offset: Type.Optional(kissopenTeamsOffsetSchema) },
    { additionalProperties: false },
);
type ListKissopenTeamsInput = Static<typeof listKissopenTeamsInputSchema>;

const listKissopenTeamsResultSchema = Type.Object(
    {
        next_offset: Type.Union([Type.Null(), kissopenTeamsOffsetSchema]),
        teams: Type.Array(kissopenTeamSchema, { maxItems: KISSOPEN_TEAMS_PAGE_ITEMS }),
    },
    { additionalProperties: false },
);
type ListKissopenTeamsResult = Static<typeof listKissopenTeamsResultSchema>;

/** List the WorkOS organizations visible to the connected Kissopen Cloud user. */
export function listKissopenTeamsTool(module: KissopenTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "list_kissopen_teams",
        defer: true,
        capabilities: ["List and manage KissOpen teams."],
        searchKeywords: ["KissOpen Cloud organizations", "team list", "WorkOS organizations"],
        description:
            "List a 10-item page of KissOpen teams the connected KissOpen Cloud user belongs to, including each WorkOS organization ID and its configured KissOpen Agent server endpoint. Follow next_offset until it is null to read every team.",
        parameters: listKissopenTeamsInputSchema,
        returnType: listKissopenTeamsResultSchema,
        durable: true,
        reloadable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: () =>
            "listing the connected KissOpen Cloud user's WorkOS organizations and their KissOpen Agent endpoints. Access: external KissOpen Cloud API",
        execute: async (
            ctx,
            { offset = 0 }: ListKissopenTeamsInput,
        ): Promise<ListKissopenTeamsResult> => {
            const all = await module.list(ctx, actingAgentId);
            const teams = all.slice(offset, offset + KISSOPEN_TEAMS_PAGE_ITEMS);
            const next = offset + teams.length;
            return {
                next_offset: next < all.length ? next : null,
                teams: [...teams],
            };
        },
        toLLM: ({ next_offset, teams }) => [
            {
                type: "text",
                text:
                    teams.length === 0
                        ? "The connected KissOpen Cloud user belongs to no KissOpen teams."
                        : [
                              ...teams.map(
                                  (team) =>
                                      `- ${team.name} — id ${team.id}, endpoint ${team.endpoint ?? "not configured"}`,
                              ),
                              ...(next_offset === null
                                  ? []
                                  : [`More teams are available at offset ${String(next_offset)}.`]),
                          ].join("\n"),
            },
        ],
    });
}

export { KISSOPEN_TEAMS_PAGE_ITEMS, listKissopenTeamsInputSchema, listKissopenTeamsResultSchema };
