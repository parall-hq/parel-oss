# @parel/sandbox-cloudflare

> PAREL sandbox capability provider plugin for Cloudflare Sandbox.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

> **Not runnable on hosted PAREL yet.** This plugin needs a Cloudflare Durable
> Object namespace injected by the host, and the hosted PAREL runtime has no way
> to inject one today, so its capabilities do not work there. Track
> [parel-oss#38](https://github.com/parall-hq/parel-oss/issues/38). Use
> [`@parel/sandbox-e2b`](https://github.com/parall-hq/parel-oss/tree/main/js/plugins/sandbox-e2b)
> on hosted PAREL.

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
