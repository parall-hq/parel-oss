# @parel/cli

> PAREL CLI - deploy and manage AI agents.

Part of [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install -g @parel/cli
parel --help
```

The CLI defaults to the hosted runtime at `https://api.parel.sh`. For another
runtime, set `PAREL_SERVER=https://...` or pass `--server`. Authenticate with a
PAREL runtime API key using `parel login` or the `PAREL_API_KEY` environment
variable.

## Usage

```bash
parel login                 # paste your PAREL API key
parel capabilities doctor ./agent.yaml
parel provider-keys set anthropic --from-env ANTHROPIC_API_KEY
export E2B_API_KEY=e2b_...      # referenced as ${E2B_API_KEY} in agent.yaml; deploy uploads it
parel deploy ./agent.yaml   # deploy an agent; prints its id
parel chat --agent <id>     # start an interactive session
```

Interactive commands authenticate session WebSockets with the `parel-v1` and
`token.<apiKey>` subprotocols. Query-string WebSocket tokens are kept only for
older clients.

Run `parel <command> --help` for per-command options.

## License

MIT — see [LICENSE](./LICENSE).
