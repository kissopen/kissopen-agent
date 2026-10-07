# Config module learnings

## Hosted message mode is not a user preference

`kissopenMessageMode` applies the backend's default model/effort to hosted human submissions,
even when a client carries a stale conversation mode. It clears service tier, preserves
permissions, and rejects an unavailable policy model/effort. BYOK providers and internal
collaborators are unchanged. Catalog reordering alone cannot override persisted `lastMode`.

## Node display identity is not P2P identity

Reusing `p2p.name` for the daemon's display name conflates separate identities. The Kissopen Agent
installation's name and avatar belong to `config.node`, independently of P2P configuration,
connection-roster labels, conversation agents, and the human profile. Bootstrap already includes
config, so a separate node snapshot, version, and event are unnecessary. Use `PATCH /v0/config`
for the name and `config.updated` for name or avatar changes; keep only image bytes on a separate
endpoint. Avatar presence is represented only by `avatar: { thumbhash } | null`; a separate boolean
duplicates that fact and permits contradictory states. This is unrelated to online/away availability.

## Configuration paths follow the platform's casing

The runtime rewrite hardcoded `Kissopen/Config` everywhere, silently ignoring the documented
`kissopen/config` directory on case-sensitive Linux filesystems. Configuration now uses `Kissopen/Config`
on macOS and `kissopen/config` elsewhere, beside the private `.kissopen` root. Loading and startup file
creation share these paths for settings, MCP, global instructions, and security. Tests must seed
the target platform's directory; private `.kissopen/agent` state remains unchanged. Existing uppercase
Linux configuration is not automatically moved or used as a fallback.

The daemon derives its public folder beside `KISSOPEN_HOME_DIR`; it does not honor the terminal-only
`KISSOPEN_TERMINAL_CONFIGURATION_DIRECTORY` override. Deployment recipes and daemon tests must write
the actual derived config path instead of setting an environment variable the daemon ignores.

## Standalone profile bootstrap is machine configuration

Remote onboarding should reuse the local person's name and email through `[profile]` records in
global `kissopen.toml`, not an HTTP profile mutation or a skip-onboarding flag. Both fields must be
valid when configured. Project configuration cannot choose an installation's identity, and team
mode rejects a shared standalone profile. The profile module consumes these records on startup
to fill missing fields without overwriting later edits.

## Claude 1M models compact at 400k, not at Claude Code's default

Claude Code's own default compacts at the model window minus a 20k response reservation and a 13k
summary buffer, so 967k on a 1M model. Matching that was considered and rejected: the Claude Code
team recommends 400k as the compromise between task depth and context pollution, replayed sessions
show 300k to 400k halving re-read tokens at the same wall-clock time, and Opus measurably degrades
on task-related context beyond that range. Going much lower is also wrong, because each compaction
loses roughly half of the user's stated constraints. The 1M Claude entries therefore compact at
400k. Rig measures context the way Claude Code does (input plus cache read plus cache write, plus
the response), so the numbers are comparable.

The threshold was never the source of user confusion. The terminal reports context remaining
against the full window, while Claude Code counts down to the compaction trigger, so any threshold
below the window makes the display and the compaction disagree. Fixing that needs the threshold on
the API's model definition, which the terminal cannot otherwise learn.

## Reseller catalogs are explicit subsets

Adding a model to its native provider must not automatically advertise it through a reseller.
Keep the Bedrock catalog limited to models AWS currently documents, and add a reseller route only
after its model ID and wire behavior are known. A native Codex model can otherwise appear usable
through Bedrock even though AWS does not serve it.

Sonnet 5 uses `anthropic.claude-sonnet-5` on Mantle, but AWS documents in-region
availability only in N. Virginia, GovCloud West, Stockholm, Ireland, and Melbourne.
Oregon returned model-not-found despite having the correct ID. Both ordinary and smart-route
catalogs now respect the selected transport and per-model region override; the private reviewer
catalog must not re-add a Bedrock Sonnet route configuration omitted. Runtime overrides retain
their existing inference-profile routing; catalog filtering never silently changes regions.

## Tailcat exposure is an explicit machine setting

`[feature.tailcat] enabled = true` asks the Tailcat module to expose whichever API transport the
daemon attaches. A repository cannot turn it on. Configuration owns the private Tailcat home,
fixed-region identity key, live address, and live port paths under the agent home; the key survives
restarts while the address and port files exist only while the tunnel is open. Admin-bot live
mutations persist the same setting in generated `runtime.toml`, which outranks the global default.
Tailcat is a dedicated account-free transport, not a Tailscale access path. It does not remove
Kissopen API authentication.

