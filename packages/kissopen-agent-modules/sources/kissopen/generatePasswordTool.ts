import { randomInt } from "node:crypto";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type } from "@sinclair/typebox";

const groups = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%*-_+=?",
] as const;
const alphabet = groups.join("");

/** Generates a new secret locally; never reads credentials or sends them to a site. */
export function generatePasswordTool() {
    return defineAgentTool({
        name: "generate_password",
        defer: false,
        description:
            "Generate a cryptographically random NEW password for the user's authorized task. Default length is 24, with uppercase, lowercase, digits and symbols. Generate once, use that same value for the new-password and confirmation fields with the browser tool, and continue the task. Return the generated password to the user after verifying the result when requested. Never use this to retrieve existing credentials, invent a completed registration, or bypass a required final-step confirmation.",
        parameters: Type.Object(
            { length: Type.Optional(Type.Integer({ minimum: 16, maximum: 128 })) },
            { additionalProperties: false },
        ),
        returnType: Type.Object({ password: Type.String({ minLength: 16, maxLength: 128 }) }),
        shouldReviewInAutoMode: () => false,
        durable: false,
        reloadable: false,
        execute: async (_ctx, { length = 24 }) => {
            const characters = groups.map((group) => group[randomInt(group.length)]!);
            while (characters.length < length)
                characters.push(alphabet[randomInt(alphabet.length)]!);
            for (let index = characters.length - 1; index > 0; index--) {
                const other = randomInt(index + 1);
                [characters[index], characters[other]] = [characters[other]!, characters[index]!];
            }
            return { password: characters.join("") };
        },
        toLLM: ({ password }) => [{ type: "text" as const, text: JSON.stringify({ password }) }],
    });
}
