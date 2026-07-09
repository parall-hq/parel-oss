---
"@parel/plugin-sdk": minor
---

Channel connector child sessions: add the `spawnChildSession` connector effect (fork a parallel child session off the binding's main conversation, idempotent on the connector's opaque `childRef`), `deliverTo.childRef` targeted delivery on `emitEvent`, a `childRef` correlation field on every agent event from a connector-spawned child, and the `child_spawn_failed` agent event as the effect's asynchronous error channel. `AgentEventEffect` now also excludes `spawnChildSession` (self-trigger loop guard).
