---
"@parel/agents-md": minor
---

New plugin `@parel/agents-md`: loads the project's `AGENTS.md` (or `agents.md` / `AGENT.md`) from the sandbox working directory into the system prompt every turn, and loads the `AGENTS.md` files of the subdirectories the model reads or writes files in. Loaded subdirectories are kept in the session store so they stay loaded on later turns; total size is capped by `maxChars` (default 32000) with a visible note for anything cut. Without a sandbox it does nothing.
