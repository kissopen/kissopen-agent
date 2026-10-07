# Goal module

`GoalModule` owns one persistent objective per agent and continues across turns until it is
verified, paused, blocked, or explicitly abandoned. Runtime composes it with Tasks, History, and
Durable Functions and gives the same instance to AutonomyBudget.

```ts
const goal = new GoalModule(tasks, history, durableFunctions);
const autonomy = new AutonomyBudget(config, goal);
```

Dependencies are modules, not host callbacks. They are optional for storage-only consumers;
acceptance requires History and rechecks require Durable Functions. Mutations use `ctx.inTx`
and participate in the caller's transaction. Agent Base and providers own pending requests,
tool settlement, and retries.

```text
human action request -> goal -> rolling tasks -> execution -> verification -> complete
                                                    |
                                              external wait
                                              durable recheck -> observe again
                                                    |
                                 stop / exhausted allowance -> saved paused or blocked goal
                                                    |
                                 explicit human continue -> new activation, same goal and usage
```

## Identity and state

The validated execution sidecar in the existing Goal table holds a stable `goalId`, requirements
`revision`, rolling summary, criteria, evidence references, task IDs, phase, wait, and lifetime
usage. A new activation gets a separate lifecycle identity. Automatic messages carry agent
provenance, activation identity, and revision; an obsolete wake cannot execute another activation
or grant human authorization.

Tasks created during an active goal are bound transactionally even without model-supplied goal
metadata. Removing a task or resetting the list removes that association. Requirements may change
after a new human instruction; initial criteria may be derived from the original request. Changing
requirements advances the revision and removes old proof. Stale revisions are refused. Summaries
may evolve without replacing requirements.

## Model tools and acceptance

The ordinary tool surface contains `create_goal`, `get_goal`, `update_goal`, `clear_goal`,
`update_goal_plan`, `control_goal`, and `wait_for_goal`.
Explicit Code Mode overrides retain their own prompt and restricted tool surface; these ordinary
goal tools do not expand a Python-only engine's capabilities.

- `create_goal` is available for ordinary multi-step action requests. Questions, discussion, and
  requests only for analysis or a plan do not start execution. This is model guidance; the runtime
  does not use a keyword classifier to create goals from arbitrary messages.
- `get_goal` returns the current objective and execution record. Model rendering is bounded and
  includes identity, revision, usage, missing proof, and summary. Transactional system notifications
  supply changed state before the next inference.
- `update_goal_plan` records a summary, criteria, requirement changes, or actual evidence.
  `historyPosition` is zero-based: subtract one from a numbered `read_agent_history` heading.
  A `callId` must name a successful result observed during the current revision. Assistant
  deliverables must reference real text produced after that revision began. Goal tools are rejected
  as verification evidence. Reusing evidence does not count as progress. Existence, provenance,
  freshness, and successful status are validated; the model must judge satisfaction of the criterion.
- `update_goal(complete)` checks the current revision, every criterion's evidence, and remaining
  bound tasks through `completeGoal`. Task completion alone is insufficient. `blocked` retains an
  objective that cannot progress.
- `control_goal` requires a current explicit human pause/resume instruction, applied once.
  Intent is interpreted semantically: directions to act autonomously and authorization resolving
  the previous blocker may resume without a particular keyword. Auto reviews resumption against
  the trusted human transcript and never asks for another confirmation. Current-turn provenance
  and the single-use receipt are checked in storage; an automatic wake revokes control authority.
  Progress questions do not invoke control or replenish limits. Failed control calls leave the
  human turn available to handle the result; only successful stop operations veto later inference.
- `clear_goal` requires explicit human abandonment. The model cannot erase an unfinished goal
  to weaken it or reset limits. Public `clearGoal` and `changeGoalStatus` remain trusted application
  administration operations; model tools use guarded abandonment and completion paths.
- `wait_for_goal` commits a bounded recheck through Durable Functions with the tool result.
  It survives service restart and is cancelled on stop or fresh input. Duplicate/stale wakes are
  harmless. It schedules observation, never replay of an uncertain operation.

## Continuation and budgets

Cancellation and explicit interruption pause in the turn hook. Inference failures reach the loop
decision: two rechecks at two and four seconds, then `blocked` after a third consecutive failure.
Success clears the streak. Six identical consecutive tool outcomes or five automatic rounds with
no new observations/evidence also block further driving. Goal bookkeeping is not an observation.

An objective starts with 200 inference starts, 500 actions, and 50 automatic continuations.
Counters persist across messages, question answers, and restart. Actions include direct tools and
starts charged by AutonomyBudget; continuations include Goal loops, rechecks, and managed wakes.
An already dispatched tool batch may finish at the action boundary; the next inference is refused.
Preparation commits stopping before a later inference stage is rejected, so rollback or Ethan retry
cannot reopen the allowance. Explicit human continue extends limits without erasing cumulative usage.

Reported input/output tokens are accumulated once per inference settlement; missing usage is
counted rather than estimated. These are diagnostic counters, not a monetary quota or exact
accounting of provider-internal retries. Ordinary conversations retain existing AutonomyBudget
per-human-turn settings.

Unknown write/submission outcomes must be inspected before a new attempt. Goal grants no new
permission and adds no replay engine. Browser restrictions and permission review remain on their
existing execution paths.

## Events and validation

Existing events are `goal_set`, `goal_status_changed`, and `goal_cleared`.
`onEventTransactional` participates in the mutation transaction; `onEvent` publishes frozen snapshots
after commit. External stop/clear aborts after commit. In-agent stopping tools save their result
before aborting and veto the next inference until fresh human input arrives.

Module tests cover hook ordering, identity, revisions, evidence, remaining tasks, human control,
stale/duplicate wakes, usage, repeated/idle outcomes, and durable restart recovery. Agent loop tests
exercise real filesystem failure, changing methods, continuation and acceptance, bounded inference
failure, and exhaustion with Ethan retries. The Terminal gym drives PTY input, file verification,
scheduled wake, completion, and a subsequent human turn.

### Verification recorded on 2026-10-04

- Goal, Autonomy, Tasks, Durable Functions, and History: 244 tests passed on Windows.
- Runtime module composition and database concurrency: 6 tests passed in Linux using the current
  source and the Gym image's deployed dependencies. The native Windows run of these existing
  runtime files encountered POSIX permission/symlink assumptions and SQLite cleanup file locks.
- Docker Terminal PTY: one end-to-end test passed. A single human instruction wrote Chinese and
  English text, waited, woke automatically, read the file back, submitted actual history evidence,
  completed the goal, and answered a subsequent status question without restarting execution.
- Modules and Gym test TypeScript checks passed; Modules and Agent builds passed. Targeted lint
  found no errors; two existing listener-snapshot spread warnings remain. `git diff --check` passed.

The PTY and Agent loop tests use scripted inference with real executors and storage. They verify
execution and stopping behavior, not a particular live model's planning quality. Agent Base remains
unchanged. This source update has not been packaged or published as a desktop release.
