# BOP-RMS

BOP-RMS is the Business Operating Platform and Restaurant Management System for configurable, multi-restaurant operations.

This repository is implemented one reviewed Work Package at a time. WP-0001 contains only the deterministic monorepo and governance baseline; applications and business code start in later Work Packages.

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

## WP-0001 verification

```bash
node --version
pnpm --version
pnpm exec turbo --version
pnpm install --frozen-lockfile
pnpm exec turbo run build --dry=json
git diff --check
```

The canonical task names are `build`, `dev`, `lint`, `typecheck`, `test`, `test:integration`, `format:check`, and `clean`. At WP-0001 they intentionally load an empty workspace graph; later Work Packages add packages without renaming these contracts.

## Roadmap

- WP-0002: workspace directories
- WP-0003: TypeScript and quality tooling
- WP-0004: runtime application skeletons, after the Figma UI Readiness Gate
- WP-0005: local PostgreSQL and Docker Compose
- WP-0006: root environment validation
- WP-0007: ADRs, module documentation, setup templates, and repository-scoped skills

See [`docs/spec/README.md`](docs/spec/README.md) for specification authority and the active Work Package.
