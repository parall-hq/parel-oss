---
"@parel/core": minor
"@parel/plugin-sdk": minor
"@parel/process-tools": minor
---

Add the `session:stop` lifecycle event: someone asked the session to stop everything it is doing (`POST /sessions/{id}/stop`); the session lives on. `@parel/process-tools` handles it by stopping every running process it lists. The channel `turn_failed` agent event gains an optional `code` (`turn_stopped`, `session_terminated`).
