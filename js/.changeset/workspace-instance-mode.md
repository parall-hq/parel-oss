---
"@parel/workspace": minor
---

workspace: instance mode — on hosts providing `ctx.instanceStore`, the workspace handle follows the shared sandbox into the instance store so every session of the agent instance works in the same materialized tree. Saving the handle goes through `cas()`; a session that loses the race adopts the sibling's result instead of clobbering it. A legacy per-session handle is promoted into the instance store on first read. Hosts without instance storage keep the exact per-session behavior.
