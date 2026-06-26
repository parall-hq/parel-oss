# @parel/cli

## 0.3.1

### Patch Changes

- Updated dependencies [440f4b9]
  - @parel/core@0.11.0

## 0.3.0

### Minor Changes

- bc1ee07: Name-based deploy and agent version management. `parel deploy` now upserts by agent name — re-deploying the same `agent.yaml` updates that agent and adds a new version instead of creating a duplicate — and reports the version number. Adds `parel versions list <name>`, `parel deployments list <name>`, `parel rollback <name> [--to vN]`, and `parel agents rename <old> <new>`.

## 0.2.3

### Patch Changes

- Updated dependencies [3ee20d4]
  - @parel/core@0.10.0

## 0.2.2

### Patch Changes

- Updated dependencies [095391b]
  - @parel/core@0.9.0

## 0.2.1

### Patch Changes

- Updated dependencies [5f78c93]
  - @parel/core@0.8.0

## 0.2.0

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

### Patch Changes

- Updated dependencies [f61ecc8]
  - @parel/core@0.7.0

## 0.1.3

### Patch Changes

- 0a3d6fa: Add provider key, plugin secret, and capability readiness commands.

## 0.1.2

### Patch Changes

- 16e1721: Derive `parel --version` from the package version instead of a hardcoded string,
  so the reported version can no longer drift from the published package.
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

## 0.1.1

### Patch Changes

- Set up release automation and npm package metadata.
