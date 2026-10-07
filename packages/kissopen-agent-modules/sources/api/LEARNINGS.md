# API module learnings

## Live run errors require the complete message contract

The synthetic `message.created` emitted at `loop.settled` omitted `metadata`, although durable
history always included it. A stopped goal could therefore leave the desktop transcript projection
throwing on `metadata.usageLimit` while re-reading history worked. Even an error without public
provenance must carry `metadata: {}`. Type the synthetic literal as `ServiceMessage` so required
fields are checked on the live path as well as the history projector.

## Named project creation is separate from folder registration

`POST /v0/projects/create` reserves a named project without a Home resource or client-selected
filesystem path. The route returns the ordinary project resource and preserves the documented
creation conflict codes; existing-folder registration is unchanged. Older servers return 404,
which the desktop describes as a missing capability rather than a lost connection.

## Hosted routing is resolved before model validation

The owner authorized automatic service-hosted routing in API.md. Normalize only `kissopen`
message modes, after existing-message idempotency lookup and before catalog validation.
Return/store the effective mode everywhere. This accepts stale client models without changing
BYOK semantics. Prepare classifier-requested expert tools before pending rows and Base admission;
acceptance hooks are too late to prevent the first everyday inference.

## Service attachments are HTTP endpoints, not workspace forward proxies

Each service CONNECT authenticates both the normal caller and a short-lived credential for the
exact principal, workspace, service, and execution. It owns one already-connected native endpoint;
neither request URLs nor Host headers can select another destination. Node's HTTP parser and
client stream bodies and WebSocket upgrades on that socket, preserving application credentials
and duplicate headers. Canonical body framing must be restored after removing hop-by-hop headers:
honoring Connection's nomination of Content-Length without reframing turns a GET body into a new
upstream request. Validate WebSocket method, version, key, and absence of a body before upgrading.
The header deadline must not end a quiet active SSE response. Stop revokes live attachments before
confirmed cleanup, and both pending admissions and established connections have bounded counts.

The service list captures its journal cursor before loading its snapshot. Input uses independent
principal/view reader positions, returns bounded capture, and does not publish I/O or credentials
in events. Ordinary workspace CONNECT remains a separate existing API contract.

## Team drafts belong to users, not shared agent metadata

Shared agent metadata made teammates read and overwrite each other's composer drafts. Team
drafts now persist one current value and clear timestamp per authenticated user and agent.
Last-write-wins comparison and saving share a transaction, and the exact committed snapshot
becomes an owner-filtered event only after commit. Reads and bootstrap use the same owner;
journal pulls, replay, and live delivery keep private payloads off other users' connections.
Standalone drafts remain in agent metadata, and existing global drafts are never assigned to
team users. Ownership stays internal: endpoints, payloads, and the published client are unchanged.

## Filter archived agents before building catalog resources

Desktop bootstrap used to build every attached agent's activity and resource, discard archived
agents afterward, then repeat the work for each project's same-ID root workspace. Collection
reads now check the agent's archival metadata first and pass the already-read configuration and
children into the resource projection. Bootstrap shares each project's built agent series with
its root workspace and reuses its project catalog for onboarding. Known owner-series and bot
resources do not query bot ownership again. All reuse stays within the current request; archival
decisions and activity are never cached across requests. Agent Base currently offers individual
configuration reads only, so reducing that remaining per-agent cost must use a future public
batch API, not reads into its private storage or a second archival index. Preserve archived
by-ID reads and the API's existing archived project/bot collection behavior.

## Avatars and artwork share private browser caching

The blanket no-store response policy prevented browsers from retaining images despite their
content-derived ETags. Fixing only project avatars left node avatars, bot avatars, profile photos
(standalone and team), and slash-command artwork uncached. All five image endpoints now use one
header helper for successful reads and conditional 304 responses: one hour of private-cache
freshness followed by 24 hours of stale-while-revalidate. Vary on Authorization isolates cached
images between credentials. Apply this policy only after finding the image; JSON, missing images,
and authentication errors remain no-store. Cache headers enable request-driven revalidation, not
an hourly timer or replacement of an already displayed image.

## The current profile identifies the authenticated team member

The profile endpoint and desktop bootstrap share one profile projection. Its read-only `userId`
is the authenticated member's local Kissopen ID, matching message authorship and batch user lookup.
It stays the same in profile/photo mutation and conflict responses and after restart. Before team
onboarding and in standalone mode it is explicitly null; the standalone profile's private identity
is never exposed as a team user. Older daemons may omit the field, and team profile events remain
identity-only invalidations rather than broadcasting another member's profile.

## API additions stay concise and fields stay logically grouped

Bot creation's identity fields were scattered alphabetically and its contract was repeated in
long prose and comments. Put request metadata (`mutationId`) first, then related IDs together
(`id`, `workspaceId`, `agentId`), then entity fields. Describe changes in the surrounding endpoint's
concise style. Comments explain only what names do not.

## One onboarding response combines installation and user readiness

The installation completion marker previously made team members skip setup even when they had
no local profile and the API correctly denied product access. Installation onboarding stays
shared, while personal readiness is derived from the authenticated member's durable profile.
The existing onboarding response reports completion only when both are satisfied in team mode;
standalone completion remains unchanged. Desktop bootstrap uses the same calculation. Clients
never select an onboarding scope, maintain separate system and personal flows, or need another
completion call after saving a profile on an already-onboarded installation.

## Cloud is authentication and organizations only

