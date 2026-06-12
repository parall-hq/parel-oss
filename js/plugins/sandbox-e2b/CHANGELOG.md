# @parel/sandbox-e2b

## 0.1.3

### Patch Changes

- @parel/plugin-sdk@0.4.2

## 0.1.2

### Patch Changes

- @parel/plugin-sdk@0.4.1

## 0.1.1

### Patch Changes

- Updated dependencies [c3d6746]
  - @parel/capability-sandbox@0.2.0

## 0.1.0

### Minor Changes

- 429a42d: Add the public contracts and first-party plugin set needed to run a coding agent on PAREL.

  Core and plugin-sdk now expose runtime-owned tool invocation identity, structured tool outputs, tool scheduling metadata, prompt-cache metadata, and deploy-time plugin `version` / `source` fields in the public agent config contract. The sandbox capability contract is published as `@parel/capability-sandbox` so sandbox providers can share a standard `parel.sandbox` interface.

  The first-party coding plugin bundle adds workspace, filesystem, search, edit, git, shell, background process, port, approval, and coding agent profile plugins. The E2B sandbox plugin now exposes process and port capabilities, subagent consumes unified async callbacks, and security-basic covers the new shell/process tool names.

  The E2B sandbox package also ships `parel.plugin.json` metadata so runtime freeze can discover its required `apiKey` secret from the published package.

### Patch Changes

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0
  - @parel/capability-sandbox@0.1.1

## 0.0.10

### Patch Changes

- d2a0a3a: Add first-party sandbox provider plugins for Daytona, Vercel Sandbox, Modal, and
  Cloudflare Sandbox, and make E2B provide the shared `parel.sandbox` capability.
- Updated dependencies [6945eb2]
- Updated dependencies [d2a0a3a]
  - @parel/plugin-sdk@0.3.0
  - @parel/capability-sandbox@0.1.0

## 0.0.9

### Patch Changes

- a9a6aee: Ship a static plugin manifest at the package root (`parel.plugin.json`) declaring the
  secrets the plugin needs. The host reads it from a CDN (jsDelivr) at deploy time —
  without loading the plugin — to drive credential UIs (e.g. auto-render the secret form
  in the console). The plugin also imports it for its runtime `requires`, so the file is
  the single source of truth. No runtime behavior change.

## 0.0.8

### Patch Changes

- 830e31b: feat(core): add `requires.secrets` to the plugin manifest

  Plugins can now declare the credentials the host must inject into their `config`
  at setup time (keyed by config field name, e.g. `apiKey`), with a `description`
  and `required` flag. This lets the host store secrets org-scoped and validate
  required ones before `setup` runs — without hard-coding which plugins need which
  keys.

  `@parel/sandbox-e2b` declares its `apiKey` requirement, so the host no longer
  needs to special-case the e2b plugin to inject its key.

  - @parel/plugin-sdk@0.2.4

## 0.0.7

### Patch Changes

- @parel/plugin-sdk@0.2.3

## 0.0.6

### Patch Changes

- 5622bac: `definePlugin` no longer requires a `version`: `package.json` is the single source
  of truth, and the SDK fills a placeholder when it is omitted. First-party plugins
  drop their hardcoded (and stale) in-source manifest version so it can no longer
  drift from the published package version.
- Updated dependencies [5622bac]
  - @parel/plugin-sdk@0.2.2

## 0.0.5

### Patch Changes

- 16e1721: Ship a README and LICENSE inside every published package tarball so npm package
  pages render documentation and the MIT license travels with the package.
- Updated dependencies [16e1721]
  - @parel/plugin-sdk@0.2.1

## 0.0.4

### Patch Changes

- Updated dependencies [c85f198]
  - @parel/plugin-sdk@0.2.0

## 0.0.3

### Patch Changes

- Updated dependencies [31cc0dd]
  - @parel/plugin-sdk@0.1.0

## 0.0.2

### Patch Changes

- Set up release automation and npm package metadata.
- Updated dependencies
  - @parel/plugin-sdk@0.0.2
