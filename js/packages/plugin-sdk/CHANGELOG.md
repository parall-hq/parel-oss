# @parel/plugin-sdk

## 0.10.0

### Minor Changes

- c838bce: Add the `resolvePause` connector effect: the human-in-the-loop decision backflow for the `execution_paused` agent event. A connector returns `{ type: "resolvePause", pauseId, approve, comment? }` from any hook (typically `onMessage`/`onWebhook` after an external approval); the platform executes it with host-side authorization — the connector never holds platform credentials. Ships together with the platform's `execution_paused` emission and step-trace (`observe: [steps]`) events.

## 0.9.0

### Minor Changes

- 81d25db: Add the `onAgentEvent` connector hook with the `AgentEvent` union and `AgentEventEffect` return type: opt-in, best-effort agent execution events (turn lifecycle now; step-trace and execution-pause events contract-reserved) pushed to channel connectors for turns their envelopes triggered. `AgentEventEffect` excludes `emitEvent` at the type level (self-trigger guard); the platform also drops any `emitEvent` arriving at runtime.

## 0.8.0

### Minor Changes

- 73afdb1: Add channel connector authoring surface: `ConnectorContext.store` (a durable per-connection key-value store the platform persists across reconnect/eviction — use it for protocol state such as a resume cursor) and the `defineChannelConnector` identity helper for type-checked connector authoring. A connector package's default export is the `ChannelConnector`; declare `type: "channel"` plus `channel.connectionTypes` / `channel.sources` in `parel.plugin.json`.

### Patch Changes

- Updated dependencies [3eedc5e]
  - @parel/core@0.12.0

## 0.7.0

### Minor Changes

- 440f4b9: Re-export the new `InvocationContext` type and thread the manifest `consumes` declaration through `definePlugin`, so plugins can declare `consumes.invocationContext` and read `ctx.invocationContext` on their tool/hook contexts.

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/core@0.11.0

## 0.6.0

### Minor Changes

- 3ee20d4: Add `Message.origin` (`MessageOrigin`: `channel`/`conversationId`/`author`) for multi-speaker / group-chat attribution of channel-sourced messages.

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/core@0.10.0

## 0.5.0

### Minor Changes

- 095391b: Add an optional `normalize` plugin capability for intake.

  Runtime plugins can register `ctx.normalize(types, handler)` to turn inbound platform inputs (e.g. `async_callback`) into canonical transcript messages at intake, so content is persisted to the transcript SSOT instead of being rendered ephemerally into the model prompt each step. `PluginManifest.provides.normalize` declares the input types a plugin handles, and `@parel/subagent` now registers a normalizer for its `subagent_result` callbacks. The context method is optional and the plugin call is guarded (`ctx.normalize?.(...)`), so plugins built against this SDK keep loading on hosts that predate the capability.

### Patch Changes

- Updated dependencies [095391b]
  - @parel/core@0.9.0

## 0.4.2

### Patch Changes

- Updated dependencies [5f78c93]
  - @parel/core@0.8.0

## 0.4.1

### Patch Changes

- Updated dependencies [f61ecc8]
  - @parel/core@0.7.0

## 0.4.0

### Minor Changes

- 429a42d: Add the public contracts and first-party plugin set needed to run a coding agent on PAREL.

  Core and plugin-sdk now expose runtime-owned tool invocation identity, structured tool outputs, tool scheduling metadata, prompt-cache metadata, and deploy-time plugin `version` / `source` fields in the public agent config contract. The sandbox capability contract is published as `@parel/capability-sandbox` so sandbox providers can share a standard `parel.sandbox` interface.

  The first-party coding plugin bundle adds workspace, filesystem, search, edit, git, shell, background process, port, approval, and coding agent profile plugins. The E2B sandbox plugin now exposes process and port capabilities, subagent consumes unified async callbacks, and security-basic covers the new shell/process tool names.

  The E2B sandbox package also ships `parel.plugin.json` metadata so runtime freeze can discover its required `apiKey` secret from the published package.

### Patch Changes

- Updated dependencies [429a42d]
  - @parel/core@0.6.0

## 0.3.0

### Minor Changes

- 6945eb2: Add core channel envelope/reply-route protocol types, move connector authoring contracts to plugin-sdk without platform routing config types, remove the unused legacy ChannelAdapter core type, and expose predicate-based InputQueue draining for generic async callbacks.

### Patch Changes

- Updated dependencies [6945eb2]
  - @parel/core@0.5.0

## 0.2.4

### Patch Changes

- Updated dependencies [830e31b]
  - @parel/core@0.4.0

## 0.2.3

### Patch Changes

- Updated dependencies [bf352a3]
  - @parel/core@0.3.0

## 0.2.2

### Patch Changes

- 5622bac: `definePlugin` no longer requires a `version`: `package.json` is the single source
  of truth, and the SDK fills a placeholder when it is omitted. First-party plugins
  drop their hardcoded (and stale) in-source manifest version so it can no longer
  drift from the published package version.

## 0.2.1

### Patch Changes

- 16e1721: Ship a README and LICENSE inside every published package tarball so npm package
  pages render documentation and the MIT license travels with the package.
- Updated dependencies [5eb50e6]
- Updated dependencies [16e1721]
  - @parel/core@0.2.1

## 0.2.0

### Minor Changes

- c85f198: Add the async-subagent runtime substrate contract and the `@parel/subagent` plugin.

  - **@parel/core**: new `RuntimeControl` host capability (`startChildSession` / `getChild` / `cancelChild` / `signalChild`) plus the `ChildInvocation` / `ChildPolicy` / `StartChildSessionOptions` / `ChildSessionHandle` types and the `PAREL_RUNTIME_CAPABILITY` constant. Type-only — the host runtime provides the implementation and plugins consume it via `ctx.require(PAREL_RUNTIME_CAPABILITY)`.
  - **@parel/plugin-sdk**: re-export the new runtime types and the `PAREL_RUNTIME_CAPABILITY` constant.
  - **@parel/subagent**: new plugin that delegates work to subagents — synchronous inline delegation via `ctx.model`, plus asynchronous background spawning when the runtime provides `parel.runtime` (falls back to sync when it does not). Renders completed child results delivered as `subagent_result` inputs into `<subagent_notification>` context.

### Patch Changes

- Updated dependencies [c85f198]
  - @parel/core@0.2.0

## 0.1.0

### Minor Changes

- 31cc0dd: Reconcile public packages with the production runtime (single source of truth in this repo going forward):

  - `@parel/core`: add optional `provides`/`requires` to the plugin type, used for plugin dependency resolution by the runtime kernel.
  - `@parel/plugin-sdk`: `definePlugin` now passes through `provides`/`requires`.
  - `@parel/security-basic`: replace the simpler command filter with the hardened shell tokenizer/allowlist (defends against substitution/quote/wrapper bypasses) plus secret redaction, with tests. Previously the published package shipped a weaker filter under the same version as the runtime's hardened implementation.

### Patch Changes

- Updated dependencies [31cc0dd]
  - @parel/core@0.1.0

## 0.0.2

### Patch Changes

- Set up release automation and npm package metadata.
- Updated dependencies
  - @parel/core@0.0.2
