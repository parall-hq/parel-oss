---
"@parel/core": minor
"@parel/plugin-sdk": minor
"@parel/subagent": minor
---

Add an optional `normalize` plugin capability for intake.

Runtime plugins can register `ctx.normalize(types, handler)` to turn inbound platform inputs (e.g. `async_callback`) into canonical transcript messages at intake, so content is persisted to the transcript SSOT instead of being rendered ephemerally into the model prompt each step. `PluginManifest.provides.normalize` declares the input types a plugin handles, and `@parel/subagent` now registers a normalizer for its `subagent_result` callbacks. The context method is optional and the plugin call is guarded (`ctx.normalize?.(...)`), so plugins built against this SDK keep loading on hosts that predate the capability.
