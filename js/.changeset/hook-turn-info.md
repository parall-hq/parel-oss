---
"@parel/core": minor
---

Add `HookTurnInfo` and the optional `hookCtx.turn` block on every hook context: `{ turnId, stepNumber, inputIds, absorbed }` — the turn a hook runs in, the input ids the turn has consumed so far, and the inputs absorbed at this step boundary (messages delivered into the turn in flight). Observation only; absent on older hosts.
