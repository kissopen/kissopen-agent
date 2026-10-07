import { homedir, hostname, platform, release } from "node:os";

import {
    describeKissopenProvider,
    type KissopenProviderDescriptor,
} from "./describeKissopenProvider.js";
import {
    KISSOPEN_PERMISSION_MODES,
    type KissopenPermissionModeKind,
} from "./kissopenPermissionModes.js";
import { KISSOPEN_SESSION_RPC_METHODS } from "./handleKissopenSessionRpc.js";
import type { KissopenConnectionConfiguration } from "./KissopenCredentials.js";
import type { KissopenModel, KissopenSessionSnapshot } from "./KissopenSession.js";

/** How large an attachment Kissopen may send. */
export const MAX_KISSOPEN_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** One model as Kissopen publishes it. */
export interface KissopenPublishedModel {
    code: string;
    contextWindow?: number;
    defaultThinkingLevel: string;
    id: string;
    name: string;
    provider: KissopenProviderDescriptor;
    providerId: string;
    providerKind: string;
    providerName: string;
    serviceTiers: readonly string[];
    thinkingLevels: readonly string[];
    value: string;
}

/** Everything the phone needs to draw a session before a single message arrives. */
export interface KissopenSessionMetadata {
    /**
     * The Agent's own identity for this session. The relay's session ID is its own, so a client
     * that also talks to the Agent directly (the desktop's API, a project board card) needs this
     * to name the same conversation there.
     */
    agentId: string;
    capabilities: {
        abort: boolean;
        attachments: { enabled: boolean; maxBytes: number; mediaTypes: readonly string[] };
        files: { browse: boolean; read: boolean; search: boolean; write: boolean };
        /**
         * This daemon answers every accepted phone message with a `user-message-accepted`
         * receipt, so the phone may hold a sent message at the bottom until one arrives.
         */
        messageReceipts: boolean;
        modelSelection: boolean;
        permissionModeSelection: boolean;
        reasoningSelection: boolean;
        resume: boolean;
        rpcMethods: readonly string[];
        shell: boolean;
        steering: boolean;
    };
    client: { id: "rig"; name: "KISSOPEN Agent"; version: string };
    currentModelCode: string;
    currentModelProviderId: string;
    currentOperatingModeCode: string;
    currentThoughtLevelCode?: string;
    flavor: string;
    kissopenHomeDir: string;
    homeDir: string;
    host: string;
    hostPid: number;
    /** Rig's branch/worktree line delta against the merge base with origin/main. */
    git?: {
        changedFiles: number;
        countsExact: boolean;
        deletions: number;
        insertions: number;
    };
    /**
     * The newest visible human text, final model response, or user-facing question, in epoch
     * milliseconds.
     */
    lastMeaningfulMessageAt?: number;
    machineId?: string;
    model: { id: string; providerId: string };
    models: readonly KissopenPublishedModel[];
    name?: string;
    operatingModes: readonly {
        code: string;
        description: string;
        kind: KissopenPermissionModeKind;
        value: string;
    }[];
    os: string;
    path: string;
    permissionMode: string;
    /**
     * What the phone groups this session under.
     *
     * Every workspace of one project carries the same `project.id`, so their sessions gather in a
     * single card, and `workspace` names the checkout within it.
     */
    project?: { id: string; kind: "home" | "regular"; name: string };
    bot?: KissopenSessionSnapshot["bot"];
    provider: KissopenProviderDescriptor;
    providers: readonly KissopenProviderDescriptor[];
    reasoning: { current: string | null; levels: readonly string[] };
    rigMetadataVersion: 1;
    session: { modelLocked: false; permissionMode: string; serviceTier?: string; status: string };
    startedBy: "daemon";
    startedFromDaemon: true;
    summary?: { text: string; updatedAt: number };
    thoughtLevels: readonly { code: string; value: string }[];
    tools: readonly string[];
    /** The branch this checkout is on, which legacy sessions report too. */
    gitBranch?: string;
    /**
     * The workspace this session runs in, absent in the project's own checkout.
     *
     * Named by its current title rather than its branch, so renaming a workspace renames it
     * everywhere the phone shows it.
     */
    workspace?: { id: string; kind: "worktree"; name: string };
}

/**
 * Describes one Kissopen Agent session in Kissopen's own terms.
 *
 * This is what makes the phone useful before anything is said: which model is
 * running, what else it could run, what the session may touch, and what KISSOPEN Agent can
 * be asked to do for it. It is republished whenever any of that changes.
 */
