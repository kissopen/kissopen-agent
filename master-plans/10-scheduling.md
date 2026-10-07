# Master plan 10: Scheduling

## Big picture

Every model, across every provider, gets `wait` and `wait_until`. Agents that
are not subagents also get `create_scheduled_task`. Their names use
`snake_case`.

`wait` pauses an agent for a duration. Durations can be expressed in seconds,
hours, or days, with several forms allowed. Waits can be very long, up to
around 24 hours. `wait_until` does the same thing, but takes a date in formats
the model can express.

## Durable waits

Waits survive a daemon restart. While an agent is waiting, the session state
shows that the session is simply waiting.

Any message into that chat interrupts the wait. The agent is told that the wait
ended early and how much time actually elapsed.

## Scheduled tasks

The agent's own scheduled messages are removed (`schedule_message`,
`list_scheduled_messages`, `cancel_scheduled_message`). This kind of task now
has dedicated Scheduled tasks. A task requested inside a conversation is
created directly with `create_scheduled_task`; the user does not navigate to
Scheduled tasks or confirm the same request again. When the time or work is
unclear, the agent asks in that conversation before creating anything.
`create_scheduled_task` is never available to subagents.

The open-source KissOpen edition creates Scheduled tasks with its local Agent,
without a cloud dependency. The commercial edition creates them through the
cloud. Both editions show created tasks and their execution records in
Scheduled tasks so the user can inspect, edit, pause or stop them.

Scheduled messages that were already pending are stopped, and listed to the
user so they can recreate the ones they want as Scheduled tasks.

## What done looks like

- Every model and provider has the `snake_case` `wait` and `wait_until` tools.
  Agents that are not subagents also have `create_scheduled_task`; subagents
  never do.
- Long waits accept durations in seconds, hours, or days, and dated waits accept
  dates in formats models can express.
- Waits survive daemon restarts, appear as waiting in session state, and are
  interrupted by any new message in the chat with the actual elapsed time
  reported to the agent.
- No agent can schedule a message for later through the removed tools.
  A clear scheduling request creates a Scheduled task in the conversation,
  without a navigation or second confirmation step.
- Open-source task creation uses the local Agent and works without a cloud
  scheduling or account service. Commercial task creation uses the cloud.
- Scheduled messages that were pending before the change never fire.
