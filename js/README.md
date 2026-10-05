# PAREL JavaScript

JavaScript and TypeScript packages for PAREL.

## Packages

- `@parel/core` - public contracts and shared runtime types.
- `@parel/plugin-sdk` - plugin authoring helpers.
- `@parel/cli` - command-line client.

## Capability Contracts

- `@parel/capability-sandbox` - provider-neutral sandbox capability contract.

## Plugins

Runtime plugins (listed in `agent.yaml` under `plugins`):

- Prompt and memory: `@parel/system-static`, `@parel/memory-rolling-summary`
- Guards and control: `@parel/security-basic`, `@parel/budget-cap`,
  `@parel/steering-immediate`
- Delegation: `@parel/subagent`
- Sandboxes: `@parel/sandbox-e2b`, `@parel/sandbox-daytona`,
  `@parel/sandbox-vercel`, `@parel/sandbox-modal`, `@parel/sandbox-cloudflare`
- Coding agents: `@parel/coding-agent`, `@parel/workspace`,
  `@parel/filesystem-tools`, `@parel/search-tools`, `@parel/edit-tools`,
  `@parel/git-tools`, `@parel/shell-tools`, `@parel/process-tools`,
  `@parel/port-tools`, `@parel/approval-tools`

Channel connectors (listed in `agent.yaml` under `channels`):

- `@parel/channel-slack-socket`
- `@parel/channel-telegram`

Which plugins run on hosted PAREL, and what each one needs, is listed at
<https://parel.sh/docs/config#available-plugins>.

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
