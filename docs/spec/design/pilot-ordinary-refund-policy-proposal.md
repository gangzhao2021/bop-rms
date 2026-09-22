# Pilot ordinary refund policy proposal

Status: **Accepted by Owner**, 2026-09-13. Implementation and acceptance evidence remain outstanding.
Scope: RF-D01–06 / DEC-H06–H07, implementation within WP-2402 after acceptance.
This does not issue a refund, change existing financial history, grant a real Actor
permission or establish legal/Provider evidence.

Authority: [refund source reconciliation](./refund-approval-boundaries.md),
Handoff87.9, and the accepted money/time/permission and original-method boundaries.
The choices below resolve previously unspecified behavior; they are not represented
as already accepted source rules.

## Proposed business choices

| Decision                         | Proposed pilot behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-D01 Same day                  | Use the Store Business Date, with its published IANA time zone and business-day start. Compare the Business Date of each selected Payment's first durable confirmed capture with the current refund decision/execution Business Date. If any selected capture is from another Business Date, require independent Owner/Finance approval, even if less than24 hours old.                                                                                                                                                                                                                                                                                                     |
| RF-D02 24 hours                  | Start from Payment's immutable first confirmed-capture fact time; map to the owning persisted timestamp during implementation, never browser time or a retry observation. More than24 elapsed hours requires escalation; exactly24 hours does not add this trigger. Re-evaluate before first Provider dispatch. An earlier request/approval cannot freeze eligibility across the boundary.                                                                                                                                                                                                                                                                                  |
| RF-D03 CAD100                    | Count ordinary refunds cumulatively for the entire Order across all Batches, Payments and initiating Managers, throughout the Order's lifetime. Include item/tax/tip/service-charge amounts. CAD100 exactly may use the Manager path if all other conditions qualify; aboveCAD100 requires escalation. Compensation is excluded from this Manager threshold but shares the captured-balance exclusion with ordinary refunds.                                                                                                                                                                                                                                                |
| RF-D04 Pending and Unknown       | Validated Requested, Approved, Processing, Pending and Unknown ordinary refund claims occupy their full requested amount; confirmed refunds remain in the cumulative amount. Release occupancy only on durable rejection/cancellation evidence proving no Provider effect. Timeout alone cannot release it. Serialize the Order threshold and underlying Payment balances, including compensation. Recheck before dispatch; new claims that push the current total aboveCAD100 require escalation for still-undispatched work.                                                                                                                                              |
| RF-D05 Quantities and allocation | Permit Full or item/quantity Partial Refund against confirmed captured, unrefunded remainder; fulfillment completion alone does not bar a Manager refund. Pricing derives all amounts from original immutable snapshots. Use cumulative quantity entitlements and deterministic integer allocation so repeated partials converge to the permitted full remainder. Ordinary proportional tax/tip/service-charge allocation is the default; any manual tip/service-charge change or override requires escalation and a newly approved digest. Browser-submitted amounts are never authority.                                                                                  |
| RF-D06 Authority                 | Introduce separately registered capabilities payment.refund.request, payment.refund.approve and payment.refund.execute. An active Store Manager may request with current scoped permission/reason. Escalation requires a different active Owner/Finance Actor with current approval permission and recent MFA; requester and approver MFA must both be at most15 minutes old at approval and first Provider dispatch. Otherwise return NeedsReapproval without dispatch. Bind approval to exact Order, claims, allocation/amount digest, policy version and Actors. Worker dispatch uses an explicitly authorized system identity and revalidates required human authority. |

The15-minute MFA bound and proposed capability codes above are part of this proposal,
not assertions about previously registered permissions. No real grants are created
by accepting the design.

An already-dispatched Unknown operation is reconciled by its original Provider
identity; revoked/expired human approval does not suppress recording an actual
Provider result. Reapproval may authorize a still-undispatched operation but must
never create a duplicate Provider refund to recover an uncertain result.

Partial allocation implementation must record the exact Pricing algorithm/version,
including deterministic remainder ordering and zero-value line handling. Acceptance
requires integer conservation and full-remainder convergence; no floating-point
money or ad hoc distribution is authorized.

## Concrete outcomes to accept

| Scenario                                                     | Result under this proposal                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store-local23:50 capture,00:10 refund, same Business Date    | Manager path can apply, subject to amount/other controls.                                                                                                |
| Same times, Business Date has changed                        | Independent approval required even though only20 minutes elapsed.                                                                                        |
| Exactly24 hours elapsed                                      | No extra trigger from the24-hour rule; Business Date/amount/override controls still apply.                                                               |
| 24 hours plus1 millisecond                                   | Independent approval required before first dispatch.                                                                                                     |
| Two concurrent CAD60 requests on one Order                   | Shared serialization prevents both using an unapproved CAD120 Manager total. Still-undispatched work above the threshold waits for independent approval. |
| CAD60 on each of two different Orders                        | Separate threshold buckets, while each Payment still enforces its captured ceiling.                                                                      |
| Different Managers refund the same Order                     | Same cumulative bucket; changing Actor cannot reset it.                                                                                                  |
| CAD60 becomes Unknown, then another CAD60 request            | Unknown still contributes; no threshold or balance release from timeout.                                                                                 |
| Partial quantities followed by full remainder                | Combined confirmed amounts cannot exceed the original captured allocations and must converge without rounding loss.                                      |
| Allocation, policy or Actor authority changes after approval | Old approval is unusable for new dispatch; obtain an exact current approval.                                                                             |
| Provider result arrives after MFA expired                    | Record/reconcile the existing operation's real result; do not send a fresh refund.                                                                       |

## Implementation and evidence after acceptance

Payment owns append-only ordinary request/claim/operation/result records and shares
captured-balance exclusion with compensation. Pricing owns allocation. Ordering
supplies immutable line/quantity facts. Permission/Identity supply current authority
and MFA facts. A receipt-facing public source must account for both ordinary and
compensation pending/Unknown claims and confirmed outcomes under held owner fences.

Required acceptance includes concurrency/Unknown recovery, immutable replay,
independent approval, revocation, Business Date/DST and exact24-hour boundaries,
partial-to-full conservation, original-method Provider behavior and customer/merchant
status visibility. Actual Terminal Interac, Provider, Store/legal evidence and live
activation remain separate gates. Until then this is not a complete pilot refund path.

## Decision record

Owner response: **Accepted RF-D01–06**.
Acceptance date/evidence: **2026-09-13**, explicit current-task user response “确认普通退款提案”.
Accepted policy version: **PILOT_ORDINARY_REFUND_V1**.
