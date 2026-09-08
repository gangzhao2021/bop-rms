# Design Completeness Review Package

This is the documentation deliverable for [WP-2224](../work-packages/WP-2224.md), prepared from
`main@cedc44c9b6a6a1b389f77342078cc6f2d540dabe`. It turns the Owner-requested design review into
traceable scenarios, concrete proposals and a decision queue. It is not a new Handoff version,
implementation authorization or production-readiness assertion.

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

The baseline inventory contains 210 canonical Screens and 273 `WP-*.md` briefs, excluding the
separately named SPIKE. Of the Screens, 201 have `work_package_mode: resolved` and nine inherit
their mapping. These are inventory and mapping states, not proof of implemented actions, connected
runtime, exhaustive requirements or successful acceptance. This package adds one WP brief and does
not alter that Screen inventory.

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

Every new scenario in these documents is **designed, not executed**. An existing test command
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
These resolve the two product choices within DC-01. Detailed recovery mechanics, owner-local
persistence and source reconciliation remain implementation obligations; other DC entries are
unchanged. The original WP-2224 proposal-status statements are historical review snapshots.

## Recommended execution order

1. Reconcile the applicable Handoff sections for DC-01 and the source ownership/atomicity question
   in DC-04. Record concrete accepted decisions and create the smallest separate execution brief.
   These decisions precede connecting the scoped Cart reader to HTTP or enabling Payment.
2. Resolve DC-02 and DC-03 follow-up ownership while preserving their current fail-closed actions.
   Ordinary refund execution needs eligibility/allocation/approval decisions; an Inbox needs real
   source-domain action/result contracts. Each is an independent later WP, not one combined change.
3. Turn the first accepted decision into producer/adapter work with continuous synthetic browser,
   HTTP and isolated-database acceptance. Then advance sequentially through the other ready WPs.
4. Resolve DC-05/DC-06/DC-07/DC-08 before the release or operating scope that depends on them.
   The accepted [Pilot readiness inventory](../../runbooks/pilot-integration-readiness-inventory.md)
   remains the owner of external evidence gates; this package cannot satisfy those gates.

A decision record must identify the source version/section, precise choice and rationale, owning
Domain/public contract, rejected incompatible alternative, acceptance scenarios, remaining gates
and accepting role/evidence reference. Until that evidence exists its status remains Proposal or
Source decision. Future WP IDs are allocated only when the actual bounded brief is created.

## Prior implementation findings

The earlier static review also found request-time/idempotency coupling, Cart-to-Menu full reload,
internal-unit Money display, incomplete telemetry route registration and an unbounded realtime
drain path. WP-2224 does not fix those source files or claim new runtime verification. They remain
separate behavior fixes under their owning WPs; the Cart/Order acceptance proposal must include
the stable-intent retry case when that implementation is authorized.

## Completion rule

This documentation package is complete when its own criteria and document checks are evidenced.
The system design is not declared complete until every in-scope scenario has a source-backed owner,
accepted input/result and state/race contract, recovery path, ready implementation work scope and
appropriate acceptance evidence. A blocked external gate and an intentional Future Trigger remain
visible gates, never defects or implied approvals.
