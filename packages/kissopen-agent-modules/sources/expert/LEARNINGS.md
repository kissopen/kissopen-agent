# Expert learnings

## The routing policy comes from the server, not a release

The owner decided that the cheap, fast model answers by default and that certain kinds of work
(slides, plans, long documents, data analysis) go to a stronger expert, with the expert model, its
effort, and the list of kinds set in the admin console. The Agent therefore reads
`GET {kissopen base_url}/policy` with the `kissopen` provider's device key rather than hard-coding
any of it. Reading it may never block or break an agent: startup does not wait, a failed reading
keeps the last good copy, and the built-in default equals the server's own default. The device key
is a credential; it is sent only as the bearer token and is never logged.

## The expert is a collaborator, and the wait belongs to this module

Collaboration deliberately never waits: a creator is told of an answer by a steered report after
the fact. A synchronous `ask_expert` cannot use that report — the caller is parked inside the tool
call, and the report would repeat the answer into the conversation after the call returned it. So
the expert is created through `CollaborationModule.createAgent` with `reportToCreator: false`, and
this module collects the answer through its own hooks, the same pattern workflows use. The one
thing added to collaboration is `subagentModels()`, so the decision to offer `ask_expert` uses the
exact list creation validates against.

## Durable and reloadable, because the answer is recorded durably

A 20-minute wait that blocked drain, or turned into an error on every daemon restart, would be
worse than none. The call's ID is the expert's ID, its note is written in the transaction that
creates the expert, the expert's outcome is written in its settling transaction, and the result
commits in the transaction that erases both. Re-executing the call after a restart therefore
re-attaches to the same expert, finds an answer that arrived meanwhile, and keeps the original
deadline. Notes left by calls the person cancelled are swept a day after their deadline.

## Escalation is deterministic

Telling the model to "ask the expert when stuck" was not relied on alone. The module counts
consecutive failed tool results and, at the policy's `escalate_after_failures`, queues a durable
requested `ask_expert` tool call. A pending marker prevents a failed tool batch from creating
multiple escalations. A success, any `ask_expert` result, or a genuine human message resets the
count; synthetic user-role continuations must not reset it or become human authorization.

## Classify before admission, not after acceptance

The backend supplies ordered literal `match_any`, `require_any`, and `exclude_any` rules and the
console offers a no-inference preview. Go and TypeScript apply ASCII word boundaries for English
terms and substring matching for Chinese. Only current human text is classified.
The API and phone relay prepare a requested tool block before queueing the human message. Trying
to steer from messageAcceptedTransact is too late: Base can make the first inference before
draining the newly queued steering message. Bounded history is reference material for the expert,
never new authorization. Explicit tool requests are not duplicated. Isolated Code Mode replaces
the tool surface, so it cannot accept automatic expert tool requests.

Policy refresh is once per minute, retaining the last successful policy on transient failures.
Task rules and model upgrades are backend settings, not application releases.

## Offering depends on provider and model

`ask_expert` is offered only on the `kissopen` provider, only when the agent is not already on the
expert model, and only when the server serves that model. This is an owner decision; it is in
tension with master plan 16's rule that no model or provider classification decides which tools
exist, and was reported as such.

## The person writing detaches the call, and the result comes back as a message

`ask_expert` was first not steerable, so a message sent during a 20-minute expert run sat unread
until it returned. The owner wanted the person to always get an answer. The call now also races the
single "a person arrived" signal (`SchedulingModule.onInterruptWaits`, fired by both the relay and
the desktop API): it commits `detached` without stopping the expert, and the expert's settlement
delivers its result later as a steered message `<expertId>:finished`. The note is marked in the same
transaction as the commit and kept as `reported` after delivery, because a re-executed call must
never create a second expert.

## An answer is checked, not trusted

An expert saying "done, files at …" was relayed as done. The module now reads the closing Files and
Open sections itself and looks each file up on the machine, outside any transaction and bounded to
ten seconds, and tells the model whether the result is verified, so the model decides — continue,
rework, wait, ask the person, finish — and records it on the project board card.

## Asking the expert is bounded per turn

Expert calls, workflow launches and automatic wake-ups could chain for hours with no one watching.
Each conversation has an allowance per turn of the person's (the autonomy module). A spent allowance
refuses the call with the autonomy notice rather than removing the tool, which keeps the tool
surface — and the prompt cache — the same on every turn.
