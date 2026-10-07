import { describe, expect, it } from "vitest";

import { createKissopenIntegrationVersion } from "../../sources/kissopen/createKissopenIntegrationVersion.js";

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createKissopenIntegrationVersion", () => {
    it("stays UUIDv7 and strictly ordered when time repeats or moves backward", () => {
        const first = createKissopenIntegrationVersion(undefined, () => 1_000);
        const second = createKissopenIntegrationVersion(first, () => 1_000);
        const third = createKissopenIntegrationVersion(second, () => 999);

        expect(first).toMatch(UUID_V7_PATTERN);
        expect(second).toMatch(UUID_V7_PATTERN);
        expect(third).toMatch(UUID_V7_PATTERN);
        expect(second > first).toBe(true);
        expect(third > second).toBe(true);
    });

    it("rejects a previous value that is not UUIDv7", () => {
        expect(() => createKissopenIntegrationVersion("not-a-version")).toThrow(
            "The WorPar integration version is invalid.",
        );
    });
});
