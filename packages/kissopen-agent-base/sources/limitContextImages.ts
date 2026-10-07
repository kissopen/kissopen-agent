import type {
    SessionImageBlock,
    SessionMessage,
    SessionTextBlock,
} from "@kissopen/kissopen-providers";

/**
 * The image data one request may carry, newest first. A picture is cheap in tokens and expensive
 * in bytes: a conversation far from its context window can still carry megabytes of base64 in
 * every request, and a provider that will not accept the request answers nothing at all.
 */
export const CONTEXT_IMAGE_BUDGET_BYTES = 4 * 1024 * 1024;
/** How many images one request may carry, newest first. */
export const CONTEXT_IMAGE_BUDGET_COUNT = 8;

/**
 * The conversation as a provider should receive it: every image the model is still likely to
 * look at, and a short note in place of each older one.
 *
 * Images are kept from the newest backwards while they fit the budget; from the first one that
 * does not, every older image is replaced, so the kept set only ever slides forward and the
 * history a provider session sees changes only when an image ages out. The newest image is
 * always kept, however large: it is the one the person just shared. Durable history is not
 * touched — this is a view for the request.
 */
export function limitContextImages(messages: readonly SessionMessage[]): SessionMessage[] {
    let kept = 0;
    let bytes = 0;
    let exhausted = false;
    const admit = (image: SessionImageBlock): boolean => {
        if (exhausted) return false;
        const size = image.data.length;
        if (
            kept > 0 &&
            (kept >= CONTEXT_IMAGE_BUDGET_COUNT || bytes + size > CONTEXT_IMAGE_BUDGET_BYTES)
        ) {
            exhausted = true;
            return false;
        }
        kept += 1;
        bytes += size;
        return true;
    };
    const blocks = <Block extends { readonly type: string }>(
        content: readonly Block[],
    ): Block[] | undefined => {
        let changed = false;
        const next = [...content];
        for (let index = next.length - 1; index >= 0; index -= 1) {
            const block = next[index]!;
            if (block.type !== "image") continue;
            if (admit(block as unknown as SessionImageBlock)) continue;
            next[index] = omitted(block as unknown as SessionImageBlock) as unknown as Block;
            changed = true;
        }
        return changed ? next : undefined;
    };

    const result = [...messages];
    for (let index = result.length - 1; index >= 0; index -= 1) {
        const message = result[index]!;
        if (
            message.role === "user" ||
            message.role === "system" ||
            message.role === "tool" ||
            message.role === "agent"
        ) {
            const content = blocks(message.content as readonly { readonly type: string }[]);
            if (content !== undefined) result[index] = { ...message, content } as SessionMessage;
        } else if (message.role === "assistant") {
            let changed = false;
            const content = [...message.content];
            for (let at = content.length - 1; at >= 0; at -= 1) {
                const block = content[at]!;
                if (block.type !== "tool_result") continue;
                const inner = blocks(block.content);
                if (inner === undefined) continue;
                content[at] = { ...block, content: inner } as typeof block;
                changed = true;
            }
            if (changed) result[index] = { ...message, content };
        }
    }
    return result;
}

function omitted(image: SessionImageBlock): SessionTextBlock {
    const kilobytes = Math.max(1, Math.round((image.data.length * 3) / 4 / 1024));
    return {
        type: "text",
        text:
            `[An earlier image (${image.mimeType}, about ${kilobytes} KB) is left out of this ` +
            "request to keep it small. You saw it when it was first shared; ask for it again " +
            "if you need to look at it.]",
    };
}
