---
"@parel/plugin-sdk": minor
---

feat(plugin-sdk): `invocationContext` on the `spawnChildSession` effect

A connector-spawned child's OPENING turn was the one turn in its life without
per-turn invocation context: it starts from the effect's `input` rather than an
envelope, and the effect had nowhere to carry one. Every later `deliverTo`
envelope carries its own, so a connector routing replies from context saw
exactly the child's first reply detach.

Named apart from the effect's existing `context`, which is the transcript
seeding mode (`fresh` | `fork`).
