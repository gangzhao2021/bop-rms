# Ordinary refund source rules and accepted approval boundaries

## Current disposition — 2026-09-29

RF-D01–06 were accepted on 2026-09-13 as `PILOT_ORDINARY_REFUND_V1`; [the accepted policy and decision record](./pilot-ordinary-refund-policy-proposal.md#decision-record) owns the exact rules. The decision table below preserves the questions used during WP-2400 review and is historical, not a new approval queue. Scope-specific implementation evidence is in [the pilot acceptance table](../../runbooks/single-store-pilot.md#current-acceptance-and-remaining-work); real Store/Provider and release gates remain separate.

Prepared in [WP-2400](../work-packages/WP-2400.md) for DEC-H06/H07 in the
[Customer, Order and Payment handoff](./customer-order-payment-handoffs.md).
This is a source reconciliation and decision specification, not approval of new refund policy,
permission, runtime behavior or an execution Work Package.

## Source and authority

The [Specification Index](../README.md) retains the accepted composite authority: Handoff
Sections 0–91 plus repository-accepted Sections 92–97. The source inspected on 2026-09-10 was then local and untracked. The Owner authorized tracking and syncing `BOP-RMS Complete Handoff Package.md` on 2026-09-22; it identifies itself as `0.5.9`.
Its Section 87.9 contains the refund text summarized below; finding that file does not accept a
replacement complete Handoff version. The source is now tracked; this summary does not duplicate it.
Section references identify the observed source; they do not independently change its authority.

[WP-1301](../work-packages/WP-1301.md) already cites Section 87.9, owns normalized original-method
Provider ports and leaves ordinary refund eligibility/approval/allocation to a later execution WP.
[WP-1310](../work-packages/WP-1310.md) owns the distinct paid-without-fulfillable full-compensation
path, cumulative captured-balance protection and Provider-confirmed recovery. Neither work package
establishes the ordinary refund decision table below as an implemented contract.

The source provides Full Refund and item/quantity-based Partial Refund, server-derived allocation
from original line/tax/tip/service-charge snapshots, original-method return and no arbitrary
unallocated refund amount. It also describes Store Manager initiation of same-day cumulative refunds
up to CAD 100; larger amounts, refunds after 24 hours, Manager Override or tip/service-charge refund
changes require recent MFA and Owner/Finance approval from another active Actor. These source-given
rules must be reconciled and retained, rather than treating the entire subject as unspecified.
They do not answer the narrower questions below or authorize implementation before its owning WP.

## Historical decision questions — superseded by accepted RF-D01–06

At the WP-2400 review, every unresolved cell was **Pending**; all RF-D01–06 policy questions now resolve through the accepted record above. The table deliberately chooses no day boundary, clock anchor,
cumulative bucket, pending-claim policy or permission identifier. The examples use synthetic values.
The future decision must state the exact result for each scenario and its source/policy version;
these are acceptance specifications, not tests executed by WP-2400.

| ID / topic                               | Source and preserved rule                                                                                                                                                                                | Exact pending decision                                                                                                                                                                                                                                                                                                          | Required acceptance scenarios                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-D01: same-day boundary                | Section 87.9 uses same-day eligibility; the Ordering time contract retains UTC instants and Store IANA zone/Business Date.                                                                               | Does same-day mean Store calendar date or Business Date, and which source transaction instant is assigned to that date? Define precedence when a refund is no longer same-day but is still younger than 24 hours.                                                                                                               | Payment at Store-local 23:50 and refund at 00:10 the next date; an overnight Store whose Business Date has not changed; a Store daylight-saving transition. Record exact permit/approval/deny outcomes without inferring them from these examples.                                                                                                               |
| RF-D02: 24-hour window                   | Section 87.9 requires the stated additional approval after 24 hours.                                                                                                                                     | Identify the authoritative origin: creation, authorization, capture or another accepted source fact. Specify the evaluation point and equality boundary, and how approval ages between request, approval and execution.                                                                                                         | Distinct Intent creation, authorization and capture instants; evaluate just before, exactly at and just after the chosen 24-hour boundary; request or approve before the boundary and resume after it.                                                                                                                                                           |
| RF-D03: cumulative approval scope        | Section 87.9 gives CAD 100 as a cumulative approval threshold. It is separate from the captured-amount ceiling.                                                                                          | Define the bucket identity and time period: Payment, Order, Actor, Store or another explicitly accepted scope, including multiple Batches/Attempts and different initiating Actors. Identify which amount components and refund classes contribute.                                                                             | Two CAD 60 requests against the same Payment; the same amounts against different Payments on one Order, across different Orders, and by different Managers. A sufficiently large captured balance makes the approval threshold, rather than over-refund prevention, the tested boundary.                                                                         |
| RF-D04: concurrent Pending/Unknown work  | WP-1310 preserves financial claims across Unknown; H-REFUND-01 proposes the shared captured-balance fence for ordinary refunds and compensation. Neither defines the ordinary cumulative approval fence. | For the RF-D03 bucket, define whether Requested, Approved, Processing, Pending, Unknown, confirmed and safely rejected/cancelled requests contribute; name the owner-local claim/fence and the evidence that changes or releases its contribution. Recheck authority when the cumulative result crosses the approved threshold. | Two concurrent CAD 60 requests observe the same initial cumulative amount; one loses the Provider or commit response and becomes Unknown; retry the same operation and introduce a second Actor. Prove the accepted cumulative policy cannot be bypassed by parallel requests or response loss, without releasing the captured-balance claim from timeout alone. |
| RF-D05: eligible lines and allocation    | Section 87.9 provides Full/item-quantity Partial Refund and original-snapshot tax/tip/service-charge allocation; WP-1301 rejects client financial authority.                                             | Define the eligible source states, line/quantity remainder and exact Pricing allocation/rounding contract. Distinguish an ordinary proportional allocation from a tip/service-charge refund change that triggers the additional source control.                                                                                 | Repeated partial quantities converge to the permitted full remainder; mixed tax/fee/tip snapshots conserve Money; a forged browser amount denies; changing allocation invalidates the prior approved amount/digest.                                                                                                                                              |
| RF-D06: approval and execution authority | Section 87.9 requires permission/reason/idempotency/Audit and the specified independent Actor/MFA controls; Section 88 identifies the Refund Wizard surface.                                             | Bind exact existing or separately accepted request/approve/execute permissions, policy version, MFA freshness contract, approval subject/version/digest, revocation and operational escalation. Define the final current-authority check without introducing a permission in this document.                                     | Self-approval denies where distinct Actors are required; revoked Actor or changed scope/policy/allocation cannot reuse approval; exact unchanged retries preserve operation identity; an approval remains authorization and never Provider-confirmed refund evidence.                                                                                            |

## Closure and verification ownership

Payment owns refund operations, the captured-balance claim and Provider-confirmed financial facts.
Ordering owns cancellation/Amendment evidence; Pricing owns approved allocation from original
snapshots. Operations and Permission owners reconcile the request/approval policy. The accepting
role and actual decision evidence must be recorded; this document assigns no real person and
creates no generic Approval or Finance Domain.

DEC-H07 closes only when RF-D01–RF-D06 have source-backed explicit decisions, exact input/result
and concurrency contracts, and an authorized owning execution WP. The execution WP must name real
producer/consumer adapters and implement the specified acceptance cases. Existing
`pnpm payment-compensation:acceptance`, `pnpm payment-reconciliation:acceptance` and
`pnpm order-amendment:acceptance` are regression anchors; their existing passes do not prove these
ordinary-refund scenarios or approve policy.

Original-method and Terminal Interac in-person/reader/Provider-confirmation boundaries remain.
Provider/Store/professional evidence and live activation remain separate gates. Documentation
reconciliation does not issue a refund, alter business history, enable an action or claim a new
business regression run.
