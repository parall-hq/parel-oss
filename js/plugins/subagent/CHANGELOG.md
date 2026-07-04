# @parel/subagent

## 0.4.4

### Patch Changes

- Updated dependencies [81d25db]
  - @parel/plugin-sdk@0.9.0

## 0.4.3

### Patch Changes

- Updated dependencies [73afdb1]
  - @parel/plugin-sdk@0.8.0

## 0.4.2

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/plugin-sdk@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/plugin-sdk@0.6.0

## 0.4.0

### Minor Changes

- 095391b: Add an optional `normalize` plugin capability for intake.

  Runtime plugins can register `ctx.normalize(types, handler)` to turn inbound platform inputs (e.g. `async_callback`) into canonical transcript messages at intake, so content is persisted to the transcript SSOT instead of being rendered ephemerally into the model prompt each step. `PluginManifest.provides.normalize` declares the input types a plugin handles, and `@parel/subagent` now registers a normalizer for its `subagent_result` callbacks. The context method is optional and the plugin call is guarded (`ctx.normalize?.(...)`), so plugins built against this SDK keep loading on hosts that predate the capability.

### Patch Changes

- Updated dependencies [095391b]
  - @parel/plugin-sdk@0.5.0

## 0.3.2

### Patch Changes

- @parel/plugin-sdk@0.4.2

## 0.3.1

### Patch Changes

- @parel/plugin-sdk@0.4.1

## 0.3.0

### Minor Changes

- 429a42d: Add the public contracts and first-party plugin set needed to run a coding agent on PAREL.

  Core and plugin-sdk now expose runtime-owned tool invocation identity, structured tool outputs, tool scheduling metadata, prompt-cache metadata, and deploy-time plugin `version` / `source` fields in the public agent config contract. The sandbox capability contract is published as `@parel/capability-sandbox` so sandbox providers can share a standard `parel.sandbox` interface.

  The first-party coding plugin bundle adds workspace, filesystem, search, edit, git, shell, background process, port, approval, and coding agent profile plugins. The E2B sandbox plugin now exposes process and port capabilities, subagent consumes unified async callbacks, and security-basic covers the new shell/process tool names.

  The E2B sandbox package also ships `parel.plugin.json` metadata so runtime freeze can discover its required `apiKey` secret from the published package.

### Patch Changes

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0

## 0.2.3

### Patch Changes

- 6945eb2: Read subagent completions from platform-level async_callback inputs while keeping legacy subagent_result compatibility.
- Updated dependencies [6945eb2]
  - @parel/plugin-sdk@0.3.0

## 0.2.2

### Patch Changes

- @parel/plugin-sdk@0.2.4

## 0.2.1

### Patch Changes

- @parel/plugin-sdk@0.2.3

## 0.2.0

### Minor Changes

- 5622bac: Add `subagent_status`, `subagent_cancel`, and `subagent_signal` tools so an agent
  can inspect, cancel, and redirect the async subagents it spawned, via the host
  `parel.runtime` capability (`getChild`/`cancelChild`/`signalChild`). Without that
  capability they return a clear error instead of silently doing nothing.

### Patch Changes

- Updated dependencies [5622bac]
  - @parel/plugin-sdk@0.2.2

## 0.1.1

### Patch Changes

- 16e1721: Ship a README and LICENSE inside every published package tarball so npm package
  pages render documentation and the MIT license travels with the package.
- Updated dependencies [16e1721]
  - @parel/plugin-sdk@0.2.1

## 0.1.0

### Minor Changes

- c85f198: Add the async-subagent runtime substrate contract and the `@parel/subagent` plugin.

  - **@parel/core**: new `RuntimeControl` host capability (`startChildSession` / `getChild` / `cancelChild` / `signalChild`) plus the `ChildInvocation` / `ChildPolicy` / `StartChildSessionOptions` / `ChildSessionHandle` types and the `PAREL_RUNTIME_CAPABILITY` constant. Type-only — the host runtime provides the implementation and plugins consume it via `ctx.require(PAREL_RUNTIME_CAPABILITY)`.
  - **@parel/plugin-sdk**: re-export the new runtime types and the `PAREL_RUNTIME_CAPABILITY` constant.
  - **@parel/subagent**: new plugin that delegates work to subagents — synchronous inline delegation via `ctx.model`, plus asynchronous background spawning when the runtime provides `parel.runtime` (falls back to sync when it does not). Renders completed child results delivered as `subagent_result` inputs into `<subagent_notification>` context.

### Patch Changes

- Updated dependencies [c85f198]
  - @parel/plugin-sdk@0.2.0
