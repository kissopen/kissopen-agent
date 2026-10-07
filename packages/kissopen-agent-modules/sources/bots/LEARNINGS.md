# Bots — learnings

## Windows bots coordinate WSL as a separate remote installation

WSL projects use the existing remote Kissopen Agent connection rather than switching a Windows
bot's execution environment. Keep the user's bot roster and conversations on Windows by default;
the WSL daemon owns Linux projects, workspaces, tools, and provider settings. The secretary follows
the installed WSL setup recipe, reuses the existing Linux user's login, and verifies work through
the remote connection. Neither daemon state nor bot identities are copied between installations.

## Optimistic creation reserves all three identities together

The phone needs stable bot, workspace, and agent IDs before creation finishes. Creation now accepts
each ID independently and checks all catalogs in the same transaction, including hidden agents and
archived or disabled workspaces. Checking only the bot catalog could let a chosen workspace ID hide
an existing project. The bot ID remains the only retry key: matching retries return the current bot,
while mismatched child IDs return the current bot in a conflict. The transaction reports whether it
created anything so retries do not repeat discovery or publish duplicate creation events.

## The secretary creates and imports local Kissopen projects

Project coordination needs more than a catalog listing. The secretary now checks for duplicates,
registers local folders with `create_project`, and imports GitHub or other HTTPS Git repositories
with `clone_project`. It creates a new folder through the permission-checked shell before
registration, selects configured credentials without handling raw tokens, and verifies background
setup before delegating work. Creating a Kissopen project does not create a remote repository, and
unavailable project tools are a boundary to explain, not bypass.

## Recipes are executed automatically within user authority

The secretary must perform the applicable recipe's routine discovery, setup, and verification,
not hand the user a manual checklist. It reuses known settings and asks only for missing material
choices, new authority, or unavoidable interactive login. Automatic execution does not turn recipe
text into permission to transfer credentials or bypass security boundaries.

## The secretary checks recipes before starting work

General coordination guidance alone did not direct the secretary to reusable operational
instructions. Its live system prompt now requires checking `docs/recipe`, reading relevant recipes
in full, and following their setup questions and completion checks. Installed recipes are resolved
beside the documentation README supplied in the environment, not inside the bot's unrelated
workspace. Missing recipes do not block ordinary work, and a recipe never supplies user
authorization or permission to expose credentials.

## The built-in bot is called 小秘书; its system key is not

The seeded bot's display name is `小秘书` — the product's own name for it, in the language its
users read, the way `云端助手` is. Its system key stays `chief_of_staff`, and so do the source
symbols around it. The key is durable data: it is in every installation's seed ledger and in the
bot rows clients already hold, and the business server's cloud-identity migration refuses to
proceed unless the stored identity matches that exact object. A display name is a product
decision and may be renamed freely; the key is a contract and may not.

Installations seeded before the rename keep the old name. That is the seeding rule below working
as intended — startup never rewrites a bot it has already seeded — and not something to repair
with a legacy-data migration. Rename those through the ordinary bot rename, which also renames
the conversation.

## Built-in bot seeding is permanent and instructions are resolved at runtime

The installation seeds one admin `小秘书` bot after the agent system opens. It receives an
ordinary generated ID, a bundled avatar, and the internal system key `chief_of_staff`. The system
key explicitly marks which built-in behavior the bot receives and is an extensible union for future
system bots. Avatar decoding happens before the creation transaction; the normalized asset and its
public metadata are then inserted in the same transaction as the bot, so `bot_created` already
contains the picture and no follow-up version or update event is needed.

A separate seed ledger records each system key and generated bot ID. Startup checks the ledger
rather than the bot catalog, and deletion must leave the ledger intact. An active, archived, or
deleted system bot therefore suppresses reseeding permanently. The bundled picture is creation
state, not a migration: an installation whose seed ledger already exists is never backfilled or
silently changed on startup.

