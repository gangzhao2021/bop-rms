# `projection`

## Identity and responsibility

- Package: `@bop/projection`
- Layer: BOP shared infrastructure
- Lifecycle: Phase 1, introduced by WP-1809
- Owner: Operations Projection Engineering Owner
- Status: active, contract-first; persistence externally gated

This module owns rebuildable operational Projection contracts. `platform_projection` is a reserved
shared-infrastructure schema rather than Module-owned storage; a later persistence WP must declare
explicit `projection-builder` access. This module does not own Dining, Ordering, Payment, Kitchen,
Fulfillment or Task source facts and cannot authorize their lifecycle or financial finality.

## Public contract

WP-1809 exports `merchant_order_exception_v1`, strict source parsing, deterministic rebuild and
permission/version/idempotency-bound action intent routing. WP-1900 exports
`merchant_order_queue_v1` with explicit collaborating-domain gaps and a 2-second freshness target.
WP-1901 exports `payment_operations_v1` using exact CAD minor-unit strings and retaining Provider
Unknown/reconciliation gaps. WP-1902 exports `kitchen_operations_v1` without replacing the
Kitchen-owned board projection and without client-derived completion. WP-1903 exports
`fulfillment_operations_v1` with minimized proof readiness and source-only Handoff completion.
WP-1904 adds the authorized, idempotent Projection Rebuild Command contract. It reads a fixed source
checkpoint in bounded batches, writes only a shadow generation, validates that generation and asks
the persistence adapter to atomically switch it under the expected active-generation guard.
WP-1905 exports the permission- and scope-bound `reporting_operations_dashboard_v1` Query. It
aggregates exact CAD minor-unit summaries and operational counts while preserving per-source
freshness, completeness and checkpoint lineage; a missing source yields `null`, never a false zero.

## Boundaries

- Inputs are immutable public Events/query snapshots; private repositories/tables are forbidden.
- Tenant, Brand, Store, Business Date, checkpoint, UTC time and freshness remain explicit.
- Amounts, Provider payloads/IDs, Customer/contact, allergy/health narrative, credentials and free
  text are excluded.
- Projection rows are disposable and replayable; source facts and append-only evidence are not.
- No persistence, migration, worker, external Provider or production composition exists yet.
- A failed rebuild abandons its shadow generation; it never clears or partially replaces the active
  generation. The adapter owns durable lease, checkpoint and atomic-switch enforcement.

## Verification

Run `pnpm --filter @bop/projection typecheck`, `lint`, `test` and `build`, followed by repository
Module Manifest, import/Domain boundary and database ownership checks.
