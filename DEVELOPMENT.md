# Developing Kissopen Agent and Kissopen Terminal

Thanks for helping improve Kissopen Agent and Kissopen Terminal. This guide contains the repository-specific
setup, testing, and release details that contributors need. For product usage
and configuration, start with the [README](README.md).

## Repository layout

This repository is a pnpm TypeScript workspace.

- `packages/kissopen-agent` contains the headless Kissopen Agent daemon and lifecycle entry points.
- `packages/kissopen-agent-modules` contains the daemon's tools and product features.
- `packages/kissopen-terminal` contains the published `@kissopen/kissopen-terminal` TUI, standalone CLI,
  and Node.js embedding API. Its executable entry point is `packages/kissopen-terminal/sources/main.ts`.
- `packages/gym` contains the host-side end-to-end harness, PTY integration,
  fixtures, and Docker image definition.
- `packages/gym-tests` contains black-box terminal scenarios that exercise Kissopen Terminal and
  Kissopen Agent together in fresh containers.
- `scripts` contains repository release automation.

Shared TypeScript and code-quality configuration lives at the workspace root.
Root commands run the relevant package scripts.

## Setup

Install dependencies from the repository root:

```sh
pnpm install
```

Build and start Kissopen Terminal with checkout-local state:

```sh
pnpm dev
```

This builds the checkout, reloads its isolated Kissopen Agent from the built Node CLI,
and runs the built Kissopen Terminal. The agent socket, token, logs, registry, and session
database stay under the ignored `.kissopen-terminal-dev` directory instead of the normal
Kissopen home. The agent remains available after the TUI exits; the next `pnpm dev`
reloads it from the newest build.

## Running this checkout as the global `kissopen-terminal`

To make `kissopen-terminal` resolve to a fresh build from this checkout, run:

```sh
pnpm link:global
```

This builds every package, compiles the local Kissopen Agent Bun binary, installs it as
version `0.0.0` in the normal shared location at
`~/.kissopen/dist/version/0.0.0/kissopen-agent`, selects it through the normal
`~/.kissopen/dist/config.json`, links `packages/kissopen-terminal` globally through pnpm,
and reloads the daemon from that installed binary. Kissopen Desktop and Kissopen Terminal
therefore discover the same local Agent through the same installation state. Run
`pnpm link:global` again whenever you want to rebuild and restart it with newer source.

Use `pnpm unlink:global` to remove only the global Kissopen Terminal link. It deliberately
leaves Kissopen Agent `0.0.0` installed and selected. The terminal offers the published
release as an update; running that upgrade is how you leave the local Agent. Selecting
another version in Kissopen Desktop does the same. Linking the real package uses the
normal Kissopen home, sessions, and daemon; it is not isolated like `pnpm dev`.

## Live process debugging

Run `/debug` in any interactive Kissopen Terminal session to start loopback-only Node
inspectors for both the terminal UI and daemon. The command reports the current
session, state directory, and both inspector URLs. In either inspector, evaluate
`globalThis.__kissopenTerminalDebug` to start walking the live process state.

Breakpoints suspend the process they target until it is resumed. Native
inspector output from the daemon is written to the state directory's
`server.log`. The TUI inherits Kissopen Terminal's stderr, so redirect it when starting Kissopen Terminal if
you want to keep inspector messages out of the interface, for example
`kissopen-terminal 2>kissopen-terminal-tui.log`. If stderr is still the terminal, `/debug` warns and asks for
confirmation before starting. The inspectors use ephemeral ports bound to
`127.0.0.1`; Node does not authenticate inspector connections, so do not expose
those ports beyond the local machine.

## Validation

Run these checks separately from the repository root:

```sh
pnpm run check
pnpm test
pnpm run build
pnpm run format:check
pnpm run lint
```

Use a check that is proportionate to the change, and run all relevant checks
before publishing.

## End-to-end gym

