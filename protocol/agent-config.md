# Agent Config Protocol

`agent.yaml` declares the portable public shape of an agent: its model, its
plugins, its limits and, optionally, its channels. It is validated by
[../schemas/agent-config.schema.json](../schemas/agent-config.schema.json). The
guided reference is <https://parel.sh/docs/config>.

## Shape

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
      prompt: You are concise.
  - plugin: sandbox-e2b
    config:
      apiKey: ${E2B_API_KEY}
  - memory-rolling-summary
  - budget-cap:
      max_usd: 25

runtime:
  maxTurns: 20
  maxSteps: 200
  maxParallelToolCalls: 4
  toolResultMaxBytes: 65536
  reasoning:
    enabled: true
    budgetTokens: 4096
```

## Top-Level Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Format version. Only `"1"` exists. Keep the quotes: an unquoted `1` is a number and fails. |
| `agent` | for the CLI | `agent.name`: the agent's name, unique in the workspace. |
| `model` | yes | Which model provider and model the agent uses. |
| `plugins` | no | Runtime plugins: tools, prompts, memory, guards. |
| `runtime` | no | Limits, and how sessions follow new versions. |
| `channels` | no | Channel connections set up when the version goes live. |

`agent.name` is how the CLI finds the agent: `parel deploy` deploys to the agent
with that name and creates it the first time. Deploys through the HTTP API
(`POST /agents/{name}/versions`) take the name from the URL instead.

Inside `agent`, `model`, and each `channels` entry, unknown keys are rejected.
The hosted runtime drops unknown keys at the top level and under `runtime`
without an error, so validate against the schema to catch misspellings.

## Model Providers

`model` is not a runtime plugin. It selects the model provider layer.
`provider` and `model` (the model id the provider expects) are required;
`config` is optional.

| `provider` | API family | Provider key it uses |
| --- | --- | --- |
| `anthropic` | Anthropic Messages API | `anthropic` |
| `openai` | OpenAI Chat Completions API | `openai` |
| `openai-responses` | OpenAI Responses API | `openai` |
| `openai-compatible` | OpenAI Chat Completions API at `config.baseUrl` | `config.credentialProvider` (default: the provider name) |
| `anthropic-compatible` | Anthropic Messages API at `config.baseUrl` | `config.credentialProvider` (default: the provider name) |

PAREL does not supply model keys. A model call uses `model.config.apiKey` when
it is set, otherwise the workspace's provider key for the credential provider
in the table, added in the console under Settings → Model providers or with
`parel provider-keys set`. With neither, the turn fails with `provider_auth`.

Provider-specific options belong under `model.config`:

| Key | Meaning |
| --- | --- |
| `baseUrl` | Endpoint base URL. Required for `openai-compatible` and `anthropic-compatible`; for the other providers it replaces the default URL. `baseURL` is accepted too. |
| `credentialProvider` | Name of the workspace provider key to use, for example `openrouter` or `deepseek`: lowercase letters, digits, and dashes. |
| `apiKey` | A key for this agent only, written as a `${NAME}` secret reference. It wins over the workspace provider key. Never write the key itself here. |
| `headers` | String map sent on every provider request as default HTTP headers — for gateways that route or authorize by header (a lane header in front of a shared hostname, `HTTP-Referer` / `X-Title` for OpenRouter). Values can be `${NAME}` references. Non-string values are ignored. |
| `parameterDialect` | How output limits and reasoning are sent on Chat Completions APIs: `openai`, `openrouter`, or `compatible`. See [Model Calls](model-calls.md#parameter-formats). |
| `thinkingMode` | Anthropic thinking: `adaptive`, `enabled`, or `disabled`. |
| `requestMetadata` | Boolean, default `true`: generated model request correlation headers. See [Model Calls](model-calls.md#request-correlation). |
| `vision`, `documents` | Booleans: whether the model accepts images and PDF files. When unset, the runtime infers them from the model id. |

See [Model Calls](model-calls.md) for supported values, defaults,
compatibility, and completion/cancellation semantics.

Any service that speaks the OpenAI or Anthropic API works through the
`-compatible` providers. DeepSeek, for example:

```yaml
model:
  provider: openai-compatible
  model: deepseek-v4.1-flash
  config:
    baseUrl: https://api.deepseek.com/v1
    credentialProvider: deepseek   # workspace key: parel provider-keys set deepseek --from-env DEEPSEEK_API_KEY
```

Or keep the key with this one agent:

```yaml
model:
  provider: openai-compatible
  model: deepseek-v4.1-flash
  config:
    baseUrl: https://api.deepseek.com/v1
    apiKey: ${DEEPSEEK_API_KEY}
```

## Runtime Plugins

`plugins` accepts three forms:

```yaml
plugins:
  # 1. Name only, no config
  - memory-rolling-summary

  # 2. Name with config
  - budget-cap:
      max_usd: 25
      max_turns: 50

  # 3. Full form: any public npm package, optional semver range
  - plugin: "@scope/third-party-plugin"
    version: "^1.0.0"
    config:
      key: value
