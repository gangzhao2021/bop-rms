# Design Completeness Review Package

This is the documentation deliverable for [WP-2224](../work-packages/WP-2224.md), prepared from
`main@cedc44c9b6a6a1b389f77342078cc6f2d540dabe`. It turns the Owner-requested design review into
traceable scenarios, concrete proposals and a decision queue. It is not a new Handoff version,
implementation authorization or production-readiness assertion. Current implementation status was
reconciled in [WP-2330](../work-packages/WP-2330.md) against local fab611e; historical inventory
and proposals below retain their original scope.

## Read in this order

1. [Business scenario coverage](./business-scenario-coverage.md): sources, owners, inputs/results,
   failure recovery and acceptance for the principal business journeys.
2. [Customer, Order and Payment handoffs](./customer-order-payment-handoffs.md): Cart/Session,
   submission/capacity, Order transitions and ordinary refunds.
3. [Approval and operating-day flow](./approval-and-operating-day.md): canonical work surfaces,
   source-domain actions and opening/closing/handover responsibilities.
4. [System completeness contracts](./system-completeness-contracts.md): component compatibility,
   privacy-owner coverage and performance acceptance inputs.

## What is and is not established

The original WP-2224 baseline inventory contained 210 canonical Screens and 273 `WP-*.md` briefs, excluding the
separately named SPIKE. Of the Screens, 201 have `work_package_mode: resolved` and nine inherit
their mapping. These are inventory and mapping states, not proof of implemented actions, connected
runtime, exhaustive requirements or successful acceptance. The current local inventory contains 380 WP briefs including WP-2330; this count is not completion
evidence and no Screen mapping is changed by the status reconciliation.

The repository already defines substantial QR/Session, Menu/Quote, Order, Payment reconciliation
and compensation, Kitchen/Pickup, Receipt, Store, Reservation, Procurement/Inventory, Food Safety,
Privacy, Platform and recovery contracts. Their detailed evidence remains in their owning WPs.
Most local evidence does not prove a connected operational Store journey. The coverage matrix
keeps those two conclusions separate.

The complete external Handoff was unavailable during this review. A repository search and the
available connected-file searches did not obtain it. A missing local rule is therefore described as
a local source/ownership gap, not a claim that the external Handoff never specified it. The
[Specification Index](../README.md) retains authority and later accepted decisions retain precedence.

## Status vocabulary

| Label                  | Meaning                                                                                | Does it permit business implementation?                                      |
| ---------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Baseline               | A rule or evidence boundary recorded by an existing accepted repository source.        | Only within a separately ready, authorized owning WP.                        |
| Correction             | A demonstrably mismatched document attribution is corrected without changing behavior. | No new behavior or authority follows.                                        |
| Proposal               | A concrete recommended design introduced by this package for review.                   | No; reconcile source, accept the decision and establish the owning WP first. |
| Source decision        | Required authority or a choice is not established by the available sources.            | No dependent implementation until resolved.                                  |
| Integration dependency | The existing contract needs an owning producer, adapter or composed acceptance.        | Only after its bounded implementation scope is ready.                        |
| External gate          | Real Store, Provider, professional, operator or environment evidence is required.      | Local synthetic work may proceed where authorized; live activation may not.  |

The original AC-H/AOD/SC scenarios were **designed, not executed in WP-2224**. Later owning WPs
provide the specific evidence identified below; this does not retroactively execute those whole suites. An existing test command
listed beside it protects the cited baseline; its mere existence does not prove the new scenario.
The actual documentation checks for this WP are recorded only in its verification section.

## Decision and ownership register

The IDs below identify workstreams inside WP-2224. They are not new Domains, runtime permissions,
approval records, database objects or assigned future WP numbers. The responsible roles are design
review roles, not claims that real people have been assigned.

| ID                            | Review roles                                                  | Reviewable proposal / preserved rule                                                                                                                                       | Required closure evidence                                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DC-01 Cart/Session            | Ordering + Identity + API                                     | H-CART-01; preserve exact binding, required rotation, immutable Cart attribution and server-authorized current lookup.                                                     | Reconciled create/bind/current sequence, concurrent and partial-failure recovery, credential-delivery boundary; accepted DEC-H01/02 and owning WP.                      |
| DC-02 Ordinary refund         | Payment + Pricing + Operations + Permission                   | H-REFUND-01; Payment owns financial truth, original-method boundary and cumulative balance; ordinary refund is distinct from the existing paid-unfulfillable compensation. | Corrected WP-1301 attribution; source-backed DEC-H06/07 eligibility, allocation and approval rules; producer/consumer work scope and Unknown/reconciliation acceptance. |
| DC-03 Work surfaces           | Source Domains + Task/Workflow + Merchant Web                 | AOD-D01/AOD-D02; Task metadata, approval facts and technical alerts retain their distinct owners.                                                                          | Exact source types and canonical Screen/action routing, permissions, freshness/unknown-outcome behavior and escalation policy; actual follow-up WP mapping.             |
| DC-04 Order and capacity      | Ordering + capacity authority + Payment + Kitchen/Fulfillment | H-PREP-01/H-ORDER-01; preserve durable preparation evidence, 30-minute capacity rule and exclusive owner-issued finality.                                                  | DEC-H03/04/05: named producer and owner-local atomic boundary; accepted transition/race/recovery matrix; no invented shared transaction over foreign tables.            |
| DC-05 Component compatibility | Architecture + Release + API/PWA/Worker owners                | System compatibility proposal; preserve immutable release digest, migration sequence and safe PWA update rules.                                                            | SC-D01/02: supported-version matrix, observation/withdrawal evidence, contract eligibility and rollback/fail-forward plan for one candidate.                            |
| DC-06 Operating day           | Store Operations + Ordering + Dining + Payment + Kitchen      | AOD-D03; operating checklist and unresolved-item handover never rewrite transaction Business Date or impersonate source completion.                                        | System/manual responsibility decision, handover acceptance/escalation rules and synthetic opening-to-next-day scenario.                                                 |
| DC-07 Privacy coverage        | Privacy + Security + every affected Data Owner                | System privacy proposal; required-owner coverage must be resolved before declaring all registered work complete.                                                           | SC-D03/04: versioned field/category-owner coverage, scoped applicability/hold evidence and completion/partial-result rules reconciled with policy.                      |
| DC-08 Performance             | Product + Operations + SRE + Data                             | System performance proposal; preserve existing rate limits, recovery objectives and database budget.                                                                       | SC-D05/06: accepted journey SLOs, workload model, observation windows and overload priorities; no invented production numbers.                                          |

