# Customer, Order and Payment Handoff Proposals

## Status and use

This document belongs to [WP-2224](../work-packages/WP-2224.md). It closes the review artifact,
not the business decisions or runtime. **Baseline** means a rule evidenced by an accepted local
WP. **Proposal** means a recommended design awaiting source reconciliation and explicit decision.
Command, record, state and decision names introduced here are design labels, not registered APIs,
permissions, Events or new Work Packages. The external Handoff was unavailable to this review;
an unresolved local reference does not prove that the external source lacks a rule. WP-2330
reconciles current local progress without accepting remaining proposals.

All four handoffs require authorization before source reads; explicit Tenant/Brand/Store, Actor,
purpose and permission; exact expected versions; immutable operation intent and append-only Audit.
Scope, Actor, purpose and permissions are server-resolved; supplied expected versions are validated,
never silently replaced. Browser amounts, identities, deadlines and Provider outcomes cannot supply
authority. Each Domain commits only its own facts through its own transaction;
collaboration uses public contracts. This document authorizes no cross-Domain private access.

## Baseline map

| Handoff               | Repository-visible rule                                                                                                                                                                                                | Remaining boundary                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Guest to Cart         | [WP-1003](../work-packages/WP-1003.md) requires exact binding and Session rotation; [WP-1201](../work-packages/WP-1201.md) binds Pickup edits to the creating Session and DineIn edits to the exact Participant.       | Current owner-store/HTTP/browser composition is evidenced by WP-2325/2326/2327; cross-document credential continuity remains separate. |
| Cart to submission    | [WP-1220](../work-packages/WP-1220.md) validates current Cart/Quote/Catalog/fulfillment evidence; [WP-1224](../work-packages/WP-1224.md) durably creates immutable submission, snapshots, number allocation and Audit. | Validation is not a capacity hold; Checkout Session/contact/capacity composition remains outside those WPs.                            |
| Submission to Payment | [WP-1302](../work-packages/WP-1302.md) requires atomic durable submission/capacity evidence and a 30-minute capacity expiry; Payment claims its Intent/Attempt before calling the Provider.                            | The public preparation evidence has no accepted production source merely because its parser exists.                                    |
| Payment to work       | [WP-1310](../work-packages/WP-1310.md) makes Ordering the sole producer of OrderConfirmed and the mutually exclusive unfulfillable disposition.                                                                        | Acceptance/cancellation/capacity-finality producers remain explicit dependencies.                                                      |
| Work to closure       | [WP-1603](../work-packages/WP-1603.md) defines partial/full Pickup handoff; [WP-1605](../work-packages/WP-1605.md) preserves Fulfilled + Open.                                                                         | Order close/reopen remains a separate source action; Dining closure cannot close an Order.                                             |
| Refund                | [WP-1301](../work-packages/WP-1301.md) defines original-method Provider ports; WP-1310 covers paid-without-fulfillable compensation.                                                                                   | Ordinary refund workflow was attributed to WP-2045, which actually owns webhook security review.                                       |

## H-CART-01: create, bind and recover the current Cart

### Preserved rules

Identity owns Guest Session credentials and rotation. A binding change creates a new Session
reference, Session credential and CSRF credential and atomically revokes the old record. Initial
Pickup Store context grants no Cart authority. Submitting a DineIn Batch does not rotate an
otherwise unchanged Dining-bound Session. No new Customer/device identity or Session cap is added.
Ordering owns Cart facts, immutable creator/Participant attribution, versions and lifecycle policy.
Cart expiry values must come from accepted versioned policy; no duration is chosen here.

### Proposed contract

**Proposal DEC-H01.** Add an Ordering-owned current-Cart binding operation, separate from immutable
Cart content. Its internal identity includes Brand, Store, channel, authorized Session or Dining
context, operation reference, binding revision and Cart reference. Credentials never enter it.
Recommend at most one selectable active Cart per exact authorized context. For DineIn, the Owner decision below resolves the selectable context as the shared Dining Session;
exact schema uniqueness and activation mechanics still belong to implementation.

