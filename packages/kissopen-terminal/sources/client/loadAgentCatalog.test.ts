import { describe, expect, it, vi } from "vitest";

import {
    KissopenAgentApiError,
    type KissopenAgentClient,
    type Workspace,
} from "@kissopen/kissopen-agent-client";

import { waitForWorkspaceReady } from "./loadAgentCatalog.js";

describe("waitForWorkspaceReady", () => {
    it("waits through the public initialization conflict and returns the ready workspace", async () => {
        const workspace = { id: "workspace" } as Workspace;
        const getWorkspace = vi
            .fn<KissopenAgentClient["getWorkspace"]>()
            .mockRejectedValueOnce(
                new KissopenAgentApiError(
                    409,
                    "The workspace is still initializing.",
                    "not_initialized",
                    {
                        code: "not_initialized",
                        error: "The workspace is still initializing.",
                    },
                ),
            )
            .mockResolvedValueOnce({ workspace });

        await expect(waitForWorkspaceReady({ getWorkspace }, workspace.id)).resolves.toBe(
            workspace,
        );
        expect(getWorkspace).toHaveBeenCalledTimes(2);
    });

    it("does not retry a terminal workspace error", async () => {
        const failure = new KissopenAgentApiError(409, "The workspace is not available.", "conflict", {
            code: "conflict",
            error: "The workspace is not available.",
        });
        const getWorkspace = vi.fn<KissopenAgentClient["getWorkspace"]>().mockRejectedValue(failure);

        await expect(waitForWorkspaceReady({ getWorkspace }, "workspace")).rejects.toBe(failure);
        expect(getWorkspace).toHaveBeenCalledTimes(1);
    });
});
