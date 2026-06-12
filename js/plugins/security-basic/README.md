# @parel/security-basic

> PAREL plugin for basic command and secret safety checks.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/security-basic
```

## Usage

```yaml
plugins:
  - security-basic
```

It enforces a command allowlist and redacts known secret patterns from tool
output. By default it scans common shell tool names, including `bash`,
`workspace_shell`, and `workspace_start_process`.

> **Scope.** This is a best-effort policy layer, **not** an isolation boundary.
> A program-name allowlist cannot see inside an allowlisted interpreter's
> arguments (e.g. `python -c`, `awk`, `find -exec`), so treat it as a guard
> rail, not a sandbox. For untrusted workloads, run inside a real sandbox.

## License

MIT — see [LICENSE](./LICENSE).
