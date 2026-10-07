# Autonomy learnings

## Ordinary conversation momentum is bounded per human turn

With workflows telling their owner when they finish, detached experts reporting back, and
collaborators reporting to their creator, an agent could keep itself going indefinitely: every
wake-up can start the next piece of work. The owner set small per-turn allowances — expert calls,
workflow starts, automatic wake-ups — that start again whenever the person writes or answers a
question. A spent allowance never drops work that already happened (a finished result is still
reported) and never removes a tool (the tool surface stays stable for the prompt cache); it only
asks the model, in the product's own wording, to ask the person whether to go on and to mark the
project board card `needs_decision`.

## An unfinished goal uses its lifetime allowance

The human requested that a stated objective be carried through without repeated requests to
continue. Applying ordinary wake/expert/workflow allowances to it stopped otherwise useful work.
AutonomyBudget now asks GoalModule to charge the root goal's persistent action or continuation
allowance when one is unfinished. Human messages and answers still reset ordinary counts, but
cannot reset goal usage. A paused or blocked goal refuses new starts; completed background inputs
remain saved. Explicit human continue extends the allowance without replacing the objective.

## One signal for "a person arrived"

The relay and the desktop API reach the daemon by different paths. Both already call
`SchedulingModule.interruptWaits`, so that is the single place the runtime learns a person wrote;
the allowance resets from its `onInterruptWaits` listener rather than from a second hook per path.
