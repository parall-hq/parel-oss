---
"@parel/cli": minor
---

Name-based deploy and agent version management. `parel deploy` now upserts by agent name — re-deploying the same `agent.yaml` updates that agent and adds a new version instead of creating a duplicate — and reports the version number. Adds `parel versions list <name>`, `parel deployments list <name>`, `parel rollback <name> [--to vN]`, and `parel agents rename <old> <new>`.
