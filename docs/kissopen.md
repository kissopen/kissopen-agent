# The Kissopen family

Kissopen is a family of two products, built by the same authors as Kissopen Agent, that put
people in touch with the coding agents working for them. Both connect to Kissopen Agent,
and both can be the thing on the other end of a conversation you are having.

- **Kissopen** is _end-to-end encrypted remote access to your coding agents_. A
  mobile and web client lets you watch and steer agents that are running on your
  own machine, from anywhere. The relay in the middle carries only ciphertext
  and can read nothing.
- **Kissopen 2** is Kissopen's _desktop collaborative sibling_: a self-hosted,
  Slack-like workspace where people and coding agents build together —
  conversations, files, documents, workspaces, and agents in one app, started
  with a single command and keeping all of its state on the machine that runs
  it.

They solve two halves of the same problem. Kissopen answers "my agent is working
on my machine and I am not at my machine." Kissopen 2 answers "my team and our
agents need one shared place to work." Kissopen Agent is the coding-agent runtime
underneath both: Kissopen synchronizes your live Kissopen Agent sessions to your phone, and
Kissopen 2 executes its agents as Kissopen Agent sessions.

A naming note, because the two products share a word. In this documentation,
**Kissopen** always means the encrypted remote-access product, and **Kissopen 2**
always means the collaborative desktop workspace. Kissopen 2 is started with
`npx kissopen2` and keeps its state under `.kissopen2`, so its package names,
configuration keys, and paths read `kissopen2`. Kissopen Agent's own `kissopen_integration`
setting belongs to **Kissopen**, not to Kissopen 2 — and Kissopen 2 deliberately turns that
integration off in the private Kissopen Agent runtime it manages.

---

# Kissopen — encrypted remote access to your agents

## What it is

Kissopen is a mobile app (iOS and Android) and a web app that act as a remote
control for coding agents running on your own computer. You start work in a
terminal, walk away, and keep reading the transcript, answering questions,
sending new instructions, or stopping a run from your phone. Nothing about
where the agent runs changes: the agent stays on your machine, with your files,
your credentials, and your permission boundary.

The design constraint that shapes everything else is that the server in the
middle must not be able to read your work.

## Architecture

Kissopen has three parts:

| Part             | Where it runs                      | What it does                                                                                                             |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Client**       | Your phone or browser              | Renders sessions, transcripts, and machines; sends messages, permission answers, and control commands.                   |
| **Relay server** | Hosted                             | Stores and routes opaque encrypted blobs, delivers realtime updates and push notifications. Holds no readable content.   |
| **CLI / daemon** | Next to the agent, on your machine | Runs or wraps the coding agent, encrypts everything before it leaves, and executes commands that arrive from the client. |

On your own machine, the Kissopen CLI is installed globally (`npm install -g
kissopen`) and used in place of the agent command — `kissopen claude`, `kissopen codex`.
It keeps local state under `~/.kissopen` (relocatable with `KISSOPEN_HOME_DIR`):
`access.key` holds the local key material, `settings.json` the profile and
onboarding state, `daemon.state.json` the background daemon's PID, control
port, and version, and `logs/` the CLI and daemon logs. The daemon is what lets
the client reach a machine when no terminal is attached: it registers the
machine, spawns sessions on request, and keeps machine state synchronized.

The relay is a Fastify server with Socket.IO for realtime, Postgres for
storage, and S3-compatible blob storage for uploads. Its API surface deals in
sessions, machines, messages, artifacts, and a key-value store — but for all of
those, the interesting fields are ciphertext it never opens.

## What "the relay sees only ciphertext" actually means

Clients encrypt before sending and decrypt after receiving. The server stores
and forwards the result as opaque strings and bytes. This covers session
metadata, session agent state, every session message, machine metadata, daemon
state, artifact headers and bodies, key-value entries, and access keys.

Two encryption variants are in use:

