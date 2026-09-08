# Developer Setup

This is the canonical repository setup template for the current bootstrap baseline. Keep values portable and synthetic; never paste credentials, account identities, signed URLs, real Store/Provider data, PII, payment data, or allergy/health facts into this file.

## Supported environment

- Windows 11 with WSL2 and Ubuntu 24.04 LTS, or a native Linux/macOS environment.
- On Windows, clone under the WSL Linux filesystem, normally `~/src/bop-rms`. Do not run repository tools from `/mnt/c`, `/mnt/d`, OneDrive, or a mixed Windows/Linux toolchain.
- Node.js `24.18.0`, Corepack `0.35.0`, pnpm `11.13.0`, and Turbo `2.10.5`.
- Native Git, Docker CLI, Docker Compose (the `docker compose` command), and a Linux-container backend available in the same macOS/Linux environment.

## Checkout and install

```bash
printf '%s' 'Authorized repository URL: '
read -r BOP_RMS_REPOSITORY_URL
test -n "$BOP_RMS_REPOSITORY_URL"
git clone "$BOP_RMS_REPOSITORY_URL" bop-rms
unset BOP_RMS_REPOSITORY_URL
cd bop-rms
test "$(node --version)" = "v24.18.0"
corepack install --global pnpm@11.13.0
test "$(corepack --version)" = "0.35.0"
test "$(pnpm --version)" = "11.13.0"
pnpm install --frozen-lockfile
pnpm build
```

On a fresh checkout, build before the full verification so architecture checks can resolve module
`dist` exports. On macOS, use native tools (including Apple Silicon builds on ARM Macs), start Docker
Desktop with Linux containers, and ensure Git can run before setup. Bash and zsh can both run the
commands below. On macOS, run verification with `TMPDIR=/private/tmp CI=true pnpm verify` to avoid
`/tmp` symlink differences in filesystem fixtures.

Use the actual authorized Repository URL; do not store embedded credentials. Do not upgrade accepted pins merely because a newer version exists.

## Local-only configuration

```bash
cp .env.example .env
install -d -m 0700 .local/postgres
node --input-type=module -e 'import { writeFileSync } from "node:fs"; import { randomBytes } from "node:crypto"; writeFileSync(".local/postgres/password", randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });'
chmod 0600 .local/postgres/password
```

The Node command creates a random local-only password without printing it and refuses to overwrite
an existing password file. `.env`, `.local/`, and the secret file are ignored. The password must be synthetic/local-only and must not appear in arguments, logs, status output, screenshots, CI artifacts, or tracked files.

## Validate and run

```bash
pnpm environment:check
pnpm dev
```

Use another terminal in the same macOS/Linux environment for:

```bash
pnpm local:status
pnpm local:stop
```

Default localhost endpoints are API `http://127.0.0.1:3000`, Merchant Web `http://127.0.0.1:5173`, and Customer PWA `http://127.0.0.1:5174`. PostgreSQL binds to `127.0.0.1:5432` by default.

API `/health` should be healthy. API `/ready` intentionally returns HTTP `503` with database `not_configured`; local PostgreSQL startup is not application database integration.

## Verify a change

Read root `AGENTS.md`, `docs/spec/README.md`, the active WP brief, and applicable nested instructions first. From the repository root, use only scripts that exist:

```bash
pnpm install --frozen-lockfile
pnpm repository-guidance:check
pnpm format:check
pnpm lint
pnpm typecheck
pnpm screen-registry:check
pnpm test
pnpm build
./tooling/postgres/verify-local.sh
pnpm environment:verify
pnpm list --depth 0
pnpm exec turbo run build --dry=json
git diff --check
```

The active WP may require additional affected checks. An unrun check is never reported as passed.

## Worktree template

Use one short-lived native macOS/Linux worktree and branch per WP after confirming a clean exact baseline:

```bash
git fetch --prune origin
printf '%s' 'Authorized WP branch: '
read -r BOP_RMS_WP_BRANCH
printf '%s' 'Native worktree path: '
read -r BOP_RMS_WORKTREE_PATH
printf '%s' 'Exact authorized baseline: '
read -r BOP_RMS_BASELINE
test -n "$BOP_RMS_WP_BRANCH" && test -n "$BOP_RMS_WORKTREE_PATH" && test -n "$BOP_RMS_BASELINE"
git worktree add -b "$BOP_RMS_WP_BRANCH" "$BOP_RMS_WORKTREE_PATH" "$BOP_RMS_BASELINE"
unset BOP_RMS_WP_BRANCH BOP_RMS_WORKTREE_PATH BOP_RMS_BASELINE
```

Commit, push, PR, Ready, merge, deploy, Figma publication, and Provider mutation are separate actions requiring explicit authority. Before merge, re-fetch and compare the exact expected PR head; never merge an unknown drifted head.

## Troubleshooting and cleanup

- Keep downloaded toolchains and package-manager caches outside the checkout; repository lint scans
  JavaScript files even inside Git-ignored `.local/`.
- On macOS, supervisor/Worker inspection uses `/bin/ps`; Linux retains `/proc`. An unavailable or
  unrelated process is never treated as the running supervisor.

- Wrong tool/path: confirm `pwd`, `command -v node pnpm git docker`, and that required executables are native tools in one environment.
- Port conflict: run `pnpm environment:check`; stop only the process/resource you own after identifying it.
- Invalid secret file: recreate it as a non-symlink regular file with mode `0600`; never print its contents.
- Local failure: run `pnpm local:stop`, inspect bounded local logs for non-sensitive errors, then rerun validation.
- Database lifecycle verification: use `./tooling/postgres/verify-local.sh`; it is self-cleaning and must not remove another Compose project.

Do not reset, stash, overwrite, delete another worktree's changes, modify host security settings, install Providers, or broaden the active WP to make setup pass.
