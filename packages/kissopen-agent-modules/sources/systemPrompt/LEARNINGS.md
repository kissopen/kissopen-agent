# System prompt learnings

## The agent names itself after the product

This repository owns the KissOpen runtime identity.
Every vendor prompt, custom-provider fallback and shared environment instruction therefore uses
KissOpen in every language. Changing only client logos cannot correct the model's identity: the
identity sentence and bot runtime guidance must agree. Named assistants still use their own live
bot name. Existing conversations, bot rows and user-authored instructions are not rewritten.
The naming rule stays inside the identity sentence because the Codex template continues that
sentence with ", an agent based on GPT-5". Provider IDs, paths and protocol fields do not change.
