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

- [`WP-0006 — Establish Root Scripts and Environment Validation`](work-packages/WP-0006.md)

WP-0001 through WP-0005 are integrated into `main`; WP-0006 is based on the accepted WP-0005 squash-merge commit `6bfb77e990343821b3dcb3812f30b2edc045d1f3`.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0006 owns only root local-environment scripts, startup-time environment validation, and deterministic orchestration of the already integrated PostgreSQL and four application skeletons. It must preserve truthful database `not_configured` readiness and the WP-0005 PostgreSQL lifecycle boundary.

WP-0006 is based directly on the integrated WP-0005 `main` baseline. It does not authorize WP-0007, migration, schema, ORM, seed, business database integration, production infrastructure, deployment, Figma changes, or external Provider mutation. Commit, push, Draft Pull Request, WP-scoped CI repair, Ready transition, expected-head squash merge, post-merge CI verification, and clean main-worktree fast-forward are authorized for this WP only.
