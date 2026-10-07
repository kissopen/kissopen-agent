# Kissopen module learnings

## Visible browser control is a revocable desktop capability

The browser tool queues bounded commands on the personal connection, not in a durable workflow.
The authenticated local API and encrypted session RPC share the same schema and broker. A lease
belongs to one agent and one desktop; polls claim commands exactly once, even if a response is
lost. Pause, archive, conversation reset, disconnect and expiry cancel pending work. Resume is
desktop-only. Revoked IDs are not reusable, including when a revoke arrives before its attach.
Unknown outcomes require a fresh observation, never a replay of a click or submission.
The desktop executes through Playwright on the existing embedded guest. Navigate automatically
opens the visible tab and panel; requiring the person to open the panel first was unnecessary.
Desktop message preparation waits for attachment with a bounded deadline, and a new human
instruction can acquire a fresh attachment after disconnection. It never replays old commands or
resumes takeover on a timer. Another already-available browser tool may handle an authorized task
if it supplies its own observable session and permission checks; no ad hoc shell/CDP bypass of
denial, takeover or explicit user closure is allowed. Keyword matching on labels and whole forms
blocked ordinary navigation and verification. Review the actual action and user authority instead;
permit user-supplied one-time codes for the intended site and leave existing sign-in credentials
and payment to the user. On 2026-10-04 the
user explicitly removed the takeover/resume buttons and page shield, and authorized updating the
native password guard and API contract. A new human instruction resumes paused control; no
separate button is required. Ordinary page clicks no longer require a takeover gesture.
The common `generate_password` tool creates a new password with Node's cryptographic randomness,
defaulting to 24 characters with four character classes. For an authorized new-password task,
the Agent fills that same generated value into password and confirmation fields and reports it
after verifying the result when requested. Newly generated values can enter tool arguments and
chat history by this explicit user direction; existing credentials are never retrieved. Native
fill and insertText checks allow registration password fields while still refusing
`current-password` and payment autocomplete fields. Observations omit input values and screenshots
mask them. Auto review still checks the concrete field, site, generated value and task authority.
Plan and verify a browser task to its requested outcome; ask only for missing input, required
confirmation or blockers. Ordinary page navigation, synthetic keyboard events and scrolling are
not human takeover. Explicit user navigation and handoff can still pause browser work; another
human instruction hands control back. Timers and Agent output cannot do so.

The user removed the mandatory final-step terms confirmation and automatic human-verification
handoff. Registration authorization now covers the intended site's routine registration terms,
privacy acknowledgement and final submission. The same guidance reaches the acting model and
the exact-operation Auto reviewer; provider-only instructions do not govern that separate review.
Verification is attempted through available browser operations and observed page state, followed
by a fresh observation before continuing. A challenge label alone cannot cause a handoff, and a
genuine capability or site blocker cannot be reported as successful verification. Existing review,
task scope, revocation and unknown-outcome protections still apply.

## Consume observations returned by browser actions

The user requested batch observations, accessible roles/names/states and snapshots in action
results to reduce slow per-control queries and model round trips. Browser guidance consumes the
fresh snapshot returned by an updated desktop after navigation, click, fill or scroll, including
its new refs. It requests an explicit read when no fresh snapshot is returned, observations are
incomplete or the page is still changing, preserving compatibility with existing desktop clients.
Screenshot supplements missing semantics; it does not add coordinate or script operations.
Automatic observation failure after a completed action is a reason to read, never to replay it.

## Repeated account unlink is not a browser lifecycle transition

Desktop account reconciliation repeats unlink when a local workspace belongs to a different
account. Unlink previously closed every browser lease before checking whether the integration was
already unlinked, so those no-op reconciliations revoked freshly attached local browser work.
Browser cancellation now occurs inside the serialized lifecycle transition, after the idempotence
guard. A genuine unlink still cancels pending work; repeated already-unlinked calls preserve a
fresh desktop lease and its current observation. Account ownership checks remain enforced.
An unavailable browser result states that no page operation was queued, and does not imply that
the model can establish the desktop connection. Bounded goal waiting is observation scheduling,
not successful reconnection or registration.

