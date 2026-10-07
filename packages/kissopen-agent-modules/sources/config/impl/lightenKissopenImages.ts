import type { SessionContext, SessionMessage } from "@kissopen/kissopen-providers";

import { shrinkImageForModel } from "../../impl/images/shrinkImageForModel.js";

/** Images from this many of the person's latest messages onwards are still sent. */
const RECENT_USER_TURNS = 2;
/** The most image data, in base64 characters, one request carries. */
const IMAGE_BUDGET_LENGTH = 1024 * 1024;
/** Shrunk images kept for the next request, which carries the same ones again. */
const SHRUNK_CACHE_SIZE = 32;

const OMITTED_TEXT =
    "[An earlier image was left out of this request to keep it small. If you need to look at it again, open its file with view_image.]";

type ImageBlock = { readonly type: "image"; readonly data: string; readonly mimeType: string };
type Block = { readonly type: string };

const shrunkCache = new Map<string, { data: string; mimeType: string }>();

/*
What the KISSOPEN server is sent of a conversation's images.

Every request carries the whole conversation, and Agent Base keeps up to 4 MB of its newest
images in it. Through the server and the model pool behind it, a conversation holding a few
generated pictures took half a minute or more to answer a one-word message, while a new one
answered in seconds: the time went on moving the same megabytes again. A chat product sends a
picture while it is being talked about, small, and afterwards only says it was there. So do
these requests: images from before the person's last two messages become a note, the rest are
shrunk to a WebP a model reads just as well, and all of them together stay within 1 MB. Durable
history keeps every image as it was; this is a view for one request.
*/
export async function lightenKissopenImages(context: SessionContext): Promise<SessionContext> {
    const messages = context.messages;
    const userIndexes: number[] = [];
    messages.forEach((message, index) => {
        if (message.role === "user") userIndexes.push(index);
    });
    const recentFrom =
        userIndexes.length >= RECENT_USER_TURNS
            ? userIndexes[userIndexes.length - RECENT_USER_TURNS]!
            : 0;

    let spent = 0;
    let kept = 0;
    let changed = false;
    const admit = async (image: ImageBlock, recent: boolean): Promise<Block> => {
        if (!recent) {
            changed = true;
            return { type: "text", text: OMITTED_TEXT } as Block;
        }
        const small = await shrunk(image);
        if (kept > 0 && spent + small.data.length > IMAGE_BUDGET_LENGTH) {
            changed = true;
            return { type: "text", text: OMITTED_TEXT } as Block;
        }
        kept += 1;
        spent += small.data.length;
        if (small.data === image.data) return image;
        changed = true;
        return { ...image, data: small.data, mimeType: small.mimeType } as Block;
    };
    const lighten = async (
        content: readonly Block[],
        recent: boolean,
    ): Promise<Block[] | undefined> => {
        if (!content.some((block) => block.type === "image")) return undefined;
        const next = [...content];
        for (let at = next.length - 1; at >= 0; at -= 1) {
            const block = next[at]!;
            if (block.type === "image") next[at] = await admit(block as ImageBlock, recent);
        }
        return next;
    };

    // Newest first, so the budget goes to what the person is looking at now.
    const result = [...messages];
    for (let index = result.length - 1; index >= 0; index -= 1) {
        const message = result[index]!;
        const recent = index >= recentFrom;
        if (message.role === "assistant") {
            const content = [...message.content] as Block[];
            let touched = false;
            for (let at = content.length - 1; at >= 0; at -= 1) {
                const block = content[at] as Block & { content?: readonly Block[] };
                if (block.type !== "tool_result" || block.content === undefined) continue;
                const inner = await lighten(block.content, recent);
                if (inner === undefined) continue;
                content[at] = { ...block, content: inner } as Block;
                touched = true;
            }
            if (touched) result[index] = { ...message, content } as SessionMessage;
        } else if ("content" in message && Array.isArray(message.content)) {
            const content = await lighten(message.content as readonly Block[], recent);
            if (content !== undefined) result[index] = { ...message, content } as SessionMessage;
        }
    }
    return changed ? { ...context, messages: result } : context;
}

async function shrunk(image: ImageBlock): Promise<{ data: string; mimeType: string }> {
    const key = `${String(image.data.length)}:${image.data.slice(0, 64)}:${image.data.slice(-64)}`;
    const cached = shrunkCache.get(key);
    if (cached !== undefined) return cached;
    const small = await shrinkImageForModel(image);
    shrunkCache.set(key, small);
    while (shrunkCache.size > SHRUNK_CACHE_SIZE) {
        const oldest = shrunkCache.keys().next().value;
        if (oldest === undefined) break;
        shrunkCache.delete(oldest);
    }
    return small;
}
