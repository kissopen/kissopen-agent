import { describe, expect, it } from "vitest";

import {
    createKissopenSessionMetadata,
    MAX_KISSOPEN_ATTACHMENT_BYTES,
} from "../../sources/kissopen/index.js";
import type {
    KissopenConnectionConfiguration,
    KissopenModel,
    KissopenSessionSnapshot,
} from "../../sources/kissopen/index.js";

const CONFIGURATION: KissopenConnectionConfiguration = {
    credentialFingerprint: "credential-fingerprint",
    credentials: { encryption: { secret: new Uint8Array(32), type: "legacy" }, token: "token" },
    credentialsPath: "/home/steve/.rig/kissopen/access.key",
    kissopenHome: "/home/steve/.rig/kissopen",
    imported: false,
    machineId: "machine-1",
    serverUrl: "https://api.kissopen.example",
};

const MODELS: readonly KissopenModel[] = [
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium", "high"],
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol",
        providerId: "codex",
        serviceTiers: ["priority"],
    },
    {
        defaultEffort: "medium",
        effortLevels: ["low", "medium"],
        id: "opus-5",
        name: "Opus 5",
        providerId: "claude",
        serviceTiers: [],
    },
];

function snapshot(overrides: Partial<KissopenSessionSnapshot> = {}): KissopenSessionSnapshot {
    return {
        agentId: "agent-1",
        archived: false,
        cwd: "/home/steve/projects/rig",
        effort: "high",
        modelId: "gpt-5.6-sol",
        permissionMode: "auto",
        projectName: "rig",
        providerId: "codex",
        sessionId: "session-1",
        status: "running",
        title: "Porting the KISSOPEN module",
        tools: ["read", "edit"],
        working: true,
        ...overrides,
    };
}

function metadata(session: KissopenSessionSnapshot = snapshot()) {
    return createKissopenSessionMetadata({
        configuration: CONFIGURATION,
        models: MODELS,
        session,
        summaryUpdatedAt: 5_000,
        version: "1.2.3",
    });
}

