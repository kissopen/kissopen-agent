import type { ProtocolSession } from "../protocol/index.js";
import { KissopenTerminalUserError } from "../KissopenTerminalUserError.js";

export function ensureSessionCanResume(session: ProtocolSession): void {
    if (session.agent.type === "subagent") {
        throw new KissopenTerminalUserError("Subagent histories are read-only.", {
            hint: "Open the parent session to see this work.",
        });
    }
}