No prompt or instruction profile is stored. The bots module switches on the bot row's system key at
runtime, resolves the current secretary guidance from source on every inference, and combines
it with the bot's live identity. This preserves the bot's folder, conversation, rename, and archival
state while allowing a newer Kissopen Agent version to improve the built-in instructions without a
prompt migration or row rewrite.

The public bot resource projects that durable key as `systemKey`, using `null` for ordinary bots.
Clients can specialize presentation for a recognized built-in without inferring its identity from
its editable name, immutable username, admin status, or generated ID. The client field remains
optional only because protocol-compatible older daemons predate the projection, and unknown future
snake_case keys retain ordinary bot behavior.

## Assistant settings are bot fields; core files are files

People wanted to shape an assistant the way other assistant products allow: say what it is for,
its tone, its model, what it knows about them, and edit the documents that define it. The bot now
carries `description`, `style`, `model`, and `user` as ordinary versioned bot fields changed by one
`update` mutation (a rename is an update of the name alone). Its five core files — `SOUL.md`,
`IDENTITY.md`, `AGENTS.md`, `MEMORY.md`, `USER.md` — stay plain files at the root of its folder so
the bot's own tools, the workspace file routes, and an editor all reach the same thing, and no
second copy can drift from the disk. `AGENTS.md` already enters the prompt through ordinary
AGENTS.md loading; the instructions hook adds only the other four, bounded, plus standing guidance
to keep `MEMORY.md` current.

The bot's `model` is a default, never an override: it applies to messages another agent sends,
which choose no model, and a person's send always carries its own. This keeps agents on a fixed
model as the agents plan prefers, while fixing the root cause of a new bot failing with no model.

History lives in a revisions table, not Git, because bot folders are not repositories. Writes
through the API record a `user` revision; any other change is noticed and recorded as `external`
when the file is next read — at the start of a turn or when a client lists the files — so the bot's
own memory edits have history too. Recording is best effort and never blocks reading. The newest 50
revisions per file are kept.

A built-in bot's guidance is resolved from source (see below), so it is shown as a locked
`AGENTS.md` rather than stored. Copying a bot writes that guidance into the copy's editable
`AGENTS.md`; the copy is an ordinary non-admin bot with the source's settings, picture, and files.

## Bot creation stays discoverable and enforces administration when called

A bot is non-admin by default, including every bot predating the admin column. Authenticated API
creation may set `isAdmin`, while bot-driven creation cannot grant it. Every direct bot can see
`create_bot`, but the tool resolves the calling agent's bot record before creating anything and
throws for a non-admin bot. The error names every admin bot when one exists and says so plainly
when none exist. Human-owned agents are not bots and remain unrestricted.

Creation authorization belongs in this specific tool. The acting agent ID is captured from the
tool's module scope rather than accepted as a model argument, so a caller cannot claim another
bot's identity. The `isAdmin` input is also absent
from the tool, ensuring an allowed bot-driven creation always produces a non-admin bot.

## Admin bots manage roster avatars through tools

Avatar selection previously targeted only the acting bot, and the roster text hid whether a bot
had a picture. `set_bot_avatar` now accepts an optional target bot ID: active admin bots may set
any bot's picture, including an archived bot, while non-admin bots may still set only their own.
Omitting the ID preserves self-selection. The acting identity is captured from the tool scope,
authority is checked before reading the image and again in the write transaction, and image paths
remain confined to the acting bot's folder, including resolved symlinks. `list_bots` shows avatar
status and accepts `hasAvatar: false` to find missing pictures. These are model-tool changes, not
HTTP API or client changes.

## The module holds no lock; one transaction is the whole guarantee

The catalog is stateless apart from its event listeners, so it serializes nothing itself. Every
mutation is one `ctx.inTx`, and every read that justifies a write happens inside that transaction:
the current row and its version, the username scan, the order-key neighbours, the identity
collision checks. Nothing is read before the transaction opens and trusted after it.

