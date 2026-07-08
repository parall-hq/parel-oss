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
| `instanceStore` | Instance-scoped store shared across the sessions of one agent instance. Optional — `undefined` on hosts without instance storage. |
| `instance` | Identity of the owning agent instance (`{ key, ephemeral }`). Optional. |
| `inputs` | Session input queue for steering and interrupts. |
| `log` | Plugin logger. |
| `model` | Access to the configured model gateway. |
| `hook` | Register lifecycle hooks. |
| `tool` | Register tools callable by the model. |
| `provide` / `require` | Capability registry. |
| `interrupt` | Request session interruption. |

## Instance-Scoped State

An agent *instance* is the long-lived entity behind one or more sessions: its
sandbox, its long-term memory, its working state. Compute always runs inside a
session; `ctx.instanceStore` is the bucket that outlives any single
conversation. Pick the bucket with one question: **"if the user starts a new
conversation, should this data still be there?"** Yes → `instanceStore`; no →
`store`.

The two buckets differ in more than lifetime:

| | `ctx.store` (session) | `ctx.instanceStore` (instance) |
| --- | --- | --- |
| Lifetime | One conversation | The entity; survives conversation resets |
| Writers | Single writer (turns are serialized per session) | **Multi-writer** — sibling sessions' turns may write concurrently |
| Write pattern | Read-modify-write freely | Prefer `cas()`; plain `set()` is last-write-wins |
| Namespacing | Plugin-named at setup | Plugin-named, always |

Both stores are only injected into the **setup** context; hook and tool
handlers reach them by closure capture:

```ts
export default {
  name: "example-sandbox",
  version: "1.0.0",
  async setup(ctx) {
    const istore = ctx.instanceStore; // capture once
    ctx.hook("turn:start", async () => {
      if (!istore) return; // host has no instance storage: degrade honestly
      const cur = await istore.get("sandbox");
      if (cur) return resume(cur.value.id);
      const sb = await createSandbox();
      const won = await istore.cas("sandbox", null, { id: sb.id });
      if (!won) {
        await sb.kill(); // lost the race: adopt the winner's sandbox
        const winner = await istore.get("sandbox");
        await resume(winner.value.id);
      }
    });
  },
};
```

`cas(key, expectedVersion, value)` writes only if the key's current version
matches (`null` = the key must not exist yet) and returns whether the write
won. Two sessions racing to create one shared resource is the canonical use:
exactly one `cas(key, null, …)` succeeds and the loser re-reads.

Rules of the road:

- **Probe explicitly.** `instanceStore` is `undefined` on hosts that predate
  it. Never fall back to `ctx.store` silently for data you promise to keep
  long-term — degrade visibly instead (e.g. report that long-term memory is
  unavailable).
- **There are no instance lifecycle hooks.** First use initializes
  (`get(...) ?? create`), and an instance reset simply empties the store — on
  the next turn your plugin sees no state and starts fresh, the same self-heal
  path it already needs for expired external resources.
- **`ctx.instance.ephemeral === true`** marks a throwaway instance that dies
  with the session (try-runs, replays). Skip expensive persistence there.
- **State is not shared across plugins.** Each plugin gets its own namespace.
  To expose shared access to a resource (e.g. one sandbox used by several
  plugins), provide a capability via `ctx.provide` instead of sharing keys.

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

### Gating vs. broadcast events

Only `model:before`, `tool:before`, and `step:end` are **gating** events: a
non-continue action takes effect (the model call, tool call, or turn
continuation is blocked/suspended/stopped) and short-circuits the remaining
hooks for that event.

Every other event is a **broadcast**: the runtime delivers it to every
registered hook regardless of what earlier hooks return or throw. A
non-continue action on a broadcast event is ignored (mutations still apply),
and a hook error does not prevent later hooks from running — errors are
collected and surfaced after the full pass. Plugins must not rely on a
broadcast-event action to gate execution, and must tolerate their lifecycle
hooks running even when a sibling plugin's hook failed: events like
`session:resume` exist so each plugin can restore its own state, and one
plugin must not be able to silently disable the others.

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
