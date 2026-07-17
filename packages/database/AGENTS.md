# Database Infrastructure Agent Guide

## Scope

- This package owns common PostgreSQL connection and migration infrastructure only.
- It never owns a business fact, Module schema/table, Repository, seed, or application startup policy.
- Read the active Work Package, Canonical Sections 50, 56, 87, 92–94, ADR-0029, and ADR-0031 before changing migration behavior.

## Migration invariants

- Execute migrations only from the root `migrations/` catalog and validate Manifest/platform-registry ownership before DDL.
- Applied migration bytes and append-only history are immutable. Never add down, repair, baseline, force, checksum-bypass, or mark-applied behavior.
- Use the fixed advisory lock, one dedicated client, one transaction per migration, finite local timeouts, fully qualified SQL, and atomic history insertion.
- Keep WP-0013 fail-closed for Module persistence. A package/database exception is not a Module exception.

## Security and verification

- Never accept or log a password, DSN, SQL body, bind value, unrestricted database error, or real business/PII fixture.
- Local integration databases must have unique WP-0020-owned names and be cleaned after both success and failure.
- Run the active WP migration, ownership, integration, root, security, and final-diff checks before handoff.
