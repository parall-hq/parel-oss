---
"@parel/sandbox-e2b": patch
---

Carry `config.env` as the per-command environment base on every command
surface (bash tool, exec capability, background processes). E2B injects
cold-start envs only at sandbox creation, so a persistent sandbox resumed
from a pause comes back with a fresh process environment — commands without
a per-turn invocation context previously ran with no configured env at all
after a resume.