- **Legacy**, when a client only holds a 32-byte shared secret: NaCl secretbox
  (XSalsa20-Poly1305) with a 24-byte nonce, laid out as nonce followed by
  ciphertext and authentication tag.
- **DataKey**, when a client supports per-session and per-machine data keys:
  AES-256-GCM with a 12-byte nonce and 16-byte tag, laid out as a version byte,
  nonce, ciphertext, and tag. The content key itself is wrapped with
  NaCl-compatible X25519/XSalsa20-Poly1305 under an ephemeral keypair and
  travels as a versioned bundle
  in fields such as `dataEncryptionKey`.

Everything encrypted becomes base64 on the wire. Identifiers, versions, and
timestamps stay in plaintext, because the server has to route and order things.
Separately, and unrelated to your content, the server encrypts certain
third-party tokens at rest with a server-only key; those are not end-to-end
encrypted, and they are the server's own secrets, not yours.

Practical consequence: the operator of the relay can see that a machine exists,
that sessions exist, and roughly when they were active. They cannot see your
prompts, the model's replies, your file contents, your tool calls, or your
machine's name.

## How Kissopen Agent connects to Kissopen

Kissopen Agent speaks the Kissopen protocol natively. It does not wrap another CLI; a Kissopen Agent
daemon registers itself as a machine and synchronizes its sessions directly.

**Turning it on and off.** Kissopen integration is enabled by default. It is a machine-level
decision controlled by `kissopen_integration = false` under `[settings]` in the user-wide
configuration file. Repository-level configuration cannot enable or disable it.

**Credentials.** When the integration is enabled, the Kissopen Agent daemon imports newer
credentials from `~/.kissopen` at startup, so a machine already paired with the
Kissopen CLI needs no extra step. To pair from Kissopen Terminal directly, `kissopen-terminal kissopen auth`
prints a QR code — a real PNG in terminals that support Kitty or iTerm2 image
protocols, and a compact text QR everywhere else — which you scan with the
Kissopen app. Kissopen Agent keeps its copy of the access key, machine identity, and settings
under its own home directory, separate from the CLI's `~/.kissopen`.

**What Kissopen Agent publishes.** Every primary Kissopen Agent session you open is synchronized live.
Kissopen Agent registers itself as a Kissopen Agent-kind machine and publishes its display name, host,
platform, version, and the complete model catalog: each provider, each model,
its available reasoning levels and default level, its service tiers, and its
context window. It also publishes Kissopen Agent's four permission modes with
human-readable names and descriptions, so the client can offer them. Session
metadata carries the live activity of a session — the current activity state,
running processes, queued and running subagents, task counts, and workflow
counts — along with the current model, provider, and the capabilities the
session supports.

**What a person can do from the app.** Send messages into a running or idle
session; attach encrypted images; answer permission requests and interactive
questions; stop the active turn; switch the session's model to any
provider-qualified model in the catalog and pick a supported reasoning level;
and ask the machine to spawn a new session in a directory, choosing the
provider, model, effort, and permission mode. Spawning in a directory that does
not exist comes back as an explicit request to approve creating it, rather than
silently creating directories on your machine.

A small set of remote procedures is also exposed against a synchronized
session, so the client can act on the machine through the agent's own
boundaries: `abort`, `bash`, `listFileTree`, `readFile`, `writeFile`, `ripgrep`, and
`communication` (the reply channel for interactive questions). These run
through the same `AgentContext`, filesystem boundary, and sandbox as the
agent's own tools — the app does not get a wider door than the agent has.

**There is no separate remote mode.** Messages that arrive from a phone enter
the same session, the same queue, and the same permission boundary as messages
typed into the terminal. You do not hand control back and forth; both surfaces
are attached to one durable session.

---

# Kissopen 2 — the desktop collaborative workspace

## What it is

