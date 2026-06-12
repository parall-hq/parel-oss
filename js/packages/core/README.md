# @parel/core

> Shared public TypeScript contracts for PAREL.

Part of [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/core
```

## Usage

`@parel/core` holds the shared TypeScript contracts (message, session,
plugin, and model types) used across the PAREL ecosystem. You normally get it
transitively via [`@parel/plugin-sdk`](https://github.com/parall-hq/parel-oss/tree/main/js/packages/plugin-sdk);
depend on it directly only when you need the raw types.

```ts
import type { Message, ParelPlugin } from "@parel/core";
```

## License

MIT — see [LICENSE](./LICENSE).
