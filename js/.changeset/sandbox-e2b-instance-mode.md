---
"@parel/sandbox-e2b": minor
"@parel/plugin-sdk": patch
---

sandbox-e2b: instance mode — on hosts providing `ctx.instanceStore`, the sandbox belongs to the agent instance instead of a single session. Every session of the instance shares one sandbox (authoritative handle in the instance store, all mutations via `cas()` so racing sessions converge on one machine and losers reap their orphans), a conversation ending releases the local handle without killing the shared sandbox, and process/port records move to the instance store so sibling sessions see them. Pre-migration per-session sandboxes are migrated on first acquire: promoted to authoritative when the instance has none, reaped as orphans when a sibling's sandbox already holds authority. Hosts without instance storage keep the exact per-session behavior. plugin-sdk re-exports `InstanceStore`/`InstanceStoreEntry`/`InstanceInfo` from `@parel/core`.
