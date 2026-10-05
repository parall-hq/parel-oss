---
"@parel/cli": minor
---

`parel api-keys create` takes `--scope read|write|admin` (the server's default is write), and `api-keys list` shows each key's scope.

Fixes:

- `parel deploy --no-activate` now stages the version. Before, the flag was ignored and the version went live.
- A staged deploy of an existing agent no longer uploads secret values (the server refuses them). If a referenced secret isn't stored yet, the CLI stops and prints the `parel secrets set` commands to run.
- `parel deploy` uploads `${NAME}` values referenced in `channels[].config`, and prints one line per channel with its result (also after `agents update` and `promote`).
- `parel logs` prints the session's events, reading every page, and says so when a session has no events or logs. `--json` now gives `events` as a list.
- `parel chat` shows a tool result's content (cut to one line) instead of the whole frame, and reply text after a tool result starts on its own line. `send`, `run` and `try` record the result content too.
- `parel send` and `parel try` return as soon as a slash command that runs without a turn finishes, instead of waiting for the timeout.
- `--agent` takes an agent name as well as an id in `sessions list`, `secrets set` and `secrets unset`.
- `send`, `run` and `try` exit as soon as the result is printed, instead of waiting seconds for the WebSocket to close.
- `parel login` exits 1 on a network error, like every other command.
- Server errors include their `details` (for example which config field is invalid).
- Colors are off when output isn't a terminal, as documented.
