# @parel/sandbox-daytona

> PAREL sandbox capability provider plugin for Daytona.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

> **Hosted PAREL:** this plugin is published, but its SDK relies on Node.js
> libraries and it has not been verified on the hosted runtime yet, so don't
> depend on it in production. The verified sandbox plugin is
> [`@parel/sandbox-e2b`](https://github.com/parall-hq/parel-oss/tree/main/js/plugins/sandbox-e2b).

## Install

```bash
npm install @parel/sandbox-daytona
```

## Usage

Provides the standard `parel.sandbox` capability from `@parel/capability-sandbox`
using the official Daytona SDK. It supports filesystem operations, shell command
execution, port preview links, and basic lifecycle management.

```yaml
plugins:
  - plugin: sandbox-daytona
    config:
      apiKey: ${DAYTONA_API_KEY}
      target: us
      snapshot: default
      timeoutMs: 60000
```

Set `sandboxId` to reconnect to an existing Daytona sandbox. By default the
plugin deletes the sandbox on `session:end`; set `destroyOnSessionEnd: false` to
stop it instead.

### Providing the API key

`apiKey` is a declared secret field, so PAREL rejects a plain value there at
deploy time (`secret_literal`) and fails the deploy when it is missing. Write a
`${DAYTONA_API_KEY}` reference as above, then provide the value in one of two
ways:

- Export it before deploying. `parel deploy` uploads it, encrypted, for this
  agent only:

  ```bash
  export DAYTONA_API_KEY=...
  parel deploy ./agent.yaml
  ```

- Or store it once for the whole workspace (needs an Admin-scope API key):
  `parel secrets set DAYTONA_API_KEY`.

## License

MIT - see [LICENSE](./LICENSE).
