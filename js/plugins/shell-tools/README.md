# @parel/shell-tools

Workspace-rooted shell tools for PAREL coding agents.

The plugin consumes the canonical `workspace` capability plus a lower-level
`exec` capability. It keeps commands rooted in the current workspace; sandbox
provider plugins own the actual process execution implementation.
