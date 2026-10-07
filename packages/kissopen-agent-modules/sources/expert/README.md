# Expert

Lets the everyday model hand the hard work to a stronger one.

```ts
const expert = new ExpertModule(config, collaboration, computeModule, autonomy);
```

`computeModule` is used to look up the files an answer lists; `autonomy` is the per-turn allowance
each new expert is charged to.

The cheap, fast model on the `kissopen` provider (DeepSeek by default) answers. Some kinds of work
— slides, plans, long documents, data analysis — go to an expert model instead, and so does a step
that keeps failing. Which model is the expert, at what effort, and which kinds of work it takes are
set in the KISSOPEN server's admin console and read by the Agent at run time, so changing them
needs no Agent release.

## The policy

`GET {kissopen base_url}/policy`, authenticated with `Authorization: Bearer <api_key>` — the same
device credential the `kissopen` provider's model calls use — answers:

```json
{
    "models": ["openai/gpt-5.6-sol", "deepseek/deepseek-flash"],
    "policy": {
        "default_model": "deepseek/deepseek-flash",
        "default_effort": "high",
        "expert_model": "openai/gpt-5.6-sol",
        "expert_effort": "medium",
        "expert_tasks": [
            { "id": "slides", "name": "演示文稿", "description": "…", "enabled": true }
        ],
        "escalate_after_failures": 3,
        "hide_model_picker": false
    }
}
```

`ExpertPolicyClient` reads it only when `[providers.kissopen]` is a Codex-typed provider with both
`base_url` and `api_key`, and reads that configuration again on every request. It starts at
`beforeStart` without being awaited, then refreshes every 10 minutes on an unreferenced timer, each
request bounded to 15 seconds. A response that fails, times out, or does not match the TypeBox
schema keeps the last good copy; before any good copy there is `DEFAULT_EXPERT_POLICY`, which is
the server's own default. Failures are logged with the endpoint (credentials, query, and fragment
removed) and the HTTP status or reason; the key is never logged, and a reason that quotes it is
redacted.

## When `ask_expert` is offered

Only when all of these hold, checked on every turn:

- the agent runs on the `kissopen` provider;
- its current model is not the policy's `expert_model`;
- `expert_model` is in the policy's `models`, and is a `kissopen` model collaboration may create a
  collaborator on (`CollaborationModule.subagentModels()`, the list `createAgent` validates against).

The effort is `expert_effort` when that model offers it, otherwise the model's default effort.
While offered, the module also contributes an instruction block listing only the enabled task kinds
with their console names and descriptions, the repeated-failure rule, and how to relay the result:

```
# Expert
You answer on a fast everyday model. A stronger expert model (GPT-5.6 Sol) takes the harder work through ask_expert.
Hand these kinds of requests to ask_expert instead of doing them yourself:
- slides (演示文稿): 制作 PPT、幻灯片、演示文稿，或重做、美化已有的演示文稿
- …
For such a request, call ask_expert with kind set to its id and a complete, self-contained task: …
If the same step has failed repeatedly, stop retrying it: call ask_expert with the goal, what you tried, and the exact errors.
ask_expert returns when the expert has finished, with a check of the files it lists. Then decide what comes next and relay the result to the person in your reply, with links to the files it produced; do not redo its work.
If the person writes while the expert is still working, ask_expert returns early as detached: reply to the person, and do not ask the expert again for the same task — its result arrives later as a message.
```

## `ask_expert`

Input `{ task, kind? }`: `task` is complete, self-contained instructions (at most 45,000
characters), `kind` an expert task id. An unknown `kind` is not an error; it only loses the kind's
description in the expert's brief.

The call creates an ordinary collaborator through `CollaborationModule.createAgent` — provider
`kissopen`, the policy's exact model and effort, the caller as parent, the caller's environment and
modules, title `Expert: <kind name>` — whose ID is the tool call's ID. Its opening message is a
short brief (work directly in this workspace, do not wait for answers, finish with the result and
the absolute path of every file written) followed by the task. It is created with
`reportToCreator: false` and `metadata.expert`, because the call collects the answer itself: the
module's own `onEventTransact` keeps the expert's last text, `onEvent` its session error,
`afterTurnTransact` whether it was aborted, and `afterAgentSettledTransact` records the outcome and
wakes the waiting call. The result is one of:

- `answered` — the expert's final text, verbatim (elided past 60,000 characters in what the model
  sees), with `verification` (below) and the instruction to decide: continue / rework (ask_expert
  again naming what is missing) / wait / ask the person / finish, recording the files and whether
  they were verified in the card in `.kissopen/project.json`;
- `failed` — why it stopped without an answer (an error, or being stopped);
- `timed_out` — it had not settled after 20 minutes, so the call interrupted it
  (`CollaborationModule.interruptAgent`) and says so;
- `detached` — the person wrote while the expert worked (below).

`failed` and `timed_out` are error results. The tool is eager (`defer: false`) and never reviewed in
Auto. The person's stop aborts the caller's whole tree, the expert included, through the Abort
module; cancelling the call itself never interrupts the expert.

