import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
    mkdir,
    open,
    lstat,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buffer } from "node:stream/consumers";

import type { AgentModule } from "@kissopen/kissopen-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createRootContext, detach, type Context, type RootContext } from "@steve.kite/stdlib";
import { GitRevisionFileTooLargeError, type GitModule } from "../git/index.js";
import type { BotsModule } from "../bots/index.js";
import type { ProjectsModule } from "../projects/index.js";
import type { WorkspacesModule } from "../workspaces/index.js";
import { ProjectFileWatcher } from "./ProjectFileWatcher.js";
import { WorkspaceFileIndex } from "./WorkspaceFileIndex.js";

const MAX_FILE_BYTES = 44 * 1024 * 1024;
const MAX_CHANGED_PATHS = 256;
const MAX_SEARCH_RESULTS = 50;
const MAX_TREE_ENTRIES = 500;

export const relativeFilePathSchema = Type.String({
    maxLength: 16_384,
    pattern: "^(?!/)(?!.*\\\\)(?!.*\\u0000)(?:[^/]+(?:/[^/]+)*)?$",
});
export const fileSearchQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
        query: Type.String({ maxLength: 512 }),
    },
    { additionalProperties: false },
);
export const fileTreeQuerySchema = Type.Object(
    {
        cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TREE_ENTRIES })),
        path: Type.Optional(relativeFilePathSchema),
    },
    { additionalProperties: false },
);
export const fileReadQuerySchema = Type.Object(
    { path: relativeFilePathSchema },
    { additionalProperties: false },
);
/**
 * A read of a generated file by its absolute path: what a picture's presentation names.
 * The folder itself is not named here — a route matches the path to the folder first and
 * uses this schema only then; `read` still proves the path stays inside the folder.
 */
export const generatedFileReadQuerySchema = Type.Object(
    {
        path: Type.String({
            minLength: 2,
            maxLength: 16_384,
            pattern: "^/(?!.*\\\\)(?!.*\\u0000)(?!.*(?:^|/)\\.\\.(?:/|$)).+$",
        }),
    },
    { additionalProperties: false },
);
const fileReadInputSchema = Type.Object(
    { path: Type.String({ minLength: 1, maxLength: 16_384, pattern: "^[^\\u0000]+$" }) },
    { additionalProperties: false },
);
const fileReadLimitSchema = Type.Integer({ minimum: 1, maximum: MAX_FILE_BYTES });
export const fileRevisionQuerySchema = Type.Object(
    {
        path: relativeFilePathSchema,
        revision: Type.String({
            minLength: 1,
            maxLength: 256,
            pattern: "^(?!-)[A-Za-z0-9_./:~^{}@-]+$",
        }),
    },
    { additionalProperties: false },
);
/** Where parts of an upload wait, inside the root so the finished file moves rather than copies. */
const UPLOAD_STAGING = ".kissopen/uploading";
/** A staged upload nobody finished within a day is abandoned. */
const UPLOAD_STAGING_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * One part of a file sent in parts: the bytes from `offset`, appended to what earlier parts
 * brought. `done` on the last part moves the whole file to `path`, under a free name.
 */
export const fileUploadSchema = Type.Object(
    {
        path: relativeFilePathSchema,
        uploadId: Type.String({ pattern: "^[A-Za-z0-9_-]{8,64}$" }),
        offset: Type.Integer({ minimum: 0, maximum: MAX_FILE_BYTES }),
        content: Type.String({ maxLength: 1024 * 1024 }),
        done: Type.Boolean(),
    },
    { additionalProperties: false },
);
export type FileUploadInput = Static<typeof fileUploadSchema>;
/** Where an upload stands: how much has arrived, and, once done, where the file landed. */
export type FileUploadResult =
    | { readonly done: false; readonly received: number }
    | { readonly done: true; readonly path: string; readonly size: number; readonly hash: string };

