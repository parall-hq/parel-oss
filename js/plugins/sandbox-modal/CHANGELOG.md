# @parel/sandbox-modal

## 0.3.1

### Patch Changes

- Updated dependencies [c52c48d]
  - @parel/plugin-sdk@0.11.0
  - @parel/capability-sandbox@0.3.0

## 0.3.0

### Minor Changes

- c76b388: sandbox-vercel/modal/daytona: instance mode — on hosts providing `ctx.instanceStore`, the sandbox belongs to the agent instance instead of a single session, matching `@parel/sandbox-e2b`. Every session of the instance shares one sandbox (authoritative handle in the instance store, all mutations via `cas()` so racing sessions converge on one machine and losers reap their orphans), a conversation ending releases the local handle without killing the shared sandbox (an ephemeral instance still destroys it), and process/port records move to the instance store so sibling sessions see them. Pre-migration per-session sandboxes are migrated on first acquire: promoted to authoritative when the instance has none, reaped as orphans when a sibling's sandbox already holds authority. Capability calls now re-check the authoritative handle so a sibling's swap can't strand a session on a dead machine, and `lifecycle.stop()` destroys the shared sandbox through a versioned `casDelete` retire. An explicitly configured sandbox identity is treated as externally managed and connected directly, without racing/killing/migrating: `sandboxId` for daytona, `sandboxId` or `name` for modal (both documented reconnect paths), and `name` for vercel (whose handle _is_ the name). Hosts without instance storage keep the exact per-session behavior, including `lifecycle.stop()` (which pauses/stops the sandbox per provider rather than deleting it).

### Patch Changes

- @parel/plugin-sdk@0.10.2

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
