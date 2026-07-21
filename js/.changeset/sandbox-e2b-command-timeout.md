---
"@parel/sandbox-e2b": patch
---

Bound every foreground command (bash tool, exec/shell) with a per-command timeout: the SDK `timeoutMs` is now passed on each run, plus a host-side race fallback that fires even when the transport dies silently (a hung connection previously stalled a turn for 15 minutes until the platform watchdog). New `commandTimeout` config (default 120000ms); per-call `timeoutMs` overrides. A timed-out command returns exit code 124 with an explanatory stderr instead of hanging or crashing the tool. `timeout` config docs clarified: it is the sandbox lifetime TTL, not a command timeout.