The proposed create/bind input is an operation reference plus expected Session/binding revisions
resolved server-side. Identity supplies usable Session and binding authority; Ordering supplies
current Cart and lifecycle evidence. A browser supplies neither a target Session nor a Cart owner.
An existing eligible binding returns the current Cart. An absent or terminal binding follows an
explicit create/replacement action; a read never creates, resurrects, abandons or clears a Cart.

Public results should distinguish current/created, conflict, unavailable and expired authority
without exposing internal binding records. Successful first binding must deliver the successor
Cookie and CSRF through Identity's approved same-origin transport before mutations become usable.
The present [Cart port](../../../apps/api/src/customer-cart.ts) does not provide that credential
handoff; a future owning WP must change the composition contract rather than embed credentials
inside a Cart DTO. Cart and Session references remain locators, never credentials.

### Proposed owner-local sequence and recovery

1. Authorize the presented Guest and exact scope; resolve the stable operation before creating
   references. Claim the expected binding revision in an Ordering-local transaction with Audit.
2. Through a future Identity public preparation port, reserve the successor Session identity and
   an opaque, operation-bound preparation receipt. This is a **new proposed port**, not an existing
   credential capability. Preparation does not revoke the current Session or grant Cart access.
3. Ordering locally persists the Cart with that exact successor as Pickup creator and a prepared
   binding result. Prepared binding is not readable through the current-Cart BFF. Identity then
   atomically activates the successor and revokes the predecessor through its own public command.
4. Ordering validates the exact Identity activation receipt and locally activates the current
   binding. Only after the activation receipts agree may the composition deliver the successor
   Cookie/CSRF and a safe Cart view. No transaction spans Identity and Ordering private tables.
5. A failure before Identity activation leaves the old Session usable and a non-public prepared
   operation; reconciliation resumes that operation or appends an authorized abort. Failure after
   activation leaves the Cart unavailable until exact receipts reconcile; never restore the old
   credential or silently attach a different Session. Duplicate/conflicting receipts converge or fail.

**Accepted product decisions, 2026-09-08.** See [WP-2228](../work-packages/WP-2228.md).
The Owner adopted a shared Cart for the same authorized Dining Session. Each Participant may
modify only their own items under WP-1201. Sharing grants no host override, membership, cross-Store
access or access merely from a Table/Cart identifier. Dining remains the membership authority;
Ordering rechecks active Participant scope and exact Cart version on every mutation. Concurrent
participants must observe a version conflict and refresh rather than overwrite another change.

**DEC-H02: accepted continuity goal; acknowledged foreground mechanism implemented.** The Owner adopted
one-time safe credential recovery to preserve the basket after a lost binding response. This
supersedes the earlier recommendation to prefer fresh Entry and accept loss of the old basket.
It does not authorize plaintext credential persistence, use of a revoked Cookie as proof, a Cart-ID
recovery endpoint or reuse of a receipt-only resume grant. Identity must own purpose-separated,
unpredictable recovery proof; server storage retains a keyed verifier, not its plaintext value.
Proof must bind the exact operation and scope and be securely available to the browser before the
binding response can be lost. Its delivery acknowledgement is therefore part of the protocol.

The accepted recovery implementation must retain its finite lifetime, same-origin/CSRF and abuse controls,
atomic single consumption, exact activation reconciliation, and denial after expiry, revocation,
scope drift or conflicting intent. A consumed proof must never restore an old Session. Repeating a
recovery after its own response is lost must have an explicit safe continuation: neither unlimited
replay nor silently abandoning the basket satisfies the accepted goal. Credential rotation must
not silently rewrite Pickup creator attribution or transfer item ownership. Resolve this with
Identity and Ordering public contracts for any further cross-document continuation mechanism.
WP-2234–2250 and WP-2294–2309 now implement acknowledged preparation/activation, bounded
foreground recovery and their owner persistence/transport. This is not durable browser-reload recovery.