Kissopen 2 is a self-hosted, Slack-like work and coding app: channels and chats,
direct messages, documents, files, activity, calls, apps and plugins, and
administration — with coding agents as first-class members of conversations
rather than a separate tool you switch to.

This page describes the **local, self-hosted** Kissopen 2, the only mode that
matters here: the app you start on your own machine, keeping all of its state
on that machine.

- One command starts everything: `npx kissopen2`, then open
  <http://127.0.0.1:3000>. Node.js 24 or later is required.
- Everything durable lives under `.kissopen2` in the directory where Kissopen 2 was
  started: the SQLite database, uploaded files, generated JWT keys and password
  pepper, plugin state, agent workspaces, and Kissopen 2's private Kissopen Agent runtime.
- The same React application runs in a browser and in an Electron desktop app.
- `npx kissopen2 daemon start` and `daemon stop` run it in the background with a
  PID file and logs under `.kissopen2`; `npx kissopen2 service start` and
  `service stop` install it as a per-user macOS LaunchAgent or print the
  systemd commands for Linux.
- Configuration is a partial TOML file merged over built-in defaults, selected
  by `--config`, `KISSOPEN2_CONFIG`, or `./.kissopen2/kissopen2.toml`.

## Local architecture

| Piece   | Role                                                                                  |
| ------- | ------------------------------------------------------------------------------------- |
| Server  | Fastify backend: authentication, SQLite persistence, files, realtime, agent execution |
| State   | Framework-independent client state; immutable snapshots plus realtime reconciliation  |
| UI      | Reusable design system and component workbench                                        |
| App     | The React product, shared by web and desktop                                          |
| Web     | Browser entry point and production web build                                          |
| Desktop | Electron app that supervises child processes and can host the Kissopen Terminal surface  |

The all-in-one executable starts the API on an ephemeral loopback port, serves
the packaged single-page app on the configured public port, and proxies the API
internally, so the browser talks to one origin for HTTP, uploads, and
server-sent events. All useful HTTP endpoints live under a `/v0` prefix; `/` is
only a small status response. Server APIs use GET and POST only, and POST paths
name explicit actions rather than CRUD verbs.

## How Kissopen 2 uses Kissopen Agent

Kissopen 2 drives Kissopen Agent in **two separate ways**. They are easy to confuse, so keep
them apart:

1. **Server-side agent execution.** The Kissopen 2 server starts and owns a
   private, bundled Kissopen Agent daemon and creates one Kissopen Agent session per agent
   conversation. This is how an agent that is a member of a channel actually
   thinks and works.
2. **The desktop Kissopen Terminal surface.** The Electron app hosts Kissopen Terminal against a Kissopen
   Agent daemon _you_ already run yourself and shows its projects, sessions, transcripts, files,
   and terminals inside Kissopen Desktop.

### 1. The private Kissopen Agent runtime that executes agent turns

An `[agents]` table configures this path — whether it is enabled, the daemon
socket and token paths, the Kissopen Agent command, and the default working directory for
agent workspaces. Its defaults point at a private Kissopen Agent runtime under
`.kissopen2/agent`, with workspaces under `.kissopen2/workspaces`.

What follows from the implementation:

- Kissopen 2 starts the Kissopen Agent executable **installed with its own server package**, never a
  global `kissopen-terminal` binary, with `KISSOPEN_HOME_DIR` pointing at its private `.kissopen2` state.
  That home holds the daemon's configuration, session state, socket, and token.
- Its generated machine configuration disables Kissopen synchronization, so this private runtime
  never appears as a machine in Kissopen's encrypted mobile sync.
- The daemon mode defaults to _managed_: Kissopen 2 writes an exact internal
  runtime configuration (durable global event queue on, Kissopen integration off),
  hashes it, checks the running daemon's version, replaces the daemon when
  either drifts, and stops it during shutdown. A separately supervised
  deployment may instead run _attached_, in which case Kissopen 2 neither rewrites
  nor stops the daemon.
