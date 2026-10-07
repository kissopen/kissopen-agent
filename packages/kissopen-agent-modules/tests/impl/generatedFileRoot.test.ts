import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { generatedFileReadQuerySchema } from "../../sources/files/index.js";
import { generatedFileRoot } from "../../sources/impl/images/generatedFileRoot.js";

describe("generated file root", () => {
    const generated = "/Users/me/Public/Generated";

    it("serves an absolute path inside the generated folder from that folder", () => {
        expect(generatedFileRoot(generated, "/Users/me/Public/Generated/call.png")).toEqual({
            projectId: "generated",
            root: generated,
        });
        expect(generatedFileRoot(generated, "/Users/me/Public/Generated/deep/er/call.png")).toEqual(
            {
                projectId: "generated",
                root: generated,
            },
        );
    });

    it("leaves every other path to the workspace root", () => {
        expect(generatedFileRoot(generated, "outputs/deck.pptx")).toBeUndefined();
        expect(generatedFileRoot(generated, "/Users/me/Public/Generated")).toBeUndefined();
        expect(
            generatedFileRoot(generated, "/Users/me/Public/GeneratedX/call.png"),
        ).toBeUndefined();
        expect(
            generatedFileRoot(generated, "/Users/me/Public/Generated/../secrets"),
        ).toBeUndefined();
        expect(generatedFileRoot(generated, "/etc/passwd")).toBeUndefined();
    });
});

describe("generatedFileReadQuerySchema", () => {
    const accepts = (path: string) => Value.Check(generatedFileReadQuerySchema, { path });

    it("admits an absolute path and refuses relative ones", () => {
        expect(accepts("/home/agent/Generated/a.png")).toBe(true);
        expect(accepts("Generated/a.png")).toBe(false);
    });

    it("refuses traversal, backslashes, and NUL", () => {
        expect(accepts("/home/agent/Generated/../a.png")).toBe(false);
        expect(accepts("/home/agent/..")).toBe(false);
        expect(accepts("/home\\agent\\a.png")).toBe(false);
        expect(accepts("/home/agent/a\u0000.png")).toBe(false);
        expect(accepts("/home/agent/Generated/..a.png")).toBe(true);
    });
});
