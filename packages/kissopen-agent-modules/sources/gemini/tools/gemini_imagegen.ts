import { defineAgentTool } from "@kissopen/kissopen-agent-base";
import { Type } from "@sinclair/typebox";

import type { ConfigModule } from "../../config/index.js";
import { decodeAndValidateImage } from "../../impl/images/decodeAndValidateImage.js";
import {
    imageGenerationPresentation,
    imageGenerationPresentationSchema,
} from "../../impl/images/imageGenerationPresentation.js";
import { readReferenceImages } from "../../impl/images/readReferenceImages.js";
import { writeGeneratedImageFile } from "../../impl/images/writeGeneratedImageFile.js";
import { quoteVisibleExact } from "../../impl/quoteVisibleExact.js";
import type { GeminiConnection } from "../Gemini.js";
import {
    DEFAULT_GEMINI_IMAGE_MODEL,
    GEMINI_ASPECT_RATIOS,
    GEMINI_IMAGE_MODELS,
    GEMINI_IMAGE_SIZES,
} from "../GeminiImageModels.js";
import { generateGeminiImage } from "../impl/generateGeminiImage.js";

/** The most reference images any model accepts, which bounds the argument itself. */
const MAX_REFERENCE_IMAGES = Math.max(
    ...GEMINI_IMAGE_MODELS.map((model) => model.maxReferenceImages),
);

const generatedImageSchema = Type.Object({
    bytes: Type.Number(),
    description: Type.Optional(Type.String()),
    image_base64: Type.String(),
    media_type: Type.Union([Type.Literal("image/png"), Type.Literal("image/jpeg")]),
    model: Type.String(),
    path: Type.String(),
    /** What a person sees of the picture; History keeps it beside the result. */
    presentation: imageGenerationPresentationSchema,
});

/** The file extension each format this tool publishes is saved under. */
const EXTENSIONS = { jpeg: "jpg", png: "png" } as const;

/** Every model listed for the argument description, so the caller can choose deliberately. */
const MODEL_GUIDE = GEMINI_IMAGE_MODELS.map(
    (model) => `- \`${model.id}\` (${model.name}): ${model.summary}`,
).join("\n");

/**
 * Gemini's image generation, published the way every generated image is.
 *
 * The tool follows the same approach as `codex_imagegen`: it needs only the credential behind it,
 * decodes the answer to prove it is a real image, publishes it into the generated-files folder
 * named after the tool call, and hands the model both the path and the image itself. The arguments
 * stay Gemini's own — its model catalog, its aspect ratios, its resolutions — because the two
 * vendor tools are separate definitions, not one shared surface.
 */
