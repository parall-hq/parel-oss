# @parel/sandbox-vercel

> PAREL sandbox capability provider plugin for Vercel Sandbox.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

> **Hosted PAREL:** this plugin is published, but its SDK relies on Node.js
> libraries and it has not been verified on the hosted runtime yet, so don't
> depend on it in production. The verified sandbox plugin is
> [`@parel/sandbox-e2b`](https://github.com/parall-hq/parel-oss/tree/main/js/plugins/sandbox-e2b).

## Install

```bash
npm install @parel/sandbox-vercel
```

## Usage

Provides the standard `parel.sandbox` capability from `@parel/capability-sandbox`
using the official `@vercel/sandbox` SDK. It supports filesystem operations,
argv command execution, detached processes, port domains, and lifecycle
management.

```yaml
plugins:
  - plugin: sandbox-vercel
    config:
      token: ${VERCEL_TOKEN}
      teamId: ${VERCEL_TEAM_ID}
      projectId: ${VERCEL_PROJECT_ID}
      name: parel-agent
      runtime: node24
      ports: [3000]
```

Named sandboxes are reused through `Sandbox.getOrCreate`. By default the plugin
deletes the sandbox on `session:end`; set `destroyOnSessionEnd: false` to stop it
instead.

### Providing the credentials

`token`, `teamId`, and `projectId` are declared secret fields, so PAREL rejects
plain values there at deploy time (`secret_literal`) and fails the deploy when
one is missing. Write `${NAME}` references as above, then provide the values in
one of two ways:

- Export them before deploying. `parel deploy` uploads them, encrypted, for
  this agent only:

  ```bash
  export VERCEL_TOKEN=...
  export VERCEL_TEAM_ID=...
  export VERCEL_PROJECT_ID=...
  parel deploy ./agent.yaml
  ```

- Or store them once for the whole workspace (needs an Admin-scope API key),
  for example `parel secrets set VERCEL_TOKEN`.

## License

MIT - see [LICENSE](./LICENSE).
