import type { AgentEnvironment } from "@kissopen/kissopen-agent-base";

import type { SystemPromptAvailableModel } from "../SystemPromptAvailableModel.js";

/** Render the heading and every configured provider/model route. */
export function formatAvailableModels(
    availableModels: readonly SystemPromptAvailableModel[],
): string {
    if (availableModels.length === 0) return "";
    return [
        "## Available models",
        ...availableModels.map(
            (model) =>
                `- ${model.name} — model ID: \`${model.id}\`; provider ID: \`${model.providerId}\``,
        ),
    ].join("\n");
}

/** Render the machine guidance and configured model routes appended to a vendor prompt. */
export function assembleEnvironmentPrompt(options: {
    environment: AgentEnvironment;
    availableModels: readonly SystemPromptAvailableModel[];
    currentModel: string | undefined;
    currentProvider: string;
    designSystemPath: string;
    documentationPath: string;
}): string {
    const { currentModel, currentProvider, environment } = options;
    const shell = environment.shell.trim();
    const catalogEntry =
        currentModel === undefined
            ? undefined
            : (options.availableModels.find(
                  (model) => model.id === currentModel && model.providerId === currentProvider,
              ) ?? options.availableModels.find((model) => model.id === currentModel));
    const currentModelLine =
        currentModel === undefined
            ? undefined
            : catalogEntry === undefined
              ? `- Current model: \`${currentModel}\``
              : `- Current model: ${catalogEntry.name} (\`${currentModel}\`)`;
    return [
        "# Environment",
        `- Primary working directory: ${environment.workingDirectory}`,
        `- Platform: ${environment.platform}`,
        ...(shell.length === 0 ? [] : [`- Shell: ${shell}`]),
        `- OS version: ${environment.osVersion}`,
        ...(environment.platform === "win32"
            ? [
                  "- Commands run on native Windows. Use the listed shell’s syntax and Windows paths; the bash tool name does not imply a Linux shell. Use PowerShell LiteralPath arguments for file operations.",
              ]
            : []),
        ...(currentModelLine === undefined ? [] : [currentModelLine]),
        `- Current provider: \`${currentProvider}\``,
        `- KissOpen Agent documentation: ${options.documentationPath}`,
        `- KissOpen design system: When the user asks for a temporary page unrelated to their work, or asks to use the KissOpen design system, read and follow ${options.designSystemPath}.`,
        "- Scratch directory: `.context/` in the working directory. Strongly prefer it for temporary files, throwaway scripts, and notes or instructions for other agents; keep it gitignored (add the entry if missing) unless there is a real reason not to, and never commit it.",
        "- Project files: what the user attached in this project's conversations is kept in `uploads/` in the working directory. Save the deliverables you make for the user — documents, spreadsheets, slides, reports, exports, and copies of generated images they will keep — in `outputs/` in the working directory (create it if missing), under clear names. Changes to the project's own files, such as code, stay where they belong; temporary files go in `.context/`.",
        "- Linking files: every file you deliver or point the user to is named in your message as a Markdown link to its path relative to the working directory, such as `[周报.pptx](outputs/周报.pptx)`; put the path in angle brackets when it contains spaces, such as `[Q3 plan.pdf](<outputs/Q3 plan.pdf>)`. The user opens files by tapping these links on their computer and phone, so never name a delivered file only in backticks or as bare text.",
        "- By default the user sees only the last message you send before stopping; earlier messages are collapsed. Include all essential information in that last message.",
        "- When the project is a Git folder, a workspace and a worktree are the same thing: creating a workspace creates a new worktree, and deleting a workspace archives it.",
        ...(options.availableModels.length === 0
            ? []
            : ["", formatAvailableModels(options.availableModels)]),
    ].join("\n");
}
