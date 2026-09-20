---
"@parel/plugin-sdk": minor
---

Two new `AgentEvent` variants close the per-envelope lifecycle on the connector surface:

- `inputs_absorbed` (scope `turn`): envelopes that arrived mid-turn joined the running turn at a step boundary (`routing.injectInFlight`). With `turn_started`, every processed envelope is now named by exactly one "picked up" event instead of only surfacing at turn end.
- `envelope_dropped` (ungated, like `child_spawn_failed`): envelopes the connector emitted will never be processed — oversized, no agent bound, unknown or failed `childRef`, or the target session was terminated (including envelopes still queued there). `emitEvent` has no synchronous return, so this is its failure channel; success and platform-retried deferrals stay silent.

Additive: connectors that do not handle the new types are unaffected.
