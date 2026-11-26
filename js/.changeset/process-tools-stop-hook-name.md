---
"@parel/process-tools": patch
---

The `session:stop` hook now registers by its name. A plugin graph holds one copy of each package, so next to a plugin that pins an older `@parel/plugin-sdk` the `LifecycleEvent.SessionStop` constant was undefined and the hook never ran: running processes kept running after a stop.
