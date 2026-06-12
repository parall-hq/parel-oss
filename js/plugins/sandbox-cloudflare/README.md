# @parel/sandbox-cloudflare

> PAREL sandbox capability provider plugin for Cloudflare Sandbox.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/sandbox-cloudflare
```

## Usage

Provides the standard `parel.sandbox` capability from `@parel/capability-sandbox`
using the official `@cloudflare/sandbox` SDK.

Cloudflare Sandbox is host-bound: it needs a Cloudflare Durable Object namespace,
not just an API token. The host runtime must inject that namespace into
`ctx.config.namespace`; this plugin does not require kernel special cases.

```yaml
plugins:
  - plugin: sandbox-cloudflare
    config:
      sandboxId: parel-default
      hostname: preview.example.com
      # namespace is host-injected, not serializable YAML
```

It supports filesystem operations, shell command execution, background processes,
port preview URLs, and lifecycle management. `destroyOnSessionEnd` defaults to
`false` because the Durable Object binding is host-managed.

## License

MIT - see [LICENSE](./LICENSE).
