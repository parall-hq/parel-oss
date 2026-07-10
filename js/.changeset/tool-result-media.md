---
"@parel/core": minor
"@parel/plugin-sdk": minor
"@parel/capability-sandbox": minor
"@parel/filesystem-tools": minor
"@parel/sandbox-e2b": minor
---

Tool-result media (multimodal tool-result leg): tools can return inline base64 media via `ToolOutput.media`; it flows to `ToolResult.media` (hooks) and `ToolResultPart.media` (transcript), rendered natively by providers that support media in tool results. `ModelCapabilities.documents` declares PDF input support. `SandboxFilesystemView.readFile` forwards `SandboxReadFileOptions` (e2b implements binary-safe base64 reads); `workspace_read_file` returns image files (png/jpg/gif/webp, ≤1MiB) as attached media with magic-byte self-checks.
