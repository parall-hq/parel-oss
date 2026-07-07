---
"@parel/sandbox-e2b": patch
---

Clear ghost process/port records when the instance sandbox is destroyed (explicit `lifecycle.stop`) or replaced after becoming unreachable — records describing a dead machine would mislead sibling sessions' list/tail/stop. Matches the behavior shipped with the vercel/modal/daytona instance-mode migrations.
