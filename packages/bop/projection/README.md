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
Later WP-1901–1903 own Payment, Kitchen and Fulfillment operational Projections.

## Boundaries

- Inputs are immutable public Events/query snapshots; private repositories/tables are forbidden.
- Tenant, Brand, Store, Business Date, checkpoint, UTC time and freshness remain explicit.
- Amounts, Provider payloads/IDs, Customer/contact, allergy/health narrative, credentials and free
  text are excluded.
- Projection rows are disposable and replayable; source facts and append-only evidence are not.
- No persistence, migration, worker, external Provider or production composition exists yet.

## Verification

Run `pnpm --filter @bop/projection typecheck`, `lint`, `test` and `build`, followed by repository
Module Manifest, import/Domain boundary and database ownership checks.
