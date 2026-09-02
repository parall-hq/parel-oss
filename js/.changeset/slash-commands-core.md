---
"@parel/core": minor
"@parel/plugin-sdk": minor
---

Slash commands: plugins register `/name` commands the user can type into a session via the optional `ctx.command(definition, handler)` (`CommandDefinition`, `CommandContext`, `CommandResult`, `CommandHandler`), and declare them in the manifest's `provides.commands` (declaration is authorization — hosts recognize `/name` only for declared names). A command runs at a turn boundary, never inside a turn; `reply` is shown to the user without entering the transcript, `prompt` expands the command into the user message of a new turn.
