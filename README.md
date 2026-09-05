# BOP-RMS

BOP-RMS is the Business Operating Platform and Restaurant Management System for configurable, multi-restaurant operations.

This repository is implemented one reviewed Work Package at a time. It contains platform and
restaurant Domain implementations, database migrations, API transports, Customer and Merchant
screens, and isolated acceptance suites. The normal runtime still leaves unconfigured business
dependencies unavailable; the complete ordering, payment, kitchen and handoff journey is not yet
connected.

Use the [delivery status ledger](docs/spec/project-status.md) for integrated work, implementation
gaps and the next increments. The [specification index](docs/spec/README.md) identifies the current
Work Package and accepted authority. Historical WP completion records describe their bounded scope,
not overall product or production readiness.

The first Pilot remains Ontario / CAD, Dine-in and Pickup, with Delivery disabled. Real Store,
Provider and production readiness are tracked separately in the
[Pilot readiness inventory](docs/runbooks/pilot-integration-readiness-inventory.md).

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

The WSL/Linux environment supervisor validates the pinned toolchain, configuration, secret-file
permissions, Docker backend and localhost ports, then starts PostgreSQL and the four application
composition roots with one foreground command:

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

For the separately gated, read-only local showcases, run either command:

```bash
pnpm demo:merchant
pnpm demo:customer
```

These previews use labelled synthetic data. They do not create Orders, take Payment or prove the
normal runtime is connected. The normal production builds exclude the demo entry points.

## Verification

