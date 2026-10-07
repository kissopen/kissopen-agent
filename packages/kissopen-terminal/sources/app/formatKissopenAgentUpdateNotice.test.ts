import { describe, expect, it } from "vitest";

import { formatKissopenAgentUpdateNotice } from "./formatKissopenAgentUpdateNotice.js";

describe("formatKissopenAgentUpdateNotice", () => {
    it("proposes the embedding host's upgrade command", () => {
        expect(
            formatKissopenAgentUpdateNotice(
                { currentVersion: "1.2.3", latestVersion: "1.2.4" },
                "my-app agent",
            ),
        ).toEqual({
            text: "KISSOPEN Agent 1.2.4 is available; this terminal is using 1.2.3. Run 'my-app agent upgrade' to download it and restart KISSOPEN Agent.",
            title: "KISSOPEN Agent update available",
        });
    });
});
