# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.6`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 94`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Section 89 is authoritative for repository guidance and WSL2; Section 90 is authoritative for Codex, Figma, plugins, skills, and external-mutation boundaries; Section 91 is authoritative for GitHub Free solo governance; Section 92 is authoritative for WP-0013 database-ownership evidence; Section 93 is authoritative for WP-0014 Domain-layer technology-dependency enforcement; Section 94 is authoritative for WP-0020 migration catalog、namespace、bootstrap、integrity、locking、transaction、diagnostic and staged-enforcement behavior.

## Active Work Package

- [`WP-0020 — Migration Runner and Namespace Rules`](work-packages/WP-0020.md)

WP-0001 through WP-0014 are integrated into `main` at squash baseline `da3f911bfa81f468308d7e4404f7642b3c2abb6a`. WP-0020 is active from that exact baseline.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0020 owns only the common Migration Runner、root migration catalog / namespace registry、byte-exact integrity and deterministic CLI、the minimal `platform_core.migration_history` bootstrap control plane、focused synthetic / isolated-database tests and root / CI / guidance integration。It does not authorize business Module persistence、WP-0021 Core / Eventing / Audit / Job functional schemas and tables、a reusable seed / fixture framework、application startup migration、Provider、production connection / deploy、API / UI or a vertical slice。

The Owner authorized the bounded WP-0020 branch、documentation、implementation、accepted dependency / lockfile change、local isolated PostgreSQL verification and one commit、push / Draft Pull Request on `2026-07-17`。Ready transition、merge、deploy、production connection、WP-0021 and Provider mutation remain unauthorized and require later explicit authorization。