```bash
node --version
pnpm --version
pnpm exec turbo --version
pnpm install --frozen-lockfile
pnpm repository-guidance:check
pnpm migration:check
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

Use the current WP's exact verification matrix. On macOS, use `TMPDIR=/private/tmp CI=true pnpm
verify` for canonical temporary paths. The root environment lifecycle checks require WSL/Linux;
local success does not replace the exact candidate's CI, external evidence or release decision.

## Repository guidance

- [`docs/adr/`](docs/adr/README.md) contains the stable ADR register and template.
- [`docs/templates/module/README.md`](docs/templates/module/README.md) is the later-module README template; it does not instantiate a module.
- [`.agents/skills/`](.agents/skills) contains the five explicitly triggered BOP-RMS project workflows. They guide execution and never replace `AGENTS.md`, the current WP brief, CI/tests, or explicit external-action authority.

Run `pnpm repository-guidance:check` after changing any of these artifacts.

The Section 48.2 Module Manifest authoring contract and deterministic synthetic fixtures live in [`tooling/module-manifest`](tooling/module-manifest). A Manifest uses an unscoped kebab-case logical `moduleName`, a separate canonical `packageName` of `@bop/<moduleName>` or `@rms/<moduleName>`, and the matching `BOP` or `RMS` layer; synchronous dependency identities use the same three-part contract. Run `pnpm module-manifest:check` after changing that contract. Database names in a Manifest declare ownership; a declaration alone does not create a database object or implement its Repository.

The bounded Module Generator lives in [`tooling/module-generator`](tooling/module-generator). Its JSON input requires Layer, unscoped Module Name, exact Package Name, Phase, Allowed Dependencies, future database schema metadata, and a caller-supplied Owner role. Inspect the closed input and safety behavior with `pnpm module-generator --help`, and run `pnpm module-generator:check` after changing it. The target is derived under `packages/bop/*` or `packages/rms/*`; existing, partial, unsafe, or case-colliding targets are never overwritten. Generator tests use temporary synthetic roots, and WP-0011 commits no generated business Module.

The Import Boundary Architecture Test lives in [`tooling/import-boundary`](tooling/import-boundary). Run `pnpm import-boundary:check` or inspect `node tooling/import-boundary/validate.mjs --help`. It discovers canonical Modules from their WP-0010 Manifest plus WP-0011 layout, requires exact package/export-map agreement, and rejects BOP-to-RMS, cross-Module relative/private/unexported/undeclared imports, case conflicts, path escapes, and unresolved dynamic imports. Tests use temporary synthetic Modules; WP-0012 commits no business Module.

The Database Schema Ownership Architecture Test lives in [`tooling/database-ownership`](tooling/database-ownership). Run `pnpm database-ownership:check` or inspect `node tooling/database-ownership/validate.mjs --help`. It treats WP-0010 `ownedDatabase` as the sole business ownership source, validates pure-literal table/access evidence plus the finite shared-infrastructure registry, and rejects conflicts, non-owner writes, unresolved targets, unsafe paths, and unsupported real persistence assets. The root migration catalog, shared driver and each accepted Module adapter have explicit ownership boundaries; an existing schema does not authorize a new persistence path. Tests use temporary synthetic Modules and migration catalogs.

The Domain Layer Technology Dependency Test lives in [`tooling/domain-layer-boundary`](tooling/domain-layer-boundary). Run `pnpm domain-layer-boundary:check` or inspect `node tooling/domain-layer-boundary/validate.mjs --help`. It reuses WP-0012 Module discovery and source-reference parsing, scans only Canonical Module `src/domain/**`, treats type-only edges like runtime edges, and rejects Application / Infrastructure / Interface, ORM / database, HTTP / transport, Provider SDK, Node runtime / I/O, dynamic, unresolved, unsafe, or unclassified dependencies. Its pure-literal registry classifies technology safety only and grants no Module, export, package-install, Provider, or business authority. Tests use fully cleaned temporary synthetic Modules; WP-0014 commits no real Module or dependency.

## Database migrations

The integrated WP-0020 Migration Runner lives in [`packages/database`](packages/database) and executes only the immutable root [`migrations`](migrations) catalog. Inspect the catalog and CLI without connecting to PostgreSQL：

```bash
pnpm migration:check
pnpm db:migrate -- --help
pnpm foundation:check
pnpm foundation:verify -- --help
```

With an ignored environment file and 0600 password file，observe or verify a target explicitly：

```bash
pnpm db:migrate -- status --env-file .env
pnpm db:migrate -- verify --env-file .env
pnpm db:migrate -- apply --env-file .env --confirm-target local:bop_rms_local
```

`apply` is the only mutating command. It uses one dedicated client, the accepted advisory lock and
one transaction per migration. There is no down, repair, baseline, force or checksum-bypass path;
applied migrations are immutable and corrected through reviewed forward migrations. The catalog
now includes foundation, platform and restaurant Module schemas and tables. Identity Guest Session,
Ordering Cart creation/current ownership, Audit and Eventing have real persistence code; individual business repositories and runtime
composition must be verified separately. Consult the catalog and owning Module manifests for the
current inventory rather than the original WP-0021 foundation snapshot.

After applying the catalog to an explicitly configured target，run the independent read-only verifier with `pnpm foundation:verify -- --env-file <path>`。It checks exact foundation schemas、owner、PUBLIC / default privileges and unexpected objects without executing DDL or repairing state。

## Workspace boundaries

- `apps/`: deployable composition roots and runtime entry points
- `packages/`: reusable BOP/RMS modules, contracts, persistence infrastructure, and testing support
- `tooling/`: shared engineering configuration and developer tooling

Applications compose public contracts and render their owned screens; Domain rules remain in the
owning packages. `packages/ui` supplies shared semantic tokens and accessibility primitives. An
implemented screen, registered route or passing isolated test does not by itself establish that its
production data source is connected.

## Delivery sequence

The [status ledger](docs/spec/project-status.md) maintains the evidence-backed integration record
through WP-2214 and the separate local work. WP-2215 verifies persisted Entry in a real browser;
WP-2216 adds Cart creation/current ownership and its opt-in PostgreSQL adapter. Consult each brief
for actual verification and integration status. WP-2217 adds opt-in HTTP composition for pristine
empty Carts, with an explicit public display source prerequisite. WP-2218 adds opt-in durable
Item commands and original-result replay; see its brief for current verification evidence.
The dedicated regression runs with `pnpm cart-item-store:acceptance` and is included in
`pnpm ordering-cart:acceptance`. WP-2219 adds optional persisted unquoted Pickup/changed-empty
HTTP reads with public Catalog names and explicitly unavailable prices. Its regression is
`pnpm customer-cart-presentation:acceptance`. WP-2221 adds opt-in Pickup Item HTTP writes with atomic Quote-absence evidence and original response replay. Next connect shared-Cart visibility,
lifecycle and Quote storage, then Payment-owned Order orchestration and the Worker /
Kitchen / Pickup / Receipt path. Each increment retains its owning contracts,
authorization, replay and failure checks. New horizontal features must not substitute for this
end-to-end acceptance.

WP-2220 adds optional pre-commit public label snapshots to persisted Cart Item operations, preserving
original labels on authorized retries. This prerequisite does not enable Customer HTTP writes or
provide Quote/Pricing evidence. See [the work package](docs/spec/work-packages/WP-2220.md).

WP-2221 verifies Pickup Item HTTP mutations with isolated persistence and synthetic public sources.
Default runtime activation and real Pricing remain gated; see [WP-2221](docs/spec/work-packages/WP-2221.md).

WP-2222 adds `pnpm customer-cart-browser:acceptance`: normal production assets, signed synthetic
Pickup entry, public Menu and persisted Cart Add/Update/Remove in Chromium at mobile and desktop
sizes. The gate checks offline recovery, refresh/CSRF refusal, private storage and database/Audit
results; CI runs it after Chromium installation. See [WP-2222](docs/spec/work-packages/WP-2222.md)
for executed evidence. This does not supply real public sources, Session resume, Pricing or checkout.

WP-2223 adds optional PostgreSQL persistence for the existing Cart Abandon/Expire commands with
atomic Audit, exact retry and immutable Item/Quote history. Its dedicated gate is
`pnpm cart-lifecycle-store:acceptance`, also included in `pnpm ordering-cart:acceptance`.
HTTP, scheduler and real lifecycle policy sources remain unconfigured; see
[WP-2223](docs/spec/work-packages/WP-2223.md) for verification evidence.