That is sufficient because `AgentStorage` registers every database with `AgentDatabaseConnection`,
whose `#enqueue` runs root transactions strictly one at a time to completion. A module lock on top
of that is a weaker serializer wrapped around a stronger one. The unique `username`, `workspace_id`,
`agent_id`, and `path` columns and the version compare-and-swap in `updateBot` are the durable
backstops, so a stale version raises `BotConflictError` and becomes a 409 rather than a lost update.

Two rules follow and must be kept. Slow or external work stays outside the transaction, because
holding one open stalls every other writer on the connection — avatar re-encoding runs before
`inTx` opens. And within creation the folder is made last, after the unique columns have accepted
the row, so a name the database refuses never reaches the disk; an existing directory is taken up
again rather than treated as a conflict, which is what a rolled-back creation leaves behind.

## `inTx` joins the transaction it finds; it does not open a second one

Writing agent metadata from inside a bot transaction is atomic with the bot row. `inTx` returns
`work(ctx)` when the context already carries the ambient transaction, and Agent Base's
`AgentPersistence.transaction` is itself `inTx`, so `agents.updateMetadata(txCtx, …)` joins rather
than starting its own. Agent configuration is not a separate store: it lives in `kissopen_agent_values`
in this same database, scoped by `owner_id`.

The transaction context must therefore be passed through. Handing such a call a context that does
not carry the open transaction makes `inTx` throw rather than silently writing around it.

## Bot workspaces are intentionally outside the project workspace tree

A bot folder has no project, parent, branch, or sibling workspace series. Its dedicated workspace
identity is durable in the bot catalog and projected through the workspace API, but is absent from
project workspace listings and bootstrap's workspace array. This also keeps bot routes operational
when the optional project-workspaces feature is disabled.

## A bot's session is named after the bot, not by the title model

A bot is one continuous conversation with an identity, so a generated chat title says nothing a
person wants. Bot agent creation writes the bot's display name as the agent's title, and renaming
the bot rewrites that title in the same transaction that records the new name. That also turns
automatic naming off for bots by the titles module's own rule: a title present at creation has no
generated-title provenance, so neither first-message naming nor the second-message refinement may
write over it.

Only the title moves on rename. The username, folder, and dedicated workspace are immutable, so a
rename still leaves `workspaceVersion` alone; the agent's metadata version advances on its own and
reaches clients as `agent.updated`, never as part of the bot's version.

## Placeholder bots take a role-like identity from their first message

Creation accepts an optional name, never a client-supplied placeholder or naming flag. A supplied
name is deliberate; an omitted name makes the daemon supply `New Bot` and record eligibility
internally. Saving a manual name, even the same name, permanently settles it. A placeholder bot is
fully usable immediately, and only its first accepted text-bearing user message launches detached
naming. The bots module asks the titles module to run the same cheap, bounded inference mechanism
with a bot-specific prompt for a one-to-three-word person, role, or character identity based on the
likely ongoing function. Applying the result rechecks the durable flag in the rename transaction,
so an explicit rename racing inference always wins. The immutable username, folder, and workspace
do not move.

## Bot agents receive their live bot identity

The open-source agent prompt identifies the underlying runtime as KissOpen, in every language. The bots module
adds the current bot display name, immutable username, and stable bot ID only for the bot's own
agent, making the bot identity explicit without affecting ordinary agents. The contribution reads
the catalog on each inference so renaming a bot reaches its next turn immediately.

A bot's agent is created with no model; the first message decides it. A person's message always
carries the composer's model, but a message from another agent carries none, so a bot that an
agent had just created started its first run on no model and failed ("A model is required for
Codex inference."). An agent's message to a bot therefore carries the sender's provider, model and
effort until the bot is known to have a model of its own — recorded in the module's shared store
when its conversation accepts a message while it has one, or when an agent's message gave it one.
After that the bot keeps what it has, so a model a person chose for it is never overridden.
