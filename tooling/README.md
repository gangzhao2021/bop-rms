# Tooling

This directory contains repository-wide, workspace-consumable engineering configuration and developer tooling.

WP-0003 establishes the root TypeScript base configuration, ESLint flat configuration, Prettier policy, and Vitest runner. The `vitest/` directory contains only the tooling smoke test that proves TypeScript test discovery and execution. WP-0004 adds `screen-registry/` to reproduce the 210-ID Section 88 mirror from the canonical Handoff and validate its schema, references, routes, placement, navigation targets, and work-package resolution. WP-0005 adds `postgres/` for its bounded PostgreSQL Compose lifecycle.

WP-0006 adds `environment/` for root validation, foreground orchestration, status, stop, and self-cleaning verification of the already integrated local services. It does not configure application database access or create WP-0007 setup templates or project skills.

Tooling must not become a home for domain logic, runtime application code, credentials, or machine-specific configuration. Applications and reusable packages extend the root contracts in their owning Work Packages.
