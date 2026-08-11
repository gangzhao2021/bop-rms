# `fulfillment`

Fulfillment-owned, runtime-inactive Pickup Aggregate creation from an authorized public Ordering
source.

## Identity and responsibility

- Module Name: `fulfillment`
- Package Name: `@rms/fulfillment`
- Layer / Domain: `RMS / Delivery & Fulfillment`
- Phase / owning Work Package: `Phase 1 / WP-1600–WP-1601`
- Owner role: `Fulfillment Engineering Owner`
- Status: `active contract and persistence boundary; runtime inactive`
- Responsibility: create one Store-scoped Pending Pickup Fulfillment from `OrderConfirmed.v1`, then
  consume exact `KitchenItemReady.v1` facts into append-only Item Ready results and derive the
  Aggregate Ready phase.
- Explicit non-goals: private Ordering/Kitchen reads, Delivery, non-Kitchen Ready, proof, handoff,
  completion/cancellation, Queue/Detail Projection, API/UI/SSE, live grants and production
  activation.

## Public contract

`createPickupFulfillmentService` exposes registration `fulfillment.confirmed-order:v1` plus an
explicit transactional consumer. It final-authorizes `ConsumeConfirmedOrder /
CreatePickupFulfillment`, asks Ordering's public `createOrderFulfillmentSourceQueryService` for a
strict source, and ignores Dine-in without an effect. Pickup creates a deterministic Aggregate and
Item set. Same-Event and semantic redelivery converge to the original effect; malformed,
cross-scope, changed or partial evidence fails closed.

The initial Aggregate is version `1`, type `Pickup`, phase `Pending`. Every Item is `Pending` with a
positive ordered quantity and zero ready/handed-over quantity. `createFulfillmentReadinessService`
consumes `fulfillment.kitchen-item-ready:v1`, records a full-quantity Item Ready result and derives
Aggregate `Ready` only from the complete owned Item vector. Kitchen Order Ready is not Fulfillment
completion. `fulfillment.operate` is the future Queue/Detail permission, not authority for either
System consumer.

## Dependencies

- Allowed synchronous dependencies: public `@bop/audit`, `@bop/eventing`, `@rms/kitchen` and
  `@rms/ordering` only.
- Allowed asynchronous dependencies: public `OrderConfirmed.v1` and `KitchenItemReady.v1` through
  the Event Catalog.
- Forbidden: private module paths, foreign repositories/tables, HTTP/ORM/SDK in Domain code and
  client-side lifecycle authority.
- Dependency failure is retryable; invalid, unauthorized, non-Pickup or conflicting evidence never
  produces an Aggregate.

## Data ownership and lifecycle

- Owned: Pickup Fulfillment Aggregate, Fulfillment Item Entity, immutable creation operation, Item
  Ready result and Ready operation.
- Scope: required Brand + Store on every record and forced PostgreSQL RLS.
- Concurrency: unique scoped Order identity, permanent semantic operation binding and generic Inbox
  idempotency; no last-write-wins.
- Time: strict UTC instants. Money: not present.
- Classification: `indirect_identifier`; synthetic-only fixtures; references/digests prohibited in
  logs, URLs and analytics.
- Correction: no correction in WP-1600; later approved compensating operation, never history edit.

## Persistence and eventing

Migration `1700_001` creates `rms_fulfillment.fulfillment`, `fulfillment_item` and
`fulfillment_creation_operation`; `1700_002` adds `fulfillment_item_ready_result` and
`fulfillment_ready_operation`. PUBLIC access is revoked and all tables use forced RLS. Current
readiness is derived from append-only facts and ordered Aggregate versions. Generic Inbox
completion, result, operation and Audit share the caller transaction. WP-1600/WP-1601 publish no
Domain Event.

## Security and privacy

The source DTO excludes Customer name/contact/address, Customer note or health narrative, Pickup
proof, Catalog definition, price/tax, Payment/Provider and credential data. Errors are bounded and
non-enumerating. No production Actor, Store, role, grant or external evidence is claimed.

## Development and verification

```bash
pnpm pickup-fulfillment:acceptance
pnpm fulfillment-readiness:acceptance
pnpm --filter @rms/ordering test
pnpm --filter @rms/fulfillment format:check
pnpm --filter @rms/fulfillment lint
pnpm --filter @rms/fulfillment typecheck
pnpm --filter @rms/fulfillment test
pnpm --filter @rms/fulfillment build
```

## Decisions and follow-up

- Authority: WP-0030, WP-0032, WP-0034, WP-0035, WP-0042, WP-0103, WP-1220–WP-1226,
  WP-1310, WP-1400–WP-1408 and IDR-0031 / IDR-0039.
- External Evidence: real Store/Pickup facts, Session/roles, managed-device continuity, accessibility,
  abuse, load, training and UAT remain gated and unclaimed.
- Next allowed Work Package: `WP-1602 — Pickup Proof` after WP-1601 integration.
