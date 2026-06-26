---
"@parel/sandbox-e2b": minor
---

Inject sandbox-level env vars at cold-start. The plugin now passes its `config.env` map through to `Sandbox.create({ envs })`, so a host can seed persistent environment variables (visible to every command in the sandbox) without a per-command prefix.
