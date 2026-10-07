import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertReleaseTagMatchesPackageVersion } from "./assertReleaseTagMatchesPackageVersion.js";

const MANIFEST = {
    name: "@kissopen/kissopen-terminal",
    version: "1.2.3",
};

describe("assertReleaseTagMatchesPackageVersion", () => {
    it("accepts the package version with a v prefix", () => {
        assert.doesNotThrow(() => assertReleaseTagMatchesPackageVersion("v1.2.3", MANIFEST));
    });

    it("rejects a tag for a different package version", () => {
        assert.throws(
            () => assertReleaseTagMatchesPackageVersion("v1.2.4", MANIFEST),
            /Expected v1\.2\.3/u,
        );
    });

    it("supports a package-specific tag namespace", () => {
        assert.doesNotThrow(() =>
            assertReleaseTagMatchesPackageVersion(
                "kissopen-providers-v1.2.3",
                { ...MANIFEST, name: "@kissopen/kissopen-providers" },
                "kissopen-providers-v",
            ),
        );
        assert.throws(
            () =>
                assertReleaseTagMatchesPackageVersion(
                    "v1.2.3",
                    { ...MANIFEST, name: "@kissopen/kissopen-providers" },
                    "kissopen-providers-v",
                ),
            /Expected kissopen-providers-v1\.2\.3/u,
        );
    });
});
