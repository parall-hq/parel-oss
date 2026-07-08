---
"@parel/cli": minor
---

Instance-era command surface: stage, try, promote, and manage agent instances.

- `parel deploy <file> --no-activate` uploads a new version via the resource-shaped `POST /agents/:name/versions` and stages it (not live); the output prints the version handle plus `try`/`promote` next steps. Without the flag, `deploy` is unchanged (still the existing endpoint). A brand-new agent's first version is always live.
- `parel try <agent> [--version vN] -m "text"` runs one throwaway (ephemeral) turn and prints the reply — a version pin runs on an ephemeral instance so a try can never touch a named entity's state. Requires `-m`; use `parel chat` for interactive.
- `parel promote <agent> --version vN` sets the live deployment (promote forward or roll back). `parel rollback` is unchanged and equivalent to promoting an older version.
- `parel instances list|pin|unpin|reset|delete <agent> [key]` manages the entity layer: pin an instance to a version, return it to tracking live, wipe its entity state (keeping sessions), or delete it (with a friendly hint when active sessions still hold it).
- `parel sessions create <agent> --instance <key>` targets a named instance via the top-level `POST /sessions`.
