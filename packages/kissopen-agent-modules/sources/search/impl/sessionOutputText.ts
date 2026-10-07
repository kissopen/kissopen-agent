import type { SessionOutputBlock } from "@kissopen/kissopen-providers";

/** The plain text a provider streamed back as the result of one of its own tool calls. */
export function sessionOutputText(content: readonly SessionOutputBlock[]): string {
    return content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}
