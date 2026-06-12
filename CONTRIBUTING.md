# Contributing to PAREL

Thanks for your interest in contributing! This repository holds the **public**
PAREL surfaces: SDK packages, first-party runtime plugins, the `parel` CLI,
cross-language schemas, and protocol docs. The hosted runtime and control plane
live in a separate, private repository.

## What belongs here

- Public SDK packages and plugin authoring helpers.
- First-party runtime plugins.
- The public CLI/client tooling.
- Cross-language schemas and protocol docs.
- Examples for users and plugin authors.

Hosted runtime and control-plane internals (platform implementation and
deployment details) do **not** belong here.

## Development setup

You need Node.js >= 22 and [pnpm](https://pnpm.io) (the repo pins a version via
`packageManager`). All JavaScript/TypeScript work happens under `js/`:

```bash
cd js
pnpm install
pnpm build      # build all packages (turbo)
pnpm test       # run tests
pnpm lint       # lint
pnpm check      # Biome format + lint check (run before pushing)
```

Schemas under `schemas/` are validated in CI; keep them and the protocol docs in
sync when you change a public contract.

## Making a change

1. Branch off `main` (short-lived feature branch).
2. Make your change with tests where it makes sense.
3. **Add a changeset** for any package change — this drives versioning and the
   changelog:
   ```bash
   cd js
   pnpm changeset
   ```
   Pick the affected packages and a semver bump (patch/minor/major). Docs-only or
   CI-only changes don't need one.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
   messages (`feat:`, `fix:`, `chore:`, `docs:`).
5. Open a pull request against `main`. CI (build, test, lint, schema validation)
   must pass, and code owners review security-sensitive paths.

## Releases

Releases are managed with [Changesets](https://github.com/changesets/changesets).
Merging a change with a changeset into `main` does not automatically start a
release:

1. Ensure `main` is green.
2. A maintainer manually starts the `Release Prepare` GitHub Actions workflow.
   It opens or updates the `chore: version packages` PR.
3. Review the version PR for semver, changelog, and lockfile changes.
4. Merge the version PR. The `Release` workflow publishes the changed packages
   to npm through trusted publishing.

Release prerequisites:

- npm trusted publishing is configured for each published package under the
  `@parel` scope, pointing at `parall-hq/parel-oss`,
  `.github/workflows/release.yml`, and the `npm-release` GitHub environment.
- Trusted publishing requires npm CLI 11.5.1 or later and Node.js 22.14.0 or
  later. Do not use long-lived npm tokens for automated publishing.
- For public packages published from a public repository, npm generates
  provenance automatically through trusted publishing.

Run the release gate in
[docs/public-release-checklist.md](docs/public-release-checklist.md) before each
release candidate. CI runs the same build, test, lint, schema, and
packed-tarball install smoke checks.

## Reporting security issues

Please **do not** open a public issue for security vulnerabilities. Follow the
process in [SECURITY.md](SECURITY.md).
