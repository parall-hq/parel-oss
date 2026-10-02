---
"@parel/core": minor
"@parel/cli": minor
---

`TokenUsage.costUsd` carries a provider-reported call cost (e.g. OpenRouter's `usage.cost`), which runtimes prefer over price-table estimates. The CLI's `parel billing plan` shows the plan and this month's metered usage (steps, connection-days, allowance, overage, spend cap); `parel billing balance` is removed now that the hosted service keeps no prepaid balance, and `parel billing summary` reports model spend as an estimate paid to your providers.
