# @parel/budget-cap

> PAREL plugin for budget and turn limits.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).

## Install

```bash
npm install @parel/budget-cap
```

## Usage

```yaml
plugins:
  - budget-cap:
      max_usd: 10
      max_turns: 50
```

| Key | Default | Meaning |
|---|---|---|
| `max_usd` | `5` | Cost ceiling for one session, in US dollars. |
| `max_turns` | no limit | Turn ceiling for one session. |

Before every model call (`model:before`), the plugin checks the session's
running totals. When the session's model cost (`totalCostUsd`, as PAREL
estimates it from token usage) has reached `max_usd`, or the session's turn
count is past `max_turns`, it stops the turn with a reason such as
`Budget exceeded: $10.02 >= $10`. The session itself stays usable; each later
turn is stopped at its first model call the same way. The older key `daily` is
still read as `max_usd`.

Both limits are per session. For a spend ceiling across every session of an
agent instance, use `runtime.instanceBudgetUsd`; for a hard turn limit enforced
by the runtime, use `runtime.maxTurns` (see the
[agent.yaml reference](https://parel.sh/docs/config#runtime)).

## License

MIT — see [LICENSE](./LICENSE).