- Kissopen 2 talks to the daemon over its Unix socket using the token file beside
  it, and enables the durable global event queue so it can follow one global
  event stream with a cursor and trim it periodically.

**One Kissopen Agent session per agent conversation.** When an agent must answer in a
chat, Kissopen 2 resolves or creates a binding of (chat, agent) to a Kissopen Agent session:

- A per-agent sandbox directory pair is created under the configured agent
  working directory, and an OCI container (Docker or Podman) is created from
  that agent's image, with the workspace bind-mounted at `/workspace` and the
  agent home at `/home`.
- The Kissopen Agent session is created against that existing container with
  `/workspace` as the working directory, the chat's model, and the agent's
  effort.
- Child channels reuse their parent conversation's container and working
  directory, so related channels share one environment; their images must
  match.
- Sessions are created with the `full_access` permission mode. That is
  deliberate: the agent is already confined by a dedicated container sandbox,
  so **full access here means "no extra Kissopen Agent-side sandbox inside an already
  sandboxed container", not "free rein on the user's machine".**
- Per-agent and per-channel secrets are registered with Kissopen Agent and reconciled onto
  the session, so environment values are attached and detached as bindings
  change.

**Turns.** Messages addressed to agents become durable turns that Kissopen 2
drains one at a time per chat. A channel has a default agent and may address
additional agent members; a direct message can only address its own agent.
Kissopen 2 submits the prompt to Kissopen Agent, streams the agent-loop events back out of the
global event stream, and turns them into Kissopen 2 messages, typing indicators,
live activity (phase, tool names, subagents, background terminals, token
counts), and a final reply. Steering delivers new user text into a running
turn; stopping a run ends it in Kissopen Agent and releases the worker lease.

**Terminals and previews.** Kissopen 2 can open Kissopen Agent remote terminals inside the
agent's container and attach them to the app over WebSocket. Optional
port-sharing configuration publishes a range of container ports through a
wildcard preview domain with per-share audiences.

### 2. The desktop Kissopen Terminal surface

Kissopen Desktop can host `@kissopen/kissopen-terminal` against the Kissopen Agent you installed yourself:

- The main process can use the embedded package or the standalone `kissopen-terminal` command,
  resolves the daemon socket and token, and refuses to connect when the protocol is incompatible.
- It proxies that daemon connection to the renderer, which uses Kissopen Agent's client
  library to keep the transcript, session list, model catalog, inbox, provider
  usage, changed files, and terminals live.
- This is a normal Kissopen Agent daemon on your machine: your projects, your workspaces,
  your credentials. It is _not_ the private Kissopen Agent runtime described above.

**Remote Kissopen Agents are in progress.** A prototype in the desktop main process
reaches another machine over OpenSSH: it asks the machine for its default
daemon socket and token with one fixed command, forwards that Unix socket to a
private local one, and then speaks the ordinary daemon protocol over it, so a
remote daemon looks identical to a local one above the connection boundary. The
intended destination is that a remote Kissopen Agent is added by naming a machine the way
you already reach it over SSH, its projects appear in the sidebar beside local
ones, Connect and Disconnect work on demand, a disconnected Kissopen Agent degrades
cleanly, and no application code above the connection layer branches on remote
versus local. Treat that polished experience as **planned**; the SSH transport
exists today.

## Files and documents

- **Files** are stored by the server under `.kissopen2/files` with signed URLs,
  quotas, optional malware scanning, and resumable uploads. A chat's workspace
  files are reachable through dedicated workspace endpoints.
- **Documents** exist today as server-owned collaborative documents with a
  Documents tab, presence, attach and detach to chats, and an approval flow for
  write requests, exercised by a built-in documents plugin.
