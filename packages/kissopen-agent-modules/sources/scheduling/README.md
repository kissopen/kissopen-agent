# Scheduling

Waiting, and handing later work to Scheduled tasks. A wait holds an agent for a while inside the
task it is already doing; this module owns its durable rows and its own timers. Nothing here makes
anything happen later — that is a Scheduled task, held by the business server, which an agent can
only propose.

```ts
const scheduling = new SchedulingModule();
```

The constructor takes nothing. Scheduling reads the clock, mints its own cuid2-shaped identities,
and holds its own timers; its bounds are module constants rather than knobs —
`MAX_SCHEDULING_WAIT_DURATION` is 24 hours and a proposal may be up to
`MAX_SCHEDULING_PROPOSAL_LENGTH` characters. The module's tables are its own, created by its
migrations, and every database operation runs on the Drizzle facade from `ctx.db`.

## Waits

Every agent gets `wait` and `wait_until`. Durations are seconds, minutes, hours, and days, as
fields or as text such as `90 seconds` or `1h 30m`; dates are ISO 8601, RFC 2822, or a Unix
timestamp in seconds or milliseconds, and a date already past resolves at once. Both are bounded to
24 hours, which the tool descriptions say out loud.

A wait is claimed in a short transaction, suspended outside every transaction, and settled in
another short transaction, so a day-long wait never holds a write lock. It survives a restart: the
durable tool call runs again, finds its own row still waiting, and re-enters the suspension for
whatever time is left.

Three things end a wait: its time arrives, the turn is aborted, or a message arrives for the agent.
The last one comes from `interruptWaits`, which Kissopen Agent calls when a person submits or steers into a
session — a queued message does not reach the conversation until the current turn ends, and the
wait is what is holding that turn open. `messageAccepted` ends any wait still standing once the
message really is in the conversation. The result is `elapsed` or `interrupted` and always reports
the time that actually passed, never the time that was asked for.

`interruptWaits` is the product's one "a person arrived" signal: both the phone relay and the
desktop's API call it for every message a person sends. `onInterruptWaits(listener)` hands the same
moment to other modules — the runtime ends a workflow's and an expert's waits with it and starts the
autonomy allowance again — so there is one place that knows a person wrote, not one per path. A
listener that throws is ignored; one module failing to end its wait must not keep the others waiting.

## Scheduled tasks are the KISSOPEN module's

This module has no tool for later work. An agent that is asked for something later or repeating
sets it up as a KISSOPEN scheduled task with `create_scheduled_task`, which the KISSOPEN module
offers (see its `createScheduledTaskTool.ts`): the business server reads the request, saves the
task, and each run comes back into the conversation it was asked for in. The waits here point at
that tool.

There is deliberately no way for an agent to book a message for itself any more. `schedule_message`,
`list_scheduled_messages` and `cancel_scheduled_message` were removed along with their table
(migration `005-remove-scheduled-messages`), and with them every message still pending.

## Events

Subscriptions are taken after construction and each returns the function that ends it:

```ts
const stop = scheduling.onEvent((ctx, event) => project(event));
scheduling.onEventTransactional((ctx, event) => mirror(ctx, event));
```

Every subscriber receives one detached, deeply frozen event: `wait_started` or `wait_finished`.
`onEventTransactional` runs inside the transaction that commits the change, so throwing from one
rejects the mutation that produced it. `onEvent` runs through stdlib `afterCommit(ctx, …)` once the
outermost transaction has committed; nothing there can undo a committed change, so a failing
subscriber is logged through `ctx.log` and the remaining subscribers still see the event.
