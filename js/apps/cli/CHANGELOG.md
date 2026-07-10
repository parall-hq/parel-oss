# @parel/cli

## 0.5.0

### Minor Changes

- 2282a07: Migrate the CLI off the deprecated agent/session routes onto the resource-shaped API (available in production v0.8.0).

  - Deploy (`run`, `deploy`, `agents update`) now uses `POST /agents/:name/versions` — a single-shot upload that activates by default, equivalent to the old `POST /agents`; `deploy --no-activate` continues to stage via `?activate=false`. `run` and `deploy` now require `agent.name` in the config to address the version (matching the pre-existing `--no-activate` behavior).
  - Session creation (`send`, `run`, `chat`, `sessions create`) now uses the top-level `POST /sessions` with the agent reference in the request body.

  User-visible output is unchanged.

## 0.4.0

### Minor Changes

- 0046e27: Instance-era command surface: stage, try, promote, and manage agent instances.

  - `parel deploy <file> --no-activate` uploads a new version via the resource-shaped `POST /agents/:name/versions` and stages it (not live); the output prints the version handle plus `try`/`promote` next steps. Without the flag, `deploy` is unchanged (still the existing endpoint). A brand-new agent's first version is always live.
  - `parel try <agent> [--version vN] -m "text"` runs one throwaway (ephemeral) turn and prints the reply — a version pin runs on an ephemeral instance so a try can never touch a named entity's state. Requires `-m`; use `parel chat` for interactive.
  - `parel promote <agent> --version vN` sets the live deployment (promote forward or roll back). `parel rollback` is unchanged and equivalent to promoting an older version.
  - `parel instances list|pin|unpin|reset|delete <agent> [key]` manages the entity layer: pin an instance to a version, return it to tracking live, wipe its entity state (keeping sessions), or delete it (with a friendly hint when active sessions still hold it).
  - `parel sessions create <agent> --instance <key>` targets a named instance via the top-level `POST /sessions`.

### Patch Changes

- Updated dependencies [0046e27]
  - @parel/core@0.14.0

## 0.3.3

### Patch Changes

- Updated dependencies [25352cf]
- Updated dependencies [45d8e5d]
  - @parel/core@0.13.0

## 0.3.2

### Patch Changes

- Updated dependencies [3eedc5e]
  - @parel/core@0.12.0

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