Credential material is restricted to approved credential transport and ephemeral handling. It must
not enter Cart DTOs, URLs, localStorage, logs, telemetry, Audit summaries or Event payloads. Audit
records bounded outcomes and operation linkage through existing approved contracts.

Required future synthetic acceptance includes: two Participants sharing one Cart while foreign-item
edits deny; cross-Dining/Store denial; concurrent version conflict; lost initial binding response;
lost recovery response; concurrent recovery with one consumption; expired/wrong-scope proof;
revoked predecessor denial; crashes between owner-local commits; exact-operation reconciliation;
and no credential persistence or disclosure. These cases were designed, not executed in WP-2228. Later evidence is scoped: WP-2300/2302/2305
cover foreground response-loss/owner recovery, WP-2323/2324 actual multi-participant persistence, and
WP-2327 simultaneous same-table browser isolation. This does not claim the entire AC-H suite ran.

Create/activate/abort each has a stable purpose-specific operation, expected local version and
bounded Audit action/result. Reconciliation rechecks current authority and exact receipt digests;
it may repair an operation's progress, never infer a business binding from timing or a matching ID.

## H-PREP-01: Checkout, capacity and Payment preparation

### Preserved rules and source stop

Checkout verifies one current Cart Version and attached Quote, revalidates Catalog selection and
requires fresh fulfillment evidence. The resulting evidence is not a capacity reservation.
WP-1302 requires submission plus capacity allocation committed in the same PostgreSQL transaction,
and capacity expires exactly 30 minutes after Payment Intent creation. Payment then atomically
claims one Intent/Attempt/operation before Provider invocation. Unknown is not success or failure.
The new-work Kill Switch precedes new preparation; accepted replay and recovery remain available.

**Source question DEC-H03.** Identify the owner and precise fact meant by that capacity allocation.
Reservation policy configuration in [WP-2115](../work-packages/WP-2115.md) creates no hold and cannot
be substituted as proof. There is no permission here to move capacity facts into Ordering, query
another Domain's tables, or call a cross-Domain transaction a local transaction.

**Proposal.** If the authoritative source permits a separate capacity owner's durable public hold
receipt plus an Ordering-owned submission allocation record, acquire the hold through that public
owner first, then atomically persist only Ordering's submission/allocation evidence locally.
The source must explicitly confirm that this satisfies WP-1302's allocation requirement; persisting
a receipt alone is not presumed equivalent. If the source instead requires a foreign capacity
mutation inside that transaction, stop for an owning architecture/ADR resolution. This handoff
remains unavailable until DEC-H03 is reconciled; the proposal does not weaken the accepted rule.

### Proposed request, result and failure sequence

The preparation request carries permanent submission and Payment operation references, exact Cart
Version and Quote, server-owned tip-selection reference if applicable, and an authoritative creation
instant. The output is the existing scoped
[OrderPaymentPreparationEvidence](../../../packages/rms/ordering/src/application/order-payment-preparation.ts)
with source version/digest evidence at each producing boundary. Contact, tip eligibility, collection
and fulfillment-slot policy must have their own approved source; unavailable is not zero/default.

1. Authorize Guest, scope and operation; resolve exact replay. Revalidate current Cart, Quote,
   selections and service eligibility. Changed versions require review and a new accepted intent.
2. After DEC-H03 closure, obtain the exact public capacity commitment under a stable reservation
   operation; commit submission and required Ordering-owned facts atomically with snapshots,
   number allocation, permanent operation, Audit and OrderCreated Outbox intent.
3. Bind the accepted Payment Intent creation instant and capacity expiry explicitly across the
   preparation/claim contracts. Delay/retry must not reset or extend the 30-minute window. The
   clock owner and admission of an aged preparation require source reconciliation in DEC-H03.
4. Payment validates scope, Cart/Quote/submission/digests, current capacity validity and integer CAD
   allocation + tip = total, then locally claims the Intent/Attempt before any Provider call.
