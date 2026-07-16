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

- [`WP-0003 — Establish TypeScript and Quality Tooling`](work-packages/WP-0003.md)

WP-0001 and WP-0002 are integrated into `main`; WP-0003 is based on the accepted WP-0002 integration commit `0d8ce351675b58fd3c0e8d923b995d4633e9592d`.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0003 owns the repository TypeScript base configuration, ESLint flat configuration, Prettier policy, Vitest foundation, exact quality-tool dependencies, and deterministic checks added to `bootstrap / verify`. It does not authorize application or reusable-package manifests, runtime skeletons, business code, databases, infrastructure, providers, deployment, or WP-0004 work.

WP-0003 is based directly on the integrated WP-0002 `main` baseline. Commit, push, and Draft Pull Request creation are authorized for this Work Package; merge, deployment, Provider changes, and WP-0004 remain unauthorized.
