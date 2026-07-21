# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.7`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 95`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Sections 89–91 govern repository execution、Codex / Figma operation and GitHub Free solo governance; Sections 92–94 govern database ownership、Domain dependency enforcement and Migration Runner behavior; Section 95 is authoritative for WP-0021 foundation schema、owner、ACL、isolation and verifier behavior.

## Active Work Package

- [`WP-0021 — Core / Eventing / Audit / Job Foundation Schemas`](work-packages/WP-0021.md)

WP-0001 through WP-0020 are integrated into `main` at baseline `44b79f4385eb2f16ac9c697ec33291a60b3bdb66`. WP-0021 documentation、bounded implementation、isolated PostgreSQL verification and final Architecture / Data / Security review passed from that exact baseline on `2026-07-20`。Ready-for-review PR #15 and its owning CI passed；the Owner authorized squash merge，while deployment remains gated。

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0021 is schema-only：harden the existing `platform_core` schema ACL and create empty `platform_eventing`、`platform_audit` and `platform_jobs` schemas with exact owner、default-deny ACL、read-only verification and isolated-test contracts。It creates zero functional tables；`platform_core.migration_history` remains the sole table；`platform_projection`、runtime grants、roles / logins、RLS policies and later Eventing / Audit / Job / Idempotency objects remain excluded。

The Owner authorized the bounded WP-0021 branch、four exact migrations、independent read-only verifier、minimum root / sole-workflow integration、tests and local isolated PostgreSQL create / drop on `2026-07-20`。The Owner subsequently authorized final review、WP-scoped remediation、commit、push、a Ready-for-review PR、CI inspection and squash merge after successful owning checks。No dependency / lockfile change is authorized or required。Deploy、staging / production connection and Provider mutation remain unauthorized。