export function geminiGenerateImageTool(connection: GeminiConnection, config: ConfigModule) {
    return defineAgentTool({
        name: "gemini_imagegen",
        defer: true,
        capabilities: ["Generate new images and edit existing images."],
        searchKeywords: [
            "Gemini image generation",
            "Nano Banana",
            "create picture",
            "edit image",
            "generate visual",
        ],
        description: `Generate a new JPEG image with Gemini (Nano Banana) from a detailed visual prompt, optionally building on reference images you provide. This tool generates JPEGs only; the output format cannot be selected.

Models:
${MODEL_GUIDE}

Guidelines:
- Write a detailed visual prompt. Every other argument is optional.
- To edit, restyle, or combine existing pictures, pass their local paths in \`reference_image_paths\`; the prompt then describes the change you want.
- Use reference images for character consistency, object fidelity, and style matching. Omit them to create something entirely new.
- \`aspect_ratio\` and \`image_size\` must be ones the chosen model supports, and are refused before a generation is spent if they are not. Omit them to let the model match the reference image, or default to a square.
- When generating an image containing text, write the text out in the prompt first, then describe the image around it.
- The finished image is saved in the shared generated-files folder named in your environment instructions and returned to you.`,
        parameters: Type.Object({
            prompt: Type.String({ minLength: 2, description: "Detailed image generation prompt" }),
            model: Type.Optional(
                Type.Union(
                    GEMINI_IMAGE_MODELS.map((model) => Type.Literal(model.id)),
                    {
                        description: `Which Gemini image model generates the image; defaults to ${DEFAULT_GEMINI_IMAGE_MODEL}`,
                    },
                ),
            ),
            reference_image_paths: Type.Optional(
                Type.Array(Type.String(), {
                    description:
                        "Local paths of images the result is built from, for editing, composition, character consistency, or style",
                    maxItems: MAX_REFERENCE_IMAGES,
                }),
            ),
            aspect_ratio: Type.Optional(
                Type.Union(
                    GEMINI_ASPECT_RATIOS.map((ratio) => Type.Literal(ratio)),
                    {
                        description:
                            "Generated image aspect ratio; 1:4, 4:1, 1:8, and 8:1 are only supported by gemini-3.1-flash-image",
                    },
                ),
            ),
            image_size: Type.Optional(
                Type.Union(
                    GEMINI_IMAGE_SIZES.map((size) => Type.Literal(size)),
                    {
                        description:
                            "Generated image resolution; defaults to 1K. 0.5K is only supported by gemini-3.1-flash-image, and gemini-2.5-flash-image has one fixed size",
                    },
                ),
            ),
        }),
        returnType: generatedImageSchema,
        // Generating an image is billed work that leaves a file behind, so an interrupted call is
        // reported rather than run a second time.
        durable: false,
        requiresAutoOrFullAccess: true,
        describeAutoPermissionAction: ({ prompt, reference_image_paths }) =>
            `sending ${quoteVisibleExact(prompt)}${
                reference_image_paths === undefined || reference_image_paths.length === 0
                    ? ""
                    : ` and ${String(reference_image_paths.length)} local image reference(s)`
            } to Gemini image generation. Access: external Gemini API${
                reference_image_paths === undefined || reference_image_paths.length === 0
                    ? ""
                    : " and local filesystem read"
            }`,
        shouldReviewInAutoMode: () => true,
        // A referenced path is read straight off this machine, so an approved call has to carry
        // the access that read needs. A prompt on its own reaches nothing local.
        shouldRunInFullAccessInAutoMode: ({ reference_image_paths }) =>
            reference_image_paths !== undefined && reference_image_paths.length > 0,
        execute: async (ctx, args, call) => {
            const paths = args.reference_image_paths ?? [];
            const references = paths.length === 0 ? [] : await readReferenceImages(paths);
            const generated = await generateGeminiImage({
                apiKey: connection.apiKey,
                ...(connection.fetch === undefined ? {} : { fetch: connection.fetch }),
                ...(args.model === undefined ? {} : { model: args.model }),
                ...(args.aspect_ratio === undefined ? {} : { aspectRatio: args.aspect_ratio }),
                ...(args.image_size === undefined ? {} : { imageSize: args.image_size }),
                prompt: args.prompt,
                referenceImages: references.map((image) => ({
                    base64: image.bytes.toString("base64"),
                    mimeType: image.mediaType,
                })),
                ...(ctx.lifetime === undefined ? {} : { signal: ctx.lifetime }),
            });
            // Validate the returned bytes and derive the extension from the decoded image.
            const base64 = Buffer.from(generated.bytes).toString("base64");
            const image = await decodeAndValidateImage(base64, ["png", "jpeg"]);
            const fileName = `${call.id.replaceAll(/[^A-Za-z0-9_-]/gu, "_")}.${EXTENSIONS[image.format]}`;
            const path = await writeGeneratedImageFile(
                config.configuration.paths.generatedPath,
                fileName,
                image.bytes,
            );
            return {
                bytes: image.bytes.byteLength,
                ...(generated.text === undefined ? {} : { description: generated.text }),
                image_base64: base64,
                media_type: image.mediaType,
                model: args.model ?? DEFAULT_GEMINI_IMAGE_MODEL,
                path,
                presentation: await imageGenerationPresentation({
                    bytes: image.bytes,
                    mediaType: image.mediaType,
                    path,
                }),
            };
        },
        toLLM: (result) => [
            {
                type: "text",
                text: `Generated image at ${result.path} (${String(result.bytes)} bytes). The person already sees this picture in the conversation, right where the generation ran, so do not offer them a link, a download, or the file path; say what you made in a sentence if that helps.${result.description === undefined ? "" : `\n\n${result.description}`}`,
            },
            // The model sees what it made at preview size: enough to describe or edit it, and
            // a hundredth of the full picture. The full picture went back on every later turn
            // of the conversation — a handful of pictures made each request tens of megabytes,
            // more than the pool would answer — and edits read the file from disk anyway.
            { type: "image", mimeType: "image/webp", data: result.presentation.preview },
        ],
    });
}
