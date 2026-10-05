# @parel/steering-immediate

> PAREL plugin for immediate steering and interruption inputs.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/steering-immediate
```

## Usage

```yaml
plugins:
  - steering-immediate
```

Steering is built into the PAREL runtime: a message sent with
`injectInFlight: true` (`POST /sessions/{id}/messages`, or `parel steer`) joins
the running turn at its next step, with no plugin needed.
`POST /sessions/{id}/steer` is a deprecated alias of that call.

What this plugin adds is **interrupts**. The runtime queues an `interrupt`
input (`POST /sessions/{id}/inputs` with `"type": "interrupt"`) but does not act
on it by itself; at the start of each step this plugin drains pending
interrupts and stops the running turn. Add it when you want callers to be able
to stop a turn without terminating the session.

The plugin still drains `steer` inputs into the model context if a host
delivers them to plugins. The hosted runtime never does: it turns steering into
ordinary in-flight messages.

## License

MIT — see [LICENSE](./LICENSE).
