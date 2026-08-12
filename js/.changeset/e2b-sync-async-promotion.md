---
"@parel/sandbox-e2b": minor
---

bash sync→async promotion (`promoteAfterMs`, default off): when configured, bash
commands launch detached with file-redirected output and a durable exit marker
from t=0, and the sync window is a push-style `handle.wait()` raced against the
threshold. Commands finishing inside the window return exactly as before (~1
extra roundtrip, no polling). A command that outlives the window keeps running
in the sandbox and the tool returns an honest handle registered in the shared
process store, so the model can follow up with the process tools (tail / list /
stop). Timeout stops being a failure that discards work (exit 124) and becomes
a shape transition.

The process record is registered at launch (removed when the command finishes
in-window), so even an isolate death inside the sync window leaves the
still-running command discoverable via processes.list. Output-file read
failures on the completed path are reported honestly instead of rendering as
an empty success, and the promotion message now includes the stderr tail.