The forwarded port is deterministic configuration, defaulting to the IANA-unassigned `24779`.
Only the global or generated runtime layer may override it, and zero is invalid: the module must
fail on a collision rather than silently changing the endpoint another node has stored.

## Team mode is machine-scoped and owns a separate network identity boundary

`[feature.team] enabled = true` is a global or runtime deployment choice, never a project choice.
The default remains standalone mode. A team deployment does not create or retain the private local
API bearer token. It listens on its configured TCP `host` and `port` and authenticates WorkOS
access tokens against one required WorkOS organization rather than inheriting the single-user local
credential. The WorkOS client ID is also machine-scoped: it defaults to production Kissopen Cloud but
remains configurable for staging and other deployments, with issuer and JWKS locations derived
from it. Team mode also requires the WorkOS owner user ID; owner status is derived from that value
when profile onboarding creates the local user.

## Managed remote connections are machine settings

The main daemon's remote roster comes from machine `[connections.<id>]` entries and active admin
bot tools. Project configuration cannot grant a remote API authority or set `[api] token`. Each
runtime connection replaces its whole global entry, so switching authentication cannot accidentally
retain an old token. A disabled runtime entry suppresses its global entry without changing remote
data. Standalone deployments may pin their socket bearer token; team deployments continue to use
WorkOS and reject a standalone token setting.

Launcher readiness requests must use the configured standalone token immediately. Creating a
random token first and rereading the file only after readiness deadlocked startup: the daemon
installed the fixed token, rejected the launcher's health requests, and was killed as unready.

## Cross-workspace work is available by default

Fresh installations enable `features.cross_workspace` by default so root agents can discover the
project catalog and message another existing agent when its unguessable Agent ID is shared. A user
who wants the narrower boundary can explicitly set `cross_workspace = false`; generated starter
configuration shows the default as `true`.

## Generated runtime configuration owns runtime state

Treating `runtime.toml` as user-authored and placing daemon mutations in a sidecar state file was
wrong. The daemon always generates `runtime.toml`, rewrites known values canonically, and persists
runtime settings there atomically. Comments and unknown fields do not need preservation.

Provider runtime state uses `auto_enable` for automatic scan enablement and `enabled` for an
explicit override. Provider tables merge field-by-field across configuration layers so writing
those runtime fields cannot erase credentials, endpoints, or model filters configured globally.

## Scripted providers own their complete catalog

A test-supplied inference override replaces both accounts and their model catalogs. Runtime state
may persist a scripted provider's compatibility protocol (for example, `gym` as `codex`), but that
must not add the protocol's curated production models to the scripted provider after a restart.
For every provider ID represented by scripted models, expose exactly those scripted routes. A
test fixture that disables providers globally must explicitly enable every scripted provider it
needs. Test infrastructure must not change the production meaning of the global provider default.

## Gemini has a config key without a provider entry

Requiring `GEMINI_API_KEY` in the daemon environment was the only way to enable the Gemini media
and search tools, which made the key awkward to keep with the rest of the machine's settings. The
user `kissopen.toml` now accepts `[gemini] api_key`, and `ConfigModule.geminiApiKey` prefers that
configured value over the environment variable. Gemini stays out of `[providers.*]` because it
powers tools rather than chat models, and the section is a machine setting: a project `kissopen.toml`
cannot set it, since a repository must not choose which account this installation bills against.

## MCP has dedicated global and workspace sources

Combining MCP records into `kissopen.toml` made MCP look configured while provider and runtime wiring
could disagree about discovery. MCP now comes from dedicated files: `~/Kissopen/Config/mcp.toml` for
the user's catalog and root `mcp.toml` for a workspace catalog. Runtime, Codex, Claude, and other
provider MCP settings do not enter the Kissopen MCP catalog. The config module owns parsing, bounded
validation, the global path, and atomic global one-server updates, while the MCP module owns live
clients, workspace demand, sharing, and reconciliation.

## Smart routing is a virtual provider with concrete accounting

A smart provider keeps the agent's configured provider identity stable while delegating each
exact-model session to one compatible concrete account. The random starting choice and failed
accounts are held per agent; authentication and account-token exhaustion advance the route, while
other failures remain terminal. Candidate validation is deliberately silent, Bedrock routing fails
closed across unknown or different regions, and usage remains attributed to concrete providers.

## Subagent filters do not change ordinary availability

Provider-level `include_subagent_models` and `exclude_subagent_models` use exact model IDs and the
same exclusion precedence as the ordinary model filters, but they are a separate delegation policy.
They must leave the model catalog and picker unchanged. Collaboration asks configuration about each
provider/model route when describing and validating new subagents, including workflow-created ones.

