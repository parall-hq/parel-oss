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
