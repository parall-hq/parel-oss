---
"@parel/sandbox-e2b": minor
---

Consume per-turn invocation context. The plugin now declares `consumes.invocationContext` and, when the host injects it, flattens `toolCtx.invocationContext.context` into per-command env vars for each `bash` execution (`commands.run(cmd, { envs })`). This lets per-turn values (e.g. a chat id that changes every input) reach in-sandbox CLIs via `process.env` without baking them into the cold-start env. Cold-start `config.env` remains for values that are constant for the whole sandbox.
