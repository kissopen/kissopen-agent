import { describe, expect, it } from "vitest";

import { readExpertClosing, saysNothingOpen } from "../../sources/expert/index.js";

describe("reading an expert's closing parts", () => {
    it("reads plain labels with a list of files", () => {
        expect(
            readExpertClosing(
                "Result.\n\nFiles:\n- /work/a.pptx\n- /work/b.png\nChecked: opened both\nOpen: none",
            ),
        ).toEqual({ files: ["/work/a.pptx", "/work/b.png"], open: "none" });
    });

    it("reads headings, bold labels, code spans, links and descriptions", () => {
        const closing = readExpertClosing(
            [
                "## Files",
                "- `/work/deck.pptx` — the deck",
                "- [chart](/work/chart.png)",
                "- notes/summary.md (short summary)",
                "**Checked:** everything",
                "**Open:** the appendix",
            ].join("\n"),
        );
        expect(closing).toEqual({
            files: ["/work/deck.pptx", "/work/chart.png", "notes/summary.md"],
            open: "the appendix",
        });
    });

    it("reads Chinese labels and comma-separated paths", () => {
        expect(
            readExpertClosing("完成。\n文件：/work/报告.docx，/work/图表.png\n遗留：无"),
        ).toEqual({
            files: ["/work/报告.docx", "/work/图表.png"],
            open: "无",
        });
    });

    it("keeps only the last sections, and does not mistake prose for a label", () => {
        const closing = readExpertClosing(
            [
                "Files: /draft/old.md",
                "Open the deck in Keynote to see the notes.",
                "Final:",
                "Files: /work/final.md",
                "Open: none",
            ].join("\n"),
        );
        expect(closing.files).toEqual(["/work/final.md"]);
        expect(closing.open).toBe("none");
    });

    it("has no files when there is no Files section, and none when it says none", () => {
        expect(readExpertClosing("Just an answer.")).toEqual({ files: undefined, open: "" });
        expect(readExpertClosing("Files: none\nOpen: none").files).toEqual([]);
    });

    it("recognizes what means nothing is left", () => {
        for (const open of ["", "none", "None.", "n/a", "无", "没有", "None — all done"]) {
            expect(saysNothingOpen(open)).toBe(true);
        }
        // "没有完成图表" is "the chart was not done": something is left.
        for (const open of ["the appendix", "没有完成图表", "none of the charts are done"]) {
            expect(saysNothingOpen(open)).toBe(false);
        }
    });
});
