# KISSOPEN product

Tells every agent running on a KISSOPEN account who it works for: an ordinary office worker.

```ts
const product = new KissopenProductModule();
```

The instructions (`KISSOPEN_PRODUCT_INSTRUCTIONS`) ask the agent to speak in the words of the
person's work, never to name models, tools, agents or experts, to carry intermediate steps through
without asking each time, and to ask real questions through `request_user_input` with two or three
options, the recommended one first.

Only agents whose provider is `kissopen` receive them. An agent on the person's own Claude, Codex
or other account is left with its own setup.

The text is a constant, identical on every turn, so the provider's prompt cache still covers
everything before it.