export function createKissopenSessionMetadata(options: {
    configuration: KissopenConnectionConfiguration;
    models: readonly KissopenModel[];
    session: KissopenSessionSnapshot;
    summaryUpdatedAt: number;
    version: string;
}): KissopenSessionMetadata {
    const { configuration, models, session } = options;
    const selected = models.find(
        (model) => model.id === session.modelId && model.providerId === session.providerId,
    );
    const providerIds = [...new Set(models.map((model) => model.providerId))];
    const providers = (providerIds.length === 0 ? [session.providerId] : providerIds).map(
        describeKissopenProvider,
    );
    const provider = describeKissopenProvider(session.providerId);
    const efforts = selected?.effortLevels ?? [];
    const title = session.bot?.name ?? session.title;
    return {
        // The snapshot's session ID is the Agent's agent ID.
        agentId: session.sessionId,
        capabilities: {
            abort: true,
            attachments: {
                enabled: true,
                maxBytes: MAX_KISSOPEN_ATTACHMENT_BYTES,
                mediaTypes: ["image/*"],
            },
            files: {
                browse: true,
                read: true,
                search: false,
                write: false,
            },
            messageReceipts: true,
            modelSelection: true,
            permissionModeSelection: true,
            reasoningSelection: efforts.length > 0,
            resume: false,
            rpcMethods: [...KISSOPEN_SESSION_RPC_METHODS],
            shell: false,
            steering: true,
        },
        client: { id: "rig", name: "KISSOPEN Agent", version: options.version },
        currentModelCode: session.modelId,
        currentModelProviderId: session.providerId,
        currentOperatingModeCode: session.permissionMode,
        ...(session.effort === undefined ? {} : { currentThoughtLevelCode: session.effort }),
        flavor: session.providerId,
        kissopenHomeDir: configuration.kissopenHome,
        homeDir: homedir(),
        host: hostname(),
        hostPid: process.pid,
        ...(session.git === undefined ? {} : { git: { ...session.git } }),
        ...(session.lastMeaningfulMessageAt === undefined
            ? {}
            : { lastMeaningfulMessageAt: session.lastMeaningfulMessageAt }),
        ...(configuration.machineId === undefined ? {} : { machineId: configuration.machineId }),
        model: { id: session.modelId, providerId: session.providerId },
        models: models.map(publishModel),
        ...(title === undefined ? {} : { name: title }),
        operatingModes: KISSOPEN_PERMISSION_MODES.map((mode) => ({ ...mode })),
        os: `${platform()} ${release()}`,
        path: session.cwd,
        permissionMode: session.permissionMode,
        // Falls back to the session's own identity only when this daemon keeps no project for it.
        // A per-session id groups nothing, which is the right answer for a session that belongs
        // to nothing, and the wrong one for every session that does.
        ...(session.bot === undefined
            ? {
                  project:
                      session.project === undefined
                          ? {
                                id: `rig:${session.sessionId}`,
                                kind: "regular",
                                name: session.projectName,
                            }
                          : {
                                id: session.project.id,
                                kind: session.project.kind,
                                name: session.project.name,
                            },
              }
            : {}),
        ...(session.bot === undefined ? {} : { bot: { ...session.bot } }),
        provider,
        providers,
        reasoning: { current: session.effort ?? null, levels: [...efforts] },
        rigMetadataVersion: 1,
        session: {
            modelLocked: false,
            permissionMode: session.permissionMode,
            ...(session.serviceTier === undefined ? {} : { serviceTier: session.serviceTier }),
            status: session.status,
        },
        startedBy: "daemon",
        startedFromDaemon: true,
        ...(title === undefined
            ? {}
            : { summary: { text: title, updatedAt: options.summaryUpdatedAt } }),
        thoughtLevels: efforts.map((level) => ({ code: level, value: level })),
        tools: [...session.tools],
        ...(session.gitBranch === undefined ? {} : { gitBranch: session.gitBranch }),
        ...(session.workspace === undefined || session.bot !== undefined
            ? {}
            : {
                  workspace: {
                      id: session.workspace.id,
                      kind: "worktree" as const,
                      name: session.workspace.name,
                  },
              }),
    };
}

function publishModel(model: KissopenModel): KissopenPublishedModel {
    const provider = describeKissopenProvider(model.providerId);
    return {
        code: model.id,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        defaultThinkingLevel: model.defaultEffort,
        id: model.id,
        name: model.name,
        provider,
        providerId: model.providerId,
        providerKind: provider.kind,
        providerName: provider.name,
        serviceTiers: [...model.serviceTiers],
        thinkingLevels: [...model.effortLevels],
        value: model.name,
    };
}
