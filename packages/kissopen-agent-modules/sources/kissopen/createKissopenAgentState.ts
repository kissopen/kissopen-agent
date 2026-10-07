import type { ProviderUsage, ProviderUsageWindow } from "@kissopen/kissopen-providers";

import type { UserInputRequest } from "../userInput/index.js";

/**
 * Kissopen carries a question the agent asked on its own channel, apart from
 * permissions: a permission gates something the agent wants to do, while this
 * asks the person for something the agent does not know. Every Kissopen Agent question is
 * published as the `form` kind whatever tool asked it, so a phone that cannot
 * render one still shows it and lets the person dismiss it.
 */
const KISSOPEN_FORM_KIND = "form";

/** How many settled questions stay published, so a long session cannot grow this forever. */
const MAX_COMPLETED_COMMUNICATIONS = 100;

export interface KissopenCommunication {
    createdAt: number;
    form: unknown;
    kind: string;
    title: string;
    toolUseId: string;
}

export interface KissopenResolvedCommunication {
    answers?: Record<string, unknown>;
    communication: KissopenCommunication;
    completedAt: number;
    status: "answered" | "cancelled";
}

export interface KissopenAgentState {
    communications: Record<string, KissopenCommunication>;
    completedCommunications: Record<string, unknown>;
    usageLimits?: KissopenUsageLimits;
}

interface KissopenUsageLimitWindow {
    id: string;
    label?: string;
    resetsAt: number | null;
    status: "allowed" | "allowed_warning" | "rejected";
    utilization: number;
}

interface KissopenUsageLimits {
    capturedAt: number;
    windows: KissopenUsageLimitWindow[];
}

/**
 * Remembers one settled question, and forgets the oldest once there are enough.
 *
 * Keeping recent ones is what lets a phone that was asleep settle a form that
 * was already answered somewhere else, rather than showing it as still waiting.
 */
export function rememberKissopenResolvedCommunication(
    completed: Map<string, KissopenResolvedCommunication>,
    requestId: string,
    resolved: KissopenResolvedCommunication,
): void {
    completed.delete(requestId);
    completed.set(requestId, resolved);
    while (completed.size > MAX_COMPLETED_COMMUNICATIONS) {
        const oldest = completed.keys().next().value;
        if (oldest === undefined) return;
        completed.delete(oldest);
    }
}

/**
 * Projects the questions this agent is waiting on into Kissopen's live state.
 *
 * Answering nothing at all clears the remote state, which is how a phone stops
 * showing a prompt for a question that is no longer being asked.
 */
export function createKissopenAgentState(options: {
    completed: ReadonlyMap<string, KissopenResolvedCommunication>;
    /**
     * When a question was first published. It must not move: the caller skips
     * the round trip only when the state is byte-identical, so a timestamp that
     * changed on every tick would republish forever.
     */
    createdAt: (requestId: string) => number;
    pending: readonly UserInputRequest[];
    /** Account quota for this session's selected provider. */
    usage?: ProviderUsage | null;
}): KissopenAgentState | null {
    const communications: Record<string, KissopenCommunication> = {};
    for (const request of options.pending) {
        communications[request.id] = toKissopenCommunication(
            request,
            options.createdAt(request.id),
        );
    }

    const completedCommunications: Record<string, unknown> = {};
    for (const [requestId, resolved] of options.completed) {
        // A question being asked again outranks a stale answer to it.
        if (communications[requestId] !== undefined) continue;
        completedCommunications[requestId] = {
            ...resolved.communication,
            completedAt: resolved.completedAt,
            status: resolved.status,
            ...(resolved.answers === undefined ? {} : { answers: resolved.answers }),
        };
    }

    const usageLimits = toKissopenUsageLimits(options.usage);
    if (
        Object.keys(communications).length === 0 &&
        Object.keys(completedCommunications).length === 0 &&
        usageLimits === undefined
    ) {
        return null;
    }
    return {
        communications,
        completedCommunications,
        ...(usageLimits === undefined ? {} : { usageLimits }),
    };
}

/** Converts provider-neutral quota windows to the open window ids understood by Kissopen. */
function toKissopenUsageLimits(
    usage: ProviderUsage | null | undefined,
): KissopenUsageLimits | undefined {
    if (usage === null || usage === undefined) return undefined;
    const windows: KissopenUsageLimitWindow[] = [];
    addUsageWindow(windows, "five_hour", usage.windows.fiveHour);
    addUsageWindow(windows, "seven_day", usage.windows.weekly);
    addUsageWindow(windows, "monthly", usage.windows.monthly);
    addUsageWindow(windows, "seven_day_fable", usage.windows.fableWeekly, "Fable 7-day");
    if (windows.length === 0) return undefined;
    return { capturedAt: usage.capturedAt, windows };
}

function addUsageWindow(
    windows: KissopenUsageLimitWindow[],
    id: string,
    window: ProviderUsageWindow | null | undefined,
    label?: string,
): void {
    if (window === null || window === undefined) return;
    const utilization = Math.min(100, Math.max(0, window.usedPercent));
    windows.push({
        id,
        ...(label === undefined ? {} : { label }),
        resetsAt: window.resetsAt,
        status: utilization >= 100 ? "rejected" : utilization >= 90 ? "allowed_warning" : "allowed",
        utilization,
    });
}

/**
 * Builds the form the phone renders.
 *
 * Every question also accepts words the person writes themselves, because Kissopen Agent
 * takes any answer and not only the ones it thought to offer.
 */
export function toKissopenCommunication(
    request: UserInputRequest,
    createdAt: number,
): KissopenCommunication {
    const questions =
        request.questions ??
        ([
            {
                ...(request.header === undefined ? {} : { header: request.header }),
                id: request.id,
                ...(request.options === undefined ? {} : { options: request.options }),
                question: request.question,
            },
        ] as const);
    return {
        createdAt,
        form: {
            questions: questions.map((question) => ({
                allowCustom: true,
                header: question.header ?? "Question",
                id: question.id,
                multiSelect: question.options?.multiSelect ?? false,
                options: (question.options?.choices ?? []).map((choice) => ({
                    description: choice.description,
                    label: choice.label,
                })),
                question: question.question,
                required: true,
            })),
        },
        kind: KISSOPEN_FORM_KIND,
        // Shown by a phone that cannot render this kind, so the person still
        // learns what the agent is waiting on.
        title: request.header ?? request.questions?.[0]?.header ?? "Question",
        toolUseId: request.id,
    };
}
