import "../../scripts/windowsSandboxTestSetup.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests must never read the machine's real Kissopen Terminal configuration. A developer who keeps a global
// AGENTS.md, kissopen.toml, or runtime.toml would otherwise change the behaviour of agents under test,
// so a suite that passes on a clean checkout fails on theirs. Point every test at empty directories
// instead.
process.env.KISSOPEN_TERMINAL_CONFIGURATION_DIRECTORY = mkdtempSync(
    join(tmpdir(), "kissopen-terminal-test-configuration-"),
);
process.env.KISSOPEN_TERMINAL_HOME = mkdtempSync(join(tmpdir(), "kissopen-terminal-test-home-"));
