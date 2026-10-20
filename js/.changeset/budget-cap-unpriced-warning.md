---
"@parel/budget-cap": patch
---

Log one warning per session when the session has used tokens but its cost is still `$0`: the model has no price (an unpriced model on your own key), so `max_usd` cannot take effect. Before, the cap silently never fired. `max_turns` is unaffected.
