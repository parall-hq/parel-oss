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

The runtime never adds this plugin for you, sandbox or not: list it when you
want shell commands filtered.

It does two things:

- **Command checks** (`tool:before`): for every call to one of the shell tools
  in `exec_tools`, it reads the call's `command` argument and blocks the call
  when the command matches a destructive pattern, or (in `allowlist` mode)
  runs a program that is not allowed. The model gets the reason back as the
  tool's error result.
- **Secret redaction**: known secret shapes (OpenAI / Anthropic / GitHub /
  Slack / Stripe keys, AWS access key ids, private key headers, JWTs) become
  `[REDACTED]` in every tool's text output, and in the system prompt and text
  messages sent to the model.

## Config

```yaml
plugins:
  - security-basic:
      mode: allowlist
      allowed_patterns: ["^(ls|cat|git|node|npm)$"]
      exec_tools: [bash, workspace_shell]
```

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `allowlist` | `allowlist`: block destructive patterns **and** any program not matched by `allowed_patterns`. Any other value (e.g. `denylist`): block destructive patterns only. |
| `allowed_patterns` | built-in list (below) | Regular expressions (JavaScript syntax, as strings). A program is allowed when any of them matches its name. Replaces the built-in list rather than adding to it, and only applies in `allowlist` mode. Anchor them (`^...$`): `git` alone also matches `legit`. |
| `exec_tools` | `bash`, `shell`, `exec`, `terminal`, `run_command`, `run`, `workspace_shell`, `workspace_start_process` | Names of the tools whose `command` argument is checked. Replaces the default list. Other tools are never blocked; their output is still redacted. |

The destructive patterns are always checked, in every mode: `rm -rf` and
`rm` of `/`, `mkfs`, `dd` to a device, writes to `/dev/sd*`, `chmod 777` and
recursive `chown` on paths, `shutdown` / `reboot` / `halt` / `poweroff` /
`init 0|6`, `wipefs`, and `shred`. Quotes and backslashes are stripped before
matching, so `'rm' -rf /` is caught too.

How `allowlist` mode reads a command:

- Every program in the command is checked: each part of a pipeline or of a
  `&&` / `||` / `;` list, subshells, and commands inside `$(...)`, backticks
  and `<(...)`. A program given by path counts by its file name
  (`/usr/bin/curl` is `curl`).
- Wrappers such as `sudo`, `env`, `nohup`, `time`, `timeout`, `nice`,
  `xargs`, and `watch` must be allowed themselves, and so must the program
  they run.
- A program name produced by a substitution (`$(echo rm) -rf /`) cannot be
  checked, so the command is blocked.

The built-in allowed programs are: common file and text tools (`ls`, `cat`,
`head`, `tail`, `wc`, `grep`, `find`, `sed`, `awk`, `sort`, `jq`, ...),
`cd` / `mkdir` / `cp` / `mv` / `touch` / `ln`, `node` / `npm` / `npx` /
`pnpm` / `bun` / `deno` / `python` / `pip`, `git` / `gh`, `curl` / `wget` and
basic network checks, `docker` / `podman` / `kubectl`, common build tools
(`make`, `cargo`, `go`, `gcc`, `javac`, `dotnet`, ...), archive tools, editors
and pagers, and shell builtins such as `test`, `export`, and `source`. Programs
outside it, for example `rm`, `bash`, `sh`, `sleep`, and `apt-get`, are
blocked in `allowlist` mode; use `mode: denylist` or your own
`allowed_patterns` to allow them.

> **Scope.** This is a best-effort policy layer, **not** an isolation boundary.
> A program-name allowlist cannot see inside an allowlisted interpreter's
> arguments (e.g. `python -c`, `awk`, `find -exec`), so treat it as a guard
> rail, not a sandbox. For untrusted workloads, run inside a real sandbox.

## License

MIT — see [LICENSE](./LICENSE).