## Cloud replies stream through the encrypted relay

Waiting for `text_end` made remote replies appear all at once even when the provider streamed.
The mapper now emits bounded, durable `text-delta` envelopes for text and reasoning, with an
inference-block identity and a UTF-16 offset derived from the event's persisted partial message.
It needs no process-local offset counter to resume after a restart. The existing final `text`
envelope carries the same optional stream identity and is the authoritative complete snapshot;
older clients still see that final reply. Shared client reduction folds packets into one stable
row, handles replay and out-of-order delivery, and never appends late deltas to finalized text.
No provider, Agent Base, HTTP API, or relay server change is involved.

## Phone and desktop share hosted routing

Phone submissions normalize hosted selections through ConfigModule and prepare classifier
tool requests through ExpertModule, matching desktop API admission. Team connections receive
the same ExpertModule. BYOK retains explicit selections; internal expert collaborators must
never be normalized back to the everyday model.

## Mobile reads are a transport adapter, not another file API

The first native bridge duplicated file readers, Git response mapping and output schemas. It now
calls the existing file methods with optional limits and shares GitModule's public projection
with HTTP. One JSON byte check before encryption handles the relay's size ceiling; an oversized
preview is an explicit error. Catalog ownership still determines the root, absolute file links
remain contained, and missing files, failed reads and unavailable comparisons remain distinct.
Request validation and the small success/error envelope belong to Kissopen; filesystem and Git
behavior stay in their existing modules.

A whole read stays capped at 512 KB, which left every office document the phone wanted to preview
unreadable. `readFile` now also takes an optional `offset` and `length` (at most 384 KB): the
answer is that part of the file plus its whole `size`, from the same bounded file reader given a
range and a 32 MB whole-file cap. A phone reads a large file part by part and reassembles it.
Older daemons ignore the fields and answer as before, so a phone treats an answer without `size`
as the whole file.

## Personal team connections are transparent to clients

Adding an owner field and a protocol bump for personal mobile connections was unnecessary.
The agreed contract keeps the existing routes, request and response shapes, bootstrap, and event
payloads unchanged: authentication selects the user's connection inside the daemon, including
private event delivery. Each team user owns independent pairing, credentials, and parallel mobile
connections; standalone behavior stays installation-wide. This is internal ownership and routing,
not a new client capability, so it needs documentation and daemon work, not an SDK release or
protocol-version negotiation. Kissopen mobile is separate from the WorkOS-based Cloud integration.

The module now owns one connection lifecycle per user. Owner-keyed storage isolates projection
cursors, queued messages, remote bindings, and rejection fingerprints even when two members pair
the same mobile account. Credentials never come from the shared CLI login in team mode. Pairing's
independent context retains the member identity so subsequent mobile RPCs and messages cannot
fall back to standalone authority. Existing standalone records retain the empty owner through
new migrations; no existing migration is rewritten and no old link is assigned to a team member.

## Rich user input remains one message

Text envelopes carrying an explicit tool request retain their ordered input blocks in optional
`content`, alongside the existing text fallback for older phones. Live acceptance and historical
backfill use the same representation. Incoming rich content is validated as text, images, and at
most one request, then queued intact; its display fallback must not become duplicate model prose.
Malformed rich content is refused rather than silently downgraded to a text-only message.
Tool execution may begin before inference. Its start opens the Kissopen turn when no turn is open,
so requested tools and their eventual settlement share the normal turn lifecycle.

Rich input can exceed the relay outbox's single-message limit, particularly with inline images.
Both live and historical projection replace an oversized envelope with a bounded, visible sync
failure notice under the same identity. The full content remains in local History; subsequent
events keep syncing. An optional relay projection must not permanently stall a session behind
one message it cannot carry.

## Mobile tool wire normalization

- Normalize tool calls at the Kissopen sync boundary only when the mobile app already owns the same
  semantic renderer and argument contract. Preserve every other real tool name and send a precise
  activity description through the generic canonical tool-call envelope; a familiar but false
  tool shape is worse than an honest generic row.
