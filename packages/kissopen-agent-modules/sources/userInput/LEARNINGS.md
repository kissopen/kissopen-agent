# User input learnings

## A question must survive the daemon that asked it

`request_user_input` used to be declared `durable: false`, so a call interrupted by a restart came
back to the model as "The tool call was interrupted by a restart and was not retried." A person may
take days to answer; losing their question to a daemon restart is the opposite of what the Inbox is
for.

The tool is now `durable: true`. Re-executing it is safe rather than merely tolerable, because the
request ID is Agent Base's generated tool-call CUID2 and Base restores that ID with the stored call:
the second execution's `ask` resumes the very request the first one created instead of asking
again, and its `wait` returns immediately when the person answered while the daemon was down.
Deadlines are absolute — `autoResolutionMs` counts from `createdAt` — so a resumed wait cannot
silently extend the window a restart interrupted.

## A parked wait is reloadable and does not hold graceful shutdown open

`request_user_input` is both durable and reloadable. During graceful drain, Agent Base aborts the
current execution lifetime without recording a tool result and leaves the same pending call in
storage. The next daemon re-executes that call with the same Base CUID2, so `ask` rejoins the one
durable request instead of creating another and `wait` returns immediately if the person answered
while the daemon was down.

Do not turn drain into an ordinary return or thrown tool failure. Either would commit a permanent
tool result and prevent the next daemon from resuming the question. The reloadable boundary is
what makes shutdown prompt while preserving both the pending tool call and request identity.

## Agent questions use natural labels and relative timeouts

Short means concise, not twelve characters. Agent-facing question headers allow up to 64
characters so ordinary labels such as “Release scope” and “Client release” remain valid. Batched
questions carry shared Markdown context once on the request and question-specific headers and
options on each question.

The direct module API can accept an absolute `deadlineAt`, but the agent tool does not expose it.
An agent does not share the daemon's authoritative wall clock and should request the bounded
relative `autoResolutionMs` instead, avoiding deadlines that precede request creation.

## Model-facing questions stay flat and always use the questions array

The request tool once wrapped a union of ask and detail-read inputs inside an `input` property so
providers would see an object at the schema root. In a real Codex call, the model produced the
complete valid ask object at the root and omitted only that artificial wrapper, so validation
rejected the question before it could reach the person.

`request_user_input` now has one flat object with shared `context`, a required `questions` array
even for one question, and optional `autoResolutionMs`. Bounded detail paging belongs to the
separate flat `read_user_input` tool. The module's direct API still accepts singular asks, but the
agent surface favors one obvious provider-compatible shape over an overloaded tool contract.

## Asking is meaningful session activity

A user-facing question advances a session's meaningful activity at the request's durable
`createdAt`. Settling the request does not advance it again and does not erase it: consumers that
sort conversations must see the same timestamp while the question is pending, after it is
answered, and after a daemon restart. User input exposes the newest question timestamp directly so
callers do not page through model-bounded list output or duplicate knowledge of its storage.

## Post-commit listeners run outside the asking turn and outside the committing step

A question is asked from inside the agent's own tool call. The listeners that hear about it after
the commit — the API module noting it on the agent's metadata, the phone sync sending it out —
write to the agent, and the agent refuses a metadata write "from inside this agent's current
operation". That refusal is judged from the asynchronous context, so a listener that inherited the
tool's context was refused although it was not the tool: new questions were never published and
answered ones never disappeared. Listeners are now invoked from the asynchronous context this
module was loaded in (`AsyncResource.runInAsyncScope`), where no turn is running.

Leaving that context also leaves the database connection's own bookkeeping, and the commit that
fires the hook still holds the connection's step queue while its hooks run. The first version
awaited the detached listeners from inside that step: a listener's database work queued behind
the step, the step waited for the listener, and every read of every agent hung behind them — the
whole daemon stopped answering. The committing step therefore does not wait for the listeners.
Notifications are chained in commit order and delivered as soon as the step lets go; the change is
durable by then. A test that wants to see a listener's effect waits for it rather than asserting
right after the transaction, and the regression test gives the in-memory database a real
lifecycle owner, because the deadlock lives in that owner's queue.

Agents are asked to offer choices. A question asked without options could only be answered by
typing, and the desktop card once had nowhere to type, so people were stuck on it; models also
drifted into writing their questions into a reply, where nothing marks them as waiting. So the
model-facing `request_user_input` requires at least two choices per question, the tool description
and the module's instructions tell the model to ask through the tool and offer its best guesses
for values only the person knows, and every answer still takes the person's own words. The API
answer path keeps the two apart: an offered label is a selection, anything else is text. Other
producers (MCP elicitation, the HTTP API) may still ask open questions; clients show a text field
for those.

## A new message ends the agent's own pending question

The online presence waits for an answer without a deadline, `request_user_input` is not steerable,
and a queued or steering message is taken into the conversation only between inferences. So a
message written while the agent's turn was parked on its own question sat behind that card for as
long as nobody tapped it. When the card never reached the client (a relay answer-shape bug hid
it), the conversation looked frozen: "working", the follow-up pending, nothing else happening.

The API's message POST and the phone's `submit` now call `supersedePending` in the transaction
that admits the message. It cancels the agent's own pending questions with a reason telling the
model that the person's new message follows and is their reply. It does not answer with the
message text, because the message is delivered anyway and the model would read it twice. Clients
that show the card still answer it first — the desktop turns typed text into the answer and the
phone answers before sending — so this only decides the cases where the card was missing, and an
answered question is left alone. Questions asked by the agent's subagents are not touched.
