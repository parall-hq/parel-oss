---
"@parel/plugin-sdk": minor
---

Add `context: "fresh" | "fork"` to the `spawnChildSession` connector effect. `"fork"` (default, the original behavior) snapshots the parent's transcript at the turn boundary, inheriting the parent's in-flight config/version and plugin session store. `"fresh"` starts the child from an empty transcript, provisioned like a new session of the binding's agent (active deployment or instance pin, plugin store starts empty) while still joining the parent's instance — for work lanes (per-fire schedule/task dispatch) that should not pay for or see the main conversation's history. Everything else is unchanged in both modes: the child runs the binding's agent, and `childRef` idempotency (context is not part of the anchor), `child_spawn_failed` feedback, `deliverTo.childRef` routing, depth/concurrency gates, and `childRef` event correlation are identical. Unrecognized values reject with `invalid_request` instead of silently forking.
