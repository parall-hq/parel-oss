# @parel/agents-md

> PAREL plugin that loads AGENTS.md project instructions into the model's context.

A first-party runtime plugin for [PAREL](https://github.com/parall-hq/parel-oss).
It follows the [AGENTS.md](https://agents.md) convention: a project keeps its
instructions for coding agents in an `AGENTS.md` file, and a subdirectory can
add its own.

## Install

```bash
npm install @parel/agents-md
```

## Usage

Add it next to a sandbox provider plugin. It reads the files through the
`parel.sandbox` capability, so any provider with filesystem support works.

```yaml
plugins:
  - plugin: "@parel/sandbox-e2b"
    config:
      apiKey: ${E2B_API_KEY}
  - plugin: "@parel/workspace"
  - plugin: "@parel/filesystem-tools"
  - agents-md
```

Options (all optional):

| Key | Default | Meaning |
|---|---|---|
| `root` | the workspace root, else the sandbox's working directory | directory to read `AGENTS.md` from |
| `maxChars` | `32000` | limit on the characters injected across all loaded files |

## How it works

- **Root file.** Each turn the plugin reads the first of `AGENTS.md`,
  `agents.md` and `AGENT.md` in the working directory. Edits show up on the next
  turn.
- **Subdirectories.** When the model reads or writes a file through a file
  tool (`workspace_read_file`, `workspace_write_file`, `workspace_edit_file`,
  or the sandbox's `file_read` / `file_write`), the plugin also loads the
  `AGENTS.md` file of every directory between the root and that file, for
  example `src/AGENTS.md` and `src/api/AGENTS.md` for `src/api/auth.ts`. The
  next model call sees them.
- **Once per session.** The directories that had a file are kept in the
  session store, so they stay loaded on later turns. Their files are re-read
  each turn, like the root file, so the model always sees the current text and
  never gets the same file twice.
- **Where it goes.** All files are appended to the system prompt in one
  `<agents_md>` block: root first, then subdirectory files in the order they
  were loaded. The block tells the model that deeper files win on conflicts and
  that direct instructions from the system prompt or the user take precedence.
- **Size limit.** Text past `maxChars` is cut. The model sees a
  `[truncated: ...]` note on a cut file and a `[not loaded: ...]` note for a
  file that no longer fits, so it knows what it is missing.
- **Never fails a turn.** No sandbox, a sandbox without filesystem access, no
  file, or a failing read: the plugin injects nothing and logs a warning where
  something is actually wrong.

The root is the `root` option when set, else the root of the
`@parel/workspace` workspace once it is materialized (the plugin
never clones it itself), else the sandbox's working directory. Workspace tools
take paths relative to that root; an absolute path from a sandbox file tool
counts only when it is inside an absolute root.

Listing, searching, patch and shell tools do not trigger subdirectory loads.
The plugin only changes the system prompt, so it declares
`consumes.transcript: "lazy"` and is never sent the message history.

## License

MIT — see [LICENSE](./LICENSE).
