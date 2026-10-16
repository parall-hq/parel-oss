---
"@parel/core": minor
---

`runtime.reasoning.effort` (`low` | `medium` | `high`): how hard a reasoning model thinks, as a first-class setting instead of a level inferred from `budgetTokens`. Adds `ReasoningEffort` and `ReasoningConfig.effort`; `RuntimeConfig.reasoning` is now `ReasoningConfig`.