## Provider hiding is file configuration, not an API field

Treating `hidden` as account disablement was wrong: it disables direct selection only. An enabled
hidden account remains usable behind a smart provider, and continues account-quota polling and
explicit verification. `hidden = true` belongs in the machine provider table, not in a new API field
or mutation. The public catalog keeps its provider/model references with direct availability false,
and new turns, subagents, and direct internal inference cannot select that ID. Smart routing uses
the independent account-enabled gate, including cancellation when the account is disabled.
Scans and runtime enable overrides never unhide it. Removing hiding and restarting restores direct
selection subject to the saved enablement preference. Quota readings remain account-specific;
duplicate consumed-token attribution under both smart and concrete providers is not implemented.

Scripted inference must replace concrete accounts, not smart routing itself. Factories receive
enabled hidden accounts as well as their visible smart routes; configuration rebuilds the real
router over the substituted concrete registry so gym tests exercise selection and cancellation.

## Kissopen resource credentials stay scoped to the Kissopen provider

The consumer extension uses a separate `kissopen` provider with an explicit model
allowlist and credential isolation. The upstream provider catalogs remain unchanged.
Kissopen's GPT-4o mini route has a conservative 32k session budget and 28k compaction
threshold. The credential is minted by the Go consumer service with an expiry and
credit ceiling; it is never the resource pool's long-lived key.

Kissopen pool endpoints do not implement native encrypted Codex compaction. The Kissopen provider alone uses a separate, tool-free summary session and Kissopen's portable plaintext checkpoint contract. The original full transcript stays in History; cancellation, incomplete output and tool attempts never replace context. Other Codex providers retain native compaction unchanged.

The Kissopen provider bounds its calls more tightly than Codex does: 150 s for a response to
start, 180 s of silence inside a stream, and at most three retries, whatever the global retry
setting says. With Codex's defaults (the SDK's ten minutes to start, five minutes of silence, ten
retries, each restarting both clocks) a stalled model pool behind the server held one turn for
up to two hours with nothing on screen. The server's own limits (120 s to start, 170 s of silence)
sit just below these, so its error is what normally arrives and is retried at once.

A Kissopen request carries at most 1 MB of images, all from the person's last two messages
onwards, each larger one re-encoded as a WebP of at most 1568 px; older images become a one-line
note telling the model to open the file with view_image (`lightenKissopenImages`). Agent Base's
own limit (4 MB, 8 images) let a conversation that once generated a few pictures send 3.5 MB on
every request, and through the server and the pool a one-word message then took 30 s to over two
minutes while a new conversation answered in seconds. Durable history is untouched; the shrunk
copies are cached in memory so a conversation does not re-encode the same picture per request.

## DeepSeek and Kimi are built-in Chat Completions providers

`deepseek` and `kimi` are built-in provider types beside Codex, Claude, Grok, and Bedrock, served
by the providers package's shared Chat Completions protocol. Their tables accept `api_key` and
`base_url` plus the common provider fields. A configured key wins; otherwise the key comes from
`DEEPSEEK_API_KEY`, respectively `MOONSHOT_API_KEY` and then `KIMI_API_KEY`, unless
`credential_isolation` forbids ambient credentials.

Their defaults are `enabled = false` with no `auto_enable`, exactly like Grok. A default of
`auto_enable = true` would have been wrong: the scan treats that value as a remembered discovery,
so a machine without the key would have offered models that could never run. Instead the startup
scan probes the key locally, writes `auto_enable = true` on first detection, and leaves a machine
without the variable showing both providers as missing and disabled, never failing startup.

The catalog is curated: `deepseek/deepseek-chat` and `deepseek/deepseek-reasoner` (128K window,
compacting at 110K) and `moonshot/kimi-k2-turbo-preview`, `moonshot/kimi-k2-0905-preview`, and
`moonshot/kimi-k2-thinking` (262,144 window, compacting at 230K, which leaves room for the 32K
output budget the provider requests). None of them has an effort control, so non-reasoning models
offer only `off` and always-reasoning ones only `high`. Each vendor is its own model family, so
switching between its models keeps the conversation while switching vendors resets it. They
have no machine tool surface of their own and receive the default one, with the simple system
prompt. A per-provider list of arbitrary vendor model IDs was not added: the catalog is
deliberately hardcoded, and an uncurated ID would have no context window to compact against.

The Kissopen provider also offers DeepSeek's models (`deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`)
through the same server and device key. They are listed on the Codex-typed `kissopen` provider
(`KISSOPEN_CATALOG`), and `KissopenSession` sends them over Chat Completions to the server's
`/chat/completions` — the server forwards DeepSeek models to DeepSeek's own API with the
company key — while the Codex models keep the Responses path. The Responses path could not carry
DeepSeek's thinking switch or its rule that every earlier `reasoning_content` comes back when
tools are present. Compaction of a DeepSeek conversation also goes through DeepSeek.

