---
"@parel/approval-tools": minor
"@parel/core": patch
---

approval-tools: deliver approval results via the normalizeInput protocol instead of an ephemeral ContextBuild drain. Approval decisions now materialize as durable transcript messages (visible to replay/fork/console) and their input rows are consumed at the turn that delivers them. Requires a host with turn-start callback materialization (parel #187 demolition); on older hosts the plugin's normalizer is simply never invoked and the host renders its generic callback framing instead.

core: update the NormalizeHandler contract note — when every normalizer defers, the host renders its own type/kind-specific fallback and consumes the input; no input survives intake as a bare re-triggerable queue row (the previous carve-out let one unclaimed callback re-fire an empty wake turn forever).
