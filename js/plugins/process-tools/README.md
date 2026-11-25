# @parel/process-tools

Workspace background process tools for PAREL coding agents.

The plugin consumes the canonical `workspace` capability plus a lower-level
`process` capability supplied by a sandbox provider. Logs are returned as
bounded previews with `sandbox_path` refs.

When the session is stopped (`POST /sessions/{id}/stop`, the `session:stop`
hook), the plugin stops every process the `process` capability lists as
`running` — including a long foreground command the sandbox promoted to the
background. A command the sandbox never registered there keeps running until
its own timeout.
