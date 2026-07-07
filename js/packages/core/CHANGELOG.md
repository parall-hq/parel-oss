# @parel/core

## 0.13.0

### Minor Changes

- 25352cf: `InstanceStore.casDelete?(key, expectedVersion)` — compare-and-delete for retiring shared resource handles. An unconditional `delete()` can erase a sibling session's just-swapped-in replacement handle without killing the resource it points at; `casDelete` makes the retire race explicit. Optional: probe and fall back to `delete()` on hosts that predate it.
- 45d8e5d: Add instance-scoped plugin state contract: `InstanceStore` (versioned get/set/delete/list + `cas`), `InstanceStoreEntry`, `InstanceInfo`, and optional `PluginContext.instanceStore` / `PluginContext.instance`. The instance bucket is shared across every session of the same agent instance and is multi-writer — prefer `cas()` for read-modify-write. `undefined` on hosts without instance storage: probe explicitly and degrade honestly (hosts never substitute the per-session store).

## 0.12.0

### Minor Changes

- 3eedc5e: `ChannelEnvelope` gains an optional `context` field: per-turn invocation context a channel connector attaches to its emitted envelope, snapshotted at turn start and exposed to consume-gated plugins (e.g. flattened into sandbox per-exec env).

## 0.11.0

### Minor Changes

- 440f4b9: Add per-turn invocation context. `InputQueueItem` gains an optional `context` (opaque, JSON-able, non-transcript metadata carried by the ingress); a new `InvocationContext` type (`{ inputId, turnId, context }`) is exposed on `ToolHandlerContext.invocationContext` (distinct from the existing `ToolHandlerContext.invocation` tool identity). `PluginManifest` gains `consumes.invocationContext` so a plugin can opt in to receiving it. All additive and optional. (Hook-context delivery for policy/channel plugins lands later, once host-side gated hook delivery is wired.) See docs/invocation-context.md.

## 0.10.0

### Minor Changes

- 3ee20d4: Add `Message.origin` (`MessageOrigin`: `channel`/`conversationId`/`author`) for multi-speaker / group-chat attribution of channel-sourced messages.

## 0.9.0

### Minor Changes

- 095391b: Add an optional `normalize` plugin capability for intake.

  Runtime plugins can register `ctx.normalize(types, handler)` to turn inbound platform inputs (e.g. `async_callback`) into canonical transcript messages at intake, so content is persisted to the transcript SSOT instead of being rendered ephemerally into the model prompt each step. `PluginManifest.provides.normalize` declares the input types a plugin handles, and `@parel/subagent` now registers a normalizer for its `subagent_result` callbacks. The context method is optional and the plugin call is guarded (`ctx.normalize?.(...)`), so plugins built against this SDK keep loading on hosts that predate the capability.

## 0.8.0

### Minor Changes

- 5f78c93: Add `"ready"` to `SessionStatus`: idle between turns, accepting input. A
  cleanly finished turn now parks the session at `ready` instead of leaving it
  `running` (which staleness reapers then killed as `timeout`); `suspended`
  keeps its existing meaning of parked mid-turn awaiting external input.
  Mirrored in the websocket-event schema enum.

## 0.7.0

### Minor Changes

- f61ecc8: Secret references: agent configs bind secrets with `${NAME}` placeholders.

  - `@parel/core`: new `secret-refs` module — `parseSecretRef`, `collectSecretRefs`,
    `collectAgentSecretRefs`, `resolveSecretRefs`, `formatSecretRef` — the SSOT for
    the whole-value `${NAME}` reference syntax shared by CLI, runtime, and consoles.
  - `@parel/cli`: `parel secrets` command group (org/agent-scoped named values)
    replaces `parel plugin-secrets`; `deploy`/`run`/`agents update` gain secret
    logistics (referenced names upload automatically from the local environment,
    `--secret NAME=value` overrides) and send the JSON deploy form with a
    `secrets` sidecar; `capabilities doctor` reports per-reference resolution
    (local env / org store / missing) under schema `parel.capability_doctor.v2`
    and flags literal values in secret-declared fields as deploy-blocking.

## 0.6.0

### Minor Changes