- **Planned:** moving document ownership to the Kissopen Agent instance rather than to
  projects, so each connected Kissopen Agent exposes its own Documents tab and local
  collection stored in a defined folder on that machine, every saved document
  keeps a normalized Markdown file beside its collaborative state, a document
  can be attached to a session without being owned by it, and agent edits enter
  as versioned changes rather than replacing the collaborative state. A later
  step would synchronize documents between Rigs through an encrypted relay that
  never owns the data.
- **Planned:** a unified set of file surfaces — Changed files, All files, and an
  in-app preview component for images, video, and Markdown, reused wherever a
  file or link is opened.

---

# What an agent under Kissopen Agent should know

## When your session is driven through Kissopen

Your execution does not change. You are an ordinary local Kissopen Agent session with your
normal permission mode, working directory, and sandbox. What changes is who is
watching and who can interrupt:

- **A person may be reading along from a phone.** Your text blocks, tool calls,
  and activity are mirrored live. Write as if someone is following on a small
  screen away from their desk.
- **Messages can arrive from anywhere.** A message sent from the app enters the
  same session and the same queue as terminal input; there is no separate
  remote mode and no reduced boundary. Steering and stopping mid-turn are
  normal outcomes, not failures.
- **Permission answers and question answers may come from the app.** A reply to
  an interactive question is a trusted user answer regardless of which surface
  it came from.
- **The model or reasoning level may change under you.** A person can switch
  the session's model and effort from the app. Do not assume the model that
  answered last time.
- **Your content is encrypted end to end, but it is still leaving the
  machine.** Session content is encrypted before it goes to the relay and the
  relay cannot read it. That is not a reason to treat the transcript as
  private-by-default: it is a normal conversation with a person who may be
  anywhere.

## When your session is driven through Kissopen 2

If your session was created by the Kissopen 2 server, your environment is
different in ways that matter:

- **You are inside a container.** Your working directory is `/workspace` and
  `HOME` is `/home`, both bind-mounted from the host's agent workspace tree.
  You are not in the user's own repository checkout unless someone put it
  there.
- **Your permission mode is `full_access` by design.** The container is the
  security boundary, not Kissopen Agent's sandbox. Being unsandboxed inside it is not an
  invitation to act outside the task you were asked to do; behave as carefully
  as you would in Auto mode.
- **Your conversation is a chat.** Your reply becomes a message in a channel or
  direct message that people and possibly other agents read. Your text blocks,
  tool calls, subagents, and background terminals are surfaced live, so partial
  work is visible while you are still working.
- **Turns are queued and steerable.** New user messages can be delivered into a
  running turn, and a reader can stop your run at any time. A stopped or steered
  turn is a normal outcome.
- **Secrets are attached, not discoverable.** Agent- and channel-scoped secrets
  are attached to your session. Use them through the mechanisms Kissopen Agent exposes; do
  not go looking for credential stores.
- **Model and effort are chosen by the chat.** They are set and reconciled from
  the chat and agent configuration.
- **Kissopen Agent's bundled documentation may not be mounted.** Kissopen Agent exposes these pages at
  `/kissopen/docs` only in containers it creates itself. Kissopen 2 supplies its own
  container, so that path is generally absent there; read documentation from
  the workspace or ask, instead of assuming the path exists.

If instead you are an ordinary local Kissopen Agent session that the Kissopen 2 **desktop
app** is displaying, nothing about your execution changes either. Kissopen 2 is
only a client watching the same daemon your terminal uses, so a person may be
reading along, sending messages, switching your model, or stopping your run
from a window you never see.

## Related pages

- [architecture.md](architecture.md) — how Kissopen Agent itself is put together: daemon,
  protocol, sessions, providers, persistence.
- [permissions-and-sandbox.md](permissions-and-sandbox.md) — the permission
  modes referenced above and how review and escalation actually work.
- [agents-and-collaboration.md](agents-and-collaboration.md) — subagents,
  messaging between agents, scheduling, and durable waits.
- [extending.md](extending.md) — plugins, skills, MCP servers, and building on
  Kissopen Agent from the inside.