- Parse Codex `apply_patch` text inside Kissopen Agent and send the established mobile
  `CodexPatch { changes }` payload. Mobile clients should render structured file changes and must
  never need to parse Codex's patch grammar.
- Send Codex update hunks as `modify { old_content, new_content }`, which mobile already routes
  through the same paired, intra-line diff renderer as Claude `Edit`. A raw unified patch sends
  native mobile down its simpler prefix-colored fallback instead.

## Pairing and public state

- Resolve the Kissopen CLI home and server URL through `ConfigModule` even before credentials exist. Reading `process.env` directly bypasses daemon-owned environment overrides and can accidentally inspect another installation during hermetic tests.
- Create the server authorization request before publishing QR data. If that initial request fails, keep the prior integration snapshot unchanged and return `kissopen_unavailable`; a client must never render a QR code that the server did not accept.
- Persist the resolved Kissopen server in owner-only settings before saving newly authorized credentials. Credentials are scoped to the server that issued them, and the pairing must reconnect to that same server after a restart.
- Publish complete, versioned integration snapshots and deduplicate identical content. Pairing owns its authorization and failure transitions, while the machine connection owns connecting, connected, disconnected, and rejected-credential transitions.
- Persist the integration version high-water mark before publishing a replacement. UUIDv7 comparison is the client reconciliation rule, so ordering must survive daemon restart and system-clock rollback.
- Pairing secrets are process-local, expire after two minutes, and are erased when the attempt settles, is cancelled, is replaced, or the daemon stops. Bound every authorization poll by the remaining lifetime and reject even a valid response that arrives after expiry. Persist credentials only after decrypting and validating the authorized bundle.
- Bound authorization response bytes and every credential-bearing string before validation or decryption. The server is an external input boundary, and a small successful pairing payload must never permit unbounded buffering.
- Serialize pairing, cancel, unlink, re-pair, activation, and credential invalidation. Generation-check work that can finish after cancellation so an obsolete authorization can never restore credentials or publish a later state.
- Coalesce the entire start operation, including configured credential refresh, rather than only QR creation. Attach a rejection observer as soon as a pairing promise crosses into module ownership; cancellation can invalidate it before the lifecycle queue installs the normal settlement handler.
- Kissopen is optional onboarding-adjacent state. Desktop bootstrap returns it beside onboarding for a polished first-run flow, but it is not an onboarding step and never blocks completion.

## Credential ownership and reconnects

- Desktop can finish the existing Agent QR before the legacy CLI gets its own machine ID. Read the sibling from the explicitly resolved live CLI home, validate its V2 account and server, and refresh metadata on an explicit integration start. The daemon-owned settings copy is not an authoritative live CLI identity. This refresh must not restart Agent work, replace credentials, or introduce another phone authorization protocol.
- Only standalone connections may resolve a sibling CLI home. Personal team connections omit it entirely, even when paired to the same account as the shared CLI. Standalone QR settlement allows sibling validation separately from credential adoption, so loading its newly saved credential cannot replace it with an existing CLI login.

- Check the disable flag before credential adoption. Disabled mode may inspect an already daemon-owned credential to report `configured`, but must not read or copy the external Kissopen login or create a machine identity.
- Remember a bounded fingerprint of credentials rejected by Kissopen or explicitly unlinked. Suppress only that exact daemon/external credential across restart, accept a genuinely changed external login, and clear rejection history after successful pairing. Fingerprints are metadata; never persist another copy of the token or encryption key.
- Unlinking owns only this daemon's credential copy and live clients. It must not edit the external Kissopen CLI installation, and repeated unlink or cancel requests must be no-ops without duplicate events.
- A Socket.IO connection error is not proof that credentials are bad. Abandon that socket and repeat authenticated HTTP machine registration; only an HTTP 401 or 403 invalidates credentials, while other failures remain retryable.
- Explicit retry must reload credentials and retry machine-identity creation instead of reusing a cached configuration that already lacks an identity.

## Session state

