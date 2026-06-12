# @parel/sandbox-vercel

> PAREL sandbox capability provider plugin for Vercel Sandbox.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

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
      token: <vercel token>
      teamId: <team id>
      projectId: <project id>
      name: parel-agent
      runtime: node24
      ports: [3000]
```

Named sandboxes are reused through `Sandbox.getOrCreate`. By default the plugin
deletes the sandbox on `session:end`; set `destroyOnSessionEnd: false` to stop it
instead.

## License

MIT - see [LICENSE](./LICENSE).