- 429a42d: Add the public contracts and first-party plugin set needed to run a coding agent on PAREL.

  Core and plugin-sdk now expose runtime-owned tool invocation identity, structured tool outputs, tool scheduling metadata, prompt-cache metadata, and deploy-time plugin `version` / `source` fields in the public agent config contract. The sandbox capability contract is published as `@parel/capability-sandbox` so sandbox providers can share a standard `parel.sandbox` interface.

  The first-party coding plugin bundle adds workspace, filesystem, search, edit, git, shell, background process, port, approval, and coding agent profile plugins. The E2B sandbox plugin now exposes process and port capabilities, subagent consumes unified async callbacks, and security-basic covers the new shell/process tool names.

  The E2B sandbox package also ships `parel.plugin.json` metadata so runtime freeze can discover its required `apiKey` secret from the published package.

## 0.5.0

### Minor Changes

- 6945eb2: Add core channel envelope/reply-route protocol types, move connector authoring contracts to plugin-sdk without platform routing config types, remove the unused legacy ChannelAdapter core type, and expose predicate-based InputQueue draining for generic async callbacks.

## 0.4.0

### Minor Changes

- 830e31b: feat(core): add `requires.secrets` to the plugin manifest

  Plugins can now declare the credentials the host must inject into their `config`
  at setup time (keyed by config field name, e.g. `apiKey`), with a `description`
  and `required` flag. This lets the host store secrets org-scoped and validate
  required ones before `setup` runs — without hard-coding which plugins need which
  keys.

  `@parel/sandbox-e2b` declares its `apiKey` requirement, so the host no longer
  needs to special-case the e2b plugin to inject its key.

## 0.3.0

### Minor Changes

- bf352a3: Add an optional `version` (semver range) to the full-form plugin declaration
  (`PluginFullForm`), so a runtime can resolve and freeze an exact plugin version +
  integrity at deploy time. Omitted means "latest at resolution time". Purely
  additive and backwards compatible — `@parel/core` does not resolve it.

## 0.2.1

### Patch Changes

- 5eb50e6: security-basic: close two allowlist bypasses where a command substitution
  supplied the program name. `$(echo rm) -rf /` (substitution in program
  position) and `echo $(( $(nc evil) + 0 ))` (substitution inside arithmetic
  expansion) both ran an arbitrary program while only the inner, allowlisted
  command was inspected. Such substitution-derived programs are now refused in
  allowlist mode, with regression tests.

  cli: send the API credential as a WebSocket subprotocol (`token.<key>`) instead
  of a `?token=` query parameter so it no longer leaks into request URLs or
  access logs.

  core: `PluginManifest.provides` / `requires` are now optional, matching the
  plugin-manifest schema (which no longer marks them required).

- 16e1721: Ship a README and LICENSE inside every published package tarball so npm package
  pages render documentation and the MIT license travels with the package.

## 0.2.0

### Minor Changes

- c85f198: Add the async-subagent runtime substrate contract and the `@parel/subagent` plugin.

  - **@parel/core**: new `RuntimeControl` host capability (`startChildSession` / `getChild` / `cancelChild` / `signalChild`) plus the `ChildInvocation` / `ChildPolicy` / `StartChildSessionOptions` / `ChildSessionHandle` types and the `PAREL_RUNTIME_CAPABILITY` constant. Type-only — the host runtime provides the implementation and plugins consume it via `ctx.require(PAREL_RUNTIME_CAPABILITY)`.
  - **@parel/plugin-sdk**: re-export the new runtime types and the `PAREL_RUNTIME_CAPABILITY` constant.
  - **@parel/subagent**: new plugin that delegates work to subagents — synchronous inline delegation via `ctx.model`, plus asynchronous background spawning when the runtime provides `parel.runtime` (falls back to sync when it does not). Renders completed child results delivered as `subagent_result` inputs into `<subagent_notification>` context.

## 0.1.0

### Minor Changes

- 31cc0dd: Reconcile public packages with the production runtime (single source of truth in this repo going forward):

  - `@parel/core`: add optional `provides`/`requires` to the plugin type, used for plugin dependency resolution by the runtime kernel.
  - `@parel/plugin-sdk`: `definePlugin` now passes through `provides`/`requires`.
  - `@parel/security-basic`: replace the simpler command filter with the hardened shell tokenizer/allowlist (defends against substitution/quote/wrapper bypasses) plus secret redaction, with tests. Previously the published package shipped a weaker filter under the same version as the runtime's hardened implementation.

## 0.0.2

### Patch Changes

- Set up release automation and npm package metadata.
