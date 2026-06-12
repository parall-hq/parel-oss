# Runtime Plugin Protocol

Runtime plugins extend session behavior with hooks, tools, capabilities, state, inputs, and policy.

Model providers are a separate extension point and must not be implemented as normal runtime plugins.

Manifest schema: [../schemas/plugin-manifest.schema.json](../schemas/plugin-manifest.schema.json).

Static plugin metadata may be shipped as `parel.plugin.json` at the published
package root. Runtime provisioning reads this file best-effort at the frozen
package version to surface required plugin secrets and execution/snapshot
metadata without loading the plugin code. The runtime lock remains authoritative
for package name, version, and integrity.

## Plugin Shape

```ts
import { definePlugin, LifecycleEvent } from "@parel/plugin-sdk";

export default definePlugin({
  name: "@example/my-plugin",
  version: "0.1.0",
  async setup(ctx) {
    ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => {
      return {
        action: "continue",
        mutations: {
          system: hookCtx.system ? `${hookCtx.system}\n\nBe concise.` : "Be concise.",
        },
      };
    });
  },
});
```

## Context Capabilities

Plugins receive a `PluginContext` with:

| Field | Purpose |
| --- | --- |
| `config` | User-provided plugin config. |
| `store` | Plugin-scoped session store. |
| `inputs` | Session input queue for steering and interrupts. |
| `log` | Plugin logger. |
| `model` | Access to the configured model gateway. |
| `hook` | Register lifecycle hooks. |
| `tool` | Register tools callable by the model. |
| `provide` / `require` | Capability registry. |
| `interrupt` | Request session interruption. |

## Execution Control

Hosts that support execution snapshots, breakpoints, branch, and replay provide
the `parel.execution` capability. Plugins can obtain it with
`ctx.require(PAREL_EXECUTION_CONTROL_CAPABILITY)` and use the public
`ExecutionControl` contract to capture snapshots, set or clear pause policies,
resume/cancel pauses, branch/replay from a snapshot, or ask the host to check a
live pause boundary with `checkPause`.

`checkPause` is for live breakpoint-style boundaries. Current live anchors are
`step_start`, `before_model`, `after_model`, `before_tool`, and `after_tool`.
Snapshot-only anchors such as `turn_start`, `turn_end`, and `manual` can still be
used with `captureSnapshot`.

Plugins should also ship a root `parel.plugin.json` with an `execution.snapshot`
policy so hosts know how to handle plugin state and side effects when creating
snapshots, branches, and replays:

```json
{
  "name": "@example/plugin",
  "version": "0.1.0",
  "execution": {
    "snapshot": {
      "store": "copy",
      "sandbox": "reset",
      "sideEffects": "require_approval"
    }
  }
}
```

Use `store: "copy"` only for state that is safe to materialize into a branch.
Use `store: "reset"` for stateless plugins or state that points to live external
resources. Use `sideEffects: "require_approval"` or `"deny_replay"` when replaying
the plugin could duplicate external actions.

## Lifecycle Events

| Event | Purpose |
| --- | --- |
| `session:start` | Session initialized. |
| `session:resume` | The runtime resumes session work. |
| `session:suspend` | The runtime is about to suspend session work. |
| `session:end` | Session teardown. |
| `turn:start` | New user turn starts. |
| `turn:end` | Turn finalizes. |
| `step:start` | Model/tool loop step starts. |
| `context:build` | Mutate system prompt or context messages. |
| `model:before` | Inspect or mutate model call params. |
| `model:after` | Inspect model response. |
| `tool:before` | Inspect, mutate, block, or suspend tool call. |
| `tool:after` | Inspect or mutate tool result. |
| `step:end` | Step finalizes. |
| `checkpoint` | Checkpoint created. |
| `error` | Runtime error observed. |

## Hook Actions

Hooks may continue, skip, block, suspend, or stop. Blocking and stopping must include a human-readable reason.

Hooks that support mutations return `action: "continue"` plus a `mutations` object.

## Static Metadata

`requires.secrets` declares which plugin config fields are secrets — their
nature, not their source. For example, `@parel/sandbox-e2b` declares that its
`apiKey` config field is a required secret. Hosts use the declaration to
reject literal values in those fields at deploy time, to prompt for missing
bindings (with the declared `description`), and to redact the fields from
logs and snapshots.

Values are bound by *secret references* in the agent config: a config string
that is exactly `${NAME}` (uppercase env-var style, whole-value match — no
interpolation) names an org- or agent-scoped secret stored by the host. The
host substitutes references when a session starts; plugins receive plain
resolved config values and never know the source. The reference form is what
appears in stored configs and read-scope API responses; secret values never do.

`execution.snapshot` describes how a plugin expects store, sandbox, and
side-effect state to behave across branch/snapshot/replay flows. These fields are
metadata for the host and do not grant capabilities by themselves.

## Security Boundary

Runtime plugins run inside the runtime environment chosen by the host. They are not model providers, account providers, billing integrations, or database migrations. Hosts may restrict third-party plugin installation in production.
