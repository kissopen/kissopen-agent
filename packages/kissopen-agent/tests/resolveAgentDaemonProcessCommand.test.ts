import { describe, expect, it } from "vitest";

import { resolveAgentDaemonProcessCommand } from "../sources/lifecycle/resolveAgentDaemonProcessCommand.js";

describe("resolveAgentDaemonProcessCommand", () => {
    it("relaunches a standalone binary directly", () => {
        expect(
            resolveAgentDaemonProcessCommand(undefined, {
                entrypoint: "/$bunfs/root/kissopen-agent.js",
                executable: "/usr/local/bin/kissopen-agent",
                execArguments: [],
                standalone: true,
            }),
        ).toEqual({
            arguments: ["run"],
            executable: "/usr/local/bin/kissopen-agent",
        });
    });

    it("preserves the Node-compatible script command", () => {
        expect(
            resolveAgentDaemonProcessCommand("/opt/rig/agent.js", {
                entrypoint: "/opt/kissopen-agent/cli.js",
                executable: "/usr/local/bin/node",
                execArguments: ["--enable-source-maps"],
                standalone: false,
            }),
        ).toEqual({
            arguments: ["--enable-source-maps", "/opt/rig/agent.js", "run"],
            executable: "/usr/local/bin/node",
        });
    });
});
