# ADR-0030 — Domain Layer Technology Dependency Boundary

- Status: `Accepted`
- Owner: BOP-RMS Owner
- Decision date: `2026-07-17`
- Effective version: `BOP-RMS-HANDOFF 0.5.5 / architecture baseline v1.0`
- Affected modules: all future Canonical BOP/RMS Modules with Domain source
- Related Work Package: `WP-0014`
- Source: Canonical Handoff Section 93
- Implementation decision: `IDR-0043 — Domain Dependency Evidence, Resolution and Diagnostics`
- Supersedes: `None`
- Superseded by: `None`

## Context

Define the executable static boundary that prevents Canonical Module Domain source from depending on Application、Infrastructure、Interface、ORM / database、HTTP / transport、Provider SDK、Node runtime / I/O or unclassified technology dependencies。This ADR authorizes no checker implementation、real Module、Domain behavior、dependency、lockfile、persistence、Provider、API、UI or deployment change。

## Decision

## Authority and reuse

- Canonical Modules、logical names、Package Names、Layers、directories、Manifest dependencies and public exports remain exclusively owned by the integrated WP-0010–0012 contracts。
- WP-0014 must reuse WP-0012 Module discovery、TypeScript-aware source-reference parsing、path safety and public-export resolution；it cannot establish a second identity、layout or export authority。
- Section 92 / WP-0013 remains independently authoritative for database ownership and staged rejection of real persistence assets。

## Scan and edge contract

- Scan only `packages/bop|rms/<moduleName>/src/domain/**` when that exact real directory exists。
- Include `.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs` and `.cjs`；`.d.ts` is included as `.ts`。
- Cover static import、re-export、`import type`、TypeScript import-type、import-equals、one-literal dynamic import and one-literal `require`。
- Type-only and declaration-only references obey the same boundary as runtime imports。
- Relative references are legal only when exact resolution stays inside the same `src/domain/**` root。
- Same-Module targets under `application`、`infrastructure` or `interfaces` are forbidden；other non-Domain targets require explicit Domain-safe package evidence rather than path-based inference。
- Canonical workspace package references must first pass WP-0012 identity、Layer、Manifest dependency and exact public-export checks。

## Domain dependency classification

WP-0014 will own one pure-literal registry at `tooling/domain-layer-boundary/domain-dependencies.manifest.ts`。It classifies technology safety only and cannot create Module identity、Layer、dependency、export or business authority。

Each version-`1` record has exact `packageName`、one `classification` and deterministic `allowedSubpaths`。Closed classifications are：

- `domain-safe`
- `orm-database`
- `http-transport`
- `provider-sdk`
- `runtime-io`

Only exact `domain-safe` subpaths are allowed；wildcards、prefix grants、case folding and implicit transitive approval are prohibited。Prohibited classifications apply to every package subpath and have no allowed subpaths。Unknown、duplicate、case-conflicting、non-literal or unclassified dependencies fail closed。

Node `24.18.0` built-ins, including `node:` and exact bare built-in names, are intrinsically `runtime-io`。Domain code uses accepted pure abstractions for Clock、ID、Money and similar capabilities rather than importing runtime facilities directly。

## IDR-0043 resolution mechanics

Resolution is deterministic and fail closed：non-literal target；case / containment / symlink safety；relative target；exact Module-local alias；WP-0012 workspace package；Node built-in；then registry classification。

Allowed aliases are finite：

- one exact non-pattern `package.json#imports` key with one repository-relative string target；
- one exact non-pattern TypeScript `paths` key with one string target resolved from effective `baseUrl`。

Wildcard、conditional、array、multiple-candidate、external、ambiguous or escaping aliases fail resolution。The final resolved target receives the same Domain-local、Layer、workspace and classification checks；an alias never changes target authority。

## Diagnostics and exit behavior

Format：`<path>:<line> [<CODE>] <message>`。Sort by normalized repository-relative path、numeric line、code and message。Closed codes：

- `DOMAIN_TO_APPLICATION`
- `DOMAIN_TO_INFRASTRUCTURE`
- `DOMAIN_TO_INTERFACE`
- `DOMAIN_ORM_DATABASE_DEPENDENCY`
- `DOMAIN_HTTP_DEPENDENCY`
- `DOMAIN_PROVIDER_SDK_DEPENDENCY`
- `DOMAIN_RUNTIME_IO_DEPENDENCY`
- `DOMAIN_UNCLASSIFIED_DEPENDENCY`
- `DOMAIN_DYNAMIC_REFERENCE`
- `DOMAIN_UNRESOLVED_REFERENCE`
- `CASE_CONFLICT`
- `PATH_ESCAPE`
- `SYMLINK_PATH`
- `UNREADABLE_DOMAIN_SOURCE`

Exit `0` means success / help、`1` means an Architecture or resolution violation、and `2` means invalid usage、missing / unreadable repository root、unreadable Domain root / source or internal failure。Identical bytes under the pinned runtime must produce byte-identical output and stable exits。An unreadable Domain path uses the formatted diagnostic at line `1` when a safe repository-relative path exists；otherwise the CLI uses `Domain Layer Boundary error: <message>`。

## Acceptance and evidence

The separately authorized WP-0014 brief must map identity/discovery reuse、all source forms and file types、legal Domain-local and Domain-safe references、each forbidden classification / Layer、workspace private boundaries、alias handling、dynamic / unresolved targets、case / path / symlink / unreadable behavior、help and `0 | 1 | 2` exits、deterministic repeated output、temporary cleanup、root / sole-workflow integration and unchanged WP-0010–0013 gates。

The focused synthetic suite has a minimum of five positive and twenty-five negative / boundary scenarios。Fixtures live only in temporary roots、are completely removed after success or failure and contain no real Store、Provider、credential、endpoint、payment、allergy / health or PII fact。

## Consequences、security and non-goals

A `domain-safe` record is not approval to install a package and is not Provider、license、security、privacy or business evidence。Actual dependencies and lockfile changes remain owned by later authorized WPs。Section 92 continues to reject real persistence assets regardless of classification。

This decision changes no Domain fact、Aggregate lifecycle、Command/Event、Actor、Permission、Tenant / Brand / Store scope、money、time、idempotency、Audit、Outbox / Inbox、transaction、retention、migration、replay or runtime permission behavior。

## Rollback and next gate

Changing classifications、resolution、diagnostics or exits requires an accepted Handoff / ADR / IDR revision；a WP brief cannot weaken them。The next allowed action is a separately authorized WP-0014 bounded brief and implementation preflight。This documentation closure authorizes no branch、worktree、checker、spec-index activation、commit、push、PR or merge。

## Revisit trigger

Revisit only when an owning later WP needs a new Domain-safe dependency、a new package-resolution form or a changed technology classification；the trigger requires accepted ADR / IDR / Handoff evidence before checker code changes。