describe("describing a KISSOPEN Agent session in KISSOPEN's own terms", () => {
    it("publishes a bot identity without inventing a project or worktree", () => {
        const bot = {
            id: "bot-1",
            name: "Research Assistant",
            username: "research_assistant",
            workspaceId: "bot-workspace-1",
            orderKey: "0001",
        };
        const published = metadata({ ...snapshot(), bot });
        expect(published).toMatchObject({ bot, name: bot.name });
        expect(published.summary?.text).toBe(bot.name);
        expect(published).not.toHaveProperty("project");
        expect(published).not.toHaveProperty("workspace");
    });

    it("names the Agent's own agent ID, so a client can address the same conversation", () => {
        expect(metadata().agentId).toBe("session-1");
    });

    it("says what the session is running on", () => {
        const published = metadata();
        expect(published.currentModelCode).toBe("gpt-5.6-sol");
        expect(published.currentModelProviderId).toBe("codex");
        expect(published.currentThoughtLevelCode).toBe("high");
        expect(published.model).toEqual({ id: "gpt-5.6-sol", providerId: "codex" });
        expect(published.reasoning).toEqual({
            current: "high",
            levels: ["low", "medium", "high"],
        });
    });

    it("never describes activity, which the phone reserves for its own counters", () => {
        expect("activity" in metadata()).toBe(false);
        expect("activity" in metadata(snapshot({ working: false }))).toBe(false);
        expect("activity" in metadata(snapshot({ archived: true, working: false }))).toBe(false);
    });

    it("carries the name a session has been given", () => {
        const published = metadata();
        expect(published.name).toBe("Porting the KISSOPEN module");
        expect(published.summary).toEqual({
            text: "Porting the KISSOPEN module",
            updatedAt: 5_000,
        });
    });

    it("publishes the exact meaningful-message timestamp used for session ordering", () => {
        expect(
            metadata(snapshot({ lastMeaningfulMessageAt: 12_345 })).lastMeaningfulMessageAt,
        ).toBe(12_345);
        expect("lastMeaningfulMessageAt" in metadata()).toBe(false);
    });

    it("publishes Rig's canonical branch-diff line counts", () => {
        expect(
            metadata(
                snapshot({
                    git: {
                        changedFiles: 39,
                        countsExact: true,
                        deletions: 180,
                        insertions: 3_032,
                    },
                }),
            ).git,
        ).toEqual({
            changedFiles: 39,
            countsExact: true,
            deletions: 180,
            insertions: 3_032,
        });
        expect("git" in metadata()).toBe(false);
    });

    it("leaves an unnamed session unnamed, rather than overwriting KISSOPEN's own words", () => {
        const { title: _named, ...untitled } = snapshot();
        const published = metadata(untitled);
        expect("name" in published).toBe(false);
        expect("summary" in published).toBe(false);
    });

    it("groups by the project it belongs to, not by the session it is", () => {
        const published = metadata(
            snapshot({
                project: { id: "project-7", kind: "regular" as const, name: "rig" },
                projectName: "rig",
            }),
        );
        expect(published.project).toEqual({ id: "project-7", kind: "regular", name: "rig" });
    });

    it("says a home project is a home project, rather than calling it regular", () => {
        const published = metadata(
            snapshot({ project: { id: "home", kind: "home" as const, name: "steve" } }),
        );
        expect(published.project).toEqual({ id: "home", kind: "home", name: "steve" });
    });

    it("names the workspace by its title, and reports the branch beside it", () => {
        const published = metadata(
            snapshot({
                gitBranch: "worktree/retry-policy",
                project: { id: "project-7", kind: "regular" as const, name: "rig" },
                workspace: { id: "workspace-3", name: "Retry policy rewrite" },
            }),
        );
        expect(published.workspace).toEqual({
            id: "workspace-3",
            kind: "worktree",
            name: "Retry policy rewrite",
        });
        expect(published.gitBranch).toBe("worktree/retry-policy");
    });

    it("says no workspace for a session in the project's own checkout", () => {
        expect(
            "workspace" in
                metadata(snapshot({ project: { id: "p", kind: "regular" as const, name: "rig" } })),
        ).toBe(false);
    });

    it("groups a session belonging nowhere by itself, rather than with strangers", () => {
        expect(metadata().project).toEqual({ id: "rig:session-1", kind: "regular", name: "rig" });
    });

    it("keeps every field a legacy KISSOPEN session is read for", () => {
        const published = metadata() as unknown as Record<string, unknown>;
        for (const key of ["path", "host", "machineId", "homeDir", "kissopenHomeDir", "os"]) {
            expect(typeof published[key]).toBe("string");
        }
        expect(published.startedBy).toBe("daemon");
        expect(published.startedFromDaemon).toBe(true);
        expect(typeof published.flavor).toBe("string");
    });

    it("offers every model the daemon can serve, whatever the provider", () => {
        const published = metadata();
        expect(published.models.map((model) => model.id)).toEqual(["gpt-5.6-sol", "opus-5"]);
        expect(published.providers.map((provider) => provider.id)).toEqual(["codex", "claude"]);
    });

    it("claims only what this daemon can actually do", () => {
        const capabilities = metadata().capabilities;
        expect(capabilities.abort).toBe(true);
        expect(capabilities.steering).toBe(true);
        expect(capabilities.messageReceipts).toBe(true);
        expect(capabilities.modelSelection).toBe(true);
        expect(capabilities.reasoningSelection).toBe(true);
        // Kissopen Agent's Kissopen connection has no file or shell surface of its own.
        expect(capabilities.files).toEqual({
            browse: true,
            read: true,
            search: false,
            write: false,
        });
        expect(capabilities.shell).toBe(false);
        expect(capabilities.rpcMethods).toEqual([
            "browserControl",
            "abort",
            "communication",
            "killSession",
            "clearConversation",
            "gitState",
            "readFile",
            "readFileAtRevision",
            "listDirectory",
            "uploadFile",
            // The terminals standing in this session's folder. Attaching to
            // one is not among them: that is a stream of the daemon's own
            // attach bytes, not a question with an answer.
            "terminalCreate",
            "terminalList",
            "terminalResize",
            "terminalStop",
        ]);
        expect(capabilities.attachments).toEqual({
            enabled: true,
            maxBytes: MAX_KISSOPEN_ATTACHMENT_BYTES,
            mediaTypes: ["image/*"],
        });
    });

    it("does not offer a reasoning choice for a model with none", () => {
        const published = metadata(snapshot({ modelId: "unknown-model" }));
        expect(published.capabilities.reasoningSelection).toBe(false);
        expect(published.reasoning.levels).toEqual([]);
    });

    it("names the session and the folder it works in", () => {
        const published = metadata();
        expect(published.name).toBe("Porting the KISSOPEN module");
        expect(published.summary).toEqual({
            text: "Porting the KISSOPEN module",
            updatedAt: 5_000,
        });
        expect(published.path).toBe("/home/steve/projects/rig");
        expect(published.project).toEqual({ id: "rig:session-1", kind: "regular", name: "rig" });
    });

    it("says which KISSOPEN Agent this is and which machine it runs on", () => {
        const published = metadata();
        expect(published.client).toEqual({ id: "rig", name: "KISSOPEN Agent", version: "1.2.3" });
        expect(published.machineId).toBe("machine-1");
        expect(published.kissopenHomeDir).toBe("/home/steve/.rig/kissopen");
        expect(published.startedBy).toBe("daemon");
        expect(published.rigMetadataVersion).toBe(1);
    });

    it("leaves out a reasoning level the session does not have", () => {
        const { effort: _effort, ...rest } = snapshot();
        expect(metadata(rest as KissopenSessionSnapshot).currentThoughtLevelCode).toBeUndefined();
        expect(metadata(rest as KissopenSessionSnapshot).reasoning.current).toBeNull();
    });
});