export const fileWriteSchema = Type.Object(
    {
        content: Type.String({ maxLength: MAX_FILE_BYTES * 2 }),
        expectedHash: Type.Union([
            Type.Null(),
            Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
        ]),
        path: relativeFilePathSchema,
    },
    { additionalProperties: false },
);
export const projectFileCurrentHashSchema = Type.Union([
    Type.Null(),
    Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
]);
export const projectFilesEventSchema = Type.Object(
    {
        at: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        eventId: Type.String({ minLength: 1, maxLength: 128 }),
        paths: Type.Union([
            Type.Null(),
            Type.Array(relativeFilePathSchema, {
                maxItems: MAX_CHANGED_PATHS,
                uniqueItems: true,
            }),
        ]),
        type: Type.Literal("files_changed"),
        workspaceId: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
);

export type FileTreeQuery = Static<typeof fileTreeQuerySchema>;
export type FileSearchQuery = Static<typeof fileSearchQuerySchema>;
export type FileReadQuery = Static<typeof fileReadQuerySchema>;
export type FileRevisionQuery = Static<typeof fileRevisionQuerySchema>;
export type FileWriteInput = Static<typeof fileWriteSchema>;
export type ProjectFileCurrentHash = Static<typeof projectFileCurrentHashSchema>;
export type ProjectFilesEvent = Static<typeof projectFilesEventSchema>;
export type ProjectFilesEventListener = (
    ctx: Context,
    event: ProjectFilesEvent,
) => Promise<void> | void;
export type ProjectFilesUnsubscribe = () => void;

export interface ProjectFileRoot {
    readonly projectId: string;
    readonly workspaceId?: string;
    readonly root: string;
}

export interface FileTreeResult {
    readonly entries: readonly {
        readonly modified: number;
        readonly name: string;
        readonly path: string;
        readonly size: number;
        readonly type: "directory" | "file" | "other" | "symlink";
    }[];
    readonly nextCursor: string | null;
    readonly path: string;
}

export interface FileSearchResult {
    readonly files: readonly { readonly fileName: string; readonly path: string }[];
}

export interface FileReadResult {
    readonly content: string;
    readonly hash: string;
}

/** Part of a file: `length` bytes from `offset`, for a reader that cannot take it whole. */
export interface FileReadRange {
    readonly offset: number;
    readonly length: number;
}

/** A part of a file, the file's whole size, and the part's own hash. */
export interface FileSliceResult extends FileReadResult {
    readonly size: number;
}

export interface FileWriteResult {
    readonly hash: string;
}

interface ComparedWriteResult extends FileWriteResult {
    readonly created: boolean;
}

export class ProjectFileError extends Error {
    readonly code: "conflict" | "forbidden" | "invalid" | "missing" | "too_large" | "unavailable";
    /** The file hash observed by the failed compare-and-swap, or null when it was absent. */
    readonly currentHash: ProjectFileCurrentHash;
    readonly status: 400 | 403 | 404 | 409 | 413 | 503;

    constructor(
        status: ProjectFileError["status"],
        code: ProjectFileError["code"],
        message: string,
        currentHash: ProjectFileCurrentHash = null,
    ) {
        super(message);
        if (!Value.Check(projectFileCurrentHashSchema, currentHash)) {
            throw new Error("The project file conflict hash is invalid.");
        }
        this.name = "ProjectFileError";
        this.code = code;
        this.currentHash = currentHash;
        this.status = status;
    }
}

export class ProjectFilesModule implements AgentModule {
    readonly name = "files";

    readonly #git: GitModule;
    readonly #bots: BotsModule | undefined;
    readonly #listeners = new Set<ProjectFilesEventListener>();
    readonly #projects: ProjectsModule;
    readonly #index = new WorkspaceFileIndex();
    readonly #workspaces: WorkspacesModule;
    readonly #writeLocks = new Map<string, Promise<void>>();
    #closed = false;
    #lifetime: RootContext | undefined;
    #watcher: ProjectFileWatcher | undefined;

    constructor(
        projects: ProjectsModule,
        workspaces: WorkspacesModule,
        git: GitModule,
        bots?: BotsModule,
    ) {
        this.#bots = bots;
        this.#git = git;
        this.#projects = projects;
        this.#workspaces = workspaces;
    }

    /** Adopts the collection lifetime for filesystem watches that outlive one API request. */
    readonly beforeStart = (ctx: Context): void => {
        this.#lifetime ??= detach(ctx);
    };

    onEvent(listener: ProjectFilesEventListener): ProjectFilesUnsubscribe {
        if (typeof listener !== "function") {
            throw new Error("A project files subscriber must be a function.");
        }
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        this.#listeners.clear();
        this.#index.close();
        await this.#watcher?.close();
        this.#watcher = undefined;
    }

    async resolveRoot(
        ctx: Context,
        projectId: string,
        workspaceId?: string,
    ): Promise<ProjectFileRoot> {
        const project = await this.#projects.get(ctx, projectId);
        if (project === undefined) {
            throw new ProjectFileError(404, "missing", "The project was not found.");
        }
        const projectRoot = await this.#canonicalRoot(project.repositoryRef);
        if (workspaceId === undefined) {
            return { projectId, root: projectRoot };
        }
        const workspace = await this.#workspaces.get(ctx, workspaceId);
        if (workspace === undefined || workspace.projectRef !== projectId) {
            throw new ProjectFileError(404, "missing", "The workspace was not found.");
        }
        if (workspace.status !== "ready") {
            throw new ProjectFileError(
                409,
                "conflict",
                "Only ready, available workspaces can access files.",
            );
        }
        // The workspace record says where it lives. A managed worktree sits in the agent's
        // workspaces directory, not inside the project, so deriving a path from the project would
        // name a folder that does not exist and hide the one that does.
        try {
            return {
                projectId,
                workspaceId,
                root: await this.#canonicalRoot(workspace.path),
            };
        } catch (error) {
            if (error instanceof ProjectFileError && error.status === 403) throw error;
            throw new ProjectFileError(
                409,
                "conflict",
                "Only ready, available workspaces can access files.",
            );
        }
    }

    /** Resolve one unlisted bot workspace through the catalog that owns its physical folder. */
    async resolveBotRoot(ctx: Context, workspaceId: string): Promise<ProjectFileRoot> {
        const bot = await this.#bots?.forWorkspace(ctx, workspaceId);
        if (bot === undefined) {
            throw new ProjectFileError(404, "missing", "The workspace was not found.");
        }
        if (bot.status !== "active") {
            throw new ProjectFileError(409, "conflict", "The workspace is not available.");
        }
        return {
            projectId: bot.id,
            workspaceId: bot.workspaceId,
            root: await this.#canonicalRoot(bot.path),
        };
    }

    async search(root: ProjectFileRoot, query: FileSearchQuery): Promise<FileSearchResult> {
        assertSchema(fileSearchQuerySchema, query, "file search query");
        try {
            return {
                files: await this.#index.search(
                    root.root,
                    query.query,
                    query.limit ?? MAX_SEARCH_RESULTS,
                ),
            };
        } catch {
            throw new ProjectFileError(
                503,
                "unavailable",
                "Workspace files could not be indexed. Try again shortly.",
            );
        }
    }

    async tree(root: ProjectFileRoot, query: FileTreeQuery): Promise<FileTreeResult> {
        assertSchema(fileTreeQuerySchema, query, "file tree query");
        const path = query.path ?? "";
        const directory = await this.#resolveExisting(root.root, path, true);
        const information = await lstat(directory);
        if (!information.isDirectory()) {
            throw new ProjectFileError(400, "invalid", "The file-tree path must be a directory.");
        }
        this.#watcherInstance().watchDirectory(root, path, directory);
        const entries = await readdir(directory, { withFileTypes: true });
        const offset = parseCursor(query.cursor);
        const limit = query.limit ?? 100;
        const selected = entries
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(offset, offset + limit);
        const result = await Promise.all(
            selected.map(async (entry) => {
                const relativePath = path === "" ? entry.name : `${path}/${entry.name}`;
                const entryPath = join(directory, entry.name);
                const entryInformation = await lstat(entryPath);
                return {
                    modified: Math.trunc(entryInformation.mtimeMs),
                    name: entry.name,
                    path: relativePath,
                    size: entryInformation.isFile() ? entryInformation.size : 0,
                    type: entry.isDirectory()
                        ? ("directory" as const)
                        : entry.isFile()
                          ? ("file" as const)
                          : entry.isSymbolicLink()
                            ? ("symlink" as const)
                            : ("other" as const),
                };
            }),
        );
        return {
            entries: result,
            nextCursor:
                offset + selected.length < entries.length ? String(offset + selected.length) : null,
            path,
        };
    }

    /** Smaller transports may lower the ordinary file limit. HTTP paths remain relative. */
    async read(
        root: ProjectFileRoot,
        query: FileReadQuery,
        maximumBytes?: number,
    ): Promise<FileReadResult>;
    /**
     * With a range, `maximumBytes` bounds the whole file and only the range is read and
     * returned, with the file's size: how a reader behind a small message ceiling takes a
     * large file in parts. The same containment and regular-file checks apply.
     */
    async read(
        root: ProjectFileRoot,
        query: FileReadQuery,
        maximumBytes: number,
        range: FileReadRange,
    ): Promise<FileSliceResult>;
    async read(
        root: ProjectFileRoot,
        query: FileReadQuery,
        maximumBytes = MAX_FILE_BYTES,
        range?: FileReadRange,
    ): Promise<FileReadResult | FileSliceResult> {
        assertSchema(fileReadInputSchema, query, "file read query");
        assertSchema(fileReadLimitSchema, maximumBytes, "file read limit");
        if (query.path.split(/[\\/]/).some((part) => part === "..")) {
            throw new ProjectFileError(
                400,
                "invalid",
                "The path must not contain parent-directory traversal.",
            );
        }
        let relativePath = query.path;
        if (isAbsolute(relativePath)) {
            this.#assertWithinRoot(relativePath, root.root);
            relativePath = relative(root.root, relativePath).split(sep).join("/");
        }
        const path = await this.#resolveExisting(root.root, relativePath, false);
        const handle = await open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
            const information = await handle.stat();
            if (!information.isFile())
                throw new ProjectFileError(
                    400,
                    "invalid",
                    "The requested path is not a regular file.",
                );
            const current = await this.#resolveExisting(root.root, relativePath, false);
            const currentInformation = await stat(current);
            if (
                current !== path ||
                information.dev !== currentInformation.dev ||
                information.ino !== currentInformation.ino
            ) {
                throw new ProjectFileError(
                    403,
                    "forbidden",
                    "The file location changed while it was being opened.",
                );
            }
            this.#assertSize(information.size, maximumBytes);
            if (range !== undefined) {
                if (
                    !Number.isSafeInteger(range.offset) ||
                    !Number.isSafeInteger(range.length) ||
                    range.offset < 0 ||
                    range.length < 1
                )
                    throw new ProjectFileError(400, "invalid", "The requested range is invalid.");
                // end is inclusive; a range past the end of the file reads nothing.
                const end = Math.min(information.size, range.offset + range.length) - 1;
                const slice =
                    end < range.offset
                        ? Buffer.alloc(0)
                        : await buffer(
                              handle.createReadStream({
                                  autoClose: false,
                                  start: range.offset,
                                  end,
                              }),
                          );
                return {
                    content: slice.toString("base64"),
                    hash: sha256(slice),
                    size: information.size,
                };
            }
            // end is inclusive: the extra byte detects growth without buffering the whole file.
            const bytes = await buffer(
                handle.createReadStream({ autoClose: false, end: maximumBytes }),
            );
            this.#assertSize(bytes.byteLength, maximumBytes);
            const relativeDirectory = dirname(relativePath);
            this.#watcherInstance().watchDirectory(
                root,
                relativeDirectory === "." ? "" : relativeDirectory,
                dirname(path),
            );
            this.#index.ensure(root.root, relativePath);
            return { content: bytes.toString("base64"), hash: sha256(bytes) };
        } finally {
            await handle.close();
        }
    }

    /** Strict callers distinguish missing paths from failed reads; HTTP keeps its preview default. */
    async readRevision(
        root: ProjectFileRoot,
        query: FileRevisionQuery,
        options: { maximumBytes?: number; strict?: boolean } = {},
    ): Promise<{ readonly content: string | null; readonly hash: string | null }> {
        const maximumBytes = options.maximumBytes ?? MAX_FILE_BYTES;
        assertSchema(fileRevisionQuerySchema, query, "file revision query");
        assertSchema(fileReadLimitSchema, maximumBytes, "file read limit");
        if (query.path.length === 0)
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        this.#assertRelativePath(query.path);
        try {
            const file = await this.#git.readFileAtRevision({
                maximumBytes,
                path: root.root,
                relativePath: query.path,
                revision: query.revision,
            });
            if (!file.found) return { content: null, hash: null };
            const bytes = Buffer.from(file.content);
            return { content: bytes.toString("base64"), hash: sha256(bytes) };
        } catch (error) {
            if (!options.strict) return { content: null, hash: null };
            if (error instanceof GitRevisionFileTooLargeError)
                throw new ProjectFileError(
                    413,
                    "too_large",
                    "The file exceeds the viewer size limit.",
                );
            throw error;
        }
    }

    async write(root: ProjectFileRoot, input: FileWriteInput): Promise<FileWriteResult> {
        assertSchema(fileWriteSchema, input, "file write request");
        if (input.path.length === 0) {
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        }
        this.#assertRelativePath(input.path);
        const bytes = decodeBase64(input.content);
        this.#assertSize(bytes.byteLength);
        const target = await this.#resolveWritePath(root.root, input.path);
        this.#assertWithinRoot(target, root.root);
        const result = await this.#withWriteLock(
            target,
            async () => await this.#writeCompared(target, input, bytes),
        );
        this.#git.invalidate(root.root);
        this.#git.markChanged({
            path: root.root,
            projectId: root.projectId,
            ...(root.workspaceId === undefined ? {} : { workspaceId: root.workspaceId }),
        });
        if (result.created) this.#index.refresh(root.root);
        this.#watcherInstance().changed(root, input.path);
        return { hash: result.hash };
    }

    /**
     * Takes one part of a file sent in parts, and on the last part publishes the whole file.
     *
     * Parts append to a staging file under `.kissopen/uploading/`, and each must start where
     * the last ended, so a part sent twice or out of order is refused rather than stitched in
     * wrong. The finished file never replaces one already there: it takes the next free name,
     * `报告 (1).pdf`, the way a download folder does.
     */
    async upload(root: ProjectFileRoot, input: FileUploadInput): Promise<FileUploadResult> {
        assertSchema(fileUploadSchema, input, "file upload part");
        this.#assertRelativePath(input.path);
        if (input.path.length === 0 || input.path.startsWith(`${UPLOAD_STAGING}/`)) {
            throw new ProjectFileError(400, "invalid", "A file path is required.");
        }
        const bytes = decodeBase64(input.content);
        const staging = join(root.root, UPLOAD_STAGING);
        const part = join(staging, `${input.uploadId}.part`);
        await mkdir(staging, { recursive: true, mode: 0o755 });
        return await this.#withWriteLock(part, async () => {
            const received = await stat(part).then(
                (information) => information.size,
                () => undefined,
            );
            if (input.offset === 0) {
                await this.#uploadSweep(staging);
                await writeFile(part, bytes, { mode: 0o600 });
            } else {
                if (received !== input.offset) {
                    throw new ProjectFileError(
                        409,
                        "conflict",
                        "This part does not continue the upload; start it again.",
                    );
                }
                this.#assertSize(input.offset + bytes.byteLength);
                await writeFile(part, bytes, { flag: "a" });
            }
            const size = input.offset + bytes.byteLength;
            if (!input.done) return { done: false, received: size };
            const target = await this.#resolveWritePath(root.root, input.path);
            this.#assertWithinRoot(target, root.root);
            await mkdir(dirname(target), { recursive: true, mode: 0o755 });
            const landed = await this.#freeName(target);
            await rename(part, landed);
            const hash = sha256(await readFile(landed));
            const path = relative(root.root, landed).split(sep).join("/");
            this.#git.invalidate(root.root);
            this.#git.markChanged({
                path: root.root,
                projectId: root.projectId,
                ...(root.workspaceId === undefined ? {} : { workspaceId: root.workspaceId }),
            });
            this.#index.refresh(root.root);
            this.#watcherInstance().changed(root, path);
            return { done: true, path, size, hash };
        });
    }

    /** `name.ext`, or the first of `name (1).ext`, `name (2).ext`, … that is not taken. */
    async #freeName(target: string): Promise<string> {
        const folder = dirname(target);
        const name = basename(target);
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        for (let copy = 0; copy < 1000; copy += 1) {
            const candidate = join(folder, copy === 0 ? name : `${stem} (${String(copy)})${extension}`);
            const taken = await lstat(candidate).then(
                () => true,
                () => false,
            );
            if (!taken) return candidate;
        }
        throw new ProjectFileError(409, "conflict", "Too many files with this name.");
    }

    /** Forgets uploads started more than a day ago and never finished. */
    async #uploadSweep(staging: string): Promise<void> {
        const names = await readdir(staging).catch(() => [] as string[]);
        const before = Date.now() - UPLOAD_STAGING_LIFETIME_MS;
        for (const name of names) {
            const path = join(staging, name);
            const information = await stat(path).catch(() => undefined);
            if (information !== undefined && information.mtimeMs < before) await rm(path, { force: true });
        }
    }

    async #writeCompared(
        target: string,
        input: FileWriteInput,
        bytes: Buffer,
    ): Promise<ComparedWriteResult> {
        let current: Buffer | undefined;
        try {
            current = await readFile(target);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (input.expectedHash === null && current !== undefined) {
            throw new ProjectFileError(
                409,
                "conflict",
                "The file already exists.",
                sha256(current),
            );
        }
        if (input.expectedHash !== null) {
            const currentHash = current === undefined ? null : sha256(current);
            if (currentHash !== input.expectedHash) {
                throw new ProjectFileError(
                    409,
                    "conflict",
                    "The file changed before it was written.",
                    currentHash,
                );
            }
        }
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
            await rename(temporary, target);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
        return { created: current === undefined, hash: sha256(bytes) };
    }

    /**
     * Serializes in-process compare-and-swap writes to one canonical path.
     *
     * A lock disappears as soon as its owner releases it, so idle paths retain no state and a
     * burst cannot leave an unbounded chain behind.
     */
    async #withWriteLock<Result>(path: string, work: () => Promise<Result>): Promise<Result> {
        const previous = this.#writeLocks.get(path);
        let release: (() => void) | undefined;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#writeLocks.set(path, current);
        await previous;
        try {
            return await work();
        } finally {
            release?.();
            if (this.#writeLocks.get(path) === current) {
                this.#writeLocks.delete(path);
            }
        }
    }

    /**
     * Proves the recorded folder is still the folder, then hands back its canonical form.
     *
     * A recorded path that now resolves somewhere else is a replaced folder, not a moved one: if
     * a project root or a workspace checkout were swapped for a link, following it would serve
     * one tree's files under another tree's name. Refusing is the only answer that cannot be
     * wrong; the record is corrected by re-probing the project, not by reading through the link.
     */
    async #canonicalRoot(path: string): Promise<string> {
        let canonical: string;
        try {
            canonical = await realpath(path);
            const information = await stat(canonical);
            if (!information.isDirectory()) {
                throw new ProjectFileError(
                    403,
                    "forbidden",
                    "The selected root is not a directory.",
                );
            }
        } catch (error) {
            if (error instanceof ProjectFileError) throw error;
            throw new ProjectFileError(404, "missing", "The selected root does not exist.");
        }
        if (canonical !== resolve(path)) {
            throw new ProjectFileError(
                403,
                "forbidden",
                "The recorded folder now points somewhere else.",
            );
        }
        return canonical;
    }

    async #resolveExisting(root: string, path: string, directory: boolean): Promise<string> {
        this.#assertRelativePath(path);
        const candidate = resolve(root, path);
        if (!isWithin(root, candidate)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        let canonical: string;
        try {
            canonical = await realpath(candidate);
        } catch {
            throw new ProjectFileError(404, "missing", "The requested path was not found.");
        }
        this.#assertWithinRoot(canonical, root);
        const information = await lstat(canonical);
        if (directory && !information.isDirectory()) {
            throw new ProjectFileError(400, "invalid", "The requested path is not a directory.");
        }
        return canonical;
    }

    async #resolveWritePath(root: string, path: string): Promise<string> {
        const candidate = resolve(root, path);
        if (!isWithin(root, candidate)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
        try {
            return await realpath(candidate);
        } catch {
            const suffix = [basename(candidate)];
            let ancestor = dirname(candidate);
            for (;;) {
                const parent = await realpath(ancestor).catch(() => undefined);
                if (parent !== undefined) return join(parent, ...suffix);
                const next = dirname(ancestor);
                if (next === ancestor) {
                    throw new ProjectFileError(
                        404,
                        "missing",
                        "The parent directory was not found.",
                    );
                }
                suffix.unshift(basename(ancestor));
                ancestor = next;
            }
        }
    }

    #assertWithinRoot(path: string, root: string): void {
        if (!isWithin(root, path)) {
            throw new ProjectFileError(403, "forbidden", "The path is outside the selected root.");
        }
    }

    #assertRelativePath(path: string): void {
        if (
            !Value.Check(relativeFilePathSchema, path) ||
            path.split("/").some((part) => part === ".." || part === ".")
        ) {
            throw new ProjectFileError(400, "invalid", "The path must be a relative POSIX path.");
        }
    }

    #assertSize(bytes: number, maximumBytes = MAX_FILE_BYTES): void {
        if (bytes > maximumBytes) {
            throw new ProjectFileError(
                413,
                "too_large",
                "The project file exceeds the size limit.",
            );
        }
    }

    #watcherInstance(): ProjectFileWatcher {
        this.#watcher ??= new ProjectFileWatcher(
            this.#root().named("project-file-watcher"),
            async (ctx, root, paths, structural) => {
                if (structural) this.#index.refresh(root.root);
                await this.#publish(ctx, root.workspaceId ?? root.projectId, paths);
            },
        );
        return this.#watcher;
    }

    #root(): RootContext {
        this.#lifetime ??= createRootContext();
        return this.#lifetime;
    }

    async #publish(
        ctx: Context,
        workspaceId: string,
        paths: readonly string[] | null,
    ): Promise<void> {
        const event = {
            at: Date.now(),
            eventId: randomUUID(),
            paths: paths === null ? null : [...paths],
            type: "files_changed" as const,
            workspaceId,
        };
        if (!Value.Check(projectFilesEventSchema, event)) {
            throw new Error("The project files module created an invalid event.");
        }
        if (event.paths !== null) Object.freeze(event.paths);
        Object.freeze(event);
        for (const listener of [...this.#listeners]) {
            try {
                await listener(ctx, event);
            } catch (error: unknown) {
                ctx.log.warn(
                    "A project files subscriber failed after the filesystem changed.",
                    { eventId: event.eventId, workspaceId: event.workspaceId },
                    error,
                );
            }
        }
    }
}

function assertSchema<T extends import("@sinclair/typebox").TSchema>(
    schema: T,
    value: unknown,
    name: string,
): asserts value is Static<T> {
    if (!Value.Check(schema, value))
        throw new ProjectFileError(400, "invalid", `The ${name} is invalid.`);
}

function parseCursor(value: string | undefined): number {
    if (value === undefined) return 0;
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new ProjectFileError(400, "invalid", "The file-tree cursor is invalid.");
    }
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor)) {
        throw new ProjectFileError(400, "invalid", "The file-tree cursor is invalid.");
    }
    return cursor;
}

function decodeBase64(value: string): Buffer {
    if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
        throw new ProjectFileError(400, "invalid", "File content must be base64.");
    }
    return Buffer.from(value, "base64");
}

function isWithin(root: string, candidate: string): boolean {
    const rootPath = resolve(root);
    const candidatePath = resolve(candidate);
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}
