# @parel/sandbox-modal

> PAREL sandbox capability provider plugin for Modal Sandboxes.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

> **Hosted PAREL:** this plugin is published, but its SDK relies on Node.js
> libraries and it has not been verified on the hosted runtime yet, so don't
> depend on it in production. The verified sandbox plugin is
> [`@parel/sandbox-e2b`](https://github.com/parall-hq/parel-oss/tree/main/js/plugins/sandbox-e2b).

## Install

```bash
npm install @parel/sandbox-modal
```

## Usage

Provides the standard `parel.sandbox` capability from `@parel/capability-sandbox`
using the official Modal JavaScript SDK. It supports filesystem operations,
command execution, Modal tunnel URLs, and lifecycle management.

```yaml
plugins:
  - plugin: sandbox-modal
    config:
      tokenId: ${MODAL_TOKEN_ID}
      tokenSecret: ${MODAL_TOKEN_SECRET}
      appName: parel-agent
      image: python:3.13
      ports: [3000]
```

By default the plugin terminates the Modal sandbox on `session:end`. Set
`destroyOnSessionEnd: false` to detach the local SDK object and leave the
sandbox running.

### Providing the credentials

`tokenId` and `tokenSecret` are declared secret fields, so PAREL rejects plain
values there at deploy time (`secret_literal`) and fails the deploy when one is
missing. Write `${NAME}` references as above, then provide the values in one of
two ways:

- Export them before deploying. `parel deploy` uploads them, encrypted, for
  this agent only:

  ```bash
  export MODAL_TOKEN_ID=...
  export MODAL_TOKEN_SECRET=...
  parel deploy ./agent.yaml
  ```

- Or store them once for the whole workspace (needs an Admin-scope API key),
  for example `parel secrets set MODAL_TOKEN_ID`.

## License

MIT - see [LICENSE](./LICENSE).
