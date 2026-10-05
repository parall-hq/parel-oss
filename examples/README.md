# PAREL Examples

Public examples for running PAREL agents and writing runtime plugins.

## Secrets: `${NAME}` references

Config values that are secrets are written as `${NAME}` references (uppercase
env-var style, whole-value only — no string interpolation):

```yaml
- plugin: sandbox-e2b
  config:
    apiKey: ${E2B_API_KEY}
```

`parel deploy` reads each referenced name from your local environment, uploads
the value encrypted and agent-scoped, and the platform substitutes it when a
session starts. The reference is what lives in this file and in git — never
the value. Literal secrets in config fields are rejected at deploy time.

For values shared across agents (or CI machines without the env var), store
them once for the whole workspace instead: `parel secrets set E2B_API_KEY`
(reads the same-named env var by default; needs an Admin-scope key). Deploys
fall back to workspace values for any reference not found locally.

## `agent.yaml` — a minimal agent

[`agent.yaml`](agent.yaml) describes a single agent: a model provider plus a list
of plugins. It validates against
[`../schemas/agent-config.schema.json`](../schemas/agent-config.schema.json).

```yaml
version: "1"
agent:
  name: hello-agent
model:
  provider: anthropic
  model: claude-sonnet-5
plugins:
  - plugin: system-static
    config:
      prompt: You are a concise assistant.
  - plugin: sandbox-e2b
    config:
      apiKey: ${E2B_API_KEY}
```

Run it with the CLI, which talks to `https://api.parel.sh`. Create a PAREL API
key in the console under
[Settings → API keys](https://parel.sh/console/settings/api-keys) first.

PAREL holds no model keys: agents call the model with your own provider key,
and the provider bills you directly. Add it in the console under
[Settings → Model providers](https://parel.sh/console/settings/providers), or
from the CLI with an Admin-scope API key:

```bash
npm install -g @parel/cli
parel login
parel provider-keys set anthropic --from-env ANTHROPIC_API_KEY  # needs an Admin-scope key
export E2B_API_KEY=e2b_...
parel deploy ./agent.yaml   # uploads E2B_API_KEY from your environment
parel chat --agent hello-agent
```

If a referenced secret is missing everywhere (local env, agent secrets,
workspace secrets), the deploy fails and the error tells you exactly what to set. To check
beforehand: `parel capabilities doctor ./agent.yaml`.

### Other model providers

`model` picks the provider: `anthropic`, `openai`, `openai-responses`, or
`openai-compatible` / `anthropic-compatible` for any endpoint that speaks those
APIs. DeepSeek, for example:

```yaml
model:
  provider: openai-compatible
  model: deepseek-v4.1-flash
  config:
    baseUrl: https://api.deepseek.com/v1
    credentialProvider: deepseek
```

Store the key once for the workspace with
`parel provider-keys set deepseek --from-env DEEPSEEK_API_KEY`, or keep it with
this agent by setting `apiKey: ${DEEPSEEK_API_KEY}` under `config`. See
[`protocol/agent-config.md`](../protocol/agent-config.md#model-providers).

## `coding-agent.yaml` — a coding-agent bundle

[`coding-agent.yaml`](coding-agent.yaml) composes the coding agent profile
with sandbox, workspace, file/search/edit/git/shell/process/port/approval, and
subagent plugins. It works as-is against a public demo repository; point the
workspace identity at your own repo (publicly clonable https only — the sandbox
has no git credentials) and `export E2B_API_KEY=...` before deploying.

A plugin entry can be written three ways:

```yaml
plugins:
  - filesystem-tools                  # bare id, no config
  - plugin: system-static             # id + config
    config: { prompt: "Be concise." }
  - system-static: { prompt: "..." }  # id-keyed shorthand
```

## `plugins/` — writing a plugin

[`plugins/concise-system-prompt.ts`](plugins/concise-system-prompt.ts) is a
minimal first-party-style plugin built with
[`@parel/plugin-sdk`](../js/packages/plugin-sdk). It registers a `ContextBuild`
hook that appends an instruction to the system prompt. See the
[plugin protocol](../protocol/plugins.md) for the full hook and context API.

If your plugin needs a secret (an API key, a token), declare the config field
in `parel.plugin.json` under `requires.secrets` — the declaration drives
deploy-time validation, error messages, and redaction. Your code just reads
the resolved value from its config; it never sees where the value came from.
