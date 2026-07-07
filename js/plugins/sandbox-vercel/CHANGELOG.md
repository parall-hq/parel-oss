# @parel/sandbox-vercel

## 0.2.9

### Patch Changes

- Updated dependencies [25352cf]
  - @parel/plugin-sdk@0.10.1

## 0.2.8

### Patch Changes

- Updated dependencies [c838bce]
  - @parel/plugin-sdk@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies [81d25db]
  - @parel/plugin-sdk@0.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [73afdb1]
  - @parel/plugin-sdk@0.8.0

## 0.2.5

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/plugin-sdk@0.7.0

## 0.2.4

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/plugin-sdk@0.6.0

## 0.2.3

### Patch Changes

- Updated dependencies [095391b]
  - @parel/plugin-sdk@0.5.0

## 0.2.2

### Patch Changes

- @parel/plugin-sdk@0.4.2

## 0.2.1

### Patch Changes

- @parel/plugin-sdk@0.4.1

## 0.2.0

### Minor Changes

- c3d6746: Add `createSandboxCapabilityViews` to `@parel/capability-sandbox` and provide the
  derived flat capability ids ("filesystem", "exec", "process", "ports") from every
  sandbox provider. Previously only `@parel/sandbox-e2b` exposed these ids, so the
  workspace and \*-tools plugins could not run on the other providers.

### Patch Changes

- Updated dependencies [c3d6746]
  - @parel/capability-sandbox@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [429a42d]
  - @parel/plugin-sdk@0.4.0
  - @parel/capability-sandbox@0.1.1

## 0.1.0

### Minor Changes

- d2a0a3a: Add first-party sandbox provider plugins for Daytona, Vercel Sandbox, Modal, and
  Cloudflare Sandbox, and make E2B provide the shared `parel.sandbox` capability.

### Patch Changes

- Updated dependencies [6945eb2]
- Updated dependencies [d2a0a3a]
  - @parel/plugin-sdk@0.3.0
  - @parel/capability-sandbox@0.1.0

## 0.0.0

Initial package placeholder. Published versions are prepared through Changesets.
