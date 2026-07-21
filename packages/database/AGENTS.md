# Database Infrastructure Agent Guide

## Scope

- This package owns common PostgreSQL connection and migration infrastructure only.
- It never owns a business fact, Module schema/table, Repository, seed, or application startup policy.
- Read the active Work Package, Canonical Sections 50, 56, 87, 92–94, ADR-0029, and ADR-0031 before changing migration behavior.

## Migration invariants

- Execute migrations only from the root `migrations/` catalog and validate Manifest/platform-registry ownership before DDL.
- Applied migration bytes and append-only history are immutable. Never add down, repair, baseline, force, checksum-bypass, or mark-applied behavior.
- Use the fixed advisory lock, one dedicated client, one transaction per migration, finite local timeouts, fully qualified SQL, and atomic history insertion.
- Keep the WP-0021 foundation verifier independent and read-only. It may inspect expected schemas, owner, ACL and unexpected objects but never execute DDL or repair state.
- Keep WP-0013 fail-closed for Module persistence. A package/database exception is not a Module exception.

## Security and verification

- Never accept or log a password, DSN, SQL body, bind value, unrestricted database error, or real business/PII fixture.
- Local integration databases must have unique active-WP-owned names and be cleaned after both success and failure.
- Run the active WP migration, ownership, integration, root, security, and final-diff checks before handoff.
