import type {
    AgentModule,
    AgentModuleHooks,
    AgentModuleScope,
    AgentSystemRef,
    AnyAgentTool,
} from "@kissopen/kissopen-agent-base";
import type { Context } from "@steve.kite/stdlib";

import { BotsModule, type BotRecord } from "../bots/index.js";
import {
    CloudModule,
    type KissopenTeam,
    type KissopenTeamInvitation,
    type ShortLivedWorkOSToken,
} from "../cloud/index.js";

import { createKissopenTeamTool } from "./tools/create_kissopen_team.js";
import { getKissopenWorkOSStateTool } from "./tools/get_kissopen_workos_state.js";
import { mintKissopenWorkOSTokenTool } from "./tools/mint_kissopen_workos_token.js";
import { inviteKissopenTeamMemberTool } from "./tools/invite_kissopen_team_member.js";
import { listKissopenTeamsTool } from "./tools/list_kissopen_teams.js";
import { updateKissopenTeamTool } from "./tools/update_kissopen_team.js";

/** Agent-facing administration of WorkOS organizations backed by the connected Kissopen Cloud user. */
export class KissopenTeamsModule implements AgentModule {
    readonly name = "kissopenTeams";

    readonly #bots: BotsModule;
    readonly #cloud: CloudModule;
    #agents: AgentSystemRef | undefined;

    constructor(cloud: CloudModule, bots: BotsModule) {
        this.#cloud = cloud;
        this.#bots = bots;
    }

    readonly #hooks: AgentModuleHooks = {
        tools: async (_ctx: Context, scope: AgentModuleScope): Promise<readonly AnyAgentTool[]> => {
            if ((await this.#requireAgents().parentOf(_ctx, scope.agent.id)) !== null) return [];
            const tools: AnyAgentTool[] = [
                listKissopenTeamsTool(this, scope.agent.id),
                createKissopenTeamTool(this, scope.agent.id),
                updateKissopenTeamTool(this, scope.agent.id),
            ];
            if (await this.#isActiveAdminBot(_ctx, scope.agent.id)) {
                tools.push(getKissopenWorkOSStateTool(this, scope.agent.id));
                tools.push(inviteKissopenTeamMemberTool(this, scope.agent.id));
                tools.push(mintKissopenWorkOSTokenTool(this, scope.agent.id));
            }
            return tools;
        },
    };

    readonly beforeStart = (_ctx: Context, agents: AgentSystemRef): AgentModuleHooks => {
        this.#agents = agents;
        return this.#hooks;
    };

    async list(ctx: Context, actingAgentId: string): Promise<readonly KissopenTeam[]> {
        await this.#assertAdministrator(ctx, actingAgentId);
        return await this.#cloud.listTeams(ctx);
    }

    async create(
        ctx: Context,
        actingAgentId: string,
        name: string,
        endpoint: string,
    ): Promise<KissopenTeam> {
        await this.#assertAdministrator(ctx, actingAgentId);
        return await this.#cloud.createTeam(ctx, name, endpoint);
    }

    async update(
        ctx: Context,
        actingAgentId: string,
        teamId: string,
        endpoint: string,
    ): Promise<string> {
        await this.#assertAdministrator(ctx, actingAgentId);
        return await this.#cloud.setTeamEndpoint(ctx, teamId, endpoint);
    }

    async getWorkOSState(
        ctx: Context,
        actingAgentId: string,
    ): Promise<{ readonly workosClientId: string; readonly workosUserId: string }> {
        if (!(await this.#isActiveAdminBot(ctx, actingAgentId))) {
            throw new Error(
                "Only an active admin bot can inspect the connected KissOpen Cloud WorkOS state.",
            );
        }
        return await this.#cloud.getWorkOSState(ctx);
    }

    async mintWorkOSToken(
        ctx: Context,
        actingAgentId: string,
        teamId: string,
    ): Promise<ShortLivedWorkOSToken> {
        if (
            (await this.#requireAgents().parentOf(ctx, actingAgentId)) !== null ||
            !(await this.#isActiveAdminBot(ctx, actingAgentId))
        ) {
            throw new Error("Only an active admin bot can mint a WorkOS access token.");
        }
        return await this.#cloud.mintShortLivedForOrganization(ctx, teamId);
    }

    async invite(
        ctx: Context,
        actingAgentId: string,
        teamId: string,
        email: string,
    ): Promise<KissopenTeamInvitation> {
        if (
            (await this.#requireAgents().parentOf(ctx, actingAgentId)) !== null ||
            !(await this.#isActiveAdminBot(ctx, actingAgentId))
        ) {
            throw new Error("Only an active admin bot can invite people to KissOpen teams.");
        }
        return await this.#cloud.inviteTeamMember(ctx, teamId, email);
    }

    async #assertAdministrator(ctx: Context, actingAgentId: string): Promise<void> {
        const actingBot = await this.#bots.forAgent(ctx, actingAgentId);
        if (actingBot !== undefined && !actingBot.isAdmin) {
            throw new Error(formatAdminBotRequired(await this.#bots.list(ctx)));
        }
    }

    async #isActiveAdminBot(ctx: Context, actingAgentId: string): Promise<boolean> {
        const bot = await this.#bots.forAgent(ctx, actingAgentId);
        return bot?.isAdmin === true && bot.status === "active";
    }

    #requireAgents(): AgentSystemRef {
        if (this.#agents === undefined)
            throw new Error("KissOpen teams started without Agent System.");
        return this.#agents;
    }
}

function formatAdminBotRequired(bots: readonly BotRecord[]): string {
    const admins = bots.filter((bot) => bot.isAdmin);
    if (admins.length === 0) {
        return "Only an admin bot can manage KissOpen teams. There are no admin bots on this installation.";
    }
    return [
        "Only an admin bot can manage KissOpen teams. Admin bots on this installation:",
        ...admins.map(
            (bot) =>
                `- ${bot.name}${bot.status === "archived" ? " (archived)" : ""} — id ${bot.id}`,
        ),
    ].join("\n");
}
