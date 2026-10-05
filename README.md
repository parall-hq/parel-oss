# PAREL Open Source

**PAREL is a provider-neutral, policy-programmable serverless runtime for AI agents.** You describe an agent in a single `agent.yaml` — pick any model provider, then compose sandbox, memory, tool, policy, and channel plugins — and deploy it. Agents and sessions are durable cloud objects, not processes you keep alive: an agent can run once, resume later, or keep durable state for as long as it needs. The kernel only dispatches; capabilities come from plugins.

[Website](https://parel.sh) · [Docs](https://parel.sh/docs) · [Console](https://parel.sh/console) · [Get an API key](https://parel.sh/console/settings/api-keys)

> **Bring your own model key.** PAREL holds no model keys and does not resell
> model access. Add your own provider key (Anthropic, OpenAI, OpenRouter, or any
> OpenAI- or Anthropic-compatible endpoint) in the console under
> [Settings → Model providers](https://parel.sh/console/settings/providers), and
> the provider bills you directly. PAREL plans (Free, Hobby, Pro) meter the
> runtime itself by steps; see [pricing](https://parel.sh/pricing).

This repository holds the **public** pieces of that ecosystem: the SDKs, first-party plugins, the `parel` CLI, cross-language schemas, and protocol docs. The PAREL runtime and control plane are a hosted service and are not part of this repository.

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

Install the CLI from npm, log in, add your model key, and deploy.

Prerequisites:

- Node.js 22 or newer.
- A PAREL API key. Sign in to the [console](https://parel.sh/console) and
  create one under [Settings → API keys](https://parel.sh/console/settings/api-keys).
  The default Write scope can deploy and chat; setting a model key from the CLI
  needs an Admin-scope key.
- Your own model provider key. The example below uses Anthropic
  (`ANTHROPIC_API_KEY`) and an E2B sandbox (`E2B_API_KEY`).

```bash
npm install -g @parel/cli
parel login                     # paste your PAREL API key (pk_...)

# Add your model key. This needs an Admin-scope API key; or add the key in the
# console under Settings → Model providers instead.
export ANTHROPIC_API_KEY=sk-ant-...
parel provider-keys set anthropic --from-env ANTHROPIC_API_KEY

export E2B_API_KEY=e2b_...      # referenced as ${E2B_API_KEY} in agent.yaml; deploy uploads it
parel capabilities doctor ./agent.yaml
parel deploy ./agent.yaml       # creates hello-agent v1 and makes it live
parel chat --agent hello-agent  # start an interactive session
```

The CLI talks to `https://api.parel.sh`. A minimal agent is described in a
single `agent.yaml` — see [`examples/`](examples/):

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

Secret values never go in `agent.yaml`: write a `${NAME}` reference, and
`parel deploy` uploads the value from your shell (or store it once with
`parel secrets set NAME`). The full config schema is
[`schemas/agent-config.schema.json`](schemas/agent-config.schema.json), and the
guided reference is <https://parel.sh/docs/config>. For a coding agent
composition, see [`examples/coding-agent.yaml`](examples/coding-agent.yaml).

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

The hosted PAREL control plane and runtime implementation live outside this repository. The public contracts they implement are documented in [`protocol/`](protocol/) and [`schemas/`](schemas/).
