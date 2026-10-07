import { Type, type Static } from "@sinclair/typebox";
import type { FileContentResponse, FileRevisionResponse } from "@kissopen/kissopen-agent-client";
import { ProjectFileError } from "../files/index.js";
import type { GitResource } from "../git/index.js";

/** Leaves room for file base64, encryption and the relay's second base64 envelope. */
export const KISSOPEN_READ_MAX_BYTES = 512 * 1024;
/** One part of a file read in parts; smaller than a whole read, for the same envelope. */
export const KISSOPEN_READ_PART_MAX_BYTES = 384 * 1024;
/** The largest file read in parts: a document the phone previews, not a data set. */
export const KISSOPEN_READ_PARTS_MAX_FILE_BYTES = 32 * 1024 * 1024;
export const KISSOPEN_RPC_MAX_JSON_BYTES = 700_000;

export const kissopenGitStateRequestSchema = Type.Object({}, { additionalProperties: true });
export const kissopenReadFileRequestSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 16_384 }),
        /**
         * Read one part of the file instead of all of it: `length` bytes from `offset`. The
         * answer carries the file's whole `size`, so a reader knows how many parts to ask
         * for. Older daemons ignore both and answer with the whole file, or refuse a large one.
         */
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        length: Type.Optional(Type.Integer({ minimum: 1, maximum: KISSOPEN_READ_PART_MAX_BYTES })),
    },
    { additionalProperties: true },
);
export const kissopenReadFileAtRevisionRequestSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 16_384 }),
        revision: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
    },
    { additionalProperties: true },
);
export type KissopenReadFileRequest = Static<typeof kissopenReadFileRequestSchema>;
/**
 * One part of a file sent into the session's workspace, from a desktop or phone uploading it.
 * Parts are at most a read part in size, so each fits the relay's envelope like a read does.
 */
export const kissopenUploadFileRequestSchema = Type.Object(
    {
        path: Type.String({ minLength: 1, maxLength: 16_384 }),
        uploadId: Type.String({ pattern: "^[A-Za-z0-9_-]{8,64}$" }),
        offset: Type.Integer({ minimum: 0 }),
        content: Type.String({ maxLength: Math.ceil(KISSOPEN_READ_PART_MAX_BYTES / 3) * 4 }),
        done: Type.Boolean(),
    },
    { additionalProperties: true },
);
export type KissopenUploadFileRequest = Static<typeof kissopenUploadFileRequestSchema>;
export type KissopenUploadFileResponse =
    | { success: true; done: false; received: number }
    | { success: true; done: true; path: string; size: number; hash: string }
    | KissopenReadFailure;
/** One folder of the session's workspace; `""` or the workspace's own path is its root. */
export const kissopenListDirectoryRequestSchema = Type.Object(
    { path: Type.String({ maxLength: 16_384 }) },
    { additionalProperties: true },
);
export type KissopenListDirectoryRequest = Static<typeof kissopenListDirectoryRequestSchema>;
/** How many entries of one folder are listed; a larger folder says it was cut short. */
export const KISSOPEN_LIST_MAX_ENTRIES = 2_000;
export type KissopenDirectoryEntry = {
    name: string;
    type: "file" | "directory" | "other";
    size: number;
    modified: number;
};
export type KissopenListDirectoryResponse =
    | { success: true; path: string; entries: KissopenDirectoryEntry[]; truncated: boolean }
    | KissopenReadFailure;
export type KissopenReadFileAtRevisionRequest = Static<
    typeof kissopenReadFileAtRevisionRequestSchema
>;
export type KissopenReadFailure = {
    success: false;
    code: Exclude<ProjectFileError["code"], "conflict"> | "unsupported";
    error: string;
};
export type KissopenGitStateResponse = { success: true; git: GitResource } | KissopenReadFailure;
export type KissopenReadFileResponse =
    | ({ success: true; size?: number } & FileContentResponse)
    | KissopenReadFailure;
export type KissopenReadFileAtRevisionResponse =
    | ({ success: true } & FileRevisionResponse)
    | KissopenReadFailure;

export function kissopenReadFailure(error: unknown): KissopenReadFailure {
    if (error instanceof KissopenReadRefused || error instanceof ProjectFileError) {
        return {
            success: false,
            code: error.code === "conflict" ? "unavailable" : error.code,
            error: error.message,
        };
    }
    return {
        success: false,
        code: "unavailable",
        error: "The workspace could not be read. Try again shortly.",
    };
}

/** A safe explanation for the phone, never a raw filesystem or Git error. */
export class KissopenReadRefused extends Error {
    constructor(
        readonly code: KissopenReadFailure["code"],
        message: string,
    ) {
        super(message);
        this.name = "KissopenReadRefused";
    }
}
