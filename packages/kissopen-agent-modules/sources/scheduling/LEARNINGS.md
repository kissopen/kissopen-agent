# Scheduling — learnings

## Later work is a Scheduled task, set up where it was asked for

Agents used `schedule_message` to book a message to themselves, and mostly to keep a daily chore
alive: each morning's run did the work and then booked tomorrow's. Those arrangements lived inside
one conversation's agent database, where the person could not see them in the Scheduled tasks list,
could not cancel them from another device, and learnt of them only from a line like "明天的任务也已
续排". Once the business server held Scheduled tasks, two systems were scheduling the same kind of
thing and only one of them was visible.

The person asked for the old kind to go and for tasks created in a conversation to go through
Scheduled tasks too. So the scheduled-message tools, their storage, their alarms and their
delivery are gone, and migration `005-remove-scheduled-messages` drops the table — a message still
pending is never delivered, which is the point: an old chain and a new Scheduled task must never
both fire.

The proposal card turned out to repeat the person's work: a request for "每天 9 点汇总"
opened Scheduled tasks and asked them to create the same task again. The owner asked
(2026-09-29, reaffirmed 2026-10-06) for direct creation. A clear request uses
`create_scheduled_task` without navigation or a second confirmation. An unclear time
is clarified in the conversation before creation. Old proposal cards remain history,
not an active creation requirement. Waits remain distinct from scheduled work.

The inherited implementation still creates through the commercial business server
using its model-provider credential. That cannot serve the open-source edition:
removing its cloud model provider produces a false "not connected to the account"
failure even when desktop OAuth is valid. The owner explicitly split the required
authority on 2026-10-06: open-source KissOpen must create and hold tasks in its local
Agent without a cloud scheduling/account dependency; commercial task creation remains
cloud-owned. Both must expose the same authoritative plans and real execution records
in Scheduled tasks. Do not fix the open-source failure by restoring a commercial
provider or copying account credentials into model configuration.

`LocalScheduledTasksModule` now owns the open-source task store and minute/calendar
rules. The current acting model supplies a validated plan to `create_scheduled_task`;
missing timing returns `needs` without saving anything. Due-work transactions advance
one occurrence and enqueue a Durable Functions delivery using a stable, letter-prefixed
Agent message ID. Acceptance means running, not complete: settlement is linked to the
History module's exact run. Clear pauses plans and cancels owed work; drain stops timers.
Standalone task ownership is the installation, and team operations are member-filtered.
The desktop is only a typed API projection and no longer starts its cloud-task claimant.
Module tests and the real-daemon gym verify creation, clarification, manual execution,
restart persistence, due dispatch and terminal records without a commercial credential.
