# BOP-RMS Specification Index

## Authority

- Canonical Library file: `BOP-RMS Complete Handoff Package.md`
- Source document ID: `BOP-RMS-HANDOFF`
- Source document version: `0.5.4`
- Architecture baseline: `v1.0`
- Current discussion node: `Closed — Section 92`

The complete Handoff Package remains outside this repository and is not duplicated here. Resolve it through the approved Library context using the exact canonical filename. Never store Library credentials, signed URLs, account identities, or private access metadata in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Section 89 is authoritative for repository guidance and WSL2; Section 90 is authoritative for Codex, Figma, plugins, skills, and external-mutation boundaries; Section 91 is authoritative for GitHub Free solo governance and current execution status.

## Active Work Package

- [`WP-0013 — Database Schema Ownership Test`](work-packages/WP-0013.md)

WP-0001 through WP-0012 are integrated into `main` at squash baseline `70b7afe82b626837d1c2f3ae46892198a9761361`. WP-0013 is active from that exact baseline.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0013 owns only deterministic declaration-based database schema/table ownership and access-evidence enforcement, synthetic fixtures/tests, reuse of WP-0010–0012 identity/layout/diagnostic contracts, and root/CI/guidance integration. It does not authorize a real business Module, real persistence asset, Domain-layer ORM scan, migration runner/schema/table, Provider, production/deploy/Figma change, or the first vertical slice.

Commit, push, Draft Pull Request, WP-scoped CI repair, explicit solo self-review, Ready transition, expected-head squash merge, post-merge CI verification, and main-worktree fast-forward while preserving the two user-provided untracked Canonical Evidence files are authorized for WP-0013 only.
