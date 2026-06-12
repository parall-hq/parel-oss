# Contract Versioning

PAREL public contracts are versioned separately from hosted runtime deploys.

## Schema IDs

Schemas use stable `$id` URLs:

```text
https://schemas.parel.sh/v1/<name>.schema.json
```

The `v1` namespace is the compatibility boundary.

## Compatible Changes

Within a major contract version, these are compatible:

- Adding optional fields.
- Adding enum values when clients are expected to ignore unknown values.
- Adding new WebSocket event types when `turn_end` semantics remain unchanged.
- Adding new HTTP endpoints.
- Adding new plugin hooks that do not change existing hook behavior.

## Breaking Changes

These require a new major contract version:

- Removing or renaming fields.
- Changing field meaning.
- Changing required fields.
- Changing WebSocket terminal event semantics.
- Changing `agent.yaml` plugin or model provider resolution.
- Changing message part meaning or replay semantics.

## Package Versions

Language packages use semver. Packages may release more often than protocol versions.

Examples:

- `@parel/core@0.2.0` may still implement protocol `v1`.
- `@parel/cli@0.3.0` may add commands without changing protocol `v1`.

## Compatibility Rule

The hosted runtime should accept the current major contract version and, when feasible, the previous major version during migration windows.

