---
"@parel/approval-tools": minor
"@parel/core": patch
---

approval-tools: deliver approval results via the normalizeInput protocol instead of an ephemeral ContextBuild drain. Approval decisions now materialize as durable transcript messages (visible to replay/fork/console) and their input rows are consumed at the turn that delivers them. The `resolvedAt` timestamp is now taken when the result is normalized (the normalizer does not receive the queue item's receipt time).

**Host requirement:** 0.2.0 removes the ContextBuild drain entirely, so it needs a host that materializes every `async_callback` at turn start and dispatches registered normalizers (parel-mono #188, the #187 demolition). On a host older than that, `approval_result` callbacks are neither drained nor rendered: the row stays queued and re-triggers the empty wake turn #187 eliminated. Roll the host out first; do not resolve agent configs to `@parel/approval-tools@0.2.0` before it is live.

core: update the NormalizeHandler contract note — when every normalizer defers, the host renders its own type/kind-specific fallback and consumes the input; no input survives intake as a bare re-triggerable queue row (the previous carve-out let one unclaimed callback re-fire an empty wake turn forever).
