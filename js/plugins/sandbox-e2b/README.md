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
| `timeout` | `300000` | Idle time in milliseconds before E2B reclaims the sandbox: it is deleted (or paused, with `persistence`). Every step of a turn sets the timer back to at least `timeout`, and a long foreground command lengthens it to cover the command. Not a per-command timeout. |
| `sandboxId` | none | Use an existing sandbox managed outside PAREL; see [Externally managed sandbox](#externally-managed-sandbox). |
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

## Sandbox lifetime

`timeout` is how long the sandbox may sit unused. E2B does not restart its
timer when the sandbox is used, so the plugin does: each step of a turn
reconnects and sets the timer to at least `timeout` from now, and before a
foreground command whose time limit could outlast what is left, it lengthens
the timer to cover the command with about a minute to spare. E2B only ever
lengthens a running sandbox's timer this way, so sessions sharing a sandbox
never cut each other short.

By default E2B **deletes** the sandbox once `timeout` passes without use. The
next use then starts from a fresh filesystem: the plugin creates a new sandbox
and puts a note in front of the next `bash`, `file_read` or `file_write` result,
telling the model that the previous sandbox and its files are gone.

## Persistence (filesystem survives across turns)

Set `persistence: true` to have E2B auto-**pause** the sandbox instead of
deleting it: the filesystem is snapshotted, and the plugin's stored sandbox id
transparently resumes it on the next use.

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
  storage quota — storage accrues until the sandbox is explicitly killed. On
  PAREL the sandbox belongs to the agent instance: a session ending leaves it
  alone, and the plugin kills it only on an explicit stop (or when a try-run
  session ends). A sandbox left behind, for example by an instance reset, keeps
  its snapshot; find it in E2B by its metadata (below) and kill it there.
- Requires an E2B account with sandbox persistence available (e2b JS SDK ≥ 2.x
  API surface; this plugin ships with `@e2b/code-interpreter` 2.7.2).

## Reconnect rules

When the plugin reconnects to its stored sandbox:

| E2B answers | The plugin |
|---|---|
| connected | uses it and sets its timer to at least `timeout` |
| the sandbox does not exist (`SandboxNotFoundError`) | creates a new one, stores its id in place of the old one, and tells the model the previous sandbox and its files are gone — with or without `persistence` |
| timeout, network error, or a 5xx | retries briefly, then reports the error; the stored id stays, nothing is created or deleted |
| the sandbox does not exist, and `sandboxId` is configured | reports a clear error; nothing is created, since the sandbox is managed outside PAREL |

The reconnect path never deletes a sandbox. A failed reconnect at the start of
a step does not fail the step; the first tool call that needs the sandbox
retries and reports the error.

## Externally managed sandbox

Set `sandboxId` when something outside PAREL owns the sandbox, for example one
sandbox per instance chosen by your own system:

```yaml
plugins:
  - plugin: sandbox-e2b
    config:
      apiKey: ${E2B_API_KEY}
      sandboxId: ${var:SANDBOX_ID}
```

The plugin then only connects to that sandbox. If it does not exist, the tool
call fails with a clear error and no replacement is created; `lifecycle.stop`
and session end only disconnect and never kill it. Give each instance its
`SANDBOX_ID` var (`PATCH /agents/{name}/instances/{key}` with
`{"vars": {"SANDBOX_ID": "..."}}`); a var without a value fails clearly before
any E2B call.

## Metadata

Each sandbox the plugin creates carries E2B metadata naming who it is for:
`parelOrgId`, `parelAgentId`, `parelInstanceKey` (absent for a try-run) and
`parelSessionId` (the session that created it). Use them to find sandboxes in
E2B, e.g. `Sandbox.list({ query: { metadata: { parelAgentId: "..." } } })`.

## License

MIT — see [LICENSE](./LICENSE).