A new call is charged to the conversation's autonomy allowance (`max_expert_calls_per_turn`, 4 by
default) just before its expert is created; past it the call fails with the autonomy notice, and the
tool stays offered so the tool surface never changes from turn to turn. A call executed again after
a restart re-attaches to its expert and is not charged.

### The person writing while the expert works

A message the person sends would otherwise wait behind a wait of up to 20 minutes. So the call also
races the one "a person arrived" signal: the runtime subscribes `interruptWaits(agentId)` to
`SchedulingModule.onInterruptWaits`, which the phone relay and the desktop's API both fire. The
expert is not stopped. The call commits `detached` (not an error: "the expert is still working; read
the person's message and reply; the result will arrive as a message") in the same transaction that
marks the note `detached: "awaiting"`. If the answer was recorded first, the call returns it instead.

When the expert later settles, the settling transaction records its outcome as usual, and the
`afterAgentSettled` hook — after the commit, outside any transaction — checks the answer and steers
it into the caller's conversation as a system message with the ID `<expertId>:finished`, marking
the note `reported` in the same transaction. The message has the expert's identity, so a repeated
delivery is the same message. It counts as one automatic wake-up of the conversation; past
`max_auto_rounds` it carries the autonomy notice. If the process ends between the commit and the
delivery, the caller's next `ask_expert` call delivers it.

The `reported` note is kept (the sweep erases it a day later), so the same call executed again finds
it and returns `detached` rather than creating a second expert.

### Checking what the expert says it made

The brief asks the expert to close with Files, Checked and Open. After an `answered` outcome, outside
any transaction, the module reads the last Files and Open sections (headings, bold labels, bullets,
code spans, links, English or Chinese labels) and looks up every listed path — at most 50 — on the
caller's machine through the compute module, relative paths against its working directory, all
within 10 seconds (anything not found in time counts as missing). `verification` is
`{ verified, files: [{ path, exists }], open }`, and `verified` holds only when Files lists at least
one path, every one exists, and Open is empty or says none (`none`, `无`, `没有`, …). The model is
shown each file as exists or MISSING and the verdict. With no machine to look on, `verification` is
left out.

### Durability

`ask_expert` is `durable` and `reloadable`. A drain may abandon the wait and a restart executes the
call again, which is safe because:

- the expert's identity is the call ID, and a note `pending.<id>` (parent, model, effort, start
  time) is written in the same transaction that creates the expert and delivers its task, so a
  re-executed call finds the note instead of creating a second expert;
- Agent Base restores the expert itself and carries on with its run;
- the settlement hook writes `answer.<id>` in the settling transaction, before the in-memory waiter
  is woken, and only while the note exists — so an answer that arrives while no process is waiting
  is found by the re-executed call;
- the deadline is measured from the note's start time, so a restart does not extend it;
- the result commits (`call.commit`) in the same transaction that erases the note and the answer;
- a detached call's note outlives its commit, marked `awaiting` then `reported`, so executing the
  call again never creates a second expert.

A call the person cancels never commits, so its note stays; each `ask_expert` call first sweeps
notes more than a day past their deadline. Both records live in the module's shared Agent KV;
nothing here needs Durable Functions, because no action has to be resumed outside Agent Base's own
tool retry and agent restoration.

## Escalation after repeated failures

While `ask_expert` is offered and `escalate_after_failures` is above zero, the module counts
consecutive failed tool results in history Agent KV. `beforeToolCallTransact` remembers each call's
tool name in its call-scoped run store; `afterToolCallTransact` adds a failure (keeping the last
three tool names and first 300 characters of their errors) or clears the count on a success. A
result of `ask_expert` itself, whatever it was, clears the count, and so does a new user message
(`messageAcceptedTransact`). When the count reaches the threshold, the next inference boundary of
`systemNotificationsTransact` adds one system notice and clears the count, so the notice repeats
only after as many further failures:

```
# Repeated failures
The last 3 tool calls failed in a row. Stop retrying the same approach.
Most recent failures:
- exec_command: …
Call ask_expert now with the goal, what you tried, and these exact errors, and let the expert solve it. Then relay its result to the person.
```

## Host operations

- `policy` — the `ExpertPolicyClient`: `current()` and `refresh()`.
- `expertFor(agent)` — the expert route for a provider/model, or undefined when not offered.
- `ask(ctx, agent, input, call, sharedKV)` — what the tool executes.
- `interruptWaits(agentId)` — the person wrote to this agent: its waiting calls return `detached`.
- `close()` — stop refreshing; the runtime registers it for shutdown.

`transport()`, `now()` and `timeoutMs` are protected seams a test subclass overrides; the product
never does.

## Storage

No tables and no migrations. Shared Agent KV holds `pending.<id>` and `answer.<id>` while a call
waits or a detached result is owed (and the `reported` note for a day after); history Agent KV holds `failures`; an expert's run store holds its last text, error, and
interruption until it settles.
