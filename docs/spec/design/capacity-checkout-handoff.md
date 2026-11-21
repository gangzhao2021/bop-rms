# Checkout capacity and Payment clock handoff

Prepared in [WP-2342](../work-packages/WP-2342.md).
Related topology record: [DEC-H03](./capacity-source-decision.md).
DEC-H03-DINING was explicitly accepted by the Owner on 2026-09-10 in this task.
The disposition below is authoritative; implementation and acceptance evidence remain separate.

## Source facts and implemented scope

- Handoff 34.1-34.3 assigns Pickup/Delivery to Fulfillment and explicitly excludes Dine-in.
  Dine-in uses Dining; no Fulfillment aggregate is created for a Dine-in Order.
- Handoff 34.32-34.33 gives ASAP a real estimated Confirmed Time Window, separately retaining
  Requested Time Window. A materially changed window requires customer reconfirmation.
- Handoff 34.34 uses Scheduled Holds during Checkout and prohibits a long-lived Scheduled Hold
  shortcut for ASAP; ASAP requires current capacity revalidation at submission.
- Higher 87.9 includes new Orders and new Dine-in Batches in the durable-before-Provider rule.
  Online capacity expiry remains exactly 30 minutes from the original Payment Intent creation instant.
- WP-2337 through WP-2340 implement Scheduled Pickup/Delivery Hold/Allocation lifecycle, PostgreSQL
  accounting and history reads. They do not implement ASAP allocation or Dining capacity.
- WP-2341 checks current monotonic time after preparation/Audit/claim waits. It retains a late
  local claim as Processing without a Provider call or invented observation. This does not produce
  a valid Order/capacity preparation where the required owner facts are missing.

Since this WP-2342 proposal was prepared, [WP-2343](../work-packages/WP-2343.md),
[WP-2344](../work-packages/WP-2344.md) and [WP-2347](../work-packages/WP-2347.md) have recorded
Scheduled owner writes/transitions with atomic Audit and actual PostgreSQL evidence.
Current application authority, Ordering linkage and the clock-seal producer remain separate.
Those implementation results do not prove the composed payment journey. The later Owner
disposition below separately accepts DEC-H03-DINING.

## Clock sequence for review

The coordinator must establish Ordering business facts before calling Payment creation. It must
not call the current Payment service first and then backdate a newly created Ordering submission
to make committedAt fit a previously chosen requestedAt.

1. Authorize current Guest/Cart/Quote/Store intent, preserve its permanent operation identity and
   perform final Catalog/Inventory/fulfillment checks. Resolve durable prior operations before
   planning new writes. Acquire the exact live capacity commitment through its owning Domain.
2. Ordering atomically commits its immutable submission/Batch, required snapshots, exact linkage
   to that owner commitment, operation, number allocation, Audit and OrderCreated Outbox intent.
   A rollback requires owner release compensation; an unknown outcome requires exact-operation
   recovery before treating the submission as either absent or successful.
3. After the original Ordering commit has been acknowledged or positively recovered, choose the
   server-owned Payment creation request instant once. Do not label a request-start instant as an
   observed database commit. Ordering evidence must truthfully identify the original durable
   submission; no producer may invent an engine commit timestamp or backdate it.
4. Seal that permanent Payment operation/request instant and exact 30-minute capacity expiry with
   the owner commitment and its immutable conversion/linkage evidence. A Scheduled Hold may convert
   only while live. Preserve the exact original Hold-to-Allocation chain in the Ordering preparation.
   Durable response-loss recovery returns the original seal/instant; it never computes now+30 again.
5. Payment's public preparation port resolves that already-durable linked evidence. Its existing
   committedAt <= requestedAt and capacityExpiresAt = requestedAt+30 minutes checks remain.
   Only then does Payment claim one Intent/Attempt before invoking its Provider adapter.
6. If any later gate expires after Ordering committed, retain the original business history and
   use authorized release/finality/reconciliation. Do not create a replacement Order on blind retry,
   erase a committed Batch, release Kitchen or infer a financial outcome.

The future producer WP must materialize exact owner receipt/clock-seal records and prove these
steps against real owner transactions, including response loss at every boundary.
This sequencing document is not evidence that those producers already exist.

## Mode-specific capacity contract

| Mode                      | Owning fact                                                                              | Implementation boundary                                                                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduled Pickup/Delivery | Fulfillment Scheduled Hold converted to Allocation with original slot/config/units       | Owner storage and atomic Audit have WP-2343/2344/2347 evidence; current application authority, Ordering linkage/Outbox and clock seal remain. |
| ASAP Pickup/Delivery      | Fulfillment current capacity commitment for the authoritative Confirmed estimated Window | Final recheck and direct allocation contract required; no fake Scheduled Hold or fabricated ETA/slot.                                         |
| Dine-in                   | Dining-owned current Session/Table relationship                                          | The interpretation below is accepted; durable owner lifecycle, linkage and race evidence remain required.                                     |

No mode may substitute a Catalog availability observation, Reservation policy configuration,
unrestricted Store reference or synthetic fixture for a durable owner commitment.

## Proposed Dine-in interpretation: DEC-H03-DINING

**Disposition: Accepted, 2026-09-10.** The Owner answered
“批准该堂食解释（推荐）” to the explicit question linking this proposal and describing Dining-owned
Session/Table commitment, no Pickup capacity record, and the unpaid-Batch-only timeout.
This accepts the following five points as a scoped business interpretation. The original heading
is retained for stable links; “Proposed” describes its origin, not its current disposition.
[WP-2402](../work-packages/WP-2402.md) records the implementation follow-up.

1. Dining owns the Dine-in checkout capacity commitment, based on the current authorized and
   applicable Dining Session/Table relationship. It is bound to the exact Store, Session, Cart,
   submission/Batch and permanent Payment operation, with version, intent and current closure checks.
2. Ordering atomically links that exact Dining commitment with the submitted Batch, using the
   owner-commitment/local-linkage topology described in DEC-H03. It does not create a Fulfillment aggregate,
   Scheduled Hold, Pickup slot or new physical seating reservation.
3. The 30-minute deadline applies to the checkout/payment commitment and the unpaid submission/Batch.
   Expiry blocks new payment confirmation and requests the approved unpaid-Batch/Intent disposition;
   it does not free an in-use table, terminate the shared Dining Session, cancel earlier paid Batches
   or detach other Participants.
4. Closure/reassignment/current-authority races must be coordinated with Dining's own versioned
   transitions. A missing, closed, foreign or unverified Session cannot issue the commitment.
   A plain Session lookup is not automatically a durable guarantee; the owner must implement and
   test the commitment lifecycle and closure collaboration before enabling the path.
5. Payment Processing/Unknown and late success retain authoritative reconciliation/compensation.
   Acceptance of this interpretation does not resolve DEC-H04/H05 Order finality or refund gates,
   create Provider/Store evidence, or authorize deployment.

The accepted interpretation makes the exact Dining commitment to the existing in-use Session/Table
the capacity allocation required by 87.9 for a Dine-in Batch, with the deadline limited as above.
[WP-2402](../work-packages/WP-2402.md) adds the commitment lifecycle and scoped owner persistence
with unit and real PostgreSQL evidence.
Current-authorized preparation and Identity/CSRF composition have separate service/API evidence.
Atomic Ordering linkage has real PostgreSQL evidence in the same WP.
Implementation remains pending: connected submission authority and cross-owner closure/move coordination,
permanent Payment clock and composed acceptance evidence are required
before enabling Dine-in Payment preparation. This approval alone does not enable that path.
