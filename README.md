# BOP-RMS

BOP-RMS is the Business Operating Platform and Restaurant Management System for configurable, multi-restaurant operations.

This repository is implemented one reviewed Work Package at a time. WP-0001 contains the deterministic monorepo and governance baseline. WP-0002 materializes the workspace directory boundaries without creating applications, packages, or business code.

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
```

## Bootstrap verification

```bash
node --version
pnpm --version
pnpm exec turbo --version
pnpm install --frozen-lockfile
pnpm exec turbo run build --dry=json
git diff --check
```

The canonical task names are `build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `format:check`, and `clean`. At WP-0001 they intentionally load an empty workspace graph; later Work Packages add packages without renaming these contracts.

## Workspace boundaries

- `apps/`: deployable composition roots and runtime entry points
- `packages/`: reusable BOP/RMS modules, contracts, persistence infrastructure, and testing support
- `tooling/`: shared engineering configuration and developer tooling

At WP-0002 these directories contain boundary documentation only. WP-0003 adds quality tooling, and WP-0004 owns the first runtime application skeletons.

## Roadmap

- WP-0002 (active): workspace directories
- WP-0003: TypeScript and quality tooling
- WP-0004: runtime application skeletons, after the Figma UI Readiness Gate
- WP-0005: local PostgreSQL and Docker Compose
- WP-0006: root environment validation
- WP-0007: ADRs, module documentation, setup templates, and repository-scoped skills

See [`docs/spec/README.md`](docs/spec/README.md) for specification authority and the active Work Package.
