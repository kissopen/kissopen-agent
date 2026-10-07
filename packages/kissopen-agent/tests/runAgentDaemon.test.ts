import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    createGymInferenceFromEnvironment: vi.fn(() => undefined),
    getDaemonIdentity: vi.fn(() => ({ version: "test" })),
    getKissopenDaemonPaths: vi.fn(() => ({
        kissopenHome: "/tmp/kissopen-agent-test",
        pidPath: "/tmp/kissopen-agent-test/daemon.pid",
    })),
    removeDaemonPidSync: vi.fn(),
    startKissopenAgentDaemon: vi.fn(),
    syncKissopenAgentDocs: vi.fn(),
}));

vi.mock("../sources/main.js", () => ({
    startKissopenAgentDaemon: mocks.startKissopenAgentDaemon,
}));
vi.mock("../sources/lifecycle/daemonPid.js", () => ({
    removeDaemonPidSync: mocks.removeDaemonPidSync,
}));
vi.mock("../sources/lifecycle/gymInference.js", () => ({
    createGymInferenceFromEnvironment: mocks.createGymInferenceFromEnvironment,
}));
vi.mock("../sources/lifecycle/getDaemonIdentity.js", () => ({
    getDaemonIdentity: mocks.getDaemonIdentity,
}));
vi.mock("../sources/lifecycle/getKissopenDaemonPaths.js", () => ({
    getKissopenDaemonPaths: mocks.getKissopenDaemonPaths,
}));
vi.mock("../sources/documentation/syncKissopenAgentDocs.js", () => ({
    syncKissopenAgentDocs: mocks.syncKissopenAgentDocs,
}));

import { runAgentDaemon } from "../sources/lifecycle/runAgentDaemon.js";

const signalListeners = {
    SIGINT: new Set(process.rawListeners("SIGINT")),
    SIGTERM: new Set(process.rawListeners("SIGTERM")),
};

afterEach(() => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.rawListeners(signal)) {
            if (!signalListeners[signal].has(listener)) process.removeListener(signal, listener);
        }
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe("runAgentDaemon", () => {
    it("refuses an emulated gym before any native runtime or filesystem work", async () => {
        vi.clearAllMocks();
        vi.stubEnv("KISSOPEN_TERMINAL_GYM_RUNTIME", "just-bash");

        await expect(runAgentDaemon({ hardExit: false, persistPid: false })).rejects.toThrow(
            "host execution cannot substitute for just-bash",
        );

        expect(mocks.startKissopenAgentDaemon).not.toHaveBeenCalled();
        expect(mocks.syncKissopenAgentDocs).not.toHaveBeenCalled();
        expect(mocks.getKissopenDaemonPaths).not.toHaveBeenCalled();
    });

    it("synchronizes docs before starting the runtime", async () => {
        mocks.startKissopenAgentDaemon.mockResolvedValue({
            close: vi.fn(),
            closed: new Promise<void>(() => undefined),
            socketPath: "/tmp/kissopen-agent-test/daemon.sock",
            tokenPath: "/tmp/kissopen-agent-test/token",
        });

        await runAgentDaemon({ hardExit: false, persistPid: false });

        expect(mocks.syncKissopenAgentDocs).toHaveBeenCalledWith("/tmp/kissopen-agent-test");
        expect(mocks.syncKissopenAgentDocs.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.startKissopenAgentDaemon.mock.invocationCallOrder[0]!,
        );
    });

    it("hard-exits after the daemon's graceful close barrier settles", async () => {
        let resolveClosed!: () => void;
        const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
        });
        mocks.startKissopenAgentDaemon.mockResolvedValue({
            close: vi.fn(),
            closed,
            socketPath: "/tmp/kissopen-agent-test/daemon.sock",
            tokenPath: "/tmp/kissopen-agent-test/token",
        });
        const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

        await runAgentDaemon({ hardExit: true, persistPid: false });
        expect(exit).not.toHaveBeenCalled();
        resolveClosed();

        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    });
});
