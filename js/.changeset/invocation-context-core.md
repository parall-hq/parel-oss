---
"@parel/core": minor
---

Add per-turn invocation context. `InputQueueItem` gains an optional `context` (opaque, JSON-able, non-transcript metadata carried by the ingress); a new `InvocationContext` type (`{ inputId, turnId, context }`) is exposed on `ToolHandlerContext.invocationContext` (distinct from the existing `ToolHandlerContext.invocation` tool identity). `PluginManifest` gains `consumes.invocationContext` so a plugin can opt in to receiving it. All additive and optional. (Hook-context delivery for policy/channel plugins lands later, once host-side gated hook delivery is wired.) See docs/invocation-context.md.
