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

- [`WP-0010 — Establish Module Manifest Schema`](work-packages/WP-0010.md), Canonical Module Identity Naming corrective follow-up

WP-0001 through WP-0010 are integrated into `main` at corrective baseline `b921321d6adf579b5c0e1b9e4d9636efbfb28adf`. The active WP-0010 follow-up corrects only the merged Manifest identity naming contract before WP-0011 may begin.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

The WP-0010 corrective follow-up owns only the Module Name, Package Name, Layer, and synchronous dependency identity semantics in the Section 48.2 Manifest contract, plus synthetic fixtures, deterministic validation, and matching guidance. Database fields remain inert future ownership declarations. It does not authorize a business Module, generator, import/database/ORM architecture scan, migration, real schema/table, ORM, seed, business database integration, Provider, production infrastructure, deployment, or Figma changes.

Commit, push, Draft Pull Request, WP-scoped CI repair, Ready transition, expected-head squash merge, post-merge CI verification, and main-worktree fast-forward while preserving the two user-provided untracked Canonical Evidence files are authorized for this corrective follow-up only.
