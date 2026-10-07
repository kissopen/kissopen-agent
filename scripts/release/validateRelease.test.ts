import assert from "node:assert/strict";
import { test } from "node:test";

import { createReleaseTestEnvironment } from "./createReleaseTestEnvironment.js";
import type { ReleasePackage } from "./ReleasePackage.js";
import { validateRelease } from "./validateRelease.js";

const RELEASE_PACKAGE: ReleasePackage = {
    buildArguments: ["--filter", "kissopen-plugins", "build"],
    checkArguments: ["--filter", "kissopen-plugins", "check"],
    commitPrefix: "Release kissopen-plugins v",
    directory: "/workspace/packages/kissopen-plugins",
    key: "kissopen-plugins",
    manifestPath: "packages/kissopen-plugins/package.json",
    tagPrefix: "kissopen-plugins-v",
    testArguments: [
        ["run", "test:scripts"],
        ["--filter", "kissopen-plugins", "test"],
    ],
};

test("synchronizes the frozen workspace install before release validation", () => {
    const commands: Array<{
        arguments_: readonly string[];
        command: string;
        environment: NodeJS.ProcessEnv | undefined;
    }> = [];

    validateRelease(RELEASE_PACKAGE, {}, (command, arguments_, options) => {
        commands.push({ arguments_, command, environment: options?.environment });
        return { status: 0, stderr: "", stdout: "" };
    });

    assert.deepEqual(
        commands.map(({ arguments_, command }) => ({ arguments_, command })),
        [
            {
                arguments_: ["install", "--frozen-lockfile"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "kissopen-plugins", "check"],
                command: "pnpm",
            },
            {
                arguments_: ["run", "test:scripts"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "kissopen-plugins", "test"],
                command: "pnpm",
            },
            {
                arguments_: ["--filter", "kissopen-plugins", "build"],
                command: "pnpm",
            },
        ],
    );
    assert.equal(commands[0]?.environment?.CI, "true");
    assert.deepEqual(commands[2]?.environment, createReleaseTestEnvironment());
    assert.deepEqual(commands[3]?.environment, createReleaseTestEnvironment());
});

test("a beta release typechecks and builds without running tests", () => {
    const commands: Array<{ arguments_: readonly string[]; command: string }> = [];

    validateRelease(RELEASE_PACKAGE, { tests: false }, (command, arguments_) => {
        commands.push({ arguments_, command });
        return { status: 0, stderr: "", stdout: "" };
    });

    assert.deepEqual(commands, [
        { arguments_: ["install", "--frozen-lockfile"], command: "pnpm" },
        { arguments_: ["--filter", "kissopen-plugins", "check"], command: "pnpm" },
        { arguments_: ["--filter", "kissopen-plugins", "build"], command: "pnpm" },
    ]);
});
