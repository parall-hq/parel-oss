# @parel/cli

> PAREL CLI - deploy and manage AI agents.

[PAREL](https://parel.sh) runs AI agents from one `agent.yaml`. This CLI deploys
them, talks to them and manages your workspace, from a terminal or from CI.

- Docs: <https://parel.sh/docs>
- CLI reference: <https://parel.sh/docs/cli>
- Get an API key: <https://parel.sh/console/settings/api-keys>
- Source: <https://github.com/parall-hq/parel-oss>

## Install

Needs Node.js 22 or later.

```bash
npm install -g @parel/cli
parel --help
```

## Log in

Create an API key in the console under
[Settings → API keys](https://parel.sh/console/settings/api-keys), then:

```bash
parel login                 # paste the key (pk_...)
parel whoami                # check it works
```

In CI, skip `parel login` and set `PAREL_API_KEY` instead. The CLI talks to
`https://api.parel.sh` unless you set `PAREL_SERVER` or pass `--server`.

## Usage

```bash
parel capabilities doctor ./agent.yaml   # check keys and secrets before deploying
parel provider-keys set anthropic --from-env ANTHROPIC_API_KEY
export E2B_API_KEY=e2b_...               # referenced as ${E2B_API_KEY} in agent.yaml
parel deploy ./agent.yaml                # deploy; uploads the referenced values
parel chat --agent my-agent              # chat in the terminal
parel send --agent my-agent -m "hi"      # one message, print the reply
parel logs <session-id>                  # a session's events and log records
```

Commands that take `--agent` accept the agent's name or its id.

### Stage, try, promote

```bash
parel deploy ./agent.yaml --no-activate   # upload a staged version (not live)
parel try my-agent --version v2 -m "hi"   # one throwaway run against v2
parel promote my-agent --version v2       # make v2 the live version
parel instances list my-agent             # instances and the versions they are pinned to
```

### Secrets

For every `${NAME}` in `model.config`, a plugin's config or a channel's config,
`parel deploy` takes the environment variable with the same name (or
`--secret NAME=value`) and uploads it with the deploy. Names you don't have
locally must already be stored on the server:

```bash
parel secrets set E2B_API_KEY                   # workspace-wide, read from $E2B_API_KEY
parel secrets set E2B_API_KEY --agent my-agent  # for one agent only
```

A staged deploy (`--no-activate`) of an existing agent can't carry secret
values, so it uploads none: every value it references must already be stored,
and the CLI stops with the `parel secrets set` commands to run if one isn't.

Channel connections read their secrets from the workspace. A deploy stores a
channel's values there only when it uses an Admin key; otherwise store them
with `parel secrets set NAME` first. After a deploy, the CLI prints one line
per declared channel with its result.

### API keys

```bash
parel api-keys create ci-deploy                 # Write scope (the default)
parel api-keys create dashboards --scope read   # read, write or admin
```

## Output and exit codes

Add `--json` (or set `PAREL_JSON=1`) for one line of JSON instead of text.
`NO_COLOR=1` turns colors off; they are also off when output isn't a terminal.

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | A problem on your side: a bad flag, a missing file, not logged in, or a network error. |
| 2 | The server answered with an error, or the turn ended with an error. |
| 3 | No reply before `--timeout` (`send`, `run`, `try`). The session keeps going. |
| 4 | Not ready: `capabilities doctor` or `--require-ready` found a missing key or secret. |

Run `parel <command> --help` for each command's options.

## License

MIT — see [LICENSE](./LICENSE).
