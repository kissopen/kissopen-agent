# Workflow learnings

## Daemon restart recovery

Agent Base restores active workflow collaborators before module `afterStart` runs. Workflow
startup must restore every durable running script and reattach each unanswered external call to
its persisted collaborator ID. Marking the run paused or creating a replacement agent loses the
live restoration edge and pays for the same call twice.

Register the recovered call's in-memory waiter before rereading its durable result. The restored
agent may settle while workflow startup is still rebuilding the script; the post-registration
read and settlement callback together cover both sides of that race without polling.

## Background runs end by telling the owner, within a per-turn allowance

A run nobody was waiting on used to finish in silence. It now steers `<runId>:finished` into its
owner's conversation in the finishing transaction, and a person writing ends a `wait_workflow` early
so their message is read. Because a finished run can wake the owner into starting the next one,
launches and those wake-ups are charged to the conversation's autonomy allowance. Past it, a launch
fails with the autonomy notice (the tool stays, so the tool surface never changes) and a finished
run is still reported, with the notice in place of "carry on".