The gym runs the built Kissopen Terminal CLI and Kissopen Agent daemon through a real PTY in a fresh Docker
container. Only inference is mocked; shell processes, tools, files, daemon
behavior, terminal rendering, interruption, and concurrency are real.

Read [packages/gym-tests/README.md](packages/gym-tests/README.md) before creating
or debugging a gym test. It is the source of truth for prerequisites,
`createGym`, fixtures, terminal snapshots, scroll tracking, targeted commands,
and cleanup.

Run the complete suite with:

```sh
pnpm test:gym
```

For a behavior regression, first reproduce the failure in
`packages/gym-tests/tests`, then make the same scenario pass without weakening
it. Name scenarios for the behavior they prove, interact at the terminal
boundary, wait for observable state instead of sleeping, and dispose every gym
instance.

## Agent evaluations

Read [EVALUATIONS.md](EVALUATIONS.md) before comparing Kissopen Terminal with another agent
harness. It defines the frozen hard-task suite, paired run contract, spend
gates, Docker and credential isolation, preflight requirements, and reporting
rules. A benchmark run is not authorized merely because its configuration is
documented; paid trials remain blocked until that guide's preflight is complete.

## Provider reference sources

Local reference implementations live in `~/Developer/coding-assistant-sources`,
including the Codex and Claude Code source trees. Consult them when implementing
or comparing provider-aligned behavior. Preserve the useful model-facing
semantics while adapting them to Kissopen Terminal's simpler product model.

Pi packages are used as foundations for model streaming and the terminal UI.
Kissopen Terminal intentionally layers a curated experience on top instead of mirroring every
Pi customization mechanism.

## Code organization

Favor one function per file when adding or reshaping source code. Keep all
user-facing strings human-readable, and translate protocol values or internal
identifiers into natural English before rendering them.

For terminal work, treat the visible transcript as append-only. Update an
existing activity row in place when its state changes, and move completed live
work into history without making the composer jump.

## Publishing

Ask an agent to release; it follows the [release instructions](.agent/skills/release-agent/SKILL.md).
An unqualified request publishes a Kissopen Agent preview (`X.Y.Z-preview.N`) for
Nightly Desktop. Explicit production requests publish the next stable patch.
Both use the existing manually dispatched workflow: version and notes in,
build/test/sign and publication in one run. Previews never move GitHub's stable
latest release. Previews are requested, not triggered by pushes.

Kissopen Terminal uses its separate manual workflow and remains stable-only. It
builds and smoke-tests the npm tarball, commits the version, then publishes and
verifies npm before creating its tag and GitHub Release. SDKs keep their existing
tagged publication workflows.

If publication fails before a tag exists, fix the issue and rerun the version.
Never move or reuse an existing tag; advance the release version instead.

### Contributors with push permissions

With release access you can request an Agent preview and test it on Nightly
Desktop. Publish and repin changed SDKs only when the candidate needs new
published dependencies; that is not a prerequisite for every preview. The flows are
described in [master-plans/25-releases.md](master-plans/25-releases.md).

### One-time publishing setup

The release workflow uses npm Trusted Publishing, so it does not need a
long-lived npm token or a contributor's npm account:

1. npm requires a package to exist before a trusted publisher can be attached. An npm owner
   must therefore publish a one-time placeholder version to initialize the
   `@kissopen/kissopen-terminal` name. Do not create a release tag for the placeholder.
2. In the GitHub repository settings, create an environment named `npm` and allow deployments
   from `main`.
3. In the npm settings for `@kissopen/kissopen-terminal`, add a GitHub Actions trusted publisher
   for organization `slopus`, repository `kissopen-agent`, workflow
   `release-kissopen-terminal.yml`, and environment `npm`. Allow the `npm publish` action.
4. Do not create an `NPM_TOKEN` GitHub secret. The workflow requests a short-lived
   OIDC credential for each run and npm automatically records provenance for the
   public package.

Anyone with GitHub Actions write access can then dispatch the release from an up-to-date
`main` branch without receiving npm access. The workflow, rather than a local release command,
owns tag creation.
