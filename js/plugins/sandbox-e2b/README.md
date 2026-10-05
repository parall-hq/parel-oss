# @parel/sandbox-e2b

> PAREL sandbox plugin for E2B code interpreter execution.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/sandbox-e2b
```

## Usage

Runs agent commands inside an [E2B](https://e2b.dev) code-interpreter sandbox.
The plugin keeps its existing `bash`, `file_read`, and `file_write` tools and
legacy `"filesystem"` / `"exec"` capabilities, and also provides the standard
`parel.sandbox` capability from `@parel/capability-sandbox`.

```yaml
plugins:
  - plugin: sandbox-e2b
    config:
      apiKey: ${E2B_API_KEY}
      template: base
      timeout: 300000
```

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | required | Your E2B API key (e2b.dev → Settings → API Keys), as a `${NAME}` secret reference. |
| `template` | `base` | E2B sandbox template name. |
| `timeout` | `300000` | Sandbox lifetime in milliseconds before it is killed (or paused, with `persistence`). Not a per-command timeout. |
| `commandTimeout` | `120000` | Per-command timeout in milliseconds for foreground commands. A timed-out command returns exit code 124 instead of hanging the turn. |
| `promoteAfterMs` | `0` (off) | When set, a `bash` command still running after this many milliseconds keeps running in the background and the tool returns its process id for the process tools to follow. |
| `env` | none | Environment variables set in the sandbox for every command. |
| `persistence`, `keepMemory` | `false` | Pause instead of kill; see below. |

### Providing the API key

`apiKey` is a declared secret field, so PAREL rejects a plain value there at
deploy time (`secret_literal`) and fails the deploy when it is missing. Write a
`${E2B_API_KEY}` reference as above, then provide the value in one of two ways:

- Export it before deploying. `parel deploy` uploads it, encrypted, for this
  agent only:

  ```bash
  export E2B_API_KEY=e2b_...
  parel deploy ./agent.yaml
  ```

- Or store it once for the whole workspace (needs an Admin-scope API key):
  `parel secrets set E2B_API_KEY`. You can also add it in the console under
  Settings → Secrets.

The value never lands in `agent.yaml`, in the stored config, or in API
responses.

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
      apiKey: ${E2B_API_KEY}
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

### Fail-closed reconnects

The plugin never replaces or deletes a stored sandbox after a reconnect error,
including an explicit `SandboxNotFoundError`. It retries briefly, preserves the
stored sandbox id, and surfaces the error so an operator can investigate or
recover the sandbox. A new sandbox is created automatically only when no stored
sandbox id exists.

Explicit lifecycle stops and cleanup of newly created cold-start race losers
retain their existing behavior; the reconnect recovery path never calls
`Sandbox.kill()`.

## License

MIT — see [LICENSE](./LICENSE).
