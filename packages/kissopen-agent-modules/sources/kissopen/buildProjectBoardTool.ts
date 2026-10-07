import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import type { Context } from "@steve.kite/stdlib";

/*
Starts the building of this project's board, from inside a conversation.

A project's setup conversation asks the person what the project is; once it
knows enough it builds the first board itself rather than sending them to a
button. The business server starts the same build the board page's 生成看板
does, where the project is — this computer, or the cloud workspace.
*/

export const BUILD_PROJECT_BOARD_TOOL = "build_project_board";

export const buildProjectBoardResultSchema = Type.Object({
    status: Type.Union([
        Type.Literal("started"),
        Type.Literal("running"),
        Type.Literal("busy"),
        Type.Literal("waiting_device"),
        Type.Literal("failed"),
    ]),
    error: Type.Optional(Type.String()),
});
export type BuildProjectBoardResult = Static<typeof buildProjectBoardResultSchema>;

/** What the model is told to do after the call, beside the outcome itself. */
export function buildProjectBoardNote(result: BuildProjectBoardResult): string {
    switch (result.status) {
        case "started":
            return "The board is being built now; it appears on the project's board page in a few minutes. Tell the person so in one sentence.";
        case "running":
            return "A board build was already under way; the board will appear when it ends. Tell the person so in one sentence.";
        case "busy":
            return "The project is reading new material right now, so the board could not start yet. Tell the person the board page's 生成看板 builds it once that ends.";
        case "waiting_device":
            return "The computer that holds the project is offline; the board is built as soon as it is back. Tell the person so.";
        default:
            return `The board could not be started: ${result.error ?? "unknown error"}. Tell the person plainly and that 生成看板 on the board page builds it.`;
    }
}

export function buildProjectBoardTool(build: (ctx: Context) => Promise<BuildProjectBoardResult>) {
    return defineAgentTool({
        name: BUILD_PROJECT_BOARD_TOOL,
        defer: true,
        capabilities: [
            "Build or rebuild this project's KissOpen board from its conversations and files.",
        ],
        searchKeywords: ["project board", "build board", "看板", "生成看板", "项目看板"],
        description:
            "Start building this project's KissOpen board — the page summarising its goal, progress and next steps — from the project's conversations and files. Use it when a project's setup is done or the person asks for the board to be built or refreshed. It returns at once; the board appears on the project's board page when the build ends.",
        parameters: Type.Object({}, { additionalProperties: false }),
        returnType: buildProjectBoardResultSchema,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx) => await build(ctx),
        toLLM: (result: BuildProjectBoardResult) => [
            {
                type: "text",
                text: JSON.stringify({ ...result, note: buildProjectBoardNote(result) }),
            },
        ],
    });
}
