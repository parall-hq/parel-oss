# @parel/security-basic

## 0.1.9

### Patch Changes

- @parel/plugin-sdk@0.4.2

## 0.1.8

### Patch Changes

- @parel/plugin-sdk@0.4.1

## 0.1.7

### Patch Changes

- 429a42d: Add the public contracts and first-party plugin set needed to run a coding agent on PAREL.

  Core and plugin-sdk now expose runtime-owned tool invocation identity, structured tool outputs, tool scheduling metadata, prompt-cache metadata, and deploy-time plugin `version` / `source` fields in the public agent config contract. The sandbox capability contract is published as `@parel/capability-sandbox` so sandbox providers can share a standard `parel.sandbox` interface.

  The first-party coding plugin bundle adds workspace, filesystem, search, edit, git, shell, background process, port, approval, and coding agent profile plugins. The E2B sandbox plugin now exposes process and port capabilities, subagent consumes unified async callbacks, and security-basic covers the new shell/process tool names.

  The E2B sandbox package also ships `parel.plugin.json` metadata so runtime freeze can discover its required `apiKey` secret from the published package.

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0

## 0.1.6

### Patch Changes

- Updated dependencies [6945eb2]
  - @parel/plugin-sdk@0.3.0

## 0.1.5

### Patch Changes

- @parel/plugin-sdk@0.2.4

## 0.1.4

### Patch Changes

- @parel/plugin-sdk@0.2.3

## 0.1.3

### Patch Changes

- 5622bac: `definePlugin` no longer requires a `version`: `package.json` is the single source
  of truth, and the SDK fills a placeholder when it is omitted. First-party plugins
  drop their hardcoded (and stale) in-source manifest version so it can no longer
  drift from the published package version.
- Updated dependencies [5622bac]
  - @parel/plugin-sdk@0.2.2

## 0.1.2

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
- Updated dependencies [16e1721]
  - @parel/plugin-sdk@0.2.1

## 0.1.1

### Patch Changes

- Updated dependencies [c85f198]
  - @parel/plugin-sdk@0.2.0

## 0.1.0

### Minor Changes

- 31cc0dd: Reconcile public packages with the production runtime (single source of truth in this repo going forward):

  - `@parel/core`: add optional `provides`/`requires` to the plugin type, used for plugin dependency resolution by the runtime kernel.
  - `@parel/plugin-sdk`: `definePlugin` now passes through `provides`/`requires`.
  - `@parel/security-basic`: replace the simpler command filter with the hardened shell tokenizer/allowlist (defends against substitution/quote/wrapper bypasses) plus secret redaction, with tests. Previously the published package shipped a weaker filter under the same version as the runtime's hardened implementation.

### Patch Changes

- Updated dependencies [31cc0dd]
  - @parel/plugin-sdk@0.1.0

## 0.0.2

### Patch Changes

- Set up release automation and npm package metadata.
- Updated dependencies
  - @parel/plugin-sdk@0.0.2
