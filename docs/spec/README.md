# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.3`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 91`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Section 89 is authoritative for repository guidance and WSL2; Section 90 is authoritative for Codex, Figma, plugins, skills, and external-mutation boundaries; Section 91 is authoritative for GitHub Free solo governance and current execution status.

## Active Work Package

- [`WP-0010 — Establish Module Manifest Schema`](work-packages/WP-0010.md)

WP-0001 through WP-0007 are integrated into `main`; WP-0010 is based on the accepted WP-0007 squash-merge commit `6d8e7aa415edc434a82dcc4bf4c4f37ab8694b8b`.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0010 owns only the Section 48.2 Module Manifest type/schema contract, synthetic legal and invalid fixtures, deterministic value validation, and root/CI integration. Database fields are inert future ownership declarations. It does not authorize a business Module, generator, import/database/ORM architecture scan, migration, real schema/table, ORM, seed, business database integration, Provider, production infrastructure, deployment, or Figma changes.

Commit, push, Draft Pull Request, WP-scoped CI repair, Ready transition, expected-head squash merge, post-merge CI verification, and clean main-worktree fast-forward are authorized for this WP only.
