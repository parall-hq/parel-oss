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
