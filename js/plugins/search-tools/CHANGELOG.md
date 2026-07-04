# @parel/search-tools

## 0.1.9

### Patch Changes

- Updated dependencies [81d25db]
  - @parel/plugin-sdk@0.9.0
  - @parel/workspace@0.1.9

## 0.1.8

### Patch Changes

- Updated dependencies [73afdb1]
  - @parel/plugin-sdk@0.8.0
  - @parel/workspace@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/plugin-sdk@0.7.0
  - @parel/workspace@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/plugin-sdk@0.6.0
  - @parel/workspace@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [095391b]
  - @parel/plugin-sdk@0.5.0
  - @parel/workspace@0.1.5

## 0.1.4

### Patch Changes

- @parel/plugin-sdk@0.4.2
- @parel/workspace@0.1.4

## 0.1.3

### Patch Changes

- @parel/plugin-sdk@0.4.1
- @parel/workspace@0.1.3

## 0.1.2

### Patch Changes

- c3d6746: Add the missing `parel.plugin.json` manifests (and ship them in the published
  package) so the coding agent plugin suite can be deployed as local plugin
  artifacts and declares its capability requirements and snapshot policies.
- Updated dependencies [c3d6746]
  - @parel/workspace@0.1.2

## 0.1.1

### Patch Changes

- 429a42d: Add the public contracts and first-party plugin set needed to run a coding agent on PAREL.

  Core and plugin-sdk now expose runtime-owned tool invocation identity, structured tool outputs, tool scheduling metadata, prompt-cache metadata, and deploy-time plugin `version` / `source` fields in the public agent config contract. The sandbox capability contract is published as `@parel/capability-sandbox` so sandbox providers can share a standard `parel.sandbox` interface.

  The first-party coding plugin bundle adds workspace, filesystem, search, edit, git, shell, background process, port, approval, and coding agent profile plugins. The E2B sandbox plugin now exposes process and port capabilities, subagent consumes unified async callbacks, and security-basic covers the new shell/process tool names.

  The E2B sandbox package also ships `parel.plugin.json` metadata so runtime freeze can discover its required `apiKey` secret from the published package.

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0
  - @parel/workspace@0.1.1
