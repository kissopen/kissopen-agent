---
name: local-agent
description: Build, install, select, and reload Kissopen Agent from this checkout, or switch back to the latest released Agent. Use when asked to link, relink, install, reload, or stop using a local Kissopen Agent build.
---

# Local Kissopen Agent

Run checks before installation, then from the repository root run:

```bash
pnpm link:global
```

This builds the checkout, globally links Kissopen Terminal, installs and selects Agent version
`0.0.0`, and schedules a detached reload. The detached worker waits five seconds, allows graceful
draining for 30 seconds, then falls back to `kill` followed by `start`.

Make `pnpm link:global` the turn's final tool call and return immediately after it. Do not poll the
reload from the agent being reloaded. The worker logs to `~/.kissopen/agent/local-reload.log`.

To bypass graceful drain when recovering a stuck daemon, run this as the final tool call:

```bash
node .agent/skills/local-agent/reload.mjs --hard
```

To switch back, use Kissopen Desktop's Agent version picker to download or select the latest release.
No unlink script is needed.