## The Kissopen server's console upstreams are the one uncurated catalog

The product owner asked for the server's console to add model services such as OpenCode Zen —
a base URL and a key — and to pick any of the models the service lists. No Agent release can
name those models in advance, so for the `kissopen` provider only, the catalog also takes what
the server states about each one: the routing policy (`GET {base_url}/policy`) carries an
optional `catalog` of `{ id, name, protocol, context_window, max_output_tokens }`, where the id is
`<upstream>/<model>`. Nothing is inferred from a model's name on the Agent side; the server says
the API, the window and the output ceiling explicitly, and its console is where a person
confirms them.

The config module keeps that list in `kissopen-served-models.json` beside `runtime.toml`, so a
restarted Agent offers the models, and can continue a conversation on one, before the server
answers again. A change is saved and announced as `config.updated` only when the list actually
differs, so the policy's regular refresh does not reload clients. The served entries join the
`kissopen` catalog after the curated ones, still filtered by the provider's `include_models`, and
their context comes from the stated window: compaction before a prompt plus the longest answer
would near it, never later than 85%. They do not need to be in the provider's `include_models`:
the desktop writes that allowlist only when it connects or renews its device key, so models the
console added in between stayed switched off on the desktop, and a cloud workspace whose allowlist
listed them was recreated every time the console changed a model. The server's policy is their
allowlist; `exclude_models` still removes one.

`KissopenSession` sends each served model over the API the server named, always to the server
with the device key: `chat` through the shared Chat Completions provider (the server resolves
the Agent's name), `messages` through the Anthropic client in bearer-key mode at
`{base_url without /v1}/v1/messages`, and `responses` through the ordinary Codex path. OpenCode
Zen does not translate between APIs — its gateway refuses a model on any API but its own — which
is why the API is part of each entry rather than a per-upstream setting. Chat and Messages
models compact through their own API; Messages uses the portable plaintext checkpoint like the
Codex models, not Anthropic's native compaction.

## Explicit local custom model connections

Custom provider display names are user-authored, bounded labels stored on the private connection.
Keep endpoint-derived provider IDs and namespaced model IDs stable when a name changes so existing
conversations and token accounting stay attributed to the same account. Catalog consumers must
use the supplied name for display, never reconstruct one from the opaque connection ID.

Requiring a manual reasoning declaration for every custom model made ordinary Effort selection
unnecessarily technical. Resolve reasoning once in Config for both the public catalog and wire
requests: explicit user override first (null forces service defaults), validated upstream
`discoveredReasoning` second, exact curated OpenAI/DeepSeek wire ID third, service default otherwise.
Never match a display name, family prefix or unlisted date suffix. Only reasoning is resolved;
transport and context limits remain unchanged. Missing declarations now select automatic behavior,
while existing explicit declarations are preserved. Discovery is bounded and user-initiated;
startup uses saved metadata and the local curated catalog, with no inference probe or new request.

Custom OpenAI-compatible connections are a separate, user-initiated exception to the curated
catalog. The desktop supplies a base URL and write-only key, discovers `/models` only while the
person edits that form, and saves only selected entries. Config owns `custom-providers.json`
beside runtime.toml, with atomic owner-only writes; startup reads that file without network
discovery. Provider scans must not disable these explicit connections. IDs are namespaced while
wire IDs remain unchanged. The shared Chat Completions implementation handles streaming, tools
and compaction; no context or tool capability is inferred from names. Unknown limits remain
null in the catalog, with an explicit conservative 32K local budget and a 24K compaction trigger.
An existing stateless session reopens its shared-protocol delegate on the next request when its
private record changes, so key updates and model selections do not silently retain stale values.

Editing a connection retains its ID and enablement. Safe metadata excludes the stored key;
omitting a replacement key preserves it, but changing the endpoint requires an explicit new
key. When a connection moves away from its original URL, adding that URL again must allocate
a distinct ID rather than overwrite the moved record. Deletion commits the private record
removal before disabling active inference, excludes the inert registry entry from public IDs,
and never removes conversation or usage history.

## Autonomy caps are machine settings

`max_expert_calls_per_turn`, `max_workflow_starts_per_turn` and `max_auto_rounds` bound how far an
agent goes on its own between two messages from the person, and so how much it can spend unwatched.
Like `max_collaborators`, a repository's `kissopen.toml` cannot set them: how far an agent may go
without the person is the person's decision, not a checked-out project's.
