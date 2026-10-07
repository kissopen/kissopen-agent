# Goal learnings

## Human follow-ups are not a keyword protocol

A resume guard recognized only continue/resume vocabulary, rejecting actual directions such as
"自己操作，不要再问我" and newly supplied authorization. The failed control result then triggered the
same stop hook as a successful pause, so each new human turn ended after a promise. Control now
uses the model's typed semantic intent plus existing Auto authorization review. Persisted current
human-turn identity and one-use receipts prevent automatic wakes or stale instructions from
resuming. Failed control calls do not write the stopped-input marker or abort the turn.

Live resume validation also exposed an evidence-reference gap: history showed tool results without
the call IDs needed to cite them. Tool-enabled history now exposes the recorded IDs, and the plan
tool explains that tool evidence needs both the zero-based position and exact call ID.

## A clear objective is the execution request

The person should state an objective once and have the agent choose steps, observe results,
change unsuccessful methods, and continue to a verified outcome. Requiring another start/takeover
instruction or ending with an offer to continue interrupts that workflow. Multi-step action requests
now prompt automatic goal creation; questions and requests only for analysis or a plan remain
conversation. Authorization still comes from actual human instructions, never a continuation or
external content.

## Failed turns must reach the continuation decision

Pausing in `afterTurn` for every error prevented `afterAgentLoop` from applying its failure policy.
Only cancellation/interruption pauses there. Errors use bounded durable backoff and block after
repeated failure. Repeated tool outcomes and rounds without observations stop fruitless driving.
External waits use Durable Functions rather than consuming model turns to poll.

A wait schedules a fresh observation; it cannot repair a browser transport or start work that
never began. Wait results and goal-tool guidance distinguish a finished model turn from a
completed objective, keep temporary transport outages active for bounded rechecks, and require
actual tool evidence before claiming recovery. Repeated unchanged failures remain genuine
blockers rather than an unbounded retry loop.

## A resumed objective keeps its identity and accumulated work

An activation describes one run, not a task's lifetime. Stable identity, tasks, criteria, evidence,
and usage survive pause/resume. Requirement revisions invalidate old proof. Completion checks
actual current history and remaining tasks. Old wakes cannot resume stopped or replacement goals.

## A stop must commit before inference is refused

An observing hook's exception cannot veto inference, and throwing in the same transaction as the
pause would roll it back. Preparation commits the decision and aborts; a subsequent transactional
inference hook refuses that stage. Real Agent coverage confirms Ethan retries cannot bypass the
saved allowance. Progress questions do not reset it; explicit continue extends cumulative limits.

Tool transaction hooks receive call-scoped run storage. A stop written there cannot veto the
next model request. The Goal-owned stopped-input marker survives the tool result and is checked
at the inference transaction boundary; only fresh human input or trusted activation clears it.
Actual Agent tests cover repeated failed actions and automatic results arriving while paused.

## Bookkeeping is not evidence or progress

Successful goal tools and resubmitting proof do not establish a new result. References must name
actual current observations or delivered text; the model must still judge their meaning. Human
abandonment is checked at the model tool boundary so the model cannot erase a goal to weaken it
or reset limits.
