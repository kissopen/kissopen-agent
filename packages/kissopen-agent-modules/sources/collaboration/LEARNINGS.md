# Collaboration learnings

## Spawn rows describe resolved execution, not task titles

A creation row cannot infer its model from the task name or wait for an arbitrary result string.
The creation path now resolves the eligible model/provider pair once, writes its complete typed
identity through History before creating the child, and adds the child ID only after initial
delivery succeeds. Replay keeps the recorded model name and provider; catalog/configuration
changes must not relabel historical spawns. The call's status describes creation, not the child's
later work. These facts belong to the feature modules, without changing frozen Agent Base.

## Messages and interruption

Messages between a creator and collaborator are steering in both directions. After the opening task
starts a collaborator, either recipient should incorporate a later message after its current
response and complete tool batch rather than waiting for its active run to finish normally.

An explicitly interrupted collaborator sends no automatic settlement report. Its creator already
observed the interrupt result, and any earlier commentary is incomplete progress rather than a
final answer. The interrupted agent remains durable and can still receive a later follow-up.

## Subagent model availability

Ordinary model availability and delegation availability are separate choices. Provider-level
`include_subagent_models` and `exclude_subagent_models` narrow only new collaborator selection,
with exclusions winning. The same filtered list must drive the creation tool's description and its
runtime validation, including direct creation from workflows, so a hidden path cannot select a
model the creating agent was not offered.

## Agent IDs and cross-workspace messaging

Every agent is told its own Agent ID on every turn, including a root with no collaborators.
`features.cross_workspace` is enabled by default; while enabled, `send_agent_message` accepts any
existing agent whose unguessable ID was shared with the sender. Explicitly disabling it limits
messaging to direct creator and collaborator relationships. Unknown IDs are rejected before
delivery. Cross-workspace access does not broaden `interrupt_agent`, which remains ancestry-scoped
because it is destructive.

## Other modules decide on the same subagent list

`subagentModels()` exposes the list `createAgent` validates against: live models on enabled
providers that the provider's subagent filters allow. The expert module uses it to decide whether
to offer `ask_expert` at all, so a module can never offer delegation to a model creation would then
refuse. Such modules still create through `createAgent` and, when they collect the answer
themselves, pass `reportToCreator: false`; collaboration itself still never waits.

## Reports to a conversation are bounded wake-ups

A chain of collaborators finishing and reporting back kept a conversation going with no one
watching. A report that reaches a root agent is now charged to the autonomy allowance as one
wake-up; past `max_auto_rounds` the report is still delivered — the answer is never dropped — and a
system notice follows it in the same transaction asking the model to check with the person first.
