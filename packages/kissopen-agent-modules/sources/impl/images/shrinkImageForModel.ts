import { getImageProcessor } from "./getImageProcessor.js";

/** An image this size or smaller, in base64 characters, is sent as it is. */
export const MODEL_IMAGE_KEEP_LENGTH = 300 * 1024;
/** The longest side a shrunk image keeps: enough to read a screenshot's text. */
const MODEL_IMAGE_MAX_SIDE = 1568;
/** More pixels than any picture worth showing a model; a decode above it is refused. */
const MAX_DECODED_PIXELS = 64 * 1024 * 1024;

/**
 * One image, small enough to send a model again and again.
 *
 * A model reads a picture as a few hundred tokens at most whatever its file size, so a 2 MB PNG
 * costs nothing in understanding when it is sent as a 1568 px WebP of a tenth the size — and a
 * conversation that carries it on every request stops spending most of each request uploading it.
 * An image already small enough, or one that cannot be decoded, is returned unchanged.
 */
export async function shrinkImageForModel(image: {
    readonly data: string;
    readonly mimeType: string;
}): Promise<{ data: string; mimeType: string }> {
    if (image.data.length <= MODEL_IMAGE_KEEP_LENGTH) return image;
    try {
        const processor = await getImageProcessor();
        const input = Buffer.from(image.data, "base64");
        let best: Buffer | undefined;
        for (const attempt of [
            { side: MODEL_IMAGE_MAX_SIDE, quality: 82 },
            { side: 1024, quality: 75 },
            { side: 768, quality: 65 },
        ]) {
            const encoded = await processor.encode(input, {
                autoOrient: true,
                format: "webp",
                maxPixels: MAX_DECODED_PIXELS,
                quality: attempt.quality,
                resize: {
                    filter: "lanczos3",
                    fit: "inside",
                    height: attempt.side,
                    width: attempt.side,
                    withoutEnlargement: true,
                },
            });
            best = encoded.data;
            if ((best.byteLength * 4) / 3 <= MODEL_IMAGE_KEEP_LENGTH) break;
        }
        if (best === undefined || (best.byteLength * 4) / 3 >= image.data.length) return image;
        return { data: best.toString("base64"), mimeType: "image/webp" };
    } catch {
        return image;
    }
}
