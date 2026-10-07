import { createHash } from "node:crypto";

import type { SessionTool } from "@/core/SessionTool.js";
import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";

/** A Chat Completions function tool as it is sent on the wire. */
export interface ChatCompletionsTool {
    readonly type: "function";
    readonly function: {
        readonly name: string;
        readonly description?: string;
        readonly parameters: Record<string, unknown>;
    };
}

/** The caller-facing identity a wire function name maps back to. */
export interface ChatCompletionsToolIdentity {
    readonly name: string;
    readonly namespace?: string;
    /**
     * The caller declared a grammar for this tool. Chat Completions has only JSON-schema
     * functions, so the call's text travels as the single `input` string and is unwrapped again.
     */
    readonly freeform: boolean;
}

/**
 * Stable, reversible function names for one request.
 *
 * Function names are limited to `[A-Za-z0-9_-]{1,64}`. A namespaced tool follows the Anthropic
 * protocol's portable convention, `mcp__<namespace>__<name>`. Anything outside the allowed
 * alphabet becomes `_`, and an over-long name keeps a readable prefix plus a short hash. Two tools
 * that still collide are told apart by a numeric suffix in declaration order. The map is the
 * authority for turning a streamed name back into the caller's name and namespace.
 */
export class ChatCompletionsToolNames {
    readonly #byWire = new Map<string, ChatCompletionsToolIdentity>();
    readonly #byIdentity = new Map<string, string>();

    constructor(tools: readonly SessionTool[]) {
        for (const tool of tools) {
            if (tool.server !== undefined) continue;
            const key = identityKey(tool);
            if (this.#byIdentity.has(key)) continue;
            const base = baseWireName(tool);
            let wire = base;
            for (let suffix = 2; this.#byWire.has(wire); suffix += 1) {
                const tail = `_${suffix}`;
                wire = `${base.slice(0, MAX_FUNCTION_NAME_LENGTH - tail.length)}${tail}`;
            }
            this.#byWire.set(wire, {
                name: tool.name,
                ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
                freeform: tool.grammar !== undefined,
            });
            this.#byIdentity.set(key, wire);
        }
    }

    /** The wire name of a declared tool, or the deterministic projection of an undeclared one. */
    wireName(tool: { readonly name: string; readonly namespace?: string }): string {
        return this.#byIdentity.get(identityKey(tool)) ?? baseWireName(tool);
    }

    /** The declared tool a streamed function name refers to. */
    resolve(wireName: string): ChatCompletionsToolIdentity | undefined {
        return this.#byWire.get(wireName);
    }

    /** Whether the declared tool with this identity is freeform. */
    isFreeform(tool: { readonly name: string; readonly namespace?: string }): boolean {
        const wire = this.#byIdentity.get(identityKey(tool));
        return wire === undefined ? false : this.#byWire.get(wire)?.freeform === true;
    }
}

/**
 * Projects caller tools onto JSON-schema functions.
 *
 * Server tools are provider-native descriptors this protocol has no way to run, so they are left
 * out. `defer` asks for native tool discovery, which Chat Completions does not have; such tools
 * are sent eagerly, exactly as providers without discovery treat them. A grammar tool becomes a
 * function taking one `input` string, with its grammar stated in the description.
 */
export function toChatCompletionsTools(
    tools: readonly SessionTool[],
    names: ChatCompletionsToolNames,
): ChatCompletionsTool[] {
    const output: ChatCompletionsTool[] = [];
    const seen = new Set<string>();
    for (const tool of tools) {
        if (tool.server !== undefined) continue;
        const name = names.wireName(tool);
        if (seen.has(name)) continue;
        seen.add(name);
        if (tool.grammar !== undefined) {
            output.push({
                type: "function",
                function: {
                    name,
                    description: freeformDescription(tool),
                    parameters: {
                        type: "object",
                        properties: {
                            input: {
                                type: "string",
                                description:
                                    "The complete raw input for this tool, written exactly as the grammar requires.",
                            },
                        },
                        required: ["input"],
                        additionalProperties: false,
                    },
                },
            });
            continue;
        }
        output.push({
            type: "function",
            function: {
                name,
                ...(tool.description === undefined ? {} : { description: tool.description }),
                parameters: toLlmParametersSchema(tool.parameters),
            },
        });
    }
    return output;
}

/** Extracts the raw text of a freeform call from its JSON arguments. */
export function unwrapFreeformArguments(argumentsJson: string): string {
    try {
        const value: unknown = JSON.parse(argumentsJson);
        if (
            typeof value === "object" &&
            value !== null &&
            "input" in value &&
            typeof value.input === "string"
        ) {
            return value.input;
        }
    } catch {
        // A truncated or malformed call is handed over as written.
    }
    return argumentsJson;
}

const MAX_FUNCTION_NAME_LENGTH = 64;

function baseWireName(tool: { readonly name: string; readonly namespace?: string }): string {
    const joined =
        tool.namespace === undefined ? tool.name : `mcp__${tool.namespace}__${tool.name}`;
    if (joined.length <= MAX_FUNCTION_NAME_LENGTH && /^[A-Za-z0-9_-]+$/.test(joined)) return joined;
    // Sanitizing can merge distinct names and truncation can too; a hash of the original keeps
    // them apart while the prefix stays readable to the model.
    return withHash(joined.replace(/[^A-Za-z0-9_-]/g, "_") || "tool", joined);
}

function withHash(sanitized: string, original: string): string {
    const hash = createHash("sha256").update(original).digest("hex").slice(0, 8);
    const prefixLength = Math.min(sanitized.length, MAX_FUNCTION_NAME_LENGTH - hash.length - 1);
    return `${sanitized.slice(0, prefixLength)}_${hash}`;
}

function identityKey(tool: { readonly name: string; readonly namespace?: string }): string {
    return `${tool.namespace ?? ""}\u0000${tool.name}`;
}

function freeformDescription(tool: SessionTool): string {
    const grammar = tool.grammar?.grammar ?? "";
    const note =
        "Pass the complete raw input as the `input` string. It is not JSON; it must match this Lark grammar:\n" +
        grammar;
    return tool.description === undefined || tool.description.length === 0
        ? note
        : `${tool.description}\n\n${note}`;
}