5. If hold acquisition succeeds but submission rolls back, the capacity owner releases that exact
   hold through an idempotent public action; a durable recovery operation retries an unknown release.
   Ordering records no successful submission/number allocation from the rollback.
6. If submission commits but Payment claim fails, retain the original submission; retry its exact
   identity while eligible, otherwise request authorized release/finality. Do not create another
   Order or silently discard the first. After a possible Provider effect, reconcile Payment truth
   before releasing/reallocating or attempting another financial action.

Owner-local leases/expected versions serialize capacity consumption, expiry and release. A late
verified payment against expired/cancelled/unfulfillable work enters WP-1310's blocked disposition
and compensation path; it cannot recreate capacity or release Kitchen from Payment success alone.

## H-ORDER-01: acceptance, cancellation and final closure

### Proposed source producer and transitions

**Proposal DEC-H04.** Add an Ordering-owned decision producer over current Order/Batch source
facts. Named Staff uses the exact action permission; a Customer cancellation requires its accepted
Guest capability and policy boundary. System decisions require explicit purpose/authority. The
action's public input includes Order/Batch, operation, expected source version, bounded reason and
applicable policy reference; actors, scope, clock and permissions are server-resolved.

| Proposed action        | Required source decision                                                                                                   | Durable result and downstream meaning                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Accept                 | Current submission, channel-specific acceptance policy, capacity and Payment eligibility                                   | Append acceptance decision; only WP-1310's exact confirmation decision can publish OrderConfirmed. Accepted alone is not Confirmed.        |
| Reject                 | Current unconfirmed work and policy-authorized rejection                                                                   | Append rejected execution decision; captured money requires Payment's public compensation/refund decision, not a rewritten Payment status. |
| Request cancellation   | Exact current execution facts and allowed cancellation boundary                                                            | Record Pending while Kitchen/Fulfillment decisions are unresolved; no success, stock reversal or refund is inferred from the request.      |
| Finalize cancellation  | Current owner receipts proving permitted stop/remainder outcome                                                            | Append cancelled execution disposition and public remediation references; preserve already completed work and financial history.           |
| Close                  | Section 24.9 source invariants: final execution, controlled financial finality and no disqualifying pending work/exception | Append closed decision separately from Fulfilled; Dining close and Task completion supply no substitute authority.                         |
| Reopen/correct closure | Explicit authoritative action, actor, reason and compensating-history policy                                               | Remains unavailable until source resolution; never edit an accepted closure record or implicitly resurrect work.                           |

The specific permissions, acceptance automation, cancellation cutoff and close/reopen conditions
must be reconciled with Handoff Sections 24 and 88. No threshold, new phase or permission identifier
is accepted by this table. Existing Amendment rules remain authoritative: destructive changes
after Kitchen start wait for Kitchen confirmation and completed work may reject the request
([WP-2110](../work-packages/WP-2110.md)). Whole-order cancellation must resolve its own source rules.

### Concurrency, Events and recovery

Serialize each final Ordering disposition using expected source version and a permanent operation
intent. The local transaction appends decision, Audit, operation result and permitted Outbox work;
an Event consumer includes its Inbox result. Public dependency receipts bind exact Store, Order,
Batch, source version, operation, decision time and digest. Retry re-reads current owners, and
Pending remains visible while any owner is unavailable or another actor won the version race.

Payment success racing cancellation must resolve to exactly one eligible confirmation or blocked
unfulfillable disposition under WP-1310. Never append both OrderConfirmed and compensation for the
same authoritative decision. A known completed Kitchen/Pickup fact is not undone by a late cancel.
Conflicting or late receipts require reconciliation of original identities, not a new cancellation.
Kitchen and Fulfillment consume only approved Events/public sources in their own local transactions.

**Proposal DEC-H05.** Make closure a separately authorized source evaluation with public execution,
Payment finality, Amendment/cancellation and critical-exception evidence. Pin all source revisions;
recheck before local close, retry on drift, and retain Open on uncertainty. A later source change
requires an explicit correction/reopen policy rather than rewriting the evidence used to close.
The exact source fence preventing close versus a new Amendment/refund race must be defined in the
owning follow-up before implementation; a collection of independent stale reads is insufficient.

