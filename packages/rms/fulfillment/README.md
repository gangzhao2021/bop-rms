# `fulfillment`

Fulfillment-owned, runtime-inactive Pickup Aggregate creation from an authorized public Ordering
source.

## Identity and responsibility

- Module Name: `fulfillment`
- Package Name: `@rms/fulfillment`
- Layer / Domain: `RMS / Delivery & Fulfillment`
- Phase / owning Work Package: `Phase 1 / WP-1600–WP-1604`
- Owner role: `Fulfillment Engineering Owner`
- Status: `active contract and persistence boundary; runtime inactive`
- Responsibility: create one Store-scoped Pending Pickup Fulfillment from `OrderConfirmed.v1`,
  consume exact `KitchenItemReady.v1` facts into append-only Item Ready results, derive the
  Aggregate Ready phase, issue/regenerate/validate Ready-bound Pickup Proof evidence, and plan an
  authorized append-only Pickup Handoff with exact cumulative quantity and completion derivation.
  A strict `FulfillmentCompleted.v1` publication exposes the minimal completed business fact.
- Explicit non-goals: private Ordering/Kitchen reads, non-Kitchen Ready, raw proof
  generation/hashing, unaccepted handoff Events, Delivery persistence, live API/SSE, grants and
  production activation.

WP-2150 adds runtime-inactive Delivery Task creation and dispatch contracts. Execution and
Assignment state remain separate; every Offer is a single active TTL-bound append-only Attempt with
pinned Dispatch Policy and Route Plan versions. Late acceptance, parallel offers, indeterminate
candidate evidence and automatic-attempt exhaustion fail closed or create a dispatch exception.
No live worker, Provider, scheduling/location result or Delivery persistence is claimed.

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

`planPickupProofIssue` composes an exact locked Ready source with WP-1005's already purpose-hashed
capability. Generation one and exact-next regeneration are append-only; regeneration records prior
invalidation and cannot reset expiry beyond 60 minutes after the original Ready fact.
`validatePickupProof` accepts only the current Store/Fulfillment/generation/version/hash and returns
a bounded `Validated` evidence record with `grantsCompletionAuthority=false`. Raw QR/PIN material
never enters this module.

`planCompletePickupHandoff` separately requires the exact staff permission, purpose, expected
Aggregate version and current validated proof. It appends actual quantities without exceeding the
Ready remainder, leaves partial pickup `InProgress`, and derives `Completed` only when every Item is
fully handed over. It produces no public Event; WP-1604 retains that boundary.

`createFulfillmentCompletionPublication` accepts only a final Completed effect and produces the
strict Store-scoped, System-actor `FulfillmentCompleted.v1` event plus a stable semantic binding.
The payload excludes proof material, recipient/customer data, actor/device and free text.

## Dependencies

- Allowed synchronous dependencies: public `@bop/audit`, `@bop/eventing`,
  `@bop/public-capability`, `@rms/kitchen` and `@rms/ordering` only.
- Allowed asynchronous dependencies: public `OrderConfirmed.v1` and `KitchenItemReady.v1` through
  the Event Catalog.
- Forbidden: private module paths, foreign repositories/tables, HTTP/ORM/SDK in Domain code and
  client-side lifecycle authority.
- Dependency failure is retryable; invalid, unauthorized, non-Pickup or conflicting evidence never
  produces an Aggregate.

## Data ownership and lifecycle

- Owned: Pickup Fulfillment Aggregate, Fulfillment Item Entity, immutable creation operation, Item
  Ready result/operation, Pickup Proof evidence and Pickup Handoff record/item/operation history.
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
`fulfillment_ready_operation`; `1700_003` adds four Pickup Proof tables; `1700_004` adds three
Pickup Handoff tables; `1700_005` adds the append-only completion publication.
PUBLIC access is revoked and all tables use forced RLS. Current readiness/proof generation are
derived from append-only facts and ordered Aggregate versions. Generic Inbox completion, result,
operation and Audit share the caller transaction. WP-1600–WP-1602 publish no Domain Event.

## Security and privacy

The source DTO excludes Customer name/contact/address, Customer note or health narrative, Pickup
proof, Catalog definition, price/tax, Payment/Provider and credential data. Errors are bounded and
non-enumerating. No production Actor, Store, role, grant or external evidence is claimed.

## Development and verification

```bash
pnpm pickup-fulfillment:acceptance
pnpm fulfillment-readiness:acceptance
pnpm pickup-proof:acceptance
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
- Next allowed Work Package: `WP-1605 — Order Completion Projection` after WP-1604 integration.