```

Short names resolve to first-party package names by prefixing `@parel/`. For
example, `sandbox-e2b` resolves to `@parel/sandbox-e2b`. A name that starts
with `@` is used as written.

`version` (full form only) is an optional semver range. It is resolved to one
exact version at deploy time and stays fixed; deploy again to pick up newer
releases. Omitted means the latest release at deploy time.

An entry without config must be the bare name: a name followed by a colon and
nothing else (`- memory-rolling-summary:`) fails validation.

If the list has a sandbox plugin but no security plugin, `security-basic` is
added automatically.

Model provider packages must not be listed under `plugins`.

### Local Plugins

Local plugin paths are deploy-time sources for the CLI. A path starts with
`./`, `../`, or `/` and is relative to the `agent.yaml` file. The directory
needs a `package.json` with a name and version, and a `parel.plugin.json`. The
CLI packs it, uploads an immutable artifact, and the runtime installs that
artifact from the frozen lock. Any of these forms works:

```yaml
plugins:
  - ./plugins/internal-tools

  - plugin: ./plugins/internal-tools
    config:
      key: value

  - plugin: "@myco/internal-tools"
    source:
      type: path
      path: ./plugins/internal-tools
```

Deploys through the HTTP API cannot resolve local paths directly; configs with
local plugin paths must be deployed with the CLI.

## Secret References

Never put secret values in `agent.yaml`. Write a reference instead: `${NAME}`
as the whole value of a field, where `NAME` starts with an uppercase letter
followed by uppercase letters, digits, or underscores. References work anywhere
inside `model.config` and inside a plugin's config (nested values too), and as
top-level values of a channel's `config`. The file, the stored config, and API
responses only ever contain the reference; the value is filled in when a
session starts.

A reference is a **whole-value match**: text around it is not filled in, so
`https://${HOST}/x` stays exactly as written.

To provide values, export them and deploy: `parel deploy` uploads every
referenced name it finds in the shell, encrypted and stored for that agent. Or
store a value for the whole workspace with `parel secrets set` (or
`POST /secrets`). An agent's own value wins over the workspace value, and an
instance's value wins over both.

The deploy checks every reference. A name with no value in the upload, the
agent's secrets, or the workspace's secrets fails the deploy with
`secret_unresolved`. Plugins declare their secret fields in `parel.plugin.json`
(`requires.secrets`); such a field must be a reference, so a plain value there
fails with `secret_literal`, and a required one left out fails too.

## Instance Vars and Budgets

Two per-instance controls compose with the instance layer (agents ×
instances × sessions):

- **Vars** — non-secret parameters referenced in `model` (the model id too), in
  plugin configs, and as the whole value of a typed `runtime` knob, written as
  `${var:NAME}` or `${var:NAME:-default}`. Inside longer text, a reference is
  filled in where it stands. A value comes from the first of three layers that
  has it:

  1. the instance's own vars (`PATCH /agents/{idOrName}/instances/{key}` with
     `{"vars": {"NAME": "value"}}`, or the batch form
     `PATCH /agents/{idOrName}/instances` with `[{"key": "...", "vars": {...}}]`);
  2. the agent-level defaults (`PATCH /agents/{idOrName}` with `{"vars": {...}}`),
     shared by every instance — and the only layer an ephemeral session sees;
  3. the reference's own default, `${var:NAME:-default}`. It applies only when
     no layer sets the var (an instance that stores `""` keeps `""`); it may
     not contain braces or a nested reference, and a config with such text is
     rejected at deploy.

  One config, N instances, each with its own values — no config copies. Values
  hot-update on the next turn for live sessions; pinned sessions keep their
  creation-time snapshot (pinned means frozen). In plugin config, references
  with no value from any layer stay as literals (visible, debuggable, never
  fatal). Secrets keep their own `${NAME}` syntax and stores; a secret field
  may hold a `${var:NAME}` reference (per-instance secret selection) but not
  one with a `:-default`, since the default text would be a literal secret in
  the stored config. Vars are stored and shown as written, so never put secret
  values in them. Before activating a version,
  `POST /agents/{name}/deployments` with `{"version": "vN", "dryRun": true}`
  reports, per instance, which references would still lack a value.

  Typed `runtime` knobs (`maxTurns`, `maxSteps`, `instanceBudgetUsd`,
  `maxParallelToolCalls`, `toolResultMaxBytes`, `reasoning.enabled`,
  `reasoning.budgetTokens`) may hold a **whole-value** reference —
  `enabled: "${var:REASONING}"` deploys fine, and the runtime substitutes
  type-aware per instance at turn boundaries (`"true"` → boolean, `"16384"` →
  number) and re-validates the field's real type there; a whole-value default
  (`enabled: "${var:REASONING:-false}"`) substitutes the same way. In the
  `model` and `runtime` blocks references fail fast: a var with no value from
  any layer, or a value of the wrong type, fails the turn before any model call
  is made. A reference embedded in a longer string does not qualify as
  whole-value, and `deploymentTracking` (a session-shape enum) never takes
  references.

