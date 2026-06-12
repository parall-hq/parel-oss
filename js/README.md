# PAREL JavaScript

JavaScript and TypeScript packages for PAREL.

## Packages

- `@parel/core` - public contracts and shared runtime types.
- `@parel/plugin-sdk` - plugin authoring helpers.
- `@parel/cli` - command-line client.

## Capability Contracts

- `@parel/capability-sandbox` - provider-neutral sandbox capability contract.

## Plugins

- `@parel/system-static`
- `@parel/memory-rolling-summary`
- `@parel/security-basic`
- `@parel/steering-immediate`
- `@parel/budget-cap`
- `@parel/subagent`
- `@parel/sandbox-e2b`
- `@parel/sandbox-daytona`
- `@parel/sandbox-vercel`
- `@parel/sandbox-modal`
- `@parel/sandbox-cloudflare`

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
```

## Releases

Use Changesets for all package version changes:

```bash
pnpm changeset
```

The release process lives in [CONTRIBUTING.md](../CONTRIBUTING.md#releases).
