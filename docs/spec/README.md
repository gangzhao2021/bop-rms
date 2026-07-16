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

- [`WP-0002 — Establish Workspace Directory Baseline`](work-packages/WP-0002.md)

WP-0001 remains the dependency baseline and is integrated into `main` at `aa7a238`.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0002 owns only the tracked `apps/`, `packages/`, and `tooling/` boundaries, their concise ownership contracts, and deterministic checks added to `bootstrap / verify`. It does not authorize package manifests, applications, TypeScript source, databases, infrastructure, providers, or business behavior. Commit, push, Pull Request mutation, and merge remain separately authorized external actions.

WP-0002 is based directly on the integrated WP-0001 `main` baseline. Do not duplicate, squash, or rewrite the WP-0001 evidence as part of this Work Package.
