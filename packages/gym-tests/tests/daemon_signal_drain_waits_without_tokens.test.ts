import { describe, expect, it, vi } from "vitest";
import { createGym } from "@kissopen/kissopen-terminal-gym";

describe("token-free local daemon draining", () => {
    it("drains a team daemon using a raw signal and the same command without WorkOS tokens", async () => {
        const gym = await createGym({
            mode: "docker",
            environment: {
                KISSOPEN_HOME_DIR: "/tmp/kissopen",
            },
            entrypoint: ["bash", "/workspace/team-drain.sh"],
            files: {
                "team-config/kissopen.toml":
                    '[feature.team]\nenabled = true\nhost = "127.0.0.1"\nport = 0\nworkos_organization_id = "org_test"\nowner_workos_user_id = "user_test"\n',
                "team-drain.sh": teamDrainScript,
                "signal-when-ready.mjs": signalWhenReady,
            },
            inference: [],
            startupText: "TEAM_SIGNAL_DRAIN_COMPLETE",
            timeoutMs: 60_000,
        });
        try {
            expect((await gym.terminal.snapshot()).text).toContain("Daemon drain is complete.");
        } finally {
            await gym.dispose();
        }
    }, 120_000);

    it("finishes in-flight inference, blocks new mutations, and stays alive until SIGTERM", async () => {
        let releaseInference!: () => void;
        const gate = new Promise<void>((resolve) => {
            releaseInference = resolve;
        });
        let inferenceStarted = false;
        const gym = await createGym({
            mode: "docker",
            environment: { KISSOPEN_HOME_DIR: "/tmp/kissopen" },
            entrypoint: ["bash", "/workspace/drain.sh"],
            files: {
                "drain.sh": drainScript,
                "check-drained.mjs": checkDrained,
                "daemon-config.toml":
                    '[providers]\ndefault_enable = false\n[providers.gym]\ntype = "codex"\nenabled = true\n',
            },
            startupText: "SIGNAL_DRAIN_READY",
            timeoutMs: 60_000,
            inference: async () => {
                inferenceStarted = true;
                await gate;
                return {
                    content: [{ type: "text", text: "Inference finished before drain completed." }],
                };
            },
        });
        try {
            gym.terminal.press("enter");
            try {
                await vi.waitFor(() => expect(inferenceStarted).toBe(true), { timeout: 30_000 });
            } catch (error) {
                throw new Error(`Inference did not start: ${await gym.readFile("inference.log")}`, {
                    cause: error,
                });
            }
            await gym.terminal.waitForText("INFERENCE_CLIENT_STARTED");
            gym.terminal.press("enter");
            await gym.terminal.waitForText("Draining: 1 agent", 30_000);
            expect((await gym.terminal.snapshot()).text).not.toContain("SIGNAL_DRAIN_COMPLETE");
            releaseInference();
            const screen = await gym.terminal.waitForText("SIGNAL_DRAIN_COMPLETE", 30_000);
            expect(screen.text).toContain("Daemon drain is complete.");
            expect(screen.text).toContain("Authenticated reads work; new mutations are rejected");
            expect(screen.text).toContain("Repeated signal kept the drained daemon alive");
            expect(screen.text).toContain("Graceful SIGTERM shutdown completed");
        } finally {
            releaseInference();
            await gym.dispose();
        }
    }, 120_000);
});

const teamDrainScript = String.raw`#!/usr/bin/env bash
set -euo pipefail
install -d -m 0700 /tmp/kissopen/config
install -m 0600 /workspace/team-config/kissopen.toml /tmp/kissopen/config/kissopen.toml
node /app/kissopen-agent/dist/cli.js run >/workspace/team-daemon.log 2>&1 &
team_pid="$!"
node /workspace/signal-when-ready.mjs "$team_pid"
test ! -e /tmp/kissopen/agent/token
test ! -e /tmp/kissopen/agent/server.sock
node /app/kissopen-agent/dist/cli.js drain
kill -0 "$team_pid"
kill -TERM "$team_pid"
wait "$team_pid"
test ! -e /tmp/kissopen/agent/drain.json
echo TEAM_SIGNAL_DRAIN_COMPLETE
read -r
`;

const signalWhenReady = String.raw`
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const pid = Number(process.argv[2]);
const deadline = Date.now() + 30000;
for (;;) {
    process.kill(pid, 0);
    let state;
    try { state = JSON.parse(await readFile('/tmp/kissopen/agent/drain.json', 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state?.pid === pid && state.phase === 'ready') break;
    if (Date.now() >= deadline) throw new Error('Team daemon did not publish signal support.');
    await delay(50);
}
process.kill(pid, 'SIGUSR2');
`;

const drainScript = String.raw`#!/usr/bin/env bash
set -euo pipefail
agent() { node /app/kissopen-agent/dist/cli.js "$@"; }
install -d -m 0700 /tmp/kissopen/config
install -m 0600 /workspace/daemon-config.toml /tmp/kissopen/config/kissopen.toml
agent start
echo SIGNAL_DRAIN_READY
read -r
node /app/packages/kissopen-terminal/dist/main.js exec --json 'Finish this inference before maintenance.' >/workspace/inference.log 2>&1 &
echo INFERENCE_CLIENT_STARTED
read -r
mv /tmp/kissopen/agent/token /tmp/kissopen/agent/token.saved
agent drain
test ! -e /tmp/kissopen/agent/token
node /workspace/check-drained.mjs
daemon_pid="$(tr -d '[:space:]' </tmp/kissopen/agent/daemon.pid)"
kill -USR2 "$daemon_pid"
agent drain
kill -0 "$daemon_pid"
echo 'Repeated signal kept the drained daemon alive'
kill -TERM "$daemon_pid"
timeout 20 tail --pid="$daemon_pid" -f /dev/null
test ! -e /tmp/kissopen/agent/drain.json
echo 'Graceful SIGTERM shutdown completed'
echo SIGNAL_DRAIN_COMPLETE
read -r
`;

const checkDrained = String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
const token = (await readFile('/tmp/kissopen/agent/token.saved', 'utf8')).trim();
async function request(method, path, body) {
    return await new Promise((resolve, reject) => {
        const req = http.request({
            socketPath: '/tmp/kissopen/agent/server.sock', method, path,
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        }, (response) => {
            let contents = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => { contents += chunk; });
            response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(contents) }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}
const health = await request('GET', '/v0/health');
assert.equal(health.status, 200);
assert.equal(health.body.ready, true);
assert.equal(health.body.draining, true);
assert.deepEqual(health.body.drainWaitingFor, []);
const mutation = await request('PATCH', '/v0/profile', { name: 'Must not be applied' });
assert.equal(mutation.status, 503);
assert.equal(mutation.body.code, 'draining');
console.log('Authenticated reads work; new mutations are rejected');
`;
