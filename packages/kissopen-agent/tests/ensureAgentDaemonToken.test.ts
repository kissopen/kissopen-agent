import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KISSOPEN_AGENT_PROTOCOL_VERSION } from "@kissopen/kissopen-agent-client";
import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getKissopenDaemonPaths: vi.fn(),
    loadKissopenAgentConfiguration: vi.fn(),
    readDaemonToken: vi.fn(),
    readOrCreateDaemonToken: vi.fn(),
    runAgentDaemon: vi.fn(),
}));

vi.mock("@kissopen/kissopen-agent-client", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@kissopen/kissopen-agent-client")>()),
    KissopenAgentClient: class {
        constructor(options: unknown) {
            mocks.createClient(options);
        }
        async getHealth() {
            return {
                ready: true,
                version: { protocol: KISSOPEN_AGENT_PROTOCOL_VERSION, daemon: "test" },
            };
        }
    },
}));
vi.mock("@kissopen/kissopen-agent-modules", () => ({
    loadKissopenAgentConfiguration: mocks.loadKissopenAgentConfiguration,
}));
vi.mock("../sources/lifecycle/daemonToken.js", () => ({
    readDaemonToken: mocks.readDaemonToken,
    readDaemonTokenIfPresent: vi.fn(async () => undefined),
    readOrCreateDaemonToken: mocks.readOrCreateDaemonToken,
}));
vi.mock("../sources/lifecycle/getDaemonIdentity.js", () => ({
    getDaemonIdentity: vi.fn(() => ({ version: "test" })),
}));
vi.mock("../sources/lifecycle/getKissopenDaemonPaths.js", () => ({
    getKissopenDaemonPaths: mocks.getKissopenDaemonPaths,
}));
vi.mock("../sources/lifecycle/runAgentDaemon.js", () => ({
    runAgentDaemon: mocks.runAgentDaemon,
}));

import { ensureAgentDaemon } from "../sources/lifecycle/ensureAgentDaemon.js";

const roots: string[] = [];
afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([true, false])(
    "authenticates startup readiness with the served token (fixed: %s)",
    async (fixed) => {
        const kissopenHome = await mkdtemp(join(tmpdir(), "kissopen-startup-token-"));
        roots.push(kissopenHome);
        const directory = join(kissopenHome, "agent");
        const tokenPath = join(directory, "token");
        mocks.getKissopenDaemonPaths.mockReturnValue({
            directory,
            kissopenHome,
            tokenPath,
            socketPath: join(directory, "server.sock"),
        });
        const configuredToken = "c".repeat(43);
        const generatedToken = "g".repeat(43);
        const servedToken = fixed ? configuredToken : generatedToken;
        mocks.loadKissopenAgentConfiguration.mockResolvedValue({
            values: {
                feature: { team: { enabled: false } },
                ...(fixed ? { api: { token: configuredToken } } : {}),
            },
        });
        mocks.readOrCreateDaemonToken.mockResolvedValue(generatedToken);
        mocks.readDaemonToken.mockResolvedValue(servedToken);
        mocks.runAgentDaemon.mockResolvedValue(undefined);

        const connection = await ensureAgentDaemon({ runInProcess: true });

        expect(mocks.createClient).toHaveBeenCalledTimes(1);
        expect(mocks.createClient).toHaveBeenCalledWith(
            expect.objectContaining({ token: servedToken }),
        );
        expect(connection.token).toBe(servedToken);
        if (fixed) {
            expect(mocks.readOrCreateDaemonToken).not.toHaveBeenCalled();
        } else {
            expect(mocks.readOrCreateDaemonToken).toHaveBeenCalledWith(tokenPath);
        }
    },
);
