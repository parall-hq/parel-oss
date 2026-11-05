---
"@parel/core": patch
---

Document that `context:build`'s `hookCtx.messages` carries the step's recent history (the host's window), and deprecate reading history through it in favour of `hookCtx.transcript.read(range)`.
