---
"@parel/core": minor
---

`runtime.reasoning.effort` (`low` | `medium` | `high`): how hard a reasoning model thinks, as a first-class setting. A level asks for level-based reasoning, `budgetTokens` alone for budget-based reasoning, neither means medium — decided by the config, never the model name (protocol/model-calls.md#reasoning). Adds `REASONING_EFFORTS`, `ReasoningEffort` and `ReasoningConfig.effort`; `RuntimeConfig.reasoning` is now `ReasoningConfig`.
