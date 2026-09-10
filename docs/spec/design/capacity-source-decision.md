# DEC-H03 - Capacity owner and submission transaction boundary

Status: Accepted by the BOP-RMS Owner in the current session on 2026-09-10.
This record is the scoped DEC-H03 Handoff acceptance addendum.
Prepared in [WP-2336](../work-packages/WP-2336.md) from fd31bdd. This record changes no runtime rule.

## Resolved source facts

The available local BOP-RMS-HANDOFF identifies itself as0.5.9. Its34.34-34.40 defines a Fulfillment
Capacity Hold as an independent aggregate created before a Fulfillment exists. Creation and capacity
occupancy are atomic; terminal Hold states cannot reopen. Hold-to-Allocation conversion is atomic
without a second capacity decrement. Slot limits include Active Holds and unreleased Allocations.
ASAP rechecks current capacity rather than creating a long-lived scheduled Hold. Kitchen capacity
is separate. A local Fulfillment package exists, but its current manifest declares no capacity table.

Higher87.9 and [WP-1302](../work-packages/WP-1302.md) require immutable Submitted/PaymentPending
Ordering facts, snapshots and a capacity allocation committed in one PostgreSQL transaction before
the linked external PaymentIntent is created. Online allocation expires30 minutes from PaymentIntent
creation. Processing/Unknown requires reconciliation; a late success cannot recreate expired capacity.
Section92 prohibits writing foreign private tables. Reading34 does not override87.9 or92.

The current [Payment creation service](../../../packages/rms/payment/src/application/payment-intent-creation-service.ts)
checks preparation committedAt no later than requestedAt, exactly30 minutes between requestedAt and
capacityExpiresAt, and assigns the durable Intent createdAt from requestedAt. Thus current code does
not permit an arbitrary fresh retry timestamp or a fresh30-minute extension. The
[Ordering evidence parser](../../../packages/rms/ordering/src/application/order-payment-preparation.ts)
validates an allocation reference and expiry; validation alone does not produce that fact.

These source facts resolve the early Hold lifecycle. The explicit Owner decision below supplies
the interpretation of the allocation requirement in87.9.
They also do not establish a new synchronous Ordering-to-Fulfillment dependency: the existing
Fulfillment dependency already points to Ordering, so reverse coupling must not create a cycle.

## Accepted topology

1. Fulfillment owns capacity pools, occupancy, Holds, Allocations and immutable owner-issued
   receipts. An application coordinator uses public contracts; neither owner reads the other's tables.
2. Obtain the exact scoped durable hold/allocation commitment through that owner before committing
   Ordering. Ordering atomically writes its immutable submission, first/new Batch, snapshots and an
   Ordering-owned linkage to the exact capacity commitment, with idempotency, Audit and Outbox.
3. The Owner explicitly accepts that owner commitment plus atomic Ordering linkage satisfies
   the capacity-allocation transaction requirement in87.9/WP-1302. This scoped Handoff addendum
   changes that interpretation only. No distributed operation is called a single local transaction.
4. Preserve permanent operation identity and current authority around every wait. If Ordering fails
   after owner capacity acquisition, release that exact owner commitment idempotently; unknown
   release is recovered durably. Do not infer rollback of the other owner's committed work.
5. Retain the original Payment creation/request instant and30-minute expiry relationship. Precise
   pre-Intent handoff/clock reservation and admission of aged preparations must be specified by the
   execution brief before implementing the real producer; an acceptance of topology alone cannot
   redefine the existing code's clock rules. Do not silently rewrite expired receipts.
6. Payment uses the real Ordering evidence after its successful commit, then claims one durable
   Intent/Attempt before external invocation. Processing/Unknown, expiry and late-success handling
   retain their existing reconciliation/compensation paths. Ordering performs final Inventory checks.

## Required evidence before enabling the path

- Exact owner names, public contracts, scope/permission and dependency direction; no private-table
  access or assumed cross-owner transaction.
- Source-approved interpretation of87.9 and an ADR/Handoff addendum recording the accepting role
  and current-session decision; a generic coding or local-commit authorization is insufficient.
- Stable allocation/operation receipts, expected versions, concurrency and capacity accounting;
  no double occupancy on conversion, no terminal resurrection and no silent limit bypass.
- Exact server clock/request identity and immutable30-minute expiry across response loss, delayed
  preparation, replay and Payment claim; no Provider invocation with stale or mismatched preparation.
- Acquisition-success/Ordering-rollback compensation, lost acknowledgements, expiry versus conversion,
  simultaneous submissions and late Payment success acceptance against actual owner persistence.
- Separate external Provider/Store/Pilot evidence and deployment approval.

## Decision state

The Owner explicitly accepted DEC-H03 in the current session on 2026-09-10 after the concrete
topology and preserved constraints were presented. Acceptance applies to points1-6 above, including
the fixed30-minute expiry, final Inventory validation and Payment reconciliation obligations.
It is separate from prior permission to develop and make verified local commits.
This scoped addendum resolves the conflicting transaction interpretation; it does not renumber
the canonical Handoff, claim a new complete source version, or reopen Cart/credential decisions.

The remaining producer clock/receipt contract and durable race/compensation evidence are execution
requirements, not pending topology approval. A bounded Fulfillment capacity lifecycle WP may proceed.
Enabling real submission/Payment still requires those implementation checks and authoritative inputs.
No external service, production, Store, Provider, push, merge or deployment approval is implied.
