import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { resolveReleasePackage } from "./resolveReleasePackage.js";

describe("resolveReleasePackage", () => {
    it("keeps KISSOPEN Terminal as the default release target", () => {
        const target = resolveReleasePackage(undefined);

        assert.equal(target.key, "kissopen-terminal");
        assert.equal(target.tagPrefix, "kissopen-terminal-v");
        assert.deepEqual(target.testArguments, [["run", "test:release"]]);
        const rootManifest = JSON.parse(
            readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ) as { scripts: Record<string, string> };
        assert.match(
            rootManifest.scripts["test:release"] ?? "",
            /--filter '!@kissopen\/kissopen-providers'/u,
        );
        assert.match(rootManifest.scripts["test:release"] ?? "", /--filter '!kissopen-plugins'/u);
    });

    it("validates only kissopen-agent-base for its local and remote releases", () => {
        const target = resolveReleasePackage("kissopen-agent-base");

        assert.equal(target.key, "kissopen-agent-base");
        assert.equal(target.tagPrefix, "kissopen-agent-base-v");
        assert.match(target.directory, /packages\/kissopen-agent-base\/?$/u);
        assert.deepEqual(target.buildArguments, [
            "--filter",
            "@kissopen/kissopen-agent-base",
            "build",
        ]);
        assert.deepEqual(target.checkArguments, [
            "--filter",
            "@kissopen/kissopen-agent-base",
            "check",
        ]);
        assert.deepEqual(target.testArguments, [
            ["--filter", "@kissopen/kissopen-agent-base", "test"],
        ]);
    });

    it("gives kissopen-agent-client its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("kissopen-agent-client");

        assert.equal(target.key, "kissopen-agent-client");
        assert.equal(target.tagPrefix, "kissopen-agent-client-v");
        assert.match(target.directory, /packages\/kissopen-agent-client\/?$/u);
        assert.deepEqual(target.buildArguments, [
            "--filter",
            "@kissopen/kissopen-agent-client",
            "build",
        ]);
        assert.deepEqual(target.checkArguments, [
            "--filter",
            "@kissopen/kissopen-agent-client",
            "check",
        ]);
        assert.deepEqual(target.testArguments, [
            ["--filter", "@kissopen/kissopen-agent-client", "test"],
        ]);
    });

    it("gives kissopen-plugins its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("kissopen-plugins");

        assert.equal(target.key, "kissopen-plugins");
        assert.equal(target.tagPrefix, "kissopen-plugins-v");
        assert.match(target.directory, /packages\/kissopen-plugins\/?$/u);
        assert.deepEqual(target.buildArguments, ["--filter", "kissopen-plugins", "build"]);
    });

    it("gives kissopen-providers its own tag namespace and package directory", () => {
        const target = resolveReleasePackage("kissopen-providers");

        assert.equal(target.key, "kissopen-providers");
        assert.equal(target.tagPrefix, "kissopen-providers-v");
        assert.match(target.directory, /packages\/kissopen-providers\/?$/u);
        assert.deepEqual(target.buildArguments, [
            "--filter",
            "@kissopen/kissopen-providers",
            "build",
        ]);
        assert.deepEqual(target.checkArguments, [
            "--filter",
            "@kissopen/kissopen-providers",
            "check",
        ]);
        assert.deepEqual(target.testArguments, [
            ["run", "test:scripts"],
            ["--filter", "@kissopen/kissopen-providers", "test"],
        ]);
    });

    it("rejects a target that could publish an unintended workspace package", () => {
        assert.throws(() => resolveReleasePackage("other"), /Unknown release package other/u);
    });
});
