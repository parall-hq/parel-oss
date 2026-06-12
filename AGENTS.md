# AGENTS.md

This repository contains public PAREL SDKs, plugins, clients, schemas, protocol docs, and examples.

## Overview

Keep this repo focused on public ecosystem surfaces:

- Public SDK packages.
- First-party runtime plugins.
- Public CLI/client tooling.
- Cross-language schemas and protocol docs.
- Examples for users and plugin authors.

Do not add hosted runtime or control-plane internals here; platform implementation and deployment details belong in the private runtime repository.

## Commands

JavaScript and TypeScript packages live under `js/`.

```bash
cd js
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm changeset
```

## Conventions

- Use `js/` for npm ecosystem packages, even when authored in TypeScript.
- Keep language ecosystems isolated by top-level directory.
- Keep shared schemas and protocol docs language-neutral.
- Runtime plugins and model providers are separate extension points; do not model provider adapters as normal runtime plugins.
- Code, comments, and public docs should be in English unless a localized doc is explicitly requested.
- Commits use conventional commit messages.

## References

- JavaScript workspace: [js/README.md](js/README.md)
- Protocol docs: [protocol/README.md](protocol/README.md)
- Schemas: [schemas/README.md](schemas/README.md)
