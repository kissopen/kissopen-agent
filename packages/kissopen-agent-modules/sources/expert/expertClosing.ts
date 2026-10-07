/**
 * The closing parts of an expert's answer, as `expertBrief` asks for them: Files (every file it
 * created or changed), Checked (what it verified), Open (what is left, or "none").
 *
 * Experts write these in whatever shape the model likes — a heading, a bold label, a bullet,
 * English or Chinese — so the reading is forgiving about the shape and strict about the meaning:
 * a label counts only when it stands alone or is followed by a colon, and only the last Files and
 * Open sections count, since they close the answer.
 */
export interface ExpertClosing {
    /** The paths listed under Files, or undefined when the answer has no Files section. */
    readonly files: readonly string[] | undefined;
    /** What Open says, or "" when the answer has no Open section. */
    readonly open: string;
}

/** The most paths one answer is checked for. */
export const MAX_CHECKED_FILES = 50;

type Section = "files" | "checked" | "open";

const LABELS: ReadonlyArray<readonly [Section, RegExp]> = [
    ["files", /^(?:files?|changed files|文件|产出文件|文件列表)$/iu],
    ["checked", /^(?:checked|verified|检查|已检查|验证|已验证|核对)$/iu],
    ["open", /^(?:open|open items|remaining|未完成|遗留|遗留问题|待办|待定|未决)$/iu],
];

/** Read the Files and Open sections from the end of an answer. */
export function readExpertClosing(answer: string): ExpertClosing {
    const lines = answer.split(/\r?\n/u);
    const headers: { readonly section: Section; readonly line: number; readonly rest: string }[] =
        [];
    lines.forEach((line, index) => {
        const header = sectionHeader(line);
        if (header !== undefined) headers.push({ ...header, line: index });
    });
    const body = (section: Section): string[] | undefined => {
        const at = headers.findLastIndex((header) => header.section === section);
        if (at < 0) return undefined;
        const start = headers[at]!;
        const end = headers[at + 1]?.line ?? lines.length;
        return [start.rest, ...lines.slice(start.line + 1, end)]
            .map((line) => line.trim())
            .filter((line) => line !== "");
    };
    const files = body("files");
    const open = body("open");
    return {
        files: files === undefined ? undefined : pathsIn(files),
        open: (open ?? []).map(stripBullet).join(" ").trim(),
    };
}

/** Whether what Open says means nothing is left. */
export function saysNothingOpen(open: string): boolean {
    const plain = open
        .replace(/[*_`"'“”‘’]/gu, "")
        .replace(/[.。!！]+$/u, "")
        .trim()
        .toLowerCase();
    if (/^(?:|none|nothing|no|n\/a|na|nil|-|—)$/u.test(plain)) return true;
    // "None — all done" says nothing is left; "none of the charts are done" does not.
    if (/^(?:none|nothing)\s*(?:[,;:—–]|-\s)/u.test(plain)) return true;
    return /^(?:无|没有|暂无|无遗留|无遗留问题|没有遗留问题|无未完成事项|全部完成)$/u.test(plain);
}

/** The section a line opens, and what follows its label on the same line. */
function sectionHeader(
    line: string,
): { readonly section: Section; readonly rest: string } | undefined {
    const stripped = line
        .trim()
        .replace(/^(?:#{1,6}\s*|>\s*|[-*+]\s+|\d+[.)]\s+)*/u, "")
        .trim();
    const match =
        /^(?:\*\*|__)?([^:：*_]{1,24})(?:\*\*|__)?\s*([:：])?\s*(?:\*\*|__)?\s*(.*)$/u.exec(
            stripped,
        );
    if (match === null) return undefined;
    const label = match[1]!.trim();
    const colon = match[2] !== undefined;
    const rest = match[3]!.trim();
    // "Open the deck in Keynote" is prose, not a section: a label stands alone or takes a colon.
    if (!colon && rest !== "") return undefined;
    const found = LABELS.find(([, pattern]) => pattern.test(label));
    return found === undefined ? undefined : { section: found[0], rest };
}

/** Every path the lines of a Files section name, in order, without repeats. */
function pathsIn(lines: readonly string[]): string[] {
    const paths: string[] = [];
    for (const line of lines) {
        for (const candidate of candidatesIn(stripBullet(line))) {
            const path = cleanPath(candidate);
            if (path === undefined || paths.includes(path)) continue;
            paths.push(path);
            if (paths.length >= MAX_CHECKED_FILES) return paths;
        }
    }
    return paths;
}

function candidatesIn(line: string): string[] {
    const quoted = [...line.matchAll(/`([^`]+)`/gu)].map((match) => match[1]!);
    if (quoted.length > 0) return quoted;
    const linked = [...line.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]!);
    if (linked.length > 0) return linked;
    // What follows a path on its line is usually a description of it.
    const [path] = line.split(/\s+[—–-]\s+|\s+\(|（|：|:\s/u);
    return (path ?? "").split(/[,，、;；]\s*/u);
}

function cleanPath(candidate: string): string | undefined {
    const path = candidate
        .trim()
        .replace(/^file:\/\//u, "")
        .replace(/^["'“‘<]+|["'”’>]+$/gu, "")
        .replace(/[.。,，;；]+$/u, "")
        .trim();
    if (path === "" || saysNothingOpen(path)) return undefined;
    // Only something that reads as a path is checked; a stray word is not a missing file.
    const looksLikePath = /[/\\]/u.test(path) || /\.[\p{L}\p{N}]{1,10}$/u.test(path);
    return looksLikePath ? path : undefined;
}

function stripBullet(line: string): string {
    return line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/u, "").trim();
}
