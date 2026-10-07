import { Type } from "@sinclair/typebox";
import { defineAgentTool } from "@kissopen/kissopen-agent-base";

import type { Compute } from "../../Compute.js";
import { computePermissionsForContext } from "../../impl/computePermissionsForContext.js";
import { describeComputePathAction } from "../../impl/describeComputePathAction.js";
import type { FileReadLog } from "../../../impl/FileReadLog.js";
import { computeImageSchema, readImageForModel } from "../../impl/readImage.js";
import { shrinkImageForModel } from "../../../impl/images/shrinkImageForModel.js";
import { resolveComputePath } from "../../impl/resolveComputePath.js";
import { shouldReviewComputePath } from "../../impl/shouldReviewComputePath.js";

const viewImageResultSchema = Type.Object(
    {
        path: Type.String(),
        detail: Type.Union([Type.Literal("high"), Type.Literal("original")]),
        image: computeImageSchema,
    },
    { additionalProperties: false },
);

/**
 * Codex's own tool for looking at an image already on the machine.
 *
 * At the default `high` detail a large image is shown as a WebP at most 1568 px on its longest
 * side, which a model reads as well as the original: the result stays in the conversation, and
 * every later request carried a multi-megabyte screenshot again. `original` keeps the file's own
 * bytes, for when exact pixels matter.
 */
export function codexViewImageTool(compute: Compute, reads: FileReadLog) {
    return defineAgentTool({
        name: "view_image",
        defer: false,
        capabilities: [
            "Read and modify files, run shell commands, inspect images, and manage background processes.",
        ],
        description:
            "View a local image file from the filesystem when visual inspection is needed. Use this for images already available on disk. PNG, JPEG, GIF, WebP, and BMP files are supported.",
        parameters: Type.Object(
            {
                path: Type.String({ description: "Local filesystem path to an image file." }),
                detail: Type.Optional(
                    Type.Union([Type.Literal("high"), Type.Literal("original")], {
                        description:
                            "Image detail level. Defaults to `high`; use `original` to preserve exact resolution.",
                    }),
                ),
            },
            { additionalProperties: false },
        ),
        returnType: viewImageResultSchema,
        // Looking at a file changes nothing, so an interrupted call may simply look again.
        durable: true,
        reloadable: true,
        // The read it records must commit with the result, or the agent could be told it has seen
        // a file the log never learned about.
        transactional: true,
        describeAutoPermissionAction: ({ path }) =>
            describeComputePathAction(compute, path, "viewing"),
        shouldReviewInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        shouldRunInFullAccessInAutoMode: ({ path }, ctx) =>
            shouldReviewComputePath(compute, path, { write: false }, ctx),
        execute: async (ctx, { detail, path }) => {
            const permissions = computePermissionsForContext(ctx);
            const filePath = resolveComputePath(path, compute.cwd, compute.fs.home);
            const read = await readImageForModel(compute, reads, ctx, permissions, filePath);
            const image =
                detail === "original"
                    ? read
                    : await shrinkImageForModel({ data: read.data, mimeType: read.mime_type }).then(
                          (small) =>
                              small.data === read.data
                                  ? read
                                  : {
                                        data: small.data,
                                        mime_type: small.mimeType,
                                        bytes: Math.floor((small.data.length * 3) / 4),
                                    },
                      );
            return { path: filePath, detail: detail ?? "high", image };
        },
        toLLM: ({ image, path }) => [
            { type: "text", text: `Image: ${path}` },
            { type: "image", data: image.data, mimeType: image.mime_type },
        ],
    });
}
