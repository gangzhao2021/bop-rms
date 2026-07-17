# ADR-0029 — Database Ownership Evidence and Shared Infrastructure Authority

- Status: `Accepted`
- Owner: BOP-RMS Owner
- Decision date: `2026-07-17`
- Effective version: `BOP-RMS-HANDOFF 0.5.4 / architecture baseline v1.0`
- Affected modules: all future BOP/RMS persistence Modules
- Related Work Package: `WP-0013`
- Source: Canonical Handoff Section 92
- Supersedes: `None`
- Superseded by: `None`

## Decision scope

Define the single source of business schema/table ownership, table-governance evidence, and the technical ownership/write-authority boundary for shared PostgreSQL schemas. This ADR does not authorize a real Module, schema, table, migration, ORM model, Repository, connection, seed, or business vertical slice.

## Context

Sections 46, 48, 50, 54, and 56 require CI to reject non-owner schema writes, but the integrated WP-0010 Manifest contains only inert `ownedDatabase.schema/tables` metadata. The older authority did not uniquely define table-governance evidence or shared-infrastructure ownership, so WP-0013 correctly stopped instead of inventing a scanner contract.

## Decision

- WP-0010 `ownedDatabase.schema/tables` is the sole business ownership source.
- Manifest table names are unqualified lower snake_case; the canonical target is `schema.table`.
- Duplicate/case-conflicting schema or fully qualified table ownership fails closed.
- Each owned table has one companion governance record; that evidence cannot create or transfer ownership.
- Business Modules cannot claim `platform_*` or `public`.
- Shared technical schemas use the finite registry and write authorities fixed by Section 92.3.
- Public Query Contracts never grant direct foreign-table access; Projection Builders and Reconciliation Jobs use only explicitly approved sources and write only their own results.
- Real persistence assets remain prohibited until WP-0020 or the first authorized Persistence WP extends the scanner and runtime enforcement.

## Alternatives and decision drivers

Rejected alternatives were inferring ownership from directory/package names, treating `packages/database` as owner of all facts, parsing arbitrary SQL/Drizzle before their persistence contract exists, or accepting advisory declarations without fail-closed gates. The accepted design preserves one business owner, explicit shared exceptions, deterministic CI, and staged delivery.

## Consequences

WP-0013 may implement only a declaration-based architecture test with synthetic fixtures. It must reuse WP-0010 identity/Manifest validation and WP-0011/WP-0012 layout and diagnostic conventions. WP-0014 remains the Domain dependency check; WP-0020+ owns real migration and database assets. This decision introduces no Tenant/Store fact, PII, Provider, production, money/time, transaction, migration, or replay behavior.

## Validation and rollback

Acceptance requires deterministic positive and negative synthetic architecture tests, root/CI integration, fail-closed path/symlink/dynamic/unsupported-asset handling, full baseline verification, and scope/security review. Rollback requires a reviewed ADR/Handoff revision plus IDR-0042 supersession; a WP brief cannot weaken the decision.

## Revisit trigger

WP-0020 or the first authorized Persistence WP introduces the accepted migration, Drizzle, raw-SQL escape-hatch, Repository, or runtime database-permission contract.