## H-REFUND-01: ordinary refund ownership and workflow

### Attribution correction and preserved financial rules

WP-1301's earlier referral of refund workflow/approval to WP-2045 was mismatched.
[WP-2045](../work-packages/WP-2045.md) owns webhook security review; it is not reassigned.
WP-1310 remains the accepted full original-method paid-without-fulfillable compensation contract.
It does not by itself authorize arbitrary Staff refunds or ordinary partial-refund policy.

**Proposal DEC-H06.** Give the ordinary refund follow-up to Payment, with Ordering/Pricing source
contracts and the [approval routing proposal](approval-and-operating-day.md). Payment owns request,
claim, Provider observations and financial finality. Ordering owns cancellation/Amendment facts;
Pricing owns any required allocation/tax calculation from immutable transaction snapshots.
No new generic Approval or Finance Domain, refund permission or implementation WP number is created.

The proposed request binds Payment/Order, stable operation, expected Payment and source-adjustment
versions, reason code and an eligible source allocation reference. A named authorized Staff actor
requests it; any Customer intent becomes an authorized request, never a Provider mutation. Amount,
currency, original method, refundable remainder and policy are derived from owner facts. No free-form
employee price or browser total is accepted. Return request state and safe recovery guidance only.

### Proposed execution sequence

1. Authorize action and scope; resolve request replay and immutable source references. Determine
   eligibility from the versioned policy and Ordering outcome before presenting an approvable draft.
2. Persist the request, source allocation/digests and Audit locally. Proposed states are Requested,
   AwaitingApproval, Approved, Rejected, Processing, ReconciliationRequired and ProviderConfirmed;
   these labels are not an accepted enum or a replacement for WP-1310's compensation states.
3. Where policy requires approval, obtain an exact request/version/amount-digest decision from an
   independently authorized Actor. A change to scope, allocation, amount or policy invalidates that
   approval. Approval authorizes work; it never establishes that a refund happened.
4. Payment acquires the original transaction/Attempt's fenced financial claim and re-reads verified
   cumulative refunds plus pending claims. Ordinary refunds and existing compensation must share
   the same balance exclusion contract: confirmed refunds + outstanding claims cannot exceed
   captured money. Conflicting claims cannot independently consume the same refundable remainder.
5. Retrieve Provider truth, claim the exact permitted remaining mutation with a stable Provider
   key, then invoke only the original-method port. Reconcile after every possible mutation. Unknown
   retains the claim and operation; it never frees balance for a second refund or reports success.
6. Append Provider-confirmed result and owner-local Audit/operation/Event effects once. A partial
   ordinary refund must not emit WP-1310's full-compensation PaymentRefunded payload; its approved
   Event and receipt/Order projection consumers require their own exact follow-up contract.
   Financial confirmation, Operations reconciliation and business-request closure stay distinct.

**Source question DEC-H07.** Reconcile full/partial eligibility, refundable line/tax/fee/tip
allocation, request/approval permissions, approval triggers, revocation and operational escalation
with accepted source and professional policy. No amount threshold, deadline or automatic approval
is invented. Until those inputs exist the relevant request/action is unavailable. Terminal Interac
retains the accepted in-person/reader/Provider-confirmation boundary; it has no generic background
refund shortcut. Receipt revisions append to the [WP-1709](../work-packages/WP-1709.md) chain.

## Acceptance scenarios and future verification anchors

These are proposed acceptance specifications, **not implemented tests or newly observed passes**.
Commands below already exist in the root package. They provide retained regression anchors; a
future owning WP must add each missing scenario and its real adapter/transaction evidence.

