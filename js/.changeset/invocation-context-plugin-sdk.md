---
"@parel/plugin-sdk": minor
---

Re-export the new `InvocationContext` type and thread the manifest `consumes` declaration through `definePlugin`, so plugins can declare `consumes.invocationContext` and read `ctx.invocationContext` on their tool/hook contexts.
