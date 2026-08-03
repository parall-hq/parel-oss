---
"@parel/capability-sandbox": minor
"@parel/sandbox-e2b": minor
---

fix(sandbox-e2b): report non-zero shell exits as errors, and stop losing exit codes and output streams

The `bash` tool returned a bare string, so the runtime recorded every result
with `isError ?? false` — `exit 7`, `command not found` (127) and a timed-out
command all persisted as `success`. It now returns a `ToolOutput` whose
`isError` reflects the real exit status.

Two adjacent losses are fixed with it. The old `exitCode !== 0 && stderr`
guard dropped the exit code entirely when a command failed without writing to
stderr (`bash -lc 'exit 7'` came back as empty output, success). And its
stdout/stderr branches were mutually exclusive, so a failure that wrote to
both surfaced only one.

`renderCommandText` / `renderCommandToolOutput` now live in
`@parel/capability-sandbox` and back both surfaces, replacing the two
divergent copies of this logic — the capability view's copy had already fixed
the guard and the mutual exclusion, but sandbox-e2b's inline one never picked
those up, and neither set `isError`.
