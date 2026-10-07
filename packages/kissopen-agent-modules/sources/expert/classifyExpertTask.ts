import type { ExpertPolicy, ExpertTask } from "./ExpertPolicy.js";

/** Matches only the current user's words, never descriptions, history or tool output. */
export function classifyExpertTask(policy: ExpertPolicy, text: string): ExpertTask | undefined {
    const normalized = text.toLowerCase();
    const includes = (phrases: readonly string[] | undefined) =>
        phrases?.some((phrase) => matches(normalized, phrase.trim().toLowerCase())) === true;
    return policy.expert_tasks.find(
        (task) =>
            task.enabled &&
            includes(task.match_any) &&
            !includes(task.exclude_any) &&
            (!task.require_any?.length || includes(task.require_any)),
    );
}

function matches(text: string, phrase: string): boolean {
    if (phrase === "") return false;
    const word = (char: string | undefined) => char !== undefined && /^[a-z0-9_]$/.test(char);
    for (let start = text.indexOf(phrase); start >= 0; start = text.indexOf(phrase, start + 1)) {
        const end = start + phrase.length;
        if (
            (!word(phrase[0]) || !word(text[start - 1])) &&
            (!word(phrase[phrase.length - 1]) || !word(text[end]))
        )
            return true;
    }
    return false;
}
