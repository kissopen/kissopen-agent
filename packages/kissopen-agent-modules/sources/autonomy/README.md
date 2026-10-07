# Autonomy

Bounds how far an agent carries on by itself between two things the person says.

```ts
const autonomy = new AutonomyBudget(config);
```

Asking the expert, starting a workflow, and being woken by work that finished in the background
each let an agent keep going with no one watching. Chained together — a workflow finishes, the
agent asks the expert, the expert's result wakes it, it starts another workflow — they could run
for hours on the person's account. So each conversation gets a small allowance per turn of the
person's, set in `[settings]`:

| Setting                        | Default | Counts                                                                                                                  |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `max_expert_calls_per_turn`    | 4       | new `ask_expert` calls (a re-executed call is not a new one)                                                            |
| `max_workflow_starts_per_turn` | 2       | `run_workflow` launches                                                                                                 |
| `max_auto_rounds`              | 6       | automatic wake-ups of the conversation: a workflow finishing, a collaborator reporting back, a detached expert's result |

The settings are machine configuration only; a repository's `kissopen.toml` cannot raise them.

## Who is counted

A conversation is a root agent and everything created under it. Expert calls and workflow starts
are charged to the root of whichever agent made them. A wake-up counts only when it reaches the
root itself: a collaborator reporting to another collaborator is work inside a step already taken,
and no person reads that agent's conversation.

## Starting again

`reset(agentId)` clears a conversation's counts. The runtime calls it from the one "a person
arrived" signal, `SchedulingModule.onInterruptWaits` — which fires for a message from the phone
relay and from the desktop's API alike — and when the person answers a question the agent asked
with `request_user_input`, since that answer is exactly the decision the limit asks for.

## When an allowance is spent

- `take(ctx, agentId, "expert_call" | "workflow_start")` throws, so the tool call fails with a
  sentence naming the limit followed by `AUTONOMY_LIMIT_NOTICE`.
- `wake(ctx, agentId)` returns `AUTONOMY_LIMIT_NOTICE`, which the waking module delivers in place
  of the wake-up's usual instructions (what finished is still reported).

```
已达到自动推进上限。用提问工具问用户是否继续（继续 / 先停下 / 换个做法），并把 project.json 里这张卡片设为 needs_decision。
```

A spent allowance never removes a tool. The tool surface stays identical on every turn so the
provider's prompt cache keeps serving it; the step is refused instead.

## Storage

None. The counts live in memory; a restart starts them again, which errs on the side of the work
carrying on.
