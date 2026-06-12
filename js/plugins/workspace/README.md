# @parel/workspace

Canonical workspace capability for PAREL coding agents.

This plugin maps session-scoped workspace config and plugin store state into a
single `workspace` capability. When the workspace identity points at a Git
repository, the plugin can lazily materialize it into the sandbox through the
lower-level `exec` capability and record the materialized root back into its
plugin store.

It also registers:

- `workspace_current`
- `workspace_materialize`
- `workspace_export`

Exports are returned as `sandbox_path` refs. The platform stores durable
session state only; it does not own workspace artifacts or Git semantics.
