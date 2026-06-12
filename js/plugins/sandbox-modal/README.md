# @parel/sandbox-modal

> PAREL sandbox capability provider plugin for Modal Sandboxes.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

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
      tokenId: <modal token id>
      tokenSecret: <modal token secret>
      appName: parel-agent
      image: python:3.13
      ports: [3000]
```

By default the plugin terminates the Modal sandbox on `session:end`. Set
`destroyOnSessionEnd: false` to detach the local SDK object and leave the
sandbox running.

## License

MIT - see [LICENSE](./LICENSE).
