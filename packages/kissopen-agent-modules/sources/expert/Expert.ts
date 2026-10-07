import { Type, type Static } from "@sinclair/typebox";

import { collaborationAgentIdSchema } from "../collaboration/CollaborationAgent.js";

/**
 * The longest task one call may hand over. The expert's opening message also carries a short
 * preamble, and the whole message must fit collaboration's 50,000-character message bound.
 */
export const MAX_EXPERT_TASK_LENGTH = 45_000;

/** What the model hands to the expert. */
export const askExpertInputSchema = Type.Object(
    {
        task: Type.String({
            minLength: 1,
            maxLength: MAX_EXPERT_TASK_LENGTH,
            description:
                "Complete, self-contained instructions. The expert cannot see this conversation: include the person's goal and every requirement, the relevant context and decisions so far, the exact paths of input files, and where results should be saved. When escalating after failures, include what was tried and the exact errors.",
        }),
        kind: Type.Optional(
            Type.String({
                minLength: 1,
                maxLength: 64,
                description: "The expert task kind this request belongs to, by its id.",
            }),
        ),
    },
    { additionalProperties: false },
);

const expertIdentitySchema = {
    expertId: collaborationAgentIdSchema,
    model: Type.String({ minLength: 1, maxLength: 256 }),
    modelName: Type.String({ minLength: 1, maxLength: 256 }),
};

/**
 * What KISSOPEN itself found when it checked an answer's closing parts, rather than what the
 * expert says it did: whether every file listed under Files is really there, and what Open says.
 * `verified` holds only when Files lists at least one file, every one of them exists, and Open
 * says nothing is left.
 */
export const expertVerificationSchema = Type.Object(
    {
        verified: Type.Boolean(),
        files: Type.Array(
            Type.Object(
                { path: Type.String({ minLength: 1 }), exists: Type.Boolean() },
                { additionalProperties: false },
            ),
            { maxItems: 50 },
        ),
        open: Type.String(),
    },
    { additionalProperties: false },
);

/**
 * How one `ask_expert` call ended: the expert's final answer, the reason it stopped without
 * one, the fact that it ran out of time and was stopped, or that the person wrote while it was
 * still working and the call stopped waiting for it.
 */
export const askExpertResultSchema = Type.Union([
    Type.Object(
        {
            status: Type.Literal("answered"),
            ...expertIdentitySchema,
            answer: Type.String(),
            // Absent when the answer could not be checked: no machine to look on.
            verification: Type.Optional(expertVerificationSchema),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { status: Type.Literal("failed"), ...expertIdentitySchema, reason: Type.String() },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            status: Type.Literal("timed_out"),
            ...expertIdentitySchema,
            minutes: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        { status: Type.Literal("detached"), ...expertIdentitySchema },
        { additionalProperties: false },
    ),
]);

/**
 * The durable note one call keeps in the module's shared store while its expert works.
 *
 * It is written in the transaction that creates the expert. A call that waits to the end erases
 * it in the transaction that commits its result, so it exists exactly while an answer is owed to
 * that call. A call the person interrupted instead commits `detached` together with marking the
 * note `awaiting`: the answer is now owed to the conversation as a message. Once that message is
 * delivered the note stays behind as `reported`, so the same call executed again still finds its
 * expert rather than starting a second one; the sweep of old notes erases it a day later.
 */
export const expertPendingCallSchema = Type.Object(
    {
        parentId: collaborationAgentIdSchema,
        model: Type.String({ minLength: 1, maxLength: 256 }),
        modelName: Type.String({ minLength: 1, maxLength: 256 }),
        effort: Type.String({ minLength: 1, maxLength: 32 }),
        startedAt: Type.Number(),
        detached: Type.Optional(Type.Union([Type.Literal("awaiting"), Type.Literal("reported")])),
    },
    { additionalProperties: false },
);

/** What an expert's settlement recorded for the call waiting on it. */
export const expertOutcomeSchema = Type.Union([
    Type.Object({ output: Type.String() }, { additionalProperties: false }),
    Type.Object({ error: Type.String() }, { additionalProperties: false }),
]);

export type AskExpertInput = Static<typeof askExpertInputSchema>;
export type AskExpertResult = Static<typeof askExpertResultSchema>;
export type ExpertPendingCall = Static<typeof expertPendingCallSchema>;
export type ExpertOutcome = Static<typeof expertOutcomeSchema>;
export type ExpertVerification = Static<typeof expertVerificationSchema>;
