import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { nodeConfigSchema, nodeNameSchema } from "@kissopen/kissopen-agent-client";
import { Type } from "@sinclair/typebox";
import type { NodeModule } from "../NodeModule.js";

export function setNodeNameTool(node: NodeModule, agentId: string) {
    return defineAgentTool({
        name: "set_node_name",
        defer: true,
        capabilities: ["Set this KissOpen Agent installation's display name and avatar."],
        searchKeywords: ["node", "daemon", "installation", "name", "rename", "display name"],
        description:
            "Set this KissOpen Agent daemon's own display name. This is independent of the P2P name, bot names, and your human's profile. Only active admin bots may use it.",
        parameters: Type.Object({ name: nodeNameSchema }, { additionalProperties: false }),
        returnType: nodeConfigSchema,
        durable: true,
        requiresAutoOrFullAccess: true,
        shouldReviewInAutoMode: () => true,
        describeAutoPermissionAction: ({ name }) =>
            `renaming this KissOpen Agent installation to ${JSON.stringify(name)}. Access: installation-wide configuration write`,
        execute: async (ctx, { name }) => await node.setNameForAdmin(ctx, agentId, name),
        toLLM: (result) => [
            {
                type: "text",
                text: `This KissOpen Agent installation is now named ${JSON.stringify(result.name)}.`,
            },
        ],
    });
}