- **`runtime.instanceBudgetUsd`** — spend ceiling per instance. Once the
  total cost across ALL sessions of an instance reaches the ceiling, new
  turns are refused with `budget_exceeded` (the session stays healthy and
  resumes once the budget is raised). Enforced with one-turn lag: the budget is
  checked when a turn starts, so a turn that starts under budget may finish
  over it.

## Channels

The optional top-level `channels:` array connects the agent to outside
services, such as a Slack app or a Telegram bot, when the version goes live (on
deploy or promote). Each entry creates or updates one connection and binds it to
the agent; deploying again updates the same connection instead of making a new
one. Declarations are additive to the HTTP channel API.

```yaml
channels:
  - type: managed_ws
    plugin: "@parel/channel-slack-socket"
    config:
      appToken: ${SLACK_APP_TOKEN}
      botToken: ${SLACK_BOT_TOKEN}
    routing:
      mode: per_subject
    instance: customer-a
```

| Field | Meaning |
| --- | --- |
| `type` | Required. `webhook` (the service calls PAREL) or `managed_ws` (PAREL keeps a WebSocket open to the service). |
| `plugin` | Required. The connector package: `@parel/channel-slack-socket` (`managed_ws`; `appToken`, `botToken`) or `@parel/channel-telegram` (`webhook`; `botToken`, `webhookSecret`). |
| `version` | Semver range for the connector, fixed at deploy. |
| `name` | Tells two entries with the same `type` and `plugin` apart. |
| `config` | Connector settings. Top-level values may be `${NAME}` references to workspace secrets. |
| `start` | `managed_ws` only: open the connection at deploy. Default `true`. |
| `routing.mode` | How conversations map to sessions: `main` (default), `per_subject`, `per_actor`, or `isolated`. Every split shares the same agent instance. |
| `routing.injectInFlight` | `true`: events arriving for the running turn's exact `(connection, subject)` group join that turn at the next step boundary instead of waiting for the turn to end; different-subject events stay queued even when they resolve to the same session. Default `false`. |
| `instance` | The instance the binding's conversations run in (default `main`). They share that instance's state — its sandbox, its memory — and follow its version tracking (a pinned instance holds its conversations at the pin). |
| `observe` | Agent events to push to the connector: `turn` (turn lifecycle), `steps` (reasoning / tool call / tool result trace), `pause` (execution pauses). Default none. |
| `childSessions` | `true`: the connector may spawn child sessions (`context: "fork" \| "fresh"`, fork by default) off the binding's main conversation. Requires `routing.mode: main`. Default `false`. |

- Channel secrets must already be stored for the workspace: run
  `parel secrets set SLACK_APP_TOKEN` (and the others) before deploying, because
  `parel deploy` does not upload values for `channels`. A `webhook` connection
  also needs `config.webhookSecret` set to a reference to a workspace secret; it
  is used to check incoming requests.
- If a channel cannot be set up, the deploy still succeeds; the result for each
  channel is in the deploy response (`parel deploy --json`).
- Declared channels are re-asserted every time a version goes live: the
  binding's capability bits are reset to the declared values, overwriting any
  interim API updates (`PATCH /channels/bindings/{bindingId}`) — the agent
  config is the source of truth for declarative bindings.
- An always-on `managed_ws` connection needs the Hobby or Pro plan.

## Runtime Controls

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxSteps` | integer ≥ 0 | 200 | Steps per turn (a step is one model call plus the tool calls it makes). When reached, the turn ends with a `turn_limit` error. |
| `maxTurns` | integer ≥ 0 | no limit | Turns per session. When reached, the session is marked completed and new messages are refused. |
| `maxParallelToolCalls` | integer ≥ 1 | 8 | How many tool calls from one step may run at the same time, when every tool in a batch declares itself parallel-safe. |
| `toolResultMaxBytes` | integer ≥ 1 | 65536 | Bounds model-visible, streamed, and persisted tool result text after tool redaction hooks have run. Full outputs should be stored in plugin-owned workspace or sandbox paths and returned as refs. |
| `instanceBudgetUsd` | number > 0 | no limit | Spend ceiling per instance (see above). |
| `deploymentTracking` | `live` \| `pinned` | `live` | How sessions follow new versions (below). |
| `reasoning.enabled` | boolean | `false` | Request provider reasoning when supported. |
| `reasoning.budgetTokens` | integer ≥ 1 | — | Reasoning budget in tokens. |

`runtime.reasoning` requests provider reasoning when supported. Providers differ
in whether they expose text, summaries, signatures, or opaque replay artifacts.
PAREL normalizes all exposed reasoning into `reasoning` message parts.

`runtime.deploymentTracking` controls how a session relates to the agent's
deployments after the session is created. `live` (the default) makes in-flight
sessions adopt the active deployment's config and frozen plugin lock at turn
boundaries — a redeploy reaches existing sessions from their next turn on, and
each turn records the agent version it executed with. `pinned` keeps the
creation-time snapshot for the session's whole life; use it for reproducible
runs (evals, experiments). Sessions created by forking, branching, or replaying
are always pinned regardless of this setting, since their meaning is "this
exact configuration". Plugin versions never change mid-turn in either mode.

`runtime.checkpointInterval` is no longer used: the runtime ignores it, and the
schema marks it deprecated. Remove it from configs.
