# @parel/filesystem-tools

Workspace-relative filesystem tools for PAREL coding agents.

The plugin consumes the canonical `workspace` capability plus a lower-level
`filesystem` capability. It keeps paths relative to the workspace root; provider
plugins own the actual filesystem implementation.
