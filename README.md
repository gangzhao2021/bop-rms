# BOP-RMS

BOP-RMS is the Business Operating Platform and Restaurant Management System for configurable, multi-restaurant operations.

This repository is implemented one reviewed Work Package at a time. WP-0001 through WP-0003 establish the deterministic monorepo and quality baseline. WP-0004 adds bounded application skeletons and a machine-checkable Screen Registry without starting business features or persistence.

## Prerequisites

- A supported Windows 11 host with WSL2 and Ubuntu 24.04 LTS, or a native Linux/macOS environment
- Node.js 24.18.0
- Corepack 0.35.0
- pnpm 11.13.0
- Git and Docker available inside the same WSL distribution

On Windows, keep the checkout in the WSL Linux filesystem, normally `~/src/bop-rms`. Do not run repository commands from `/mnt/c`, `/mnt/d`, OneDrive, or a mixed Windows/Linux toolchain.

## Setup

```bash
corepack install --global pnpm@11.13.0
pnpm install --frozen-lockfile
pnpm verify
```

## Local environment

Create the ignored local configuration and a unique local-only PostgreSQL password:

```bash
cp .env.example .env
install -d -m 0700 .local/postgres
read -r -s -p 'Local PostgreSQL password: ' BOP_RMS_LOCAL_POSTGRES_PASSWORD
printf '%s' "$BOP_RMS_LOCAL_POSTGRES_PASSWORD" > .local/postgres/password
unset BOP_RMS_LOCAL_POSTGRES_PASSWORD
chmod 0600 .local/postgres/password
```

Validate the exact WSL/Linux toolchain, configuration, secret-file permissions, Docker backend, and available localhost ports, then start PostgreSQL and all four application skeletons with one foreground command:

```bash
pnpm environment:check
pnpm dev
```

From another WSL terminal, inspect or stop that environment:

```bash
pnpm local:status
pnpm local:stop
```

The API health endpoint is `http://127.0.0.1:3000/health`. Its `/ready` endpoint intentionally remains `503` with database `not_configured`; local PostgreSQL startup is not application database integration. The Merchant Web and Customer PWA defaults are `http://127.0.0.1:5173` and `http://127.0.0.1:5174`.

## Bootstrap verification

```bash
node --version
pnpm --version
pnpm exec turbo --version
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm screen-registry:check
pnpm test
pnpm build
pnpm environment:verify
pnpm exec turbo run build --dry=json
git diff --check
```

The canonical task names are `build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `format:check`, and `clean`. At WP-0001 they intentionally load an empty workspace graph; later Work Packages add packages without renaming these contracts.

## Workspace boundaries

- `apps/`: deployable composition roots and runtime entry points
- `packages/`: reusable BOP/RMS modules, contracts, persistence infrastructure, and testing support
- `tooling/`: shared engineering configuration and developer tooling

At WP-0004, `apps/` contains only deployable runtime/shell composition roots. `packages/ui` contains semantic tokens and minimal accessibility wrappers; it is not a business component library.

## Roadmap

- WP-0002: workspace directories (integrated)
- WP-0003: TypeScript and quality tooling (integrated)
- WP-0004: runtime application skeletons and Screen Registry
- WP-0005: local PostgreSQL and Docker Compose (integrated)
- WP-0006 (active): root scripts and environment validation
- WP-0007: ADRs, module documentation, setup templates, and repository-scoped skills

See [`docs/spec/README.md`](docs/spec/README.md) for specification authority and the active Work Package.
