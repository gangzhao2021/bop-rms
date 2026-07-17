# BOP-RMS

BOP-RMS is the Business Operating Platform and Restaurant Management System for configurable, multi-restaurant operations.

This repository is implemented one reviewed Work Package at a time. WP-0001 through WP-0006 establish the deterministic monorepo, quality baseline, application skeletons, local PostgreSQL, and root environment lifecycle. WP-0007 materializes repository guidance without starting a business vertical slice.

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

See [`docs/onboarding/developer-setup.md`](docs/onboarding/developer-setup.md) for the complete setup, local secret-file, worktree, verification, and troubleshooting template.

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
pnpm repository-guidance:check
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

The canonical task names are `build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `format:check`, and `clean`.

## Repository guidance

- [`docs/adr/`](docs/adr/README.md) contains the stable ADR register and template.
- [`docs/templates/module/README.md`](docs/templates/module/README.md) is the later-module README template; it does not instantiate a module.
- [`.agents/skills/`](.agents/skills) contains the five explicitly triggered BOP-RMS project workflows. They guide execution and never replace `AGENTS.md`, the current WP brief, CI/tests, or explicit external-action authority.

Run `pnpm repository-guidance:check` after changing any of these artifacts.

The Section 48.2 Module Manifest authoring contract and deterministic synthetic fixtures live in [`tooling/module-manifest`](tooling/module-manifest). A Manifest uses an unscoped kebab-case logical `moduleName`, a separate canonical `packageName` of `@bop/<moduleName>` or `@rms/<moduleName>`, and the matching `BOP` or `RMS` layer; synchronous dependency identities use the same three-part contract. Run `pnpm module-manifest:check` after changing that contract. Database names in a Manifest are future ownership metadata only and do not create persistence artifacts.

The bounded Module Generator lives in [`tooling/module-generator`](tooling/module-generator). Its JSON input requires Layer, unscoped Module Name, exact Package Name, Phase, Allowed Dependencies, future database schema metadata, and a caller-supplied Owner role. Inspect the closed input and safety behavior with `pnpm module-generator --help`, and run `pnpm module-generator:check` after changing it. The target is derived under `packages/bop/*` or `packages/rms/*`; existing, partial, unsafe, or case-colliding targets are never overwritten. Generator tests use temporary synthetic roots, and WP-0011 commits no generated business Module.

The Import Boundary Architecture Test lives in [`tooling/import-boundary`](tooling/import-boundary). Run `pnpm import-boundary:check` or inspect `node tooling/import-boundary/validate.mjs --help`. It discovers canonical Modules from their WP-0010 Manifest plus WP-0011 layout, requires exact package/export-map agreement, and rejects BOP-to-RMS, cross-Module relative/private/unexported/undeclared imports, case conflicts, path escapes, and unresolved dynamic imports. Tests use temporary synthetic Modules; WP-0012 commits no business Module.

## Workspace boundaries

- `apps/`: deployable composition roots and runtime entry points
- `packages/`: reusable BOP/RMS modules, contracts, persistence infrastructure, and testing support
- `tooling/`: shared engineering configuration and developer tooling

At the current bootstrap stage, `apps/` contains only deployable runtime/shell composition roots. `packages/ui` contains semantic tokens and minimal accessibility wrappers; it is not a business component library.

## Roadmap

- WP-0001–WP-0003: monorepo and quality baseline (integrated)
- WP-0004: runtime application skeletons and Screen Registry (integrated)
- WP-0005: local PostgreSQL and Docker Compose (integrated)
- WP-0006: root scripts and environment validation (integrated)
- WP-0007: ADRs, module documentation, setup templates, and repository-scoped skills (integrated)
- WP-0010: Module Manifest Schema and deterministic declaration validation (integrated)
- WP-0011: deterministic Module Generator (integrated)
- WP-0012: Import Boundary Architecture Test (active)

See [`docs/spec/README.md`](docs/spec/README.md) for specification authority and the active Work Package.