Cloud previously exposed encryption setup, account enrollment, profiles, social state, and device
management. The API now exposes only WorkOS authentication and organizations. Retired routes return
not found; desktop bootstrap and the journal carry only the authentication snapshot, and Cloud
errors include only that snapshot. Keep the separate local profile and Kissopen integration surfaces
independent of Cloud account state.

Team nodes must not connect an installation-wide personal Cloud account. Both authorization
start and completion now throw the existing unsupported API error before parsing bodies or
calling Cloud, including when an attempt predates team mode. Keep this deployment restriction
at the API seam; standalone authorization and the existing Cloud status and disconnect routes
remain unchanged.

## Input requests and generated calls retain distinct identities

Send accepts the published tool-request block schema, with at most one request among the text
and image blocks. Pending responses, bootstrap, acceptance, and history retain that block exactly.
Acceptance is still carried by the run event, not an extra user-message update.

Release 0.4.45 expressed "at most one request" as one array with `contains`, `minContains: 0`,
and `maxContains: 1`. TypeBox's value check refuses any `contains` array with zero matches
before it reads `minContains`, so every plain text or image `content` array was rejected with a
400 and images stopped working. Only text-only sends, which omit `content`, survived. The send
content schema is now a union of two arrays: text and image blocks alone, or text, image, and
exactly one request. Any schema test for an "at most one" rule must cover the zero case.

A requested call has no inference-start event. Publish its completed acceptance-time assistant
row on tool start and its updated row on completion, using History's call-owned message identity.
Never project it under a synthetic run-level assistant ID: that makes live clients disagree with
reload and leaves the real call without a creation event.

## Protocol revisions identify new capabilities without removing older requests

Unnamed bot creation was added without a distinct advertised revision, leaving clients
unable to know whether omitting a name was supported. The daemon now advertises protocol
24 for that capability. Older name-bearing requests remain valid; clients that omit the
name require protocol 24 or newer. Protocol 22 onward remains additive, so a client must
not reject an otherwise compatible daemon merely because its revision differs. A product
that requires a newer capability may require that capability's protocol and explain the
needed upgrade. The daemon's product version remains display and diagnostic information.

## Local signals and HTTP share one drain boundary

Draining only the agent runtime leaves API mutations admitted and can falsely report that an
installation is safe to maintain. Local OS control now calls the API module's public `beginDrain`
and reads its bounded `drainProgress`, the same operations used by authenticated HTTP. This keeps
the read-only transition, event identity, admitted-mutation count, and agent/reviewer completion
barrier identical without creating an unauthenticated HTTP route. Draining remains separate from
shutdown and does not claim that terminals or background processes have exited.

## Composer mode

- A null `mode.serviceTier` must reach Agent Base as an explicit `null`, never as an omission and
  never as a sentinel tier string. Agent Base persists the last tier and reads an omitted message
  option as "keep the previous tier", so omission leaves a stale tier in force — including the
  retired `"default"` sentinel written by earlier releases, which Codex rejects on every turn and
  which nothing else ever clears. The same rule applies to every sibling send path that stamps a
  mode on a message: the tier the mode claims is the tier the message must carry.

## System bot identity

- Every public bot projection includes the database-backed `systemKey`: a stable snake_case key for
  a built-in bot and `null` for an ordinary bot. The one shared projection feeds reads, mutations,
  conflicts, bootstrap, and events, so this discriminator must stay there rather than being added
  route by route. Client schemas keep the field optional only for older compatible daemons and
  tolerate unknown keys so newer built-ins retain ordinary bot behavior in older UIs.

## A pending message can be taken back, and only once

A message sent while the agent was busy, or a steering message an abort left behind, used to be
unremovable: it sat grey under the transcript and joined whatever the person sent next. The person
asked for a way to delete it. History stays append-only, so the answer is withdrawal of what
inference has not accepted yet (protocol 26, `POST /v0/agents/:agentId/pending/:messageId/withdraw`,
event `message.withdrawn`).

The history module's pending row and Agent Base's queue entry leave in one transaction. Agent Base
decides withdrawal against consumption: withdrawal deletes the queue entry, and consumption checks
for its entries again inside the transaction that consumes them, starting over when one is gone.
So a message is never both withdrawn and accepted; losing that race answers `409` with the accepted
message. The ID is spent — Agent Base keeps its identity claim — so a retried send of a withdrawn
ID is `409` rather than a resurrection, and the send's pending row rolls back with it.

## Clearing a conversation is the one deliberate deletion

A bot has one conversation, so the only way to start over was to lose the bot. The person asked for
cloud conversations to be deletable, and chose clearing the conversation while keeping the
assistant. `POST /v0/agents/:agentId/clear` (protocol 26, event `agent.history.cleared`) is the one
place the API permanently deletes durable history; the spec says so where it otherwise promises
archival.

Swapping in a new agent was not an option: the cloud gateway re-creates its default assistant with
a fixed agent ID, and a mismatch is a conflict that takes the cloud assistant offline. So the agent
is cleared in place. Agent Base erases its records, queues, measurement and history KV in one
transaction, and every feature clears its own part through `conversationClearedTransact` in that
transaction (history rows, usage context, auto-review evidence). Busy is decided on the durable
work-owed record, not the in-memory loop: loading an idle agent starts its loop once to look for
unfinished work, and that no-op loop must not refuse a clear.

The message POST opens a pending-message announcement that every later event of the agent waits
on. It is now closed in a `finally`: when reading the accepted message back or updating the
agent's metadata threw after the commit, the announcement stayed open and the agent's desktop
stream stopped until the daemon restarted, although the agent itself kept working.
