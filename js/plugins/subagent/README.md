# @parel/subagent

> PAREL plugin for delegating work to subagents — synchronous inline delegation, plus asynchronous background spawning when the runtime provides the parel.runtime capability.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/subagent
```

## Usage

Delegates work to subagents — synchronous inline delegation, plus
asynchronous background spawning when the runtime provides the
`parel.runtime` capability.

```yaml
plugins:
  - subagent
```

## License

MIT — see [LICENSE](./LICENSE).
