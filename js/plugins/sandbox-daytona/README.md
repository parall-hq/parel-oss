# @parel/sandbox-daytona

> PAREL sandbox capability provider plugin for Daytona.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

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
      apiKey: <your Daytona API key>
      target: us
      snapshot: default
      timeoutMs: 60000
```

Set `sandboxId` to reconnect to an existing Daytona sandbox. By default the
plugin deletes the sandbox on `session:end`; set `destroyOnSessionEnd: false` to
stop it instead.

## License

MIT - see [LICENSE](./LICENSE).