- Bot pictures travel as encrypted relay session avatars, not synthetic projects. Ordinary project
  sessions leave this field unset so mobile can inherit project artwork. The local bot catalog
  remains the image authority, including removal. Image uploads run independently of message and
  question delivery, are bounded and cancelled with the session connection, and old relays that
  omit the additive avatar field continue syncing normally. An encrypted content hash in the
  preview prevents restart from re-uploading unchanged images; upload retries retain their
  completed blob reference until activation succeeds. No avatar bytes or new resource fields are
  added to Kissopen Agent's direct API or Agent Base.
  Sessions are the relay image owner because pictures may eventually differ per conversation;
  synthetic bot projects would expose invalid creation actions on older phones. Keep small
  resource-specific validation and error messages local, while reusing the encryption primitives.
  Read bot metadata and bytes in one transaction. Artwork failures use five exponentially spaced
  retries independently of chat, then wait for a new bot revision or a recreated session client;
  a socket reconnect alone does not reset the budget. Archival never waits for artwork to finish.

- Capture an archive transition's timestamp once per session-client lifetime.
  Recomputing it while composing metadata makes each relay echo appear to be a
  new change: the sync loop writes forever, `archive()` never reaches remote
  archival or closure, and phones are flooded with metadata updates. An echoed
  write must converge without another write; restoration uses a new client.
- Bots are discovered through `BotsModule`, not project/workspace membership. Each bot projects
  its existing agent into one Kissopen session, with optional encrypted `bot` identity and no synthetic
  project or worktree. Startup includes idle bots; catalog events attach new bots and refresh names.
- Bot lifecycle stays in the bot catalog. Phone archival calls `BotsModule.archive`; late messages
  to archived bots and attempts to create a second conversation in their exact folder are refused
  (subdirectories remain ordinary session locations). Resolve and archive the bot in one transaction
  so concurrent renames cannot invalidate the version between those operations. Restoration awaits
  the explicit post-commit archive completion, reuses the same remote identity, and replaces stale
  archive/project metadata. Never infer completion from a map entry not yet installed by `afterCommit`.
  Mobile needs no separate bot resource on the relay.

- The phone composer has no tier selector and stamps `serviceTier: null` on every message's mode,
  so its sends must carry an explicit `null` service tier option. Omitting the option tells Agent
  Base to keep the previously persisted tier, which contradicts the stamped mode and leaves a stale
  tier — such as the retired `"default"` sentinel Codex rejects — in force forever.
- Account quota and per-turn token usage are different projections. The native Kissopen app reads plan limits from each session's encrypted `agentState.usageLimits`, so Kissopen Agent maps the selected provider's latest account snapshot into the legacy open-window shape and republishes attached sessions whenever that snapshot changes. Fable's separate allowance uses Claude's native `seven_day_fable` id so current and older apps can render it without a new machine-metadata contract.
- A message received from the phone is steering, not an ordinary queued send. Store its pending History row and offer the same ID through `AgentSystemRef.steer` in one transaction. History's committed-pending notification is what makes the message visible to an already-open desktop transcript before Agent Base accepts it at the next run boundary.
- Acceptance of a phone-originated message must not stay silent on the session stream. Suppressing the text echo also withheld the acceptance position, so the phone could not align its transcript with run order or tell "daemon offline" from "steering queued". The mapper now emits a content-free `user-message-accepted` receipt — server message ID, durable message ID, run ID — after the same steering turn close every other accepted user message causes. The phone's vocabulary silently drops unknown event kinds, so the receipt is additive and needs no server change: the server relays opaque encrypted payloads.
- Permanent refusal is a terminal send outcome too. A turn-less service notice was discarded by mobile, leaving receipt-enabled messages pending forever. Emit `user-message-rejected` with the original relay `ref` and readable `reason`; mobile marks the original bubble failed without inventing acceptance, a turn boundary, or a timeout.
- Echo suppression is personal-connection scoped. A different participant's phone does not have the sender's original relay message: live projection and backfill must include its text, while only the sending connection gets a receipt. Use History's authenticated `userId` for that decision, independently of profile lookup. Optional author ID, display name, and connection-relative ownership travel inside the encrypted envelope; the relay learns no participant identity. Advertise receipt support explicitly so older daemons never leave newly sent bubbles waiting for an event they cannot emit.
- A queued user's submission timestamp can precede the previous archive row. Backfill keeps projected timestamps nondecreasing without changing the source History record. Mobile deliberately sorts by timestamp only, with no sequence tie-breaker; equal timestamps have no guaranteed archive ordering.

