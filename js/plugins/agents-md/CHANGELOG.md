# @parel/agents-md

## 0.1.0

### Minor Changes

- 4a8e166: New plugin `@parel/agents-md`: loads the project's `AGENTS.md` (or `agents.md` / `AGENT.md`) from the sandbox working directory into the system prompt every turn, and loads the `AGENTS.md` files of the subdirectories the model reads or writes files in. Loaded subdirectories are kept in the session store so they stay loaded on later turns; total size is capped by `maxChars` (default 32000) with a visible note for anything cut. Without a sandbox it does nothing.

### Patch Changes

- Updated dependencies [0b7ee7d]
  - @parel/plugin-sdk@0.18.0
  - @parel/workspace@0.2.13
