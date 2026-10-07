import type { AskExpertResult, ExpertVerification } from "./Expert.js";
import { enabledExpertTasks, type ExpertPolicy, type ExpertTask } from "./ExpertPolicy.js";

/**
 * The instruction block an agent that can call `ask_expert` receives.
 *
 * Only enabled kinds are listed, in the console's order, with the console's own names and
 * descriptions — they are what an operator edits to change the routing, so they reach the model
 * verbatim. The repeated-failure rule is stated even when no kind is enabled, because escalation
 * works without any routed kinds.
 */
export function expertInstructions(policy: ExpertPolicy, _expertName: string): string {
    const tasks = enabledExpertTasks(policy);
    const lines = [
        "# Expert",
        "A stronger expert takes the harder work through ask_expert. Its work reaches the person as yours: never mention the expert or any model to them.",
    ];
    if (tasks.length > 0) {
        lines.push(
            "Hand these kinds of requests to ask_expert instead of doing them yourself:",
            ...tasks.map(
                (task) => `- ${task.id} (${oneLine(task.name)}): ${oneLine(task.description)}`,
            ),
            "For such a request, call ask_expert with kind set to its id and a complete, self-contained task: the person's goal and every requirement, the relevant context from this conversation, the exact paths of input files, and where to save the result. The expert cannot see this conversation. Ask the person first only when something essential is missing.",
        );
    }
    lines.push(
        "If the same step has failed repeatedly, stop retrying it: call ask_expert with the goal, what you tried, and the exact errors.",
        "ask_expert returns when the expert has finished, with a check of the files it lists. Then decide what comes next and relay the result to the person in your reply, with links to the files it produced; do not redo its work.",
        "Routing may already have executed ask_expert before your first response. Use that result; do not call it again for the same request merely because the task matches a category.",
        "If the person writes while the expert is still working, ask_expert returns early as detached: reply to the person, and do not ask the expert again for the same task — its result arrives later as a message.",
    );
    return lines.join("\n");
}

/** One recorded failure, as the escalation notice quotes it. */
export interface ExpertFailure {
    readonly tool: string;
    readonly error: string;
}

/** The system notice that tells the model to stop retrying and hand the problem over. */
export function escalationNotice(count: number, failures: readonly ExpertFailure[]): string {
    return [
        "# Repeated failures",
        `The last ${String(count)} tool calls failed in a row. Stop retrying the same approach.`,
        ...(failures.length === 0
            ? []
            : ["Most recent failures:", ...failures.map((f) => `- ${f.tool}: ${f.error}`)]),
        "Call ask_expert now with the goal, what you tried, and these exact errors, and let the expert solve it. Then relay its result to the person.",
    ].join("\n");
}

/**
 * The opening message the expert receives. The expert is an ordinary collaborator, so its
 * creator is already named in its own instructions; this says what kind of work it is doing and
 * what its final message is for, since that message is the whole result the caller gets back.
 */
export function expertBrief(task: string, kind: ExpertTask | undefined): string {
    return [
        "You are the expert this agent hands its hardest work to. Do the task below completely and to a high standard, directly in this workspace: you have the same files and tools. Do not wait for answers to questions; make reasonable assumptions and state them.",
        'When you finish, your final message is returned to the agent that asked and relayed to the person. Make it the finished result: the answer or deliverable itself, then three short parts — Files (the absolute path of every file you created or changed), Checked (what you verified), Open (anything left undone or uncertain, or "none"). Do not mention models or agents in it.',
        ...(kind === undefined
            ? []
            : [`Kind of work: ${oneLine(kind.name)} (${oneLine(kind.description)})`]),
        "",
        "Task:",
        task,
    ].join("\n");
}

/** The longest expert answer handed back verbatim; anything past it is elided. */
const MAX_ANSWER_CHARACTERS = 60_000;

/** What to do with a finished answer, whatever its check found. */
const DECIDE =
    "Now decide: continue / rework (ask_expert again naming what is missing) / wait / ask the person / finish; record files and verified in the card in .kissopen/project.json.";

/** How one finished call reads to the model that made it. */
export function formatExpertResult(result: AskExpertResult): string {
    const who = "The expert";
    if (result.status === "answered") {
        const answer =
            result.answer.length <= MAX_ANSWER_CHARACTERS
                ? result.answer
                : `${result.answer.slice(0, MAX_ANSWER_CHARACTERS)}\n…[the rest of the answer was elided]`;
        return [
            `${who} finished. Its final answer follows verbatim. Relay the result to the person in your reply, with links to the files it lists (they are in this same workspace), and do not redo work that is done.`,
            "",
            answer,
            "",
            ...(result.verification === undefined
                ? []
                : [formatVerification(result.verification), ""]),
            DECIDE,
        ].join("\n");
    }
    if (result.status === "detached") {
        return `${who} is still working. The person wrote while you waited — read their message and reply to it now. The expert's result will arrive as a message when it finishes; do not ask it again for the same task or redo its work meanwhile.`;
    }
    if (result.status === "failed") {
        return `${who} stopped without answering: ${result.reason}\nAny files it wrote before stopping are in this workspace. Tell the person, then continue on your own or ask again with a narrower task.`;
    }
    return `${who} had not finished after ${String(result.minutes)} minutes and was stopped. Any files it wrote so far are in this workspace. Tell the person, then continue on your own or call ask_expert again with a smaller, more specific task.`;
}

/**
 * How a result the conversation stopped waiting for reads when it arrives later as a message.
 * `limit` is the autonomy notice, when the turn's wake-ups are spent: the result is still
 * reported, but the model is asked to check with the person instead of deciding by itself.
 */
export function formatDetachedExpertResult(result: AskExpertResult, limit?: string): string {
    return [
        "# Expert result",
        "The expert you stopped waiting for when the person wrote has now finished.",
        ...(limit === undefined ? [] : [limit]),
        "",
        formatExpertResult(result),
    ].join("\n");
}

/** What KISSOPEN found when it checked the answer's closing parts. */
function formatVerification(verification: ExpertVerification): string {
    const lines = ["# Check (made by WorPar, not by the expert)"];
    if (verification.files.length === 0) {
        lines.push("- Files: none listed, so nothing it produced could be checked.");
    } else {
        const missing = verification.files.filter((file) => !file.exists).length;
        lines.push(
            missing === 0
                ? `- Files: all ${String(verification.files.length)} listed files exist.`
                : `- Files: ${String(missing)} of ${String(verification.files.length)} listed files are missing.`,
            ...verification.files.map(
                (file) => `  - ${file.path} — ${file.exists ? "exists" : "MISSING"}`,
            ),
        );
    }
    lines.push(
        `- Open: ${verification.open === "" ? "(not stated)" : oneLine(verification.open)}`,
        `- Verified: ${verification.verified ? "yes" : "no"}`,
    );
    return lines.join("\n");
}

function oneLine(text: string): string {
    return text.replace(/\s+/gu, " ").trim();
}
