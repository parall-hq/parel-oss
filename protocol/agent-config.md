# Agent Config Protocol

`agent.yaml` declares the portable public shape of an agent. It is validated by [../schemas/agent-config.schema.json](../schemas/agent-config.schema.json).

## Shape

```yaml
version: "1"
agent:
  name: hello-agent

model:
  provider: anthropic
  model: claude-sonnet-4-20250514

plugins:
  - plugin: system-static
    config:
      prompt: You are concise.
  - sandbox-e2b

runtime:
  maxTurns: 20
  maxSteps: 200
  maxParallelToolCalls: 4
  toolResultMaxBytes: 65536
  checkpointInterval: 10
  reasoning:
    enabled: true
    budgetTokens: 4096
```

## Model Providers

`model` is not a runtime plugin. It selects the model provider layer.

Current public provider aliases:

| Alias | API family |
| --- | --- |
| `anthropic` | Anthropic Messages API |
| `openai` | OpenAI Chat Completions compatible API |
| `openai-responses` | OpenAI Responses API |

Provider-specific options belong under `model.config`.

## Runtime Plugins

`plugins` accepts three forms:

```yaml
plugins:
  - sandbox-e2b
  - system-static:
      prompt: Be concise.
  - plugin: "@scope/third-party-plugin"
    version: "^1.0.0"
    config:
      key: value
  - plugin: ./plugins/internal-tools
    config:
      key: value
  - plugin: "@parel/channel-api"
    version: "^0.1.0"
    config:
      port: 3000
  - plugin: "@myco/internal-tools"
    source:
      type: path
      path: ./plugins/internal-tools
```

Short names resolve to first-party package names by replacing `/` with `-` and prefixing `@parel/`. For example, `sandbox-e2b` resolves to `@parel/sandbox-e2b`.

`version` (full form only) is an optional semver range. A runtime may resolve it to an exact version at deploy time; omitted means the latest at resolution time.

Local plugin paths are deploy-time sources. `plugin: ./plugins/internal-tools`
points at a local plugin directory for CLI deploys; the CLI reads that package's
`package.json` for the plugin identity, packages the directory, uploads an
immutable artifact, and the hosted runtime installs that artifact from the frozen
lock. With no config, `- ./plugins/internal-tools` is also accepted.

The expanded equivalent is:

```yaml
plugins:
  - plugin: "@myco/internal-tools"
    source:
      type: path
      path: ./plugins/internal-tools
```

Hosted API uploads cannot resolve local paths directly; configs with local plugin
paths must be deployed with the CLI.

Model provider packages must not be listed under `plugins`.

## Instance Vars and Budgets

Two per-instance controls compose with the instance layer (agents ×
instances × sessions):

- **Vars** — non-secret per-instance parameters. Set them on an instance
  (`PATCH /agents/:agent/instances/:key` with `{"vars": {"NAME": "value"}}`,
  or `parel instances vars`), reference them anywhere in plugin or model
  config values as `${var:NAME}`. One config, N instances, each with its own
  prompt variables — no config copies. Values hot-update on the next turn for
  live sessions; pinned sessions keep their creation-time snapshot (pinned
  means frozen). In plugin config, unresolved references stay as literals
  (visible, debuggable, never fatal). Secrets keep their own `${NAME}` syntax
  and stores.

  Typed `runtime` knobs (`maxTurns`, `maxSteps`, `instanceBudgetUsd`,
  `maxParallelToolCalls`, `toolResultMaxBytes`, `checkpointInterval`,
  `reasoning.enabled`, `reasoning.budgetTokens`) may hold a **whole-value**
  reference — `enabled: "${var:REASONING}"` deploys fine, and the runtime
  substitutes type-aware per instance at turn boundaries (`"true"` → boolean,
  `"16384"` → number) and re-validates the field's real type there. In the
  `model` and `runtime` blocks references fail fast: an unset var or a value
  of the wrong type fails the turn before any model call is made. A reference
  embedded in a longer string does not qualify as whole-value, and
  `durability` / `deploymentTracking` (session-shape enums) never take
  references.

- **`runtime.instanceBudgetUsd`** — spend ceiling per instance. Once the
  total cost across ALL sessions of an instance reaches the ceiling, new
  turns are refused (the send is blocked with a clear reason; the session
  stays healthy and resumes once the budget is raised or a new deployment
  lowers usage). Enforced with one-turn lag: cost accrues at turn finalize,
  so a turn that starts under budget may finish over it.

## Channels

The optional top-level `channels:` array declares channel connector bindings
provisioned at deploy time — the platform freezes the connector plugin,
creates (or updates) the connection, and binds it to the agent. Declarations
are idempotent across redeploys and additive to the control-plane channel API.

```yaml
channels:
  - type: managed_ws
    plugin: "@parel/channel-slack-socket"
    config:
      appToken: ${SLACK_APP_TOKEN}
    routing:
      mode: per_subject
    instance: customer-a
```

- `routing.mode` splits conversations (`main` | `per_subject` | `per_actor` |
  `isolated`); every split shares the same agent instance.
- `instance` routes the binding's conversations into a named agent instance
  (default `main`): all of the binding's conversations share that instance's
  entity state — its sandbox, its memory — and follow its version tracking
  (a pinned instance holds its conversations at the pin).
- `config` values may be `${SECRET_REF}` references resolved at the org scope.
- `observe` opts the binding into agent-event pushes (`turn`; `steps`/`pause`
  are contract-reserved).

## Runtime Controls

`runtime.maxTurns` limits turns per session.

`runtime.maxSteps` limits model/tool loop steps per turn.

`runtime.maxParallelToolCalls` limits how many tool calls the runtime may execute
concurrently when every tool in a batch declares itself parallel-safe.

`runtime.toolResultMaxBytes` bounds model-visible, streamed, and persisted tool
result text after tool redaction hooks have run. Full outputs should be stored in
plugin-owned workspace or sandbox paths and returned as refs.

`runtime.checkpointInterval` controls internal checkpoint cadence.

`runtime.reasoning` requests provider reasoning when supported. Providers differ in whether they expose text, summaries, signatures, or opaque replay artifacts. PAREL normalizes all exposed reasoning into `reasoning` message parts.

`runtime.deploymentTracking` controls how a session relates to the agent's
deployments after the session is created. `live` (the default) makes in-flight
sessions adopt the active deployment's config and frozen plugin lock at turn
boundaries — a redeploy reaches existing sessions from their next turn on, and
each turn records the agent version it executed with. `pinned` keeps the
creation-time snapshot for the session's whole life; use it for reproducible
runs (evals, experiments). Sessions created by forking, branching, or replaying
are always pinned regardless of this setting, since their meaning is "this
exact configuration". Plugin versions never change mid-turn in either mode.
