# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.5`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 93`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Section 89 is authoritative for repository guidance and WSL2; Section 90 is authoritative for Codex, Figma, plugins, skills, and external-mutation boundaries; Section 91 is authoritative for GitHub Free solo governance; Section 92 is authoritative for WP-0013 database-ownership evidence; Section 93 is authoritative for WP-0014 Domain-layer technology-dependency enforcement.

## Active Work Package

- [`WP-0014 — Domain Layer ORM / Infrastructure Test`](work-packages/WP-0014.md)

WP-0001 through WP-0013 are integrated into `main` at squash baseline `d3221393cf5bba4d4d8bda8a4c7b482541d28760`. WP-0014 is active from that exact baseline.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0014 owns only deterministic Domain-source dependency enforcement, the pure-literal Domain dependency-classification registry, synthetic temporary fixtures/tests, reuse of WP-0010–0012 identity/layout/parser contracts, and root/CI/guidance integration. It does not authorize a real business Module or Domain behavior, real persistence asset, dependency/lockfile change, migration runner/schema/table, Provider integration, production/deploy/Figma change, or the first vertical slice.

The Owner separately authorized one WP-0014 commit、push and Draft Pull Request on `2026-07-17`。Ready transition、merge、deploy and Provider mutation remain unauthorized and require later explicit authorization。
