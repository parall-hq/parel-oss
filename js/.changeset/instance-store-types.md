---
"@parel/core": minor
---

Add instance-scoped plugin state contract: `InstanceStore` (versioned get/set/delete/list + `cas`), `InstanceStoreEntry`, `InstanceInfo`, and optional `PluginContext.instanceStore` / `PluginContext.instance`. The instance bucket is shared across every session of the same agent instance and is multi-writer — prefer `cas()` for read-modify-write. `undefined` on hosts without instance storage: probe explicitly and degrade honestly (hosts never substitute the per-session store).