## Tests

- AgentGym must enforce its isolated `KISSOPEN_HOME_DIR` after merging caller-supplied environment values. A default placed before that merge can be overridden accidentally, causing an API test to import the developer's real Kissopen credentials and register persistent machines against the production backend. The harness prevents the connection rather than relying on remote teardown.
- Build package `dist` output before running AgentGym because the harness imports package exports, not sibling TypeScript source. A stale build can make a correct source change appear absent at the public boundary.
- Exercise the independent Kissopen protocol fixture through `KissopenAgentClient`: successful authorization and current-agent attachment, concurrent start joining, lifecycle controls, restart ordering, rejection suppression and changed-login recovery, socket-auth revalidation, server affinity, expiry, and disabled isolation are release-risk behavior rather than optional unit coverage.

## Kissopen account switching

An explicitly accepted new pairing creates a new daemon-owned machine UUID before publishing its credentials. Relay machine IDs are globally unique; reusing the previous account's ID fails with an ownership collision. Never overwrite a relay machine owned by another account. Ordinary reconnects and daemon restarts retain the saved identity.

## A cleared conversation starts over on KISSOPEN too

After a clear the phone's copy still held every old message. The connection listens to the history
module's cleared notice, however the clear arrived (local API, or the `clearConversation` relay
request a desktop or phone sends), deletes the relay copy, forgets the local sync row and attaches
the agent again, which creates a new, empty copy under the same tag. A copy the relay will not
delete is left attached as it is: creating a new copy beside it would duplicate the conversation.
New relay methods must be added to `KISSOPEN_SESSION_RPC_METHODS`, or the relay answers that the
method is not available; clients read the same list from the session's advertised capabilities to
decide whether to offer the action.

## The public server is api.firstcache.cc

The user moved every client's server domain from kissopen.com to `https://api.firstcache.cc`
(2026-09-24). The agent's fallback server is that origin; the environment and saved settings still
win, in the order `resolveKissopenServerUrl` states. Installers and release feeds stay on
kissopen.com, so a download URL there is not a leftover to change.

## A cloud project's files are listed one folder at a time

A cloud workspace has no local folder on the desktop or phone, so before `listDirectory` neither
could show its file list. The method answers one folder of the session's workspace (path relative
to the root, `""` for the root), paging the files module's `tree` under the hood and stopping at
`KISSOPEN_LIST_MAX_ENTRIES` with `truncated`. An absolute path inside the root is accepted and made
relative; anything outside is refused as `forbidden`, the same refusal `readFile` gives. With it
the session advertises `files.browse: true`.

## Uploads reach a cloud workspace through `uploadFile`

The relay method `uploadFile` carries one part of a file (at most a read part, 384 KB) into the
session's workspace via `ProjectFilesModule.upload`; clients send 192 KB parts so each call is
answered within the timeout on a slow connection. It is advertised in `rpcMethods` like every
other relay method, and a client offers upload only when it is listed.

## Answers are normalised before they are resolved or echoed

The phone answers a question with `{ options, custom }` per question; the desktop sent a bare list
of labels and written text. The list failed `kissopenAnswerSchema`, so the question resolved as "No
answer was given"; worse, the session client echoed the raw answer into the published agent
state's `completedCommunications`, where the clients' zod `AgentStateSchema` rejected it and threw
the whole state away. Every later question in that conversation then had no card on any device,
while the run sat waiting for it — until the daemon restarted and forgot its completed answers.
`handleKissopenSessionRpc` now passes answers through `normalizeKissopenAnswers` first (list →
options, string → custom), so both the resolution and the echo use the shape clients read.

## A working session repeats its keep-alive

