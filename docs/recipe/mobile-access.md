# Set up or repair Mobile Access

Use this recipe when someone wants to control Kissopen Desktop from Kissopen Coder on their phone,
or control terminal Claude Code/Codex sessions remotely. Mobile access is optional and the phone
holds the account's primary key. Messages and session content are end-to-end encrypted between
the computer and phone. This is not a migration to direct phone-to-Agent transport.

## KissOpen community account login

The community desktop and phone clients use the same username/password or
configured OAuth account. Sign in on both; mobile discovers the account's
computers automatically, without a required QR scan. Desktop authorizes the
native Agent using its existing integration API and an account-authenticated,
encrypted handoff. The standalone terminal QR workflow below remains available
for clients that do not implement account login.

Workspace seeds remain device-owned. The first connection of a new device to
an existing encrypted workspace needs an already signed-in device online to
deliver its key securely. Saved keys are reused on later sign-ins. Do not
replace an existing key or silently start an empty account when recovery is
unavailable. Computer files and Agent operations still require that computer
online; the relay does not execute models or become a plaintext cloud drive.

## Legacy guided QR setup

Use the Mobile Access flow in Desktop onboarding or **Settings → Mobile Access**. Both local
entry points use the same guided setup: opt in; get Kissopen Coder from the App Store or Google
Play while Desktop prepares the legacy Kissopen CLI; confirm the app is open; scan the device QR
inside Kissopen Coder and approve; wait for terminal setup to finish. The store QR downloads the
app; the device QR authorizes the computer. There is only one device-authorization scan.

If the computer is already linked, reuse that link and finish terminal setup without asking for
another scan or forced login. A saved link can be offline; do not call it connected until live
status confirms it. The CLI and native Agent still have distinct machine registrations.

To control a terminal session remotely, start it with `kissopen claude` or `kissopen codex`. Merely
running vanilla `claude` or `codex` does not put that session under Kissopen's remote control. The
phone can also start sessions when the corresponding computer and daemon are online.

## Diagnose without destroying the existing setup

- Never delete, reset, or recursively repair `~/.kissopen` or `KISSOPEN_HOME_DIR`. Kissopen Agent shares
  that directory; existing history, configuration, and account state must remain intact.
- Never prescribe `kissopen auth login --force` as routine onboarding. An account/server mismatch
  requires the user's intended account/server choice, not silently replacing either login.
- Desktop currently requires an available Node.js/npm installation to prepare the terminal CLI.
  Inspect the reported prerequisite/PATH/permissions error. Do not run a global install with
  sudo or change ownership recursively as a generic fix.
- The CLI must support `kissopen auth desktop --check`, whose exact marker is
  `kissopen-desktop-link-v1`. The marker names the local command capability, not V1 account auth;
  this handoff supports V2 credentials. If the published CLI lacks it, stop and explain that
  compatible builds are required. Do not fall back to interactive or forced authentication.
- If phone approval succeeds but terminal setup fails, retain the native pairing and retry the
  shared flow. `kissopen auth desktop` performs credential handoff and starts the daemon; it is a
  mutation, not a read-only diagnostic. Run it only within the user's authorized repair task.
  Its direct error can distinguish account/server refusal from daemon startup/readiness failure.
- Do not print or ask the user to paste credential files, tokens, QR payloads, or private keys.
  CLI credentials are at the shared home root; native credentials are beneath `agent/kissopen/`.
  Validate status through product tools; do not reconstruct authentication by copying secrets.
- Readiness is checked during setup, not continuously. In the current implementation a CLI
  daemon stopped by reboot or a crash is not automatically restarted by ordinary Desktop
  startup. Explain this limitation; use the authorized setup action to start it again. Do not
  confuse native Desktop connectivity with terminal spawn/resume readiness.

Remote Agents keep their existing Agent-only Mobile Access path. Connect them through that
Agent's Settings; local Desktop's automatic terminal linking does not install a CLI on a remote
machine or transfer credentials there. Read the remote deployment recipe if that is the task.

Lost accounts, phone reinstalls, and conflicting saved accounts require a deliberate recovery
conversation. Preserve both sides until the user chooses the account to keep. Do not initiate
notifications or an older-user promotion campaign as part of repair.

## Completion checks

Confirm the intended account remains in place, native status is truthful, and terminal daemon
setup completed. Where real devices and authority are available, verify a Claude/Codex start
and resume from the phone. Do not claim a real-device check from build or unit-test results.
