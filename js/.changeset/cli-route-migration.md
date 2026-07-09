---
"@parel/cli": minor
---

Migrate the CLI off the deprecated agent/session routes onto the resource-shaped API (available in production v0.8.0).

- Deploy (`run`, `deploy`, `agents update`) now uses `POST /agents/:name/versions` — a single-shot upload that activates by default, equivalent to the old `POST /agents`; `deploy --no-activate` continues to stage via `?activate=false`. `run` and `deploy` now require `agent.name` in the config to address the version (matching the pre-existing `--no-activate` behavior).
- Session creation (`send`, `run`, `chat`, `sessions create`) now uses the top-level `POST /sessions` with the agent reference in the request body.

User-visible output is unchanged.
