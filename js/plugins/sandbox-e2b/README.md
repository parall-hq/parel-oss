# @parel/sandbox-e2b

> PAREL sandbox plugin for E2B code interpreter execution.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/sandbox-e2b
```

## Usage

Runs agent commands inside an [E2B](https://e2b.dev) code-interpreter sandbox.
Provide your E2B API key through the plugin's `apiKey` config; without it the
plugin logs a warning and skips sandbox creation. `template` and `timeout` are
optional.

The plugin keeps its existing `bash`, `file_read`, and `file_write` tools and
legacy `"filesystem"` / `"exec"` capabilities, and also provides the standard
`parel.sandbox` capability from `@parel/capability-sandbox`.

```yaml
plugins:
  - plugin: sandbox-e2b
    config:
      apiKey: <your E2B API key> # from https://e2b.dev
      template: base
      timeout: 300000
```

## Persistence (filesystem survives across turns)

By default the sandbox is **killed** when `timeout` elapses — the next turn
starts from a fresh filesystem. Set `persistence: true` to auto-**pause**
instead: the filesystem is snapshotted, the plugin's stored sandbox id
transparently resumes it on the next session resume, and `timeout` becomes
"idle time before pause" rather than time-to-death.

```yaml
plugins:
  - plugin: sandbox-e2b
    config:
      apiKey: <your E2B API key>
      persistence: true
      # keepMemory: true   # also snapshot memory (warm ~1s resume, larger
                           # snapshot); default false = filesystem-only
                           # (resume cold-boots from disk in a few seconds,
                           # running processes are not restored)
```

Notes:

- E2B retains paused snapshots **indefinitely** and they count against your
  storage quota — storage accrues until the sandbox is explicitly killed
  (the plugin kills it on session end; garbage-collect abandoned sessions).
- Requires an E2B account with sandbox persistence available (e2b JS SDK ≥ 2.x
  API surface; this plugin ships with `@e2b/code-interpreter` ^2.6).

## License

MIT — see [LICENSE](./LICENSE).
