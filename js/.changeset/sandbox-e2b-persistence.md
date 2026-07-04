---
"@parel/sandbox-e2b": minor
---

Opt-in sandbox persistence: `persistence: true` auto-pauses the sandbox on
timeout instead of killing it, so the filesystem survives across turns and
sessions; the stored sandbox id transparently resumes on reconnect. Optional
`keepMemory: true` also snapshots memory for warm resumes (default is a
filesystem-only snapshot that cold-boots on resume). Upgrades
`@e2b/code-interpreter` to ^2.6.1 (e2b SDK 2.x) for the lifecycle API.
