# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.3`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 91`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Section 89 is authoritative for repository guidance and WSL2; Section 90 is authoritative for Codex, Figma, plugins, skills, and external-mutation boundaries; Section 91 is authoritative for GitHub Free solo governance and current WP-0001 execution status.

## Active Work Package

- [`WP-0005 — Establish Docker Compose and PostgreSQL Local Environment`](work-packages/WP-0005.md)

WP-0001 through WP-0004 are integrated into `main`; WP-0005 is based on the accepted WP-0004 squash-merge commit `c3ffec49ac1e0c14ff98a091f4b1dc228089f678`.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0005 owns only the Docker Compose and PostgreSQL `18.4` local environment, its safe secret template, bounded lifecycle documentation, and self-cleaning verification. It must preserve the four application skeletons, truthful database `not_configured` readiness, shared UI foundation, and machine-checkable 210-screen Section 88 mirror from WP-0004.

WP-0005 is based directly on the integrated WP-0004 `main` baseline. It does not authorize migration/schema/extension/seed/database-driver work, WP-0006 root startup or environment validation, production settings, deployment, Figma changes, or external Provider mutation. Commit, push, Draft Pull Request, WP-scoped CI repair, Ready transition, expected-head squash merge, post-merge CI verification, and clean main-worktree fast-forward are authorized for this WP only.