| ID     | Scenario and required observation                                                                                                                             | Existing regression command                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| AC-H01 | First Pickup create activates only the exact successor Session/Cart binding; old Cookie and foreign scope cannot access it.                                   | `pnpm ordering-cart:acceptance`; `pnpm guest-session:acceptance`                 |
| AC-H02 | Concurrent create/current/replacement requests select the agreed single binding; losing revisions do not create a second usable Cart.                         | `pnpm ordering-cart:acceptance`; `pnpm e2e:concurrent-update`                    |
| AC-H03 | Fail at each create/prepare/rotate/activate/response boundary; exact recovery creates no authority from IDs and discloses basket-loss behavior.               | `pnpm guest-session:acceptance`; `pnpm e2e:qr-menu-cart-order`                   |
| AC-H04 | DineIn unchanged Batch submission retains Session; Participant can modify only its authorized items.                                                          | `pnpm ordering-cart:acceptance`; `pnpm dining-closing:acceptance`                |
| AC-H05 | Stale Quote, changed Catalog or denied capacity produces no submission/Payment claim; changed price requires customer review.                                 | `pnpm ordering-create-order:acceptance`; `pnpm payment-intent:acceptance`        |
| AC-H06 | Inject hold-success/submission-rollback and submission-success/claim-failure; original identities reconcile and no durable number is consumed by rollback.    | `pnpm ordering-create-order:acceptance`; `pnpm payment-intent:acceptance`        |
| AC-H07 | Test exact 30-minute expiry, delayed retry and late confirmed payment; no extension or Kitchen release from expiry recovery.                                  | `pnpm payment-intent:acceptance`; `pnpm payment-compensation:acceptance`         |
| AC-H08 | Race accept/cancel/Payment success; one authoritative Ordering disposition and no duplicate confirmation/compensation.                                        | `pnpm e2e:payment-success`; `pnpm kitchen-confirmed-order:acceptance`            |
| AC-H09 | Cancel during Kitchen work/partial Pickup remains pending or rejects as source rules require; completed quantities/history remain intact.                     | `pnpm order-amendment:acceptance`; `pnpm pickup-fulfillment:acceptance`          |
| AC-H10 | Fulfilled with pending refund/Amendment/critical exception stays Open; source drift and concurrent new work prevent stale closure.                            | `pnpm dining-closing:acceptance`; `pnpm payment-reconciliation:acceptance`       |
| AC-H11 | Refund request denies unauthorized scope, client amounts and stale source; changed approved allocation requires new approval.                                 | `pnpm payment-compensation:acceptance`; `pnpm order-amendment:acceptance`        |
| AC-H12 | Race ordinary partial/full requests with compensation; cumulative confirmed plus claimed refunds never exceed capture.                                        | `pnpm payment-compensation:acceptance`; `pnpm payment-reconciliation:acceptance` |
| AC-H13 | Lose Provider/commit response, retry same financial operation and exercise Interac denial; no duplicate refund or inferred success.                           | `pnpm payment-compensation:acceptance`; `pnpm payment-reconciliation:acceptance` |
| AC-H14 | Confirm a permitted refund and append the matching receipt revision; original receipt is unchanged and partial refund cannot masquerade as full compensation. | `pnpm e2e:receipt-resume-email`; `pnpm payment-compensation:acceptance`          |

## Decision disposition and follow-up

DEC-H01/H02 belong to Identity + Ordering + Customer composition; DEC-H03 to Ordering + the
source-confirmed capacity owner + Payment + Architecture; DEC-H04/H05 to Ordering and the
collaborating execution/finality owners; DEC-H06/H07 to Payment + Ordering/Pricing + Operations.
DEC-H01/H02 product choices are **accepted in WP-2228**, with the implemented and remaining
mechanics distinguished above. DEC-H03–H07 remain **Proposal / source reconciliation pending**.
No named person, additional policy approval, production evidence, new permission or readiness for
the unresolved handoffs is claimed.
The next allowed increment is reconciliation and a separately scoped owning implementation brief
with exact public contracts, source version fences, migrations if needed and the relevant AC-H
scenarios. Passing existing regression commands alone cannot accept these proposals.
