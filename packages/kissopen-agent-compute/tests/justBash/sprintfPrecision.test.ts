import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const dependencyRequire = createRequire(require.resolve("just-bash"));
const { sprintf, vsprintf } = dependencyRequire("sprintf-js");

describe("sandboxed printf dependency precision", () => {
    for (const type of ["e", "f", "g"]) {
        it.each(["101", "1000000000", "9".repeat(400)])(
            `bounds excessive %${type} precision (%s)`,
            (precision) => {
                expect(sprintf(`%.${precision}${type}`, 1.25)).toBe(sprintf(`%.100${type}`, 1.25));
                expect(vsprintf(`%.${precision}${type}`, [1.25])).toBe(
                    sprintf(`%.100${type}`, 1.25),
                );
            },
        );
    }

    it("handles zero significant-digit precision without aborting the caller", () => {
        expect(sprintf("%.0g", 1.25)).toBe(sprintf("%.1g", 1.25));
    });

    it("preserves valid numeric precision and positional arguments", () => {
        expect(sprintf("%2$.2f %1$.0e", 12, 1.25)).toBe("1.25 1e+1");
        expect(sprintf("%.100f", 1.25)).toBe((1.25).toFixed(100));
        expect(sprintf("%.3g", 1.25)).toBe("1.25");
    });

    it("preserves string precision above the numeric limit", () => {
        expect(sprintf("%.101s", "a".repeat(120))).toBe("a".repeat(101));
    });
});
