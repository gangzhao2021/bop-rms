# ADR-0033 — Database Helper Type and Tenant Context Boundary

- Status: `Accepted`
- Owner: BOP-RMS Owner
- Decision date: `2026-07-21`
- Effective version: `BOP-RMS-HANDOFF 0.5.8 / architecture baseline v1.0`
- Affected modules: shared database infrastructure and future persistence owners
- Related Work Package: `WP-0022`
- Source: Canonical Handoff Section 96
- Implementation decision: `IDR-0046 — Helper DDL, ACL and Verification`

## Context

Sections 50 and 87 establish UUID、Money、Time and Tenant isolation invariants but did not previously close the exact reusable database object、ownership or privilege boundary。Without one accepted contract，future table WPs could create incompatible helpers or turn a shared function into business logic or authorization。

## Decision

WP-0022 creates the migration-owner-owned `platform_helpers` technical schema and only the exact UUID validation、Money storage-domain、IANA / local-time-domain and transaction-local Tenant Context reader objects defined by Section 96。It creates no business fact、table、role、extension、UUID generator/default、rounding engine、Business Date resolver or table-specific RLS policy。

All functions are `SECURITY INVOKER` with fixed safe resolution；PUBLIC receives no schema、type or function privilege，and no runtime grant is made in advance。Later table-owning WPs grant only required access and retain ownership of scope columns、constraints、indexes、RLS、authorization and business semantics。

## Consequences

This provides one explicit database contract without transferring Domain identity、Money calculation、Business Date or Tenant authorization ownership into PostgreSQL。Validation uses four immutable Section 94 migrations、a read-only verifier、synthetic fixtures and unique isolated local databases。Applied changes use forward-fix or independently approved restore only。

## Revisit trigger

Revisit only if PostgreSQL / RDS compatibility、security evidence or a real owning-table contract proves an accepted helper cannot enforce the boundary without changing schema ownership、privilege、type compatibility or Tenant isolation。

## IDR-0046 resolution mechanics

The exact object inventory、migration filenames、ACL、diagnostic / exit contract、behavior matrix and non-goals are Canonical Section 96。Implementation may not add another helper、grant、extension or default without an accepted supersession。
