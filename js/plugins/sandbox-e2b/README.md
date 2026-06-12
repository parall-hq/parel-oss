# @parel/sandbox-e2b

> PAREL sandbox plugin for E2B code interpreter execution.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/sandbox-e2b
```

## Usage

Runs agent commands inside an [E2B](https://e2b.dev) code-interpreter sandbox.
Provide your E2B API key through the plugin's `apiKey` config; without it the
plugin logs a warning and skips sandbox creation. `template` and `timeout` are
optional.

The plugin keeps its existing `bash`, `file_read`, and `file_write` tools and
legacy `"filesystem"` / `"exec"` capabilities, and also provides the standard
`parel.sandbox` capability from `@parel/capability-sandbox`.

```yaml
plugins:
  - plugin: sandbox-e2b
    config:
      apiKey: <your E2B API key> # from https://e2b.dev
      template: base
      timeout: 300000
```

## License

MIT — see [LICENSE](./LICENSE).
