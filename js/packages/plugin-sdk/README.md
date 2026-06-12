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
context API and lifecycle events.

## License

MIT — see [LICENSE](./LICENSE).
