import sharp from "sharp";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    IMAGE_GENERATION_PREVIEW_MAX_BYTES,
    IMAGE_GENERATION_PREVIEW_MAX_SIDE,
    imageGenerationPresentation,
    imageGenerationPresentationSchema,
} from "../../sources/impl/images/imageGenerationPresentation.js";

async function picture(width: number, height: number, noisy: boolean): Promise<Uint8Array> {
    const raw = Buffer.alloc(width * height * 3);
    for (let index = 0; index < raw.length; index += 3) {
        const x = (index / 3) % width;
        raw[index] = noisy ? Math.floor(Math.random() * 256) : Math.floor((x / width) * 255);
        raw[index + 1] = noisy ? Math.floor(Math.random() * 256) : 120;
        raw[index + 2] = noisy ? Math.floor(Math.random() * 256) : 200;
    }
    return new Uint8Array(
        await sharp(raw, { raw: { width, height, channels: 3 } })
            .png()
            .toBuffer(),
    );
}

describe("image generation presentation", () => {
    it("describes the picture and carries a preview no larger than the transcript allows", async () => {
        const bytes = await picture(1600, 900, false);
        const presentation = await imageGenerationPresentation({
            bytes,
            mediaType: "image/png",
            path: "/tmp/generated/wide.png",
        });
        expect(Value.Check(imageGenerationPresentationSchema, presentation)).toBe(true);
        expect(presentation).toMatchObject({
            type: "image_generation",
            path: "/tmp/generated/wide.png",
            mediaType: "image/png",
            bytes: bytes.byteLength,
            width: 1600,
            height: 900,
        });
        const preview = Buffer.from(presentation.preview, "base64");
        expect(preview.byteLength).toBeLessThanOrEqual(IMAGE_GENERATION_PREVIEW_MAX_BYTES);
        const meta = await sharp(preview).metadata();
        expect(meta.format).toBe("webp");
        expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(IMAGE_GENERATION_PREVIEW_MAX_SIDE);
    });

    it("shrinks a picture that will not compress rather than shipping it over budget", async () => {
        const bytes = await picture(1024, 1024, true);
        const presentation = await imageGenerationPresentation({
            bytes,
            mediaType: "image/png",
            path: "/tmp/generated/noise.png",
        });
        const preview = Buffer.from(presentation.preview, "base64");
        expect(preview.byteLength).toBeLessThanOrEqual(IMAGE_GENERATION_PREVIEW_MAX_BYTES);
        expect(presentation.width).toBe(1024);
    });
});
