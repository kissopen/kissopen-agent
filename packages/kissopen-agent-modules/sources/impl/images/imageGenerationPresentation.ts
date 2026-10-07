import { Type, type Static } from "@sinclair/typebox";

import { getImageProcessor } from "./getImageProcessor.js";

/** The longest side of the inline preview, in pixels. */
export const IMAGE_GENERATION_PREVIEW_MAX_SIDE = 512;
/** The preview's largest allowed size before base64, so a transcript row stays light. */
export const IMAGE_GENERATION_PREVIEW_MAX_BYTES = 96 * 1024;
/** Base64 grows bytes by 4/3; this bounds the field the preview travels in. */
export const MAX_IMAGE_GENERATION_PREVIEW_LENGTH = 132_000;
export const MAX_IMAGE_GENERATION_PATH_LENGTH = 4_096;
export const MAX_IMAGE_GENERATION_MEDIA_TYPE_LENGTH = 256;
/** More pixels than any generated picture has; a decode above it is refused, not attempted. */
const MAX_DECODED_PIXELS = 64 * 1024 * 1024;

/**
 * What a finished image-generation call shows a person, as the API publishes it.
 *
 * Outcome-derived like a file diff: absent while the call runs, present when it completes. The
 * full-resolution file lives in the generated-files folder, outside every workspace root, so a
 * client cannot read it through the workspace file routes; `preview` is the same picture small
 * enough to travel inside the tool result and be drawn the moment the call completes.
 */
export const imageGenerationPresentationSchema = Type.Object(
    {
        type: Type.Literal("image_generation"),
        path: Type.String({ minLength: 1, maxLength: MAX_IMAGE_GENERATION_PATH_LENGTH }),
        mediaType: Type.String({ minLength: 1, maxLength: MAX_IMAGE_GENERATION_MEDIA_TYPE_LENGTH }),
        bytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        width: Type.Integer({ minimum: 1, maximum: 65_536 }),
        height: Type.Integer({ minimum: 1, maximum: 65_536 }),
        /** Base64 WebP, at most 512 px on its longest side and 96 KB before encoding. */
        preview: Type.String({ minLength: 1, maxLength: MAX_IMAGE_GENERATION_PREVIEW_LENGTH }),
    },
    { additionalProperties: false },
);

export type ImageGenerationPresentation = Static<typeof imageGenerationPresentationSchema>;

/**
 * Renders the presentation for one finished picture.
 *
 * The preview is encoded at 512 px and quality 80 first, which fits almost every generated
 * picture in a few tens of kilobytes. A busy picture that still overflows the byte budget is
 * encoded again smaller and rougher rather than shipped over budget or dropped: a coarse preview
 * a reader can see beats a row that says nothing until they open the file.
 */
export async function imageGenerationPresentation(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly path: string;
}): Promise<ImageGenerationPresentation> {
    const processor = await getImageProcessor();
    const metadata = await processor.metadata(input.bytes, {
        autoOrient: true,
        maxPixels: MAX_DECODED_PIXELS,
    });
    const attempts = [
        { side: IMAGE_GENERATION_PREVIEW_MAX_SIDE, quality: 80 },
        { side: 384, quality: 70 },
        { side: 256, quality: 60 },
    ];
    let preview: Buffer | undefined;
    for (const attempt of attempts) {
        const encoded = await processor.encode(input.bytes, {
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
        preview = encoded.data;
        if (preview.byteLength <= IMAGE_GENERATION_PREVIEW_MAX_BYTES) break;
    }
    if (preview === undefined) throw new Error("The generated picture could not be previewed.");
    return {
        type: "image_generation",
        path: input.path,
        mediaType: input.mediaType,
        bytes: input.bytes.byteLength,
        width: metadata.width,
        height: metadata.height,
        preview: preview.toString("base64"),
    };
}
