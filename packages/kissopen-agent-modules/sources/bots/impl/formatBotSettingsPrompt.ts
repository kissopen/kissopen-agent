import type { BotCoreFileName } from "@kissopen/kissopen-agent-client";

import type { BotRecord } from "../Bot.js";

/** How much of each core file enters the instructions; the rest is read with ordinary tools. */
export const BOT_CORE_FILE_PROMPT_CHARS = 32 * 1024;

const STYLE_GUIDANCE: Readonly<Record<string, string>> = {
    professional: "Professional: precise, well organized, and businesslike.",
    friendly: "Friendly: warm and approachable, while still getting to the point.",
    creative: "Creative: imaginative, offering fresh angles and ideas.",
    concise: "Concise: brief and to the point; no preamble or filler.",
    casual: "Casual: relaxed and conversational.",
    expert: "Expert: authoritative, with depth and precise terminology.",
};

const FILE_HEADINGS: Readonly<Partial<Record<BotCoreFileName, string>>> = {
    "SOUL.md": "Your character (SOUL.md)",
    "IDENTITY.md": "Who you are (IDENTITY.md)",
    "USER.md": "About the person (USER.md)",
    "MEMORY.md": "What you remember (MEMORY.md)",
};

/**
 * The assistant settings and core files a bot reads at the start of every turn.
 *
 * `AGENTS.md` is absent on purpose: it already reaches the bot through ordinary AGENTS.md loading
 * from its folder. The memory guidance is always present, because a bot that has never written
 * `MEMORY.md` is exactly the one that needs to be told it may.
 */
export function formatBotSettingsPrompt(
    bot: Pick<BotRecord, "description" | "style" | "user">,
    files: Readonly<Partial<Record<BotCoreFileName, string>>>,
): string {
    const sections: string[] = [];
    const about: string[] = [];
    if (bot.description.trim() !== "") about.push(`What you are for: ${bot.description.trim()}`);
    const style = bot.style === undefined ? undefined : STYLE_GUIDANCE[bot.style];
    if (style !== undefined) about.push(`Answer in this style — ${style}`);
    if (about.length > 0) sections.push(["# Your role", "", ...about].join("\n"));

    const person: string[] = [];
    if (bot.user.name.trim() !== "") person.push(`- Address them as: ${bot.user.name.trim()}`);
    if (bot.user.language.trim() !== "") {
        person.push(
            `- Preferred language: ${bot.user.language.trim()} — answer in it unless they write in another or ask otherwise.`,
        );
    }
    if (bot.user.note.trim() !== "") person.push(`- Note: ${bot.user.note.trim()}`);
    if (bot.user.background.trim() !== "") {
        person.push(`- Background: ${bot.user.background.trim()}`);
    }
    if (person.length > 0) sections.push(["# The person you serve", "", ...person].join("\n"));

    for (const name of ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"] as const) {
        const text = files[name]?.trim() ?? "";
        if (text === "") continue;
        const bounded =
            text.length > BOT_CORE_FILE_PROMPT_CHARS
                ? `${text.slice(0, BOT_CORE_FILE_PROMPT_CHARS)}\n\n[Truncated; read ${name} in your folder for the rest.]`
                : text;
        sections.push(`# ${FILE_HEADINGS[name] ?? name}\n\n${bounded}`);
    }

    sections.push(
        [
            "# Keeping your memory",
            "",
            "MEMORY.md at the root of your folder is your long-term memory, and you read it at the start of every turn. When you learn something that should outlast this conversation — a preference, a decision, a standing fact about the person or your work — update it with your file tools. Keep it short, current, and organized: rewrite or remove entries that are stale instead of appending forever. Never store secrets or credentials in it.",
        ].join("\n"),
    );
    return sections.join("\n\n");
}
