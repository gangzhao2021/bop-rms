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

- [`WP-0004 — Establish Application Skeletons`](work-packages/WP-0004.md)

WP-0001 through WP-0003 are integrated into `main`; WP-0004 is based on the accepted WP-0003 integration commit `12ec26e0c72b03e16b14283d336e09883fa63771`.

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-0004 owns the API, worker, merchant web, and customer PWA runtime skeletons; the minimal shared UI foundation; the machine-checkable 210-screen Section 88 mirror; and their bounded tests. It does not authorize business pages, databases, migrations, Docker, providers, production authentication, deployment, or WP-0005 work.

WP-0004 is based directly on the integrated WP-0003 `main` baseline. Commit, push, Draft Pull Request creation, and WP-0004-scoped CI repair are authorized. Merge, deployment, external-service mutation, and WP-0005 remain unauthorized.
