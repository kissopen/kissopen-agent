import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";

import {
    kissopenTeamInvitationEmailInputSchema,
    kissopenTeamInvitationOrganizationIdSchema,
    kissopenTeamInvitationSchema,
} from "../../cloud/index.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { KissopenTeamsModule } from "../KissopenTeamsModule.js";

const inviteKissopenTeamMemberInputSchema = Type.Object(
    {
        email: kissopenTeamInvitationEmailInputSchema,
        team_id: kissopenTeamInvitationOrganizationIdSchema,
    },
    { additionalProperties: false },
);
type InviteKissopenTeamMemberInput = Static<typeof inviteKissopenTeamMemberInputSchema>;

/** Send one WorkOS member invitation using the connected Cloud user's authority. */
export function inviteKissopenTeamMemberTool(module: KissopenTeamsModule, actingAgentId: string) {
    return defineAgentTool({
        name: "invite_kissopen_team_member",
        defer: true,
        capabilities: ["List and manage WorPar teams."],
        searchKeywords: ["invite people", "email invitation", "WorkOS organization member"],
        description:
            "Invite one email address to a WorPar team (WorkOS organization) as a member. Use list_kissopen_teams to find the team ID. Only an active admin bot may call this tool, and the connected WorkOS user must administer that organization. WorkOS uses its configured invitation email delivery; email delivery must be enabled there. Returns a sensitive acceptance link to share only with the intended recipient. Do not automatically retry an uncertain result: the invitation may already have been sent. WorkOS may allow another address on the same corporate domain to accept; do not promise exact-email binding. No administrator role or delivery override is supported.",
        parameters: inviteKissopenTeamMemberInputSchema,
        returnType: kissopenTeamInvitationSchema,
        durable: false,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ email, team_id }: InviteKissopenTeamMemberInput) =>
            `inviting ${quoteVisibleExact(email)} to WorPar team ${quoteVisibleExact(team_id)} as a member and sending a WorkOS invitation email. Access: external WorPar Cloud API and WorkOS organization membership invitation`,
        execute: async (ctx, { email, team_id }: InviteKissopenTeamMemberInput) =>
            await module.invite(ctx, actingAgentId, team_id, email),
        toLLM: (invitation) => [
            {
                type: "text",
                text: [
                    `Member invitation created for ${invitation.email}.`,
                    `Invitation ID: ${invitation.id}`,
                    `Expires: ${invitation.expiresAt}`,
                    `Acceptance link (share only with the intended recipient): ${invitation.acceptanceLink}`,
                ].join("\n"),
            },
        ],
    });
}
