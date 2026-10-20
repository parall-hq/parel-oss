# @parel/plugin-sdk

> Plugin authoring helpers for PAREL runtime plugins.

Part of [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/plugin-sdk
```

## Usage

Author a runtime plugin with `definePlugin`:

```ts
import { definePlugin, LifecycleEvent } from "@parel/plugin-sdk";

export default definePlugin({
  name: "@example/my-plugin",
  version: "0.1.0",
  async setup(ctx) {
    ctx.hook(LifecycleEvent.ContextBuild, async (hookCtx) => ({
      action: "continue",
      mutations: {
        system: hookCtx.system ? `${hookCtx.system}\n\nBe concise.` : "Be concise.",
      },
    }));
  },
});
```

See the [plugin protocol](https://github.com/parall-hq/parel-oss/blob/main/protocol/plugins.md) for the full
context API and lifecycle events. Two rules worth knowing:

- `ctx.model.capabilities()` reports the session model's real context window
  (`maxContextTokens: 0` = unknown), and a failed `ctx.model.chat()` throws an
  error with a stable `code` to branch on
  ([Model Access](https://github.com/parall-hq/parel-oss/blob/main/protocol/plugins.md#model-access)).
- Await every request a hook, tool, or command starts before it returns: one
  still running when the call returns is cancelled
  ([Finish Your Work Inside the Call](https://github.com/parall-hq/parel-oss/blob/main/protocol/plugins.md#finish-your-work-inside-the-call)).

## License

MIT — see [LICENSE](./LICENSE).
