import { describe, expect, it } from "vitest";

import { resolveKissopenUserInputAnswers } from "../../sources/kissopen/index.js";
import { normalizeKissopenAnswers } from "../../sources/kissopen/resolveKissopenUserInputAnswers.js";
import type { UserInputOptions, UserInputRequest } from "../../sources/userInput/index.js";

const CHOICES: UserInputOptions = {
    choices: [
        { description: "The safe one.", label: "Keep it" },
        { description: "The other one.", label: "Replace it" },
    ],
    multiSelect: false,
};

function request(overrides: Partial<UserInputRequest> = {}): UserInputRequest {
    return {
        askingAgentId: "agent-1",
        context: "Deciding what to do with the file.",
        createdAt: 1_000,
        id: "req-1",
        question: "What should happen to it?",
        status: "pending",
        updatedAt: 1_000,
        ...overrides,
    } as UserInputRequest;
}

describe("resolving what somebody tapped on their phone", () => {
    it("takes a label the agent actually offered as a choice", () => {
        expect(
            resolveKissopenUserInputAnswers(request({ options: CHOICES }), {
                "req-1": { options: ["Keep it"] },
            }),
        ).toEqual({ answer: { selectedOptions: ["Keep it"] }, requestId: "req-1" });
    });

    it("reads a desktop's list-shaped answer once normalised, rather than as no answer", () => {
        expect(
            resolveKissopenUserInputAnswers(
                request({ options: CHOICES }),
                normalizeKissopenAnswers({ "req-1": ["Keep it", "and tell me why"] }),
            ),
        ).toEqual({
            answer: { selectedOptions: ["Keep it"], text: "and tell me why" },
            requestId: "req-1",
        });
    });

    it("treats a label the agent never offered as the person's own words", () => {
        expect(
            resolveKissopenUserInputAnswers(request({ options: CHOICES }), {
                "req-1": { options: ["Rename it instead"] },
            }),
        ).toEqual({ answer: { text: "Rename it instead" }, requestId: "req-1" });
    });

    it("keeps a choice and the words written beside it", () => {
        expect(
            resolveKissopenUserInputAnswers(request({ options: CHOICES }), {
                "req-1": { custom: "but back it up first", options: ["Replace it"] },
            }),
        ).toEqual({
            answer: { selectedOptions: ["Replace it"], text: "but back it up first" },
            requestId: "req-1",
        });
    });

    it("refuses to turn one answer into several", () => {
        expect(
            resolveKissopenUserInputAnswers(request({ options: CHOICES }), {
                "req-1": { options: ["Keep it", "Replace it"] },
            }),
        ).toEqual({ answer: { selectedOptions: ["Keep it"] }, requestId: "req-1" });
    });

    it("keeps every choice when the question invited several", () => {
        expect(
            resolveKissopenUserInputAnswers(request({ options: { ...CHOICES, multiSelect: true } }), {
                "req-1": { options: ["Keep it", "Replace it"] },
            }),
        ).toEqual({
            answer: { selectedOptions: ["Keep it", "Replace it"] },
            requestId: "req-1",
        });
    });

    it("answers each question of a form on its own", () => {
        const form = request({
            questions: [
                { id: "q1", options: CHOICES, question: "The file?" },
                { id: "q2", question: "Anything else?" },
            ],
        });
        expect(
            resolveKissopenUserInputAnswers(form, {
                q1: { options: ["Keep it"] },
                q2: { custom: "no, that is all" },
            }),
        ).toEqual({
            answers: {
                q1: { selectedOptions: ["Keep it"] },
                q2: { text: "no, that is all" },
            },
            requestId: "req-1",
        });
    });

    it("says so plainly when a question was left unanswered", () => {
        expect(resolveKissopenUserInputAnswers(request({ options: CHOICES }), {})).toEqual({
            answer: { text: "No answer was given." },
            requestId: "req-1",
        });
    });

    it("ignores blank and repeated labels", () => {
        expect(
            resolveKissopenUserInputAnswers(request({ options: { ...CHOICES, multiSelect: true } }), {
                "req-1": { custom: "  ", options: ["Keep it", "  ", "Keep it"] },
            }),
        ).toEqual({ answer: { selectedOptions: ["Keep it"] }, requestId: "req-1" });
    });
});
