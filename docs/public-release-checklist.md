# Public Release Checklist

Use this checklist before every npm release candidate. The goal is to prove
that the public repo contains only public contracts, installs cleanly from
tarballs, and gives new users a working first path.

## Release blockers

- Secret scan passes on the working tree and git history:

  ```bash
  gitleaks detect --source . --redact
  gitleaks dir . --redact
  detect-secrets scan --all-files \
    --exclude-files '^\.git/' \
    --exclude-files '^js/pnpm-lock\.yaml$' \
    --exclude-files '(^|/)dist/' \
    --exclude-files '(^|/)node_modules/' \
    --exclude-files '(^|/)\.turbo/'
  ```

- Public/private boundary scan is reviewed. Expected hits are boundary docs,
  public protocol endpoints, and host-managed plugin notes only:

  ```bash
  git grep -n -I -E '(@parel/(kernel|config|cloudflare)|packages/(kernel|config|cloudflare)|Durable Object|D1 migration|billing|web console)' -- . ':(exclude).git'
  ```

- JavaScript workspace validation passes:

  ```bash
  cd js
  pnpm install --frozen-lockfile
  pnpm exec ajv compile --spec=draft2020 \
    -s ../schemas/agent-config.schema.json \
    -s ../schemas/message.schema.json \
    -s ../schemas/transcript.schema.json \
    -s ../schemas/websocket-event.schema.json \
    -s ../schemas/plugin-manifest.schema.json \
    -s ../schemas/api-error.schema.json
  pnpm check
  pnpm build
  pnpm pack:smoke
  pnpm test
  pnpm lint
  ```

- Each published package has `README.md`, `LICENSE`, `CHANGELOG.md`,
  `repository.directory`, `publishConfig.access=public`, and a restrictive
  `files` list. Runtime plugins must also publish `parel.plugin.json`.
- The quickstart in [README.md](../README.md) and the example in
  [examples/agent.yaml](../examples/agent.yaml) are still aligned with the CLI
  help output and the public schema.
- The release workflow uses npm trusted publishing for `@parel/*`; do not use a
  long-lived npm automation token.

## Public preview polish

- Open issues and PR templates render correctly.
- SECURITY.md points reporters to private vulnerability disclosure.
- CONTRIBUTING.md explains which changes belong in the public repo versus the
  hosted runtime repo.
- Protocol and schema docs label experimental surfaces clearly.
- First-party plugin docs explain required credentials and whether the plugin is
  host-managed, BYOK, or local-only.
- Release notes call out package versions, known limitations, and migration
  notes for any public contract changes.