The narrow WP-1301 correction is within this package. Canonical Screen mapping corrections remain
explicit follow-up work because a replacement execution WP must actually own the required behavior;
pointing every Screen to this documentation package would not close that gap.

## Owner decisions recorded after the review

[WP-2228](../work-packages/WP-2228.md) records the Owner's 2026-09-08 acceptance of a shared
Dining Session Cart with Participant-owned item edits and one-time safe credential recovery.
These resolve the two product choices within DC-01; they are not pending approval again.
Owner-local acknowledged credential preparation/activation/recovery and foreground transport now
have WP-2234–2250 and WP-2294–2309 evidence. Current bound Dining identity is owner-validated
(WP-2299/2326). Shared Cart create/read/items, scoped history and safe UI are implemented in
WP-2313–2325. [WP-2327](../work-packages/WP-2327.md) proves two simultaneous browser contexts
on one table, with own-line edits, foreign-note/control isolation and actual invitation regeneration.

Pickup Quote persistence/HTTP and continuous recalculation have WP-2255–2268 evidence;
[WP-2328](../work-packages/WP-2328.md) and [WP-2329](../work-packages/WP-2329.md) add current
authority and fresh expiry checks across asynchronous Pricing/persistence. These are local owner-store
proofs with labeled synthetic commercial/Staff/QR inputs, not real Store or Provider readiness.

Remaining DC-01 obligations include cross-document credential continuity (foreground response-loss
recovery is not browser-reload recovery), authoritative Catalog selection/commercial producers and
Dining Quote/Checkout composition. DC-04's capacity ownership/atomicity decision still gates full
submission-to-Payment even for a proposed local operational scenario. Other DC entries remain
unchanged. Do not reopen the accepted sharing/recovery product choices to resolve these mechanics.

## Recommended execution order

1. Continue source-ready producer/composition work for Catalog selection, commercial Quote inputs
   and Dining Quote/Checkout; keep unavailable results where their owner inputs are absent. Establish
   each bounded execution brief before implementation. Do not substitute a display projection as
   current Catalog eligibility or synthetic prices as live authority.
2. Resolve DEC-H03's precise capacity owner and local atomic boundary before enabling submission
   and Payment. Existing policy configuration or a receipt cannot silently replace the accepted hold
   requirement. Reconcile remaining Order finality and ordinary refund source decisions separately.
3. Finish cross-document credential continuity only through an accepted Identity-owned mechanism;
   preserve random independent CSRF, page-memory handling and immutable Cart/Participant attribution.
   Existing acknowledged foreground recovery is retained and need not be redesigned or reapproved.
4. Resolve source action ownership for work surfaces and DC-05/DC-06/DC-07/DC-08 before their
   dependent release/operating scope. The accepted [Pilot readiness inventory](../../runbooks/pilot-integration-readiness-inventory.md)
   owns external evidence gates. Keep local connected acceptance and actual deployment separate.

A decision record must identify the source version/section, precise choice and rationale, owning
Domain/public contract, rejected incompatible alternative, acceptance scenarios, remaining gates
and accepting role/evidence reference. Until that evidence exists its status remains Proposal or
Source decision. Future WP IDs are allocated only when the actual bounded brief is created.

## Prior implementation findings

The original request-time/idempotency, Cart-to-Menu navigation/Money display and telemetry/drain
findings have owning repairs in WP-2225/2226/2227 and integrated local evidence in
[WP-2232](../work-packages/WP-2232.md). They are no longer an unassigned open defect list.
Current Quote authority/expiry repairs are recorded in WP-2328/2329. Evidence remains at each WP's
stated scope; status reconciliation runs no new business regression.

## Completion rule

This documentation package is complete when its own criteria and document checks are evidenced.
The system design is not declared complete until every in-scope scenario has a source-backed owner,
accepted input/result and state/race contract, recovery path, ready implementation work scope and
appropriate acceptance evidence. A blocked external gate and an intentional Future Trigger remain
visible gates, never defects or implied approvals.
