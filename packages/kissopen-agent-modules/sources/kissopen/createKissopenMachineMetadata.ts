import { homedir, hostname, platform } from "node:os";

import {
    describeKissopenProvider,
    type KissopenProviderDescriptor,
} from "./describeKissopenProvider.js";
import {
    KISSOPEN_PERMISSION_MODES,
    type KissopenPermissionModeKind,
} from "./kissopenPermissionModes.js";
import { KISSOPEN_SPAWN_RETRY_MS } from "./handleKissopenSpawnSession.js";
import type { KissopenConnectionConfiguration } from "./KissopenCredentials.js";
import type { KissopenModel } from "./KissopenSession.js";
import type { KissopenPublishedModel } from "./createKissopenSessionMetadata.js";

/**
 * What the phone knows about this computer before it opens any session on it.
 *
 * Deliberately not a catalog of the projects and workspaces on this computer. Machine metadata is
 * one document, republished whole on every change, and a person setting up work moves several
 * catalogs at once — so carrying them here meant re-sending everything about this machine each
 * time a workspace was created or renamed. The phone reads the places to work from the sessions
 * themselves instead, which it already receives one at a time.
 */
export interface KissopenMachineMetadata {
    capabilities: { newSession: boolean; resume: false; worktrees: false };
    client: { id: "rig"; name: "KISSOPEN Agent"; version: string };
    defaults: { effort: string; modelId: string; permissionMode: "auto"; providerId: string };
    displayName: string;
    /**
     * The version of the daemon speaking for this machine, which here is Kissopen Agent's own.
     *
     * The phone requires this of every machine, and rejects the whole metadata document without
     * it — leaving a machine with no models, no name and no way to start anything. The name says
     * CLI because Kissopen CLI was the only daemon when it was chosen.
     */
    kissopenCliVersion: string;
    kissopenHomeDir: string;
    homeDir: string;
    host: string;
    machineKind: "rig";
    models: readonly KissopenPublishedModel[];
    operatingModes: readonly {
        code: string;
        description: string;
        kind: KissopenPermissionModeKind;
        value: string;
    }[];
    platform: string;
    providers: readonly KissopenProviderDescriptor[];
    rigMetadataVersion: 1;
    rigOnly: true;
    /**
     * The machine Kissopen CLI registered for this same computer.
     *
     * Kissopen gives each daemon its own machine, so one computer with both arrives as two. This
     * names the other half of the pair, so the phone can offer the computer once and choose the
     * daemon underneath by itself. Absent when this daemon is the only one here.
     */
    siblingMachineId?: string;
    sessionCreation: {
        idempotencyKey: "clientRequestId";
        pendingRetryAfterMs: number;
        resultKinds: readonly string[];
    };
}

/**
 * Describes this computer to Kissopen.
 *
 * This is what a person sees before any session exists: which machine this is,
 * what it can run, and that it can be asked to start something new. Without it
 * the phone has a daemon it cannot do anything with.
 */
export function createKissopenMachineMetadata(options: {
    configuration: KissopenConnectionConfiguration;
    models: readonly KissopenModel[];
    siblingMachineId?: string;
    version: string;
}): KissopenMachineMetadata {
    const defaultModel = options.models[0];
    if (defaultModel === undefined)
        throw new Error("This KissOpen Agent has no model to offer KissOpen.");
    const host = hostname();
    return {
        capabilities: { newSession: true, resume: false, worktrees: false },
        client: { id: "rig", name: "KISSOPEN Agent", version: options.version },
        defaults: {
            effort: defaultModel.defaultEffort,
            modelId: defaultModel.id,
            permissionMode: "auto",
            providerId: defaultModel.providerId,
        },
        // The machine's own name. Apps show it wherever a person picks or reads which computer
        // a conversation runs on; a product suffix only made that longer, and apps say in their
        // own language what the machine runs.
        displayName: host,
        kissopenCliVersion: options.version,
        kissopenHomeDir: options.configuration.kissopenHome,
        homeDir: homedir(),
        host,
        machineKind: "rig",
        models: options.models.map((model) => {
            const provider = describeKissopenProvider(model.providerId);
            return {
                code: model.id,
                ...(model.contextWindow === undefined
                    ? {}
                    : { contextWindow: model.contextWindow }),
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
        }),
        operatingModes: KISSOPEN_PERMISSION_MODES.map((mode) => ({ ...mode })),
        platform: platform(),
        providers: [...new Set(options.models.map((model) => model.providerId))].map(
            describeKissopenProvider,
        ),
        rigMetadataVersion: 1,
        rigOnly: true,
        ...(options.siblingMachineId === undefined
            ? {}
            : { siblingMachineId: options.siblingMachineId }),
        sessionCreation: {
            idempotencyKey: "clientRequestId",
            pendingRetryAfterMs: KISSOPEN_SPAWN_RETRY_MS,
            resultKinds: ["success", "pending", "requestToApproveDirectoryCreation", "error"],
        },
    };
}
