# PAREL Open Source

**PAREL is a provider-neutral, policy-programmable runtime for long-running AI agents.** You describe an agent in a single `agent.yaml` — pick any model provider, then compose sandbox, memory, tool, policy, and channel plugins — and the runtime runs it. The kernel only dispatches; capabilities come from plugins.

This repository holds the **public** pieces of that ecosystem: the SDKs, first-party plugins, the `parel` CLI, cross-language schemas, and protocol docs. The hosted runtime and control plane live in a separate, private repository.

Sandbox plugins share the public `@parel/capability-sandbox` contract so
consumers can depend on `parel.sandbox` instead of provider-specific APIs. The
provider adapters remain ordinary runtime plugins; the kernel still only
dispatches dynamic capabilities.

The layout is organized for a future multi-language ecosystem. JavaScript and TypeScript packages live under `js/`; future SDKs can be added under language-specific directories such as `python/` or `go/`.

## Contents

- `js/packages/core` - shared public TypeScript contracts.
- `js/packages/plugin-sdk` - helpers for writing PAREL runtime plugins.
- `js/capabilities` - plugin-to-plugin capability contract packages.
- `js/plugins` - first-party runtime plugins.
- `js/apps/cli` - the `parel` CLI.
- `schemas` - cross-language schema definitions.
- `protocol` - HTTP, WebSocket, and runtime protocol notes.
- `examples` - public agent and plugin examples.

## Quickstart

Install the CLI from npm and connect it to a PAREL runtime.

Prerequisites:

- Node.js 22 or newer.
- A PAREL runtime API key. The CLI defaults to `https://api.parel.sh`; for a
  self-hosted or staging runtime, set `PAREL_SERVER=https://...` or pass
  `--server`.
- Credentials for the capabilities your agent uses. The example below uses
  Anthropic and E2B, so export `ANTHROPIC_API_KEY` and `E2B_API_KEY` before
  running the setup commands.

```bash
npm install -g @parel/cli
parel --help
parel login                                             # paste your PAREL API key
parel provider-keys set anthropic --from-env ANTHROPIC_API_KEY
export E2B_API_KEY=e2b_...      # referenced as ${E2B_API_KEY} in agent.yaml; deploy uploads it
parel capabilities doctor ./agent.yaml
parel deploy ./agent.yaml                              # deploy an agent; prints its id
parel chat --agent <id>                                # start an interactive session
```

A minimal agent is described in a single `agent.yaml` — see [`examples/`](examples/):

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
      prompt: You are a concise assistant.
  - plugin: sandbox-e2b
    config:
      apiKey: ${E2B_API_KEY}
```

The full config schema is [`schemas/agent-config.schema.json`](schemas/agent-config.schema.json).
For a coding agent composition, see
[`examples/coding-agent.yaml`](examples/coding-agent.yaml).

## Building from source

```bash
cd js
pnpm install
pnpm build
pnpm test
pnpm lint
```

Packages are authored in TypeScript and published as npm packages.

## Releases

JavaScript package releases are managed with Changesets from the `js/`
workspace. The release process lives in
[CONTRIBUTING.md](CONTRIBUTING.md#releases); the pre-release gate lives in
[`docs/public-release-checklist.md`](docs/public-release-checklist.md).

## Runtime Boundary

Model providers are not runtime plugins. They are selected through PAREL's model provider layer. Runtime plugins provide hooks, tools, capabilities, memory, policy, sandbox, channel, and steering behavior.

The hosted PAREL control plane and runtime implementation live outside this repository.
