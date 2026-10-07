import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertBundledKissopenRuntimeDependencies } from "./assertBundledKissopenRuntimeDependencies.js";

describe("assertBundledKissopenRuntimeDependencies", () => {
    it("accepts the KISSOPEN Agent client as KISSOPEN Terminal's only agent dependency", () => {
        assert.doesNotThrow(() =>
            assertBundledKissopenRuntimeDependencies({
                dependencies: { "@kissopen/kissopen-agent-client": "0.0.12" },
                name: "@kissopen/kissopen-terminal",
                version: "1.2.3",
            }),
        );
    });

    it("rejects daemon implementation packages in either dependency section", () => {
        assert.throws(
            () =>
                assertBundledKissopenRuntimeDependencies({
                    dependencies: { "@kissopen/kissopen-agent-client": "0.0.12" },
                    devDependencies: { "@kissopen/kissopen-agent-modules": "workspace:*" },
                    name: "@kissopen/kissopen-terminal",
                    version: "1.2.3",
                }),
            /must not depend on Kissopen Agent implementation packages/u,
        );
    });

    it("rejects a missing public client dependency", () => {
        assert.throws(
            () =>
                assertBundledKissopenRuntimeDependencies({
                    name: "@kissopen/kissopen-terminal",
                    version: "1.2.3",
                }),
            /must depend on @slopus\/kissopen-agent-client/u,
        );
    });
});