`session-alive` used to go out only from the sync loop, which runs when something changed. A run
parked on a question, or waiting on a slow model, changes nothing for minutes, and the relay marks
a session it has not heard from in ten minutes as stopped (`thinking:false`, inactive). The desktop
then showed a conversation still waiting for an answer as not running, and the phone showed it as
offline. While the last snapshot said the session was working, the client now repeats the
keep-alive every minute; an idle session is left to the relay's timeout as before.

A phone message that arrives while the agent's own question is pending now ends that question in
the same transaction (see userInput's learnings): the desktop's cloud composer never cancelled the
question the way the phone does, and its message sat behind the card.

## A tool's end always names a turn

The session protocol requires a turn id on every agent envelope, and the shared client parser
drops one without it, silently. The mapper keeps the open turn only in memory. A call that
outlived the process that started it — a question pending across a daemon restart or a cloud
container replacement, then answered — ended in a fresh mapper with no turn, so its
`tool-call-end` was discarded by every client and the question's row showed "running" forever,
while the agent had in fact completed it. A tool end with no open turn now opens one; clients pair
the result with its call by call id, and the turn closes when the loop settles. Ends already lost
this way stay lost: relay messages are not rewritten.

## A project's first board is built by its setup conversation

An empty board used to offer only 生成看板, which built a board from a folder that said nothing yet
about what the project was for. The empty board now starts a setup conversation that asks the
person a few rounds of questions and, once it knows enough, calls `build_project_board`. That tool
asks the business server (`POST /agent/v1/boards/build`, with the agent's own KISSOPEN credential)
to start the same build 生成看板 does, where the project is; it is offered only to root agents and
refuses outside a regular project. A build already under way is an answer, not a failure.

## Browser tool parameters must have an object root

The browser transport's discriminated operation union cannot itself be an LLM tool's parameter
schema: the runtime rejects non-object roots before inference, breaking even ordinary chat.
The tool wraps it in `{ operation }`, retaining strict per-action validation and write review.
Check the standalone transport smoke as well as unit tests before deploying eager tools.

## Browser writes must reach Auto review

Marking clicks and fills for Auto review is insufficient without a non-empty
`describeAutoPermissionAction`: PermissionsModule refuses the tool before the desktop receives
anything. Describe the concrete operation and external-site boundary, keep the exact arguments
available to the reviewer, and retain denial and restricted-mode enforcement. Exercise the real
browser tool through PermissionsModule, not only the broker or isolated Playwright execution;
successful navigation and reading do not prove that reviewed input works.

## Browser pages outlive their control leases

Task navigation revokes authority, not necessarily the mounted page. A fresh lease can reconnect
to that task's exact visible guest. Scope retained pages by window, account, workspace and
conversation; forget them on user tab closure or account cleanup. Never replay navigation to
recover a page with a completed form submission. Resume of an already active attachment must be
idempotent: advancing its epoch would silently invalidate the engine serving an in-flight action.

## Browser extensions are negotiated and batches preserve progress

The additive SDK contract advertises `batch` and `wait` per attachment. Reject unsupported
operations before enqueueing them; attachment fallback may repeat only the same idempotent
attach, never an action. A bounded batch reviews all exact writes, validates its original DOM
handles before starting, and stops after DOM/frame/navigation changes. Return completed-step
counts and an observation; normal `page_changed` interruption is successful transport, while
failed or timed-out steps remain uncertain and must not be replayed. Validate completion totals
against the pending command rather than accepting fabricated progress.

## Embedded iframe input must be tested in a real webview

Electron's guest CDP bridge must forward only descendant iframe sessions. Already attached OOPIF
children need their frame tree and runtime initialized before semantic observation. Focus alone
can acknowledge an insert without writing text in an embedded guest; actual pointer focus and
native input routing, followed by input-value verification, are required. A standalone browser
window is insufficient coverage. The opt-in native fixture exercises same-origin, cross-site and
nested frames inside a real webview, with disposable cookies and profile. Document readiness can
precede the next execution context: retry observation within a bound, never a completed write.

The approved implementation uses the existing local SDK links for local testing only. Publishing
the SDK and switching dependencies back to a published release remain a separate release step.
