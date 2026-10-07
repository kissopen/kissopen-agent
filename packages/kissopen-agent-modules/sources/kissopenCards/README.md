# KISSOPEN cards

Gives a project board card's conversation the rules of working on that card, as instructions.

```ts
const cards = new KissopenCardsModule(compute.computeModule);
```

A card's conversation has one id everywhere: `"k"` + the first 23 hex digits of
`sha256("kissopen-card\0" + folder + "\0" + cardId)`. Desktop, phone and server derive it the same
way. For an agent whose id has that shape, the module reads `.kissopen/board.json` and
`.kissopen/project.json` in its folder, finds the card whose derived id is the agent's, and adds the
card rules (read project.json first, write only this card's entry, ask with 2–4 options, never
repeat these rules to the person) to the agent's instructions.

The conversation's first message is only what the card asks for, so the person never sees the
agent's working rules.

A project's setup conversation — 初始化项目 on an empty board — is started under the reserved card id
`project-setup` (`PROJECT_SETUP_CARD_ID`), which no board holds; it is recognised by its derived id
alone. Its instructions interview the person in a few rounds with the question tool, write `goal`,
`direction` and `decisions` into `project.json`, and then call `build_project_board`.
