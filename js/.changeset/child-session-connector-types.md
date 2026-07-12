---
"@parel/plugin-sdk": minor
---

Add the child-session connector contract types: the `spawnChildSession` effect (idempotent on `childRef`, gated on the binding's child-sessions opt-in and `main` routing), `deliverTo.childRef` targeting on `emitEvent`, the `childRef` correlation field on agent events, and the `child_spawn_failed` agent event (pushed regardless of observe scopes; documents per-code retry semantics). `AgentEventEffect` now also excludes `spawnChildSession` — agent-event hooks must not spawn execution, matching the runtime guard. Also updates the `AgentEvent` doc to reflect that all three observe scopes (`turn`, `steps`, `pause`) are emitted.

Note: `child_spawn_failed` is not turn-scoped — it declares the turn-scoped common fields (`sessionId`, `turnId`, `subject`, `envelopeIds`) as explicitly absent (`?: undefined`), so pre-narrowing access to them across `AgentEvent` now types as `T | undefined`. Narrow on `event.type` (or exclude `child_spawn_failed`) before relying on them.
