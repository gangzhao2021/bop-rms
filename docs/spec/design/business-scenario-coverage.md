# Business Scenario Coverage

Payment status persistence (2026-09-12): initial payment_status_v1 now has a current-authorized
owner adapter backed by the existing table and exact committed terminal fact. Actual captured
projection, concurrent deduplication, rollback, amount mismatch and revoked access pass in
/tmp/bop-wp2402-payment-status-paid.log (104.12s). Event consumer/query/PWA composition remain;
this per-intent terminal fact does not establish whole-Order payment or financial closure.

Persistent runtime assembly evidence (2026-09-12): configured paid Pickup uses real acquired
connections through the Worker transaction adapter and the combined dispatch/retry composition.
Both retry plans recover without duplicate owner effects; tracked connections are released.
PostgreSQL run /tmp/bop-wp2402-persistent-worker-paid.log passed101.92s. Test credentials and
authority remain synthetic; production pool/configuration and complete routes remain gates.

Consumer recovery evidence (2026-09-12): both persisted retry plans recover after owner permission
returns via real claim -> scoped original event read -> reauthorized Inbox recovery -> completed
schedule with cleared lease. No extra owner/Audit/projection effects. Actual configured paid
Pickup run /tmp/bop-wp2402-consumer-recovery-paid.log passed102.12s. Continuous retry runtime
integration and actual Store/pool/configuration remain incomplete; this is synthetic authority.

Persistent failure evidence (2026-09-12): actual paid Pickup runtime now writes failure decisions
and scheduled retries for both revoked owner-consumer deliveries (2 attempts/2 schedules), with
unchanged owner/Audit/projection counts. PostgreSQL run
/tmp/bop-wp2402-eventing-persistent-paid.log passed101.63s. Retry execution/recovery, actual pool
assembly and complete subscriptions remain outstanding; scope/identity/random authority is synthetic.

Continuous Worker evidence (2026-09-12): createOutboxWorkload performs first completion delivery
against real PostgreSQL in the configured paid Pickup journey, with persisted publication and
successful stop (/tmp/bop-wp2402-outbox-loop-paid.log,103.94s including due-time wait).
Worker37 tests also cover non-overlap, timeout and background failure propagation. Trusted
pool/runtime setup, remaining subscriptions/retries and real Store activation are not complete.

Worker startup update (2026-09-12): unconfigured process startup now fails explicitly instead of
keeping an empty MessageChannel alive. Supplied workload starts before success and is stopped
once on failure/signals, including a signal during startup (Worker33 tests passed). Actual
continuous Outbox workload and trusted runtime configuration still need assembly.

Current first-processing evidence (2026-09-12): configured positive paid Pickup now obtains both
initial OrderCreated projection and FulfillmentCompleted owner/Audit/Inbox/projection through real
Outbox first delivery using createConsumerOutboxRuntime. Publication, rollback and duplicate
redelivery passed /tmp/bop-wp2402-outbox-first.log (99.37s, includes real due-time wait).
Full runtime startup/configuration and other event subscriptions remain incomplete; this does not
establish Store activation, real Provider acceptance or overall pilot readiness.

Current Outbox evidence (2026-09-12): persisted OrderCreated/FulfillmentCompleted rows now pass
real claim/lease -> authorized Worker duplicate consumption -> published confirmation in
/tmp/bop-wp2402-outbox-paid-due.log (101.25s, includes waiting for synthetic event due time).
This proves committed-event redelivery; first processing from Outbox and deployed runtime
configuration remain outstanding. Unconfigured event types are rejected, not acknowledged.

Current Worker evidence (2026-09-12): actual OrderCreated and FulfillmentCompleted are registered
and delivered through ConsumerDeliveryWorker to their authorized services in the configured
positive Pickup PostgreSQL journey. Concurrent completion, creation replay and revoked duplicate
authority passed in /tmp/bop-wp2402-worker-paid.log (49.94s). This still explicitly invokes delivery;
live Outbox runtime assembly and real Store/Provider activation remain outstanding.

Current WP-2402 evidence update (2026-09-12): configured positive Pickup now creates its initial
status projection by consuming the actual persisted OrderCreated event through the API composition,
then persists the Fulfilled projection through the actual completion consumer. Creation replay
preserves Fulfilled. PostgreSQL run /tmp/bop-wp2402-created-projection-paid.log passed (54.73s);
Store/System authority and Provider transport remain synthetic. Runtime dispatch and remaining
pilot flows are still incomplete; this does not establish single-Store trial readiness.

Latest v2 completion consumer persistence (WP-2402): configured positive Pickup now uses
the event-only API public-contract composition to resolve the original Order, generate or
recover the authoritative record, and execute actual published Workflow before it commits
actual Ordering completion/Audit, consumer Inbox and owner-derived status projection in one
restricted-role PostgreSQL transaction. Generation/pointer/Inbox failure with caller catch+commit
leaves the original projection and no completion/Audit/Inbox. Concurrent delivery produces one
processed result, one duplicate, and one completed projection generation. Item names/quantities/
money and guest audience come from the original Order snapshot. Initial Submitted projection is
seeded through fixture composition; production OrderCreated/Workflow/worker/UI composition is
still outstanding. Payment/Kitchen statuses remain explicitly unreported, not inferred.
Provider/Store/system authorization and publication approvals are synthetic; no pilot readiness
or financial Closed status is claimed. Exact fresh run is recorded in WP-2402.

Current paid Pickup Ordering completion (WP-2402, 2026-09-12): configured Pickup positive now
continues through actual FulfillmentCompleted publication into Ordering completion record and
public Audit under the actual published synthetic Store Workflow transition. One concurrent
request creates and one recovers; final counts remain one completion/one Audit. Record/Audit
failure caught before caller commit leaves neither; initial-window reads and new cancellation
reject completed Orders, while exact completion and Kitchen history retries remain recoverable.
JSONB key-order recovery is canonicalized. A current-authorized owner execution query now
returns the actual completion record/version/checkpoint, with before/after and permission-denied
evidence in the same configured paid Pickup case. The selected configured cancelled-after-capture
regression also passes. These are restricted-role isolated PostgreSQL cases; Provider transport,
Store/system authority and publication approvals remain synthetic. Phase is Fulfilled + Open.
Runtime Inbox delivery, authoritative current status/projection composition, receipt and separate
financial closure are still outstanding; earlier all-eight evidence is not relabeled fresh.

Earlier captured-Payment to Kitchen ticket milestone (2026-09-12, WP-2402): all8 isolated PostgreSQL
cases passed across Dining/Pickup, quote1/quote2 and positive/cancelled-after-capture.
Positive cases connect actual persisted submission, owner capacity/Inventory, Payment observation/
terminal history, published Workflow acceptance/release, OrderConfirmed, real Recipe/Modifier
publication and reviewed preparation, Store routing and Kitchen ticket/Audit/Outbox/Inbox.
Negative paths preserve compensation disposition without Kitchen release. Provider transport,
Store/System capabilities and external review/eligibility facts remain explicitly synthetic.
Kitchen queue/operator runtime, fulfillment/receipt/refund/ops, live Provider and pilot activation remain
unfinished. Exact selected-case runs and the resolved local DB connection failure are recorded
in [WP-2402](../work-packages/WP-2402.md); no full production readiness is claimed.

Current lifecycle extension (WP-2402): Pickup quote1 positive and Dining quote2 positive now
continue through actual Kitchen Accept/Start/Complete and automatic item/order Ready publication,
using restricted-role transactions and the actual Ordering source fence. A race between distinct
Accept commands at the same version has exactly one winner; original operations recover after
later progress. Remaining operator/admission/Expo policy decisions are synthetic.
A separate two-item PostgreSQL case proves no order Ready publication after only the first item,
one order publication after both, and duplicate concurrent operation recovery. That case uses
administrator connections and synthetic Ordering eligibility; it is not two-item paid-order evidence.
The isolated lifecycle acceptance also covers manual Expo Ready and savepoint rollback when callers
catch mandatory Audit/Outbox failures. Earlier all8 ticket milestone evidence is not a fresh run
of the lifecycle extension: only the two named positive combinations were rerun with this helper.

Current Pickup fulfillment creation extension (WP-2402): Pickup quote2 positive now uses the
actual Ordering accepted checkpoint, confirmation event and immutable snapshot to create one
Pending Fulfillment with exact original quantities, Audit and Inbox through a restricted role.
Original event retry recovers the saved creation effect. Dining quote1 positive returns its
actual DineIn source but creates no Pickup aggregate. These two selected combinations passed;
System authority remains synthetic. At that creation milestone KitchenItemReady consumption and actual handoff were still missing;
the Ready extension below supersedes only the former for its named tested combination.

Current Fulfillment Ready extension (WP-2402): configured Pickup quote2 positive now consumes
the actual public KitchenItemReady event after the Kitchen transaction commits, appends
Fulfillment-owned Ready result/operation with Audit/Inbox, and reads current Fulfillment Ready
under the restricted role and real Ordering source gate. Four consumer failure points roll back
all consumer effects; retry restores the exact original effect. This is a one-item paid fixture.
Separate two-item owner PostgreSQL coverage now proves Pending after the first item and Ready
after the second, contiguous versions, original replay and record-binding rejection. Its
Ordering/Kitchen inputs are synthetic and it uses an administrator connection; a complete paid
multi-item journey, handed-over guard evidence, handoff and runtime remain incomplete.
Prior paragraphs describe earlier milestones, not fresh runs of all combinations with this extension.

Current Pickup proof persistence extension (WP-2402): the two-item owner PostgreSQL fixture
continues actual Ready history through first issue, regeneration/invalidation and both proof
verifications with mandatory same-transaction Audit. Current aggregate versions include proof
issue/regeneration; verification grants no completion authority and does not advance version.
Old-code new verification, wrong selector and expiry are rejected. Original authorized issue/
verification replay survives regeneration and fresh eligibility denial; injected write/Audit
failures roll back all current operation effects. Source authority, clock and hashed capabilities
are synthetic, and this fixture uses administrator connections. The actual paid restricted-role
Pickup quote2 case now also continues through issue, regeneration/invalidation and verification,
with the real Ordering source gate, exact owner grants, rollback and original-replay coverage.
An initial fixture future-time violation was corrected without changing Audit limits; final run
passes. Real credential transport/abuse controls, operator authority, handoff/completion and
receipts remain to be connected. Strict full/partial handoff command/effect parsing and original
record encoding have owner-unit coverage; the handoff extension below supersedes the former
persistence gap for its named cases.

Current Pickup handoff persistence extension (WP-2402): actual paid configured Pickup quote2
continues through actor-bound handoff service/store writes, mandatory Audit and reconstructed
Fulfillment Completed under the restricted database role. Concurrent same-command attempts
recover one original delivery. Independent two-item owner PostgreSQL coverage proves partial
InProgress then remaining-quantity Completed using the same current validated proof, with
per-command permission/device admission and version checks. Record/item/operation/Audit failures
roll back atomically; old original retries work after fresh eligibility closes. Current proof/
Ready access rejects after handoff; original history remains recoverable. Staff/device/location
eligibility and Provider transport remain synthetic. Final handoff now also commits its exact
FulfillmentCompleted publication and public Outbox event in the same savepoint; partial handoff
emits none. Publication/Outbox failures roll back the final delivery, and concurrent/idempotent
retries retain one completion event. Both the two-item owner fixture and the named paid restricted
case passed. Ordering's existing completion consumer only changes its projection; the actual
Order lifecycle/Workflow consumer, receipt and operator/runtime/Store acceptance remain incomplete.
Fulfillment Completed is not a claim that the commercial Order is closed or the pilot is ready.

Current Ordering completion boundary (WP-2402): a strict immutable completion record now binds
the original event, owner version increment, Workflow version/transition and System authority
metadata, with digest-checked recovery. It records Fulfilled plus Open and rejects inferred
Closed. Targeted owner-unit tests pass; actual lifecycle persistence, Workflow execution and
transactional completion consumption remain unfinished. No projection-only consumer result is
treated as an authoritative commercial Order transition.

Original review baseline: `main@cedc44c9b6a6a1b389f77342078cc6f2d540dabe`.
The initial WP-2400 repair covered `f7a4c90` (WP-2350). The current view was reconciled during
[WP-2400](../work-packages/WP-2400.md) local integration on 2026-09-10 through
`4c3f9be52db676641a2cddc7d1f894424875f879` (WP-2352), including the committed WP-2351 write fence.
These are referenced owning-WP results, not fresh business runs by this documentation task.
Package and status definitions are in the [design index](./README.md). This maintained matrix
covers the principal journeys; the 210-row [canonical Screen Registry](../../product/screen-registry.yaml)
and accepted Handoff remain their source authorities. Inventory completeness is not a runtime or
production claim.

Current Kitchen persistence update (2026-09-12): actual persisted Order confirmation and
original item snapshots now feed the Kitchen consumer and PostgreSQL ticket/work-item/action
writer, with Audit, Outbox, Inbox and an immutable original creation record in one transaction.
Five injected failure boundaries roll back every effect. Concurrent intake, semantic duplicate
events, current authority revocation, and original replay after recorded lifecycle work progress and actual
Order cancellation have scoped database evidence in [WP-2402](../work-packages/WP-2402.md).
Saved quantities, options and notes are persisted from original Order history. Kitchen routing now uses
actual append-only Store configuration revisions and the real single-Station planner. Missing
configuration or denied read authority yields no routing evidence, and resolution binds the
revision effective at the exact confirmation instant; later configuration cannot change original
ticket history. Configuration write/read, Audit rollback, concurrency, scoped RLS and revision
behavior have actual PostgreSQL evidence. Recipe preparation now comes from real publication,
immutable reviewed storage and the public API composition, with actual persisted text/time evidence.
Store/Ingredient/reviewer facts and System/merchant capabilities remain explicitly synthetic.
The actual captured-Payment-to-Kitchen database path now passes both modes and quote versions.
Complete current release eligibility, Kitchen lifecycle/queue and production runtime activation
remain incomplete.

Current WP-2402 payment/termination milestone (2026-09-12): actual configured Dining and
Pickup PostgreSQL journeys now connect captured Payment history, initial Ordering execution,
append-only cancellation and a replayable PaidWithoutFulfillableOrder disposition. Cancellation
produces CompensationRequired with Kitchen blocked and zero OrderConfirmed, even when Inventory
read authority is unavailable; terminal processing does not depend on retained capacity/Inventory.
System/merchant policy capabilities and Provider transport remain explicitly synthetic. Published
acceptance-to-confirmation now also joins the actual captured Payment and Recipe/Kitchen
transaction path in both modes and quote versions. Provider
refund execution, Critical case/Operations reconciliation, full current Kitchen/fulfillment rules
and pilot runtime activation are still outstanding. [WP-2402](../work-packages/WP-2402.md) records
the exact fresh/reused evidence; earlier dated paragraphs retain their original component scope.

Latest WP-2402 transaction milestone (2026-09-11): Dining and ASAP Pickup now have actual
PostgreSQL evidence for persisted Workflow/Recipe/Item demand, atomic Inventory reservation/final
validation with Order creation, and Payment Intent/Attempt/Audit claim. Capacity-owner advisory
locks and Inventory Item locks remain held at Payment INSERT. Policy refusal, Order/Payment
Audit rollback and post-commit response-loss recovery are covered for both Quote versions;
original recovery does not repeat reservation or Payment admission. Current customer Identity
authorization is used. Store configuration/review data and the Inventory policy evaluator in
these acceptance cases remain explicitly synthetic. There is no Provider call, runtime activation
or complete merchant/Kitchen/handoff/receipt/refund/ops acceptance claim. Formal preparation
snapshot generation now derives exact amounts and source provenance from owner records; exact logs and remaining conditions are maintained in
[WP-2402](../work-packages/WP-2402.md). Earlier progress paragraphs below describe their own
component scope and must not be treated as current evidence of missing Inventory persistence.

Current WP-2402 update (2026-09-11): both actual Pickup and Dining submission cases use
the production API Order source, persisted Catalog snapshots and Pricing Quote history.
Current PriceBook and TaxConfiguration are read from owned PostgreSQL tables in one
read-only Repeatable Read transaction before quote calculation; exact money, currency versions, tax evidence references and validity are checked.
Complete external tax evidence is required because the legacy version table does not contain
all review facts. The acceptance policies/evidence are explicitly synthetic. Original Order
response-loss recovery, capacity/clock, tip and payment-safety cases remain connected.
The existing Guest-authorized Quote HTTP case now also uses the coherent persisted-policy
composition, including original Quote/request/attachment recovery and Guest revocation.
Dining basic no-option Quote HTTP also passes with real current Identity/Dining participation
and actual Quote/request/attachment persistence, response-loss replay and later Guest revocation.
That isolated Cart fixture does not establish Catalog selection or selected-option pricing;
Dining Quote expiry now has actual HTTP/PostgreSQL recovery evidence: a saved unattached Quote
expires once with one Audit, lost expiry acknowledgement recovers the original 410, attached
history remains original, and current Guest revocation denies both paths. The locked Cart
rejects missing/foreign DiningSession authority. See WP-2402 dining-expiry-http evidence.
Selected-option pricing now has a v2 calculator, canonical complete evidence and actual atomic
PostgreSQL Quote/request/Audit and Cart attachment persistence. The current-authorized application
service matches exact Catalog binding/quantity/version/tax evidence and recovers original history.
Both Dining and Pickup service-to-store cases recover sequential Pricing and attachment commit
acknowledgement loss, concurrent replay and Audit rollback with separate owner roles. The configured
customer entry now composes actual Identity records/CSRF, Pickup Cart binding or Dining participation,
and current Catalog snapshots with the persisted Quote/request/attachment. Invalid CSRF or mismatched
candidate scope writes nothing; an archived SKU blocks attachment and later availability recovers the
original Quote. Persisted Guest revocation denies history. Store/QR/consumed-admission authority,
Inventory/KillSwitch safety and commercial policies remain explicit synthetic dependencies in these cases.
Current Option rule versions now persist with immutable history and scoped reads. Dining/Pickup
entries read PriceBook, tax and Option policies through a dedicated read-only transaction instead of
a precomputed Quote callback. Actual concurrent policy-update acceptance proves a single snapshot;
original-operation recovery does not reread prices. Synthetic seed values do not establish publishing
permission, commercial approval or real tax evidence. Option publication, final authority composition,
complete customer submission and final runtime wiring remain outstanding. The configured Quote HTTP port now passes
actual Dining/Pickup 201/recovery, original attached history, durable unbound-operation 410 and
revoked-Guest 404 with persisted policies and owner records; customized-item checkout and complete submission-to-Payment are not yet accepted.
Configured Order price evidence now has an explicit v2 snapshot parser and original Quote source.
Actual Dining/Pickup persisted Quote cases preserve base/option amounts, included/charged quantities
and original rule versions in the mapped output. The configured Checkout producer now generates v2 evidence from current persisted Cart/attachment,
Catalog selection/full snapshots and original Quote history, with repeated current entry authorization.
Actual Dining/Pickup cases feed that evidence to the Order-price source. Fulfillment/Store readiness
and safety inputs remain synthetic. Configured Order item composition matches Catalog options to
original price evidence. Actual restricted-role PostgreSQL acceptance now writes v2 Orders/items,
number allocation, Audit and Outbox atomically, with exact charged quantities and original amounts.
Both modes pass capacity-linked application creation, original recovery after lost commit response,
current authorization denial, Audit rollback and scoped history reads. The production configured source now composes persisted Cart, original Pricing history and current
Catalog instead of manual line assembly; both-mode acceptance also proves SKU withdrawal rejection.
Actual configured customer submission now composes persisted Identity/CSRF, Cart/Quote, current
Catalog, Dining commitment or Pickup shared capacity, configured source and atomic Order writes.
Both modes preserve option prices through lost Order responses and recover the original sealed
Payment clock. v2 Quote policies come from persisted PriceBook/Tax/Option owners; commercial,
Store/QR/admission and Inventory/safety fixture values remain synthetic. Public HTTP/browser
submission remains open. Both configured modes now also pass persisted explicit tip response-loss
recovery, exact Order allocation plus tip, original clock recovery, current payment access,
kill-switch denial and persisted Guest revocation. The final Inventory/Payment preparation producer
and Provider activation remain open.
Final Inventory, real Store policies, Payment activation and downstream/browser pilot journeys
remain open. See WP-2402 for exact commands and reusable evidence.

## Matrix contract

Each scenario carries a stable local ID, initiating role, owning Domain/public handoff, bounded
input and outcome, failure recovery, baseline source and acceptance/evidence boundary. Tenant,
Brand, Store, Actor, purpose and permission remain explicit where required. Mutations additionally
retain expected version, stable operation identity and owner-local Audit/history semantics.

The following labels describe **design coverage**, not pass/fail test results:

- **Baseline:** relevant source contract exists; preserve its exact implementation/evidence limits.
- **Decision:** this review identified an unresolved source or local design handoff.
- **Mapping:** the assigned WP does not own the promised workflow; correct attribution or assign a
  real follow-up before claiming coverage.
- **Integration:** the contract exists but its required producer/composition needs a ready WP.
- **Proposal:** this package introduces a reviewable system/SOP improvement requiring acceptance.
- **Gate:** the scope is intentionally deferred or requires external evidence.

No prior WP test count is reproduced as a new pass. The original AC-H, AOD and SC scenarios below were newly
designed acceptance requirements in WP-2224. Later WP evidence is listed at its actual scope,
without claiming execution of those entire named suites. Their documents map them to existing
regression commands and explicitly identify missing future acceptance implementation.

## Latest WP-2402 submission evidence

Order source composition update (2026-09-11): both actual submission cases now use the production
Ordering source to join current Cart, stored Pricing lines and Catalog snapshots. It checks
version, quantity, option/tax provenance and the original Checkout observation time. Both
database paths pass with that composition; runtime activation and final Inventory/Payment
remain open. See [WP-2402](../work-packages/WP-2402.md).

Both Order price paths update (2026-09-11): Dining and Pickup now persist the full Pricing Quote
and Audit, read it through a separate SELECT-only owner role, and write its original pricing
lines into the actual Order. Recovery preserves Quote digest, amount and tax-version provenance.
[WP-2402](../work-packages/WP-2402.md) has fresh composed database evidence. Price/tax policies are
still explicit synthetic configurations; final Inventory, runtime activation and payment remain.

Pricing source update (2026-09-11): actual saved complete Quote history now feeds the Ordering
price adapter under a SELECT-only role. Large exact amounts and compounded tax components are
preserved; digest mismatch, foreign history and expiry deny conversion without writes.
[WP-2402](../work-packages/WP-2402.md) records evidence. Persisting a new Order from this source
and replacing synthetic commercial pricing configuration remain outstanding.

Dining Order snapshot update (2026-09-11): actual Catalog snapshots now also feed persisted
Dining Order item names, selected options and SKU/Product facts, with original response-loss
recovery verified. Both modes retain explicit synthetic Pricing inputs pending connection to
the immutable Pricing owner quote. [WP-2402](../work-packages/WP-2402.md) owns the evidence.

Pickup Order snapshot update (2026-09-11): persisted Catalog facts now produce the actual
transactional Order item names, selected option names, SKU/unit and tax-classification reference.
Recovered Orders preserve those snapshots. Missing tax/invalid selection/unavailable safety
refuses snapshot generation. [WP-2402](../work-packages/WP-2402.md) records actual Catalog and
Pickup database evidence; Pricing, final Inventory and live commercial facts remain outstanding.

Dining Checkout update (2026-09-11): the real Dining submission case now also reads current
persisted Catalog release, SKU and option bindings. SKU withdrawal rejects before Order creation;
restoration retains original Order/clock/tip and payment-safety recovery. Fresh Dining and Pickup
database runs are in [WP-2402](../work-packages/WP-2402.md); final Inventory and commercial
snapshot/Pricing sources remain open.

Pickup Checkout update (2026-09-11): persisted current Catalog release, SKU and option binding
now participate in actual submission acceptance. SKU withdrawal rejects before Order creation;
restoration permits the existing original Order/clock/tip recovery path. Inventory/safety
observations and commercial pricing/snapshot fixtures remain synthetic. See
[WP-2402](../work-packages/WP-2402.md) for fresh database evidence and remaining final preparation.

Cart integration update (2026-09-11): actual HTTP add/update now composes persisted Identity,
Catalog release/SKU/availability and Ordering writes. Response-loss retries recover original
operations; archiving the SKU rejects a fresh update without Cart/Audit changes. The owner
database runs are recorded in [WP-2402](../work-packages/WP-2402.md). Inventory/KillSwitch
observations and commercial fixture configuration remain synthetic; final submission and
rendered browser acceptance remain open.

Payment safety update (2026-09-11): actual persisted Dining and Pickup Guest/Order authorization
now feeds persisted Feature Control definitions through the Payment safety adapter. Inactive
permits admission, Active denies, and actual Guest revocation denies. The switch reader uses an
independent SELECT-only role. [WP-2402](../work-packages/WP-2402.md) records both composed database
runs. Switch initialization and rollout assignment remain explicit fixtures; final Inventory,
payment preparation and Provider activation are still outstanding.

| Scenario                | Current implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Remaining dependencies                                                                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-04 Dining submission | Accepted DEC-H03-DINING; persisted Identity/Dining/Cart/Quote to original atomic Order, original payment clock and explicit saved tip; response-loss recovery and current Dining payment authority verified in [WP-2402](../work-packages/WP-2402.md).                                                                                                                                                                                                                                                                                  | Production PWA client/HTTP recovery now passes both quote versions against PostgreSQL; final Inventory, complete Payment preparation/activation, rendered browser and operating journeys remain.                                                                                                                                 |
| BC-04 Pickup submission | Actual Identity/CSRF, Cart/Quote owner reads, default unit provenance, shared ASAP capacity, Checkout and atomic Order/Audit/Outbox composition now verified in isolated PostgreSQL. Lost acknowledgement preserves original Order/Batch and one set of effects; original 30-minute payment-clock sealing/recovery and explicit tip/Audit are persisted. Exact amounts and current capacity permission are verified separately; revoked Identity denies access. [WP-2402](../work-packages/WP-2402.md) owns commands and tested inputs. | Complete OrderPaymentPreparation/Payment/Inventory and compensation; held-capacity permission alone is not full payment readiness; commercial Catalog/Pricing/BusinessDate, QR/Store binding and explicit default policy are still synthetic inputs in this acceptance. No submitted-order browser evidence or pilot activation. |

Payment persistence update in [WP-2402](../work-packages/WP-2402.md): BC-05 now has an actual
PostgreSQL Intent/Attempt/operation/Audit adapter and normalized observation recovery. The
actual creation service is verified to commit before invoking its synthetic Provider adapter;
unknown claim response stays Processing and does not trigger another Provider call. This
acceptance injects preparation, Guest and KillSwitch evidence and does not establish final
Inventory eligibility, live Provider readiness or the complete BC-04-to-BC-05 journey.

## Customer and transaction journey

| ID / initiating role                                   | Owner and bounded input/result                                                                                                                                                             | Failure and recovery contract                                                                                                                                           | Source / design status                                                                                                                                                                                                                                                                                                                                                                                            | Acceptance and remaining evidence                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-01 Guest scans and browses                          | Public Capability + Store + Identity establish a scoped Guest; Catalog supplies the published menu through public queries.                                                                 | Invalid/expired QR or Session denies uniformly; preserve rotation, revocation and source-scoped menu parsing.                                                           | [WP-1003](../work-packages/WP-1003.md), [WP-2221](../work-packages/WP-2221.md), [WP-2222](../work-packages/WP-2222.md). Baseline.                                                                                                                                                                                                                                                                                 | Existing local Entry/Menu PostgreSQL lab is bounded synthetic evidence, not real Store readiness; continue `customer-lab:acceptance` when behavior changes.                                                                        |
| BC-02 Guest creates/resumes Cart                       | Ordering owns Cart/current lookup; Identity owns Session rotation and credentials. Exact authorized binding is required before read/mutation.                                              | Concurrent creation, partial binding and lost response must converge without granting authority from a Cart reference or reviving a revoked Session.                    | [WP-1003](../work-packages/WP-1003.md), [WP-2223](../work-packages/WP-2223.md); DEC-H01/H02 accepted in [WP-2228](../work-packages/WP-2228.md). Remaining mechanics are Integration DC-01; H-CART-01.                                                                                                                                                                                                             | AC-H01–04 in [handoff proposal](./customer-order-payment-handoffs.md); current service, HTTP, persistence and browser evidence plus remaining continuity work are in the [current evidence view](#current-scenario-evidence-view). |
| BC-03 Guest changes Cart and reviews Quote             | Ordering owns item/version intent; Catalog validates selection; Pricing owns exact amount, tax, Quote and expiry.                                                                          | Same business intent replays without duplicate mutation; stale version/selection requires refresh; changed/expired Quote requires accepted review flow.                 | [WP-1201](../work-packages/WP-1201.md), [WP-1205](../work-packages/WP-1205.md), [WP-1104](../work-packages/WP-1104.md). Baseline/Integration; Catalog selection and availability remain distinct from commercial authority.                                                                                                                                                                                       | Current Quote, selection and availability evidence through WP-2335, their synthetic inputs and remaining producer/Checkout dependencies are in the [current evidence view](#current-scenario-evidence-view).                       |
| BC-04 Guest submits for Payment                        | Ordering public preparation must prove immutable submission plus the exact owner capacity commitment linked under accepted DEC-H03; Payment owns Intent/Attempt claim before Provider use. | Hold expiry, duplicate preparation and commit-unknown must not create a second submission or charge; source identity/scope/amount mismatch denies.                      | [WP-1220](../work-packages/WP-1220.md), [WP-1224](../work-packages/WP-1224.md), [WP-1302](../work-packages/WP-1302.md); [DEC-H03](./capacity-source-decision.md) topology Accepted. Integration DC-04; the distinct [Dine-in interpretation](./capacity-checkout-handoff.md) is accepted; owner lifecycle and bounded composed PostgreSQL evidence are recorded in WP-2402; complete Payment integration remains. | AC-H05–07 remain whole preparation scenarios. Current capacity/Order evidence and the remaining Payment composition are in the [current evidence view](#current-scenario-evidence-view).                                           |
| BC-05 Payment progresses and reconciles                | Payment processes verified Provider observations through durable Inbox and publishes only canonical terminal facts.                                                                        | Unknown remains unknown; duplicate/conflicting webhook cannot create duplicate financial effect; reconciliation reads Provider truth before eligible retry.             | [WP-1303](../work-packages/WP-1303.md), [WP-1304](../work-packages/WP-1304.md), [WP-1307](../work-packages/WP-1307.md). Baseline/Gate; [WP-2341](../work-packages/WP-2341.md) preserves the original Payment clock and checks current preparation freshness.                                                                                                                                                      | Synthetic financial/reconciliation evidence and the service-only freshness repair are separated in the [current evidence view](#current-scenario-evidence-view); live Provider evidence remains gated.                             |
| BC-06 Merchant accepts/cancels; Order reaches finality | Ordering owns acceptance, cancellation, confirmation and closure; downstream Payment/Kitchen/Fulfillment consume exact public facts.                                                       | Cancellation, payment success, capacity expiry and kitchen start need one owner-issued disposition; fulfillment evidence alone cannot close financial history.          | [WP-1309](../work-packages/WP-1309.md), [WP-1310](../work-packages/WP-1310.md), [WP-1605](../work-packages/WP-1605.md). Integration DC-04; H-ORDER-01.                                                                                                                                                                                                                                                            | AC-H08–10 transition/race scenarios; required fact producers and close/reopen execution remain separate follow-up scope.                                                                                                           |
| BC-07 Kitchen prepares and hands over                  | Only Ordering-confirmed source releases Kitchen work; named operator uses authorized station/ticket state and immutable outcome.                                                           | Stale/disconnected KDS is read-only; ownership handover locks and refreshes; duplicated events do not duplicate preparation.                                            | [WP-1400](../work-packages/WP-1400.md), [WP-1408](../work-packages/WP-1408.md). Baseline.                                                                                                                                                                                                                                                                                                                         | Existing `kitchen-confirmed-order:acceptance` and `kds-continuity:acceptance`; AOD-08 extends continuous operating acceptance.                                                                                                     |
| BC-08 Pickup recipient receives order                  | Fulfillment owns proof checking, eligible handoff and completion; Ordering/Payment remain source owners.                                                                                   | Wrong/expired proof denies; partial/replayed handoff respects existing remaining-item and version rules.                                                                | [WP-1602](../work-packages/WP-1602.md), [WP-1603](../work-packages/WP-1603.md), [WP-1605](../work-packages/WP-1605.md). Baseline.                                                                                                                                                                                                                                                                                 | Existing `pickup-proof:acceptance` / `pickup-fulfillment:acceptance`; real Store device/operator evidence is not supplied here.                                                                                                    |
| BC-09 Guest retrieves Receipt/recovery                 | Ordering owns immutable Receipt source snapshots/version history; Notification delivers a purpose-bound recovery capability.                                                               | Expired/consumed recovery or lost Session never authorizes by Order ID alone; correction/reissue preserves prior receipt facts.                                         | [WP-1709](../work-packages/WP-1709.md), [WP-1723](../work-packages/WP-1723.md), [WP-2028](../work-packages/WP-2028.md). Baseline/Gate.                                                                                                                                                                                                                                                                            | Existing `e2e:receipt-resume-email`; actual deliverability, consent/legal policy and production evidence retain their gates.                                                                                                       |
| BC-10 Merchant requests ordinary refund                | Payment owns refundable balance and financial outcome; Pricing supplies accepted allocation; source approval policy governs request/review/execution.                                      | Concurrent ordinary/compensation refunds share cumulative protection; Pending/Unknown is reconciled before another execution; final source evidence closes the request. | [WP-1301](../work-packages/WP-1301.md), [WP-2045](../work-packages/WP-2045.md), [WP-1310](../work-packages/WP-1310.md). Mapping DC-02; H-REFUND-01.                                                                                                                                                                                                                                                               | AC-H11–14 refund scenarios; ordinary workflow/approval needs its own execution WP. Existing paid-unfulfillable compensation does not prove this journey.                                                                           |

## Merchant operating journey

| ID / initiating role                           | Owner and bounded input/result                                                                                                             | Failure and recovery contract                                                                                                                                       | Source / design status                                                                                                                                                                                            | Acceptance and remaining evidence                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-11 Operator configures and opens Store      | Tenant owns identity/lifecycle; Store owns hours/service/Business Date configuration; Publishing owns Live Gate decision.                  | Unknown/expired source blocks activation; draft/version/approval conflicts preserve prior publication; pause never rewrites existing transactions.                  | [WP-2192](../work-packages/WP-2192.md), [WP-2194](../work-packages/WP-2194.md). Baseline/Gate.                                                                                                                    | `store-configuration:acceptance`; AOD-06 opening proposal; actual premises, policy and approval evidence remain external.                                |
| BC-12 Staff enters/amends Order                | Ordering owns staff command and amendment; Pricing, Kitchen and permission owners provide exact evidence.                                  | Stale source or absent required approval/Kitchen acknowledgement blocks commit; no client-authored financial truth.                                                 | [WP-2116](../work-packages/WP-2116.md), [WP-2110](../work-packages/WP-2110.md). Baseline/Integration.                                                                                                             | Existing `order-amendment:acceptance`; staff/Terminal runtime evidence follows its owning later WP.                                                      |
| BC-13 Staff seats, moves and closes Dining     | Reservation/Waiting own booking/queue; Dining owns actual seating/Session; Payment owns deposit and settlement facts.                      | Capacity revision retains old claim until replacement accepted; close locks new submissions and preserves unpaid exceptions; table cleaning is a separate boundary. | [WP-1007](../work-packages/WP-1007.md), [WP-2112](../work-packages/WP-2112.md), [WP-2113](../work-packages/WP-2113.md), [WP-2114](../work-packages/WP-2114.md). Baseline/Gate.                                    | Existing `dining-closing:acceptance`; AOD-07 manual/system boundary; Floor Board phase and customer self-service inheritance are not silently activated. |
| BC-14 Author publishes Menu/prices             | Catalog, Pricing, Recipe and Publishing retain own versioned facts and public validation/approval references.                              | Invalid/stale safety evidence or conflicting effective period blocks publication; immutable sales snapshots are not repriced from current configuration.            | [WP-2100](../work-packages/WP-2100.md), [WP-2101](../work-packages/WP-2101.md), [WP-2102](../work-packages/WP-2102.md), [WP-2103](../work-packages/WP-2103.md), [WP-2105](../work-packages/WP-2105.md). Baseline. | Existing catalog/pricing/recipe acceptance scripts; approval entry orchestration belongs to AOD, not implicit Task completion.                           |
| BC-15 Buyer procures and receives              | Procurement owns requisition/PO/discrepancy and event-derived PO fulfillment; Inventory owns Goods Receipt and Stock Movement.             | Partial receipt, duplicate posting and discrepancy use public owner evidence and compensating records, never direct foreign writes.                                 | [WP-2133](../work-packages/WP-2133.md), [WP-2134](../work-packages/WP-2134.md), [WP-2135](../work-packages/WP-2135.md), [WP-2136](../work-packages/WP-2136.md). Baseline.                                         | Owning WPs retain contract/isolated-DB evidence; AOD source-routing includes approval and unresolved receipt handover.                                   |
| BC-16 Stock operator counts/transfers/disposes | Inventory owns append-only movements, blind count, approved adjustment, transfer and waste facts.                                          | Exact version/approval and source proof prevent duplicate posting; discrepancy/correction appends history.                                                          | [WP-2121](../work-packages/WP-2121.md), [WP-2122](../work-packages/WP-2122.md), [WP-2123](../work-packages/WP-2123.md), [WP-2124](../work-packages/WP-2124.md), [WP-2125](../work-packages/WP-2125.md). Baseline. | Owning WP acceptance remains authoritative; no new accounting or stock-policy assumption.                                                                |
| BC-17 Food Safety investigates/contains        | Compliance owns case/inspection/recall/trace workflow; Catalog/Ordering/Payment keep source controls.                                      | Missing provenance, expired qualification or unresolved safety evidence fails closed through owner controls; case acknowledgement does not remove a safety block.   | [WP-2171](../work-packages/WP-2171.md), [WP-2175](../work-packages/WP-2175.md), [WP-2176](../work-packages/WP-2176.md), [WP-2177](../work-packages/WP-2177.md). Baseline/Gate.                                    | Existing `e2e:allergen-safety`; real professional evidence and incident notification decisions remain external.                                          |
| BC-18 Manager handles work/approvals           | Task owns assignment metadata; each source Domain owns approval and business result; Merchant surfaces route exact authorized source work. | Stale permission/source version, unknown outcome and unavailable approver require explicit refresh/reconciliation/escalation without auto-approval.                 | [WP-0125](../work-packages/WP-0125.md), [WP-0045](../work-packages/WP-0045.md), canonical APPROVAL-INBOX/ALERT-CENTER. Mapping DC-03.                                                                             | AOD-01–05 in [work-routing proposal](./approval-and-operating-day.md); assigning the same narrow WP to a Screen does not implement it.                   |
| BC-19 Operator closes day and hands over       | Store Operations coordinates; Dining, Ordering, Payment, Kitchen and Task retain their own open/final facts.                               | Stop-new-work, unresolved in-flight work and next-day responsibility are explicit; business-date change never fabricates completion or edits history.               | [WP-1905](../work-packages/WP-1905.md), [WP-1007](../work-packages/WP-1007.md), [WP-1408](../work-packages/WP-1408.md). Proposal DC-06.                                                                           | AOD-06–10 operating-day scenarios; system/manual steps and real operator exercise require separate acceptance.                                           |

## Customer governance, platform and operations

| ID / initiating role                                       | Owner and bounded input/result                                                                                                              | Failure and recovery contract                                                                                                                                     | Source / design status                                                                                                                                                         | Acceptance and remaining evidence                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| BC-20 Customer/authorized operator manages profile/loyalty | Customer/Loyalty own verified links, consent, program/account and immutable points ledger.                                                  | Merge evidence, reservations and compensating corrections preserve source records; consent or Task completion does not invent financial/profile truth.            | [WP-2140](../work-packages/WP-2140.md), [WP-2141](../work-packages/WP-2141.md), [WP-2143](../work-packages/WP-2143.md), [WP-2144](../work-packages/WP-2144.md). Baseline/Gate. | Owning WP evidence remains scoped; inherited Customer self-service Screens require parent/source reconciliation before activation.    |
| BC-21 Privacy reviewer fulfills rights                     | Privacy coordinates verified subject/purpose and required Data Owners; each owner executes its accepted policy.                             | Missing owner, partial evidence, hold/retention or changed coverage prevents unsupported completion; retry does not duplicate exports or erase protected history. | [WP-2146](../work-packages/WP-2146.md), [WP-2051](../work-packages/WP-2051.md), [WP-2055](../work-packages/WP-2055.md). Baseline/Proposal DC-07.                               | SC-PRIV-01–04 in [system proposal](./system-completeness-contracts.md); no real rights execution or policy applicability is asserted. |
| BC-22 Analyst runs/reconciles reports                      | Reporting owns versioned metric/report/result/projection facts; source Domains remain authoritative.                                        | Missing data is unavailable, not zero; immutable discrepancy resolves only with rerun evidence; backfill never silently corrects source history.                  | [WP-2160](../work-packages/WP-2160.md), [WP-2163](../work-packages/WP-2163.md), [WP-2164](../work-packages/WP-2164.md), [WP-2165](../work-packages/WP-2165.md). Baseline.      | Existing `data-quality-reconciliation:acceptance` / `pipeline-run:acceptance`; no claim of statutory accounting.                      |
| BC-23 Platform/Support acts on Tenant                      | Tenant owns lifecycle; Task owns purpose-bound Support Case/grants; Identity/Permission/Audit remain independent controls.                  | Missing case/purpose/MFA/evidence denies; suspension retains impact assessment; diagnostic expiry/revocation removes access without impersonation.                | [WP-2197](../work-packages/WP-2197.md), [WP-2198](../work-packages/WP-2198.md), [WP-2199](../work-packages/WP-2199.md). Baseline/Gate.                                         | Existing `platform-tenant-admin:acceptance` / `support-case:acceptance`; real people, approvals and support actions not created.      |
| BC-24 Operator manages Provider/device boundary            | Device owns device/profile facts; each Provider Domain owns adapter, credential and replay authority; admin Projection routes intents only. | Unknown health or absent evidence denies activation; failed output/replay has owning recovery, not generic raw-payload or device-command access.                  | [WP-1806](../work-packages/WP-1806.md), [WP-1808](../work-packages/WP-1808.md), [WP-2181](../work-packages/WP-2181.md), [WP-2182](../work-packages/WP-2182.md). Baseline/Gate. | Existing device/profile/admin acceptance; deferred output WPs and actual Store UAT remain explicit gates.                             |
| BC-25 Release operator rolls forward/back                  | Release composes PWA/API/Worker, immutable digest and schema compatibility with migration ownership.                                        | Long-lived old clients/workers, contract migration and rollback require one accepted compatibility manifest; safe update rules stay intact.                       | [WP-1708](../work-packages/WP-1708.md), [WP-2049](../work-packages/WP-2049.md), [WP-2064](../work-packages/WP-2064.md). Proposal DC-05.                                        | SC-COMP-01–04; existing release/PWA checks protect baseline but do not prove a new version-support window.                            |
| BC-26 SRE restores service/data                            | Recovery owners retain fencing, RPO/RTO, immutable evidence, tombstone replay and Provider reconciliation.                                  | Restore cannot replay financial Commands blindly, resurrect withdrawn rights or erase Audit; stale primary remains fenced.                                        | [WP-2053](../work-packages/WP-2053.md), [WP-2055](../work-packages/WP-2055.md), [WP-2066](../work-packages/WP-2066.md). Baseline/Gate.                                         | Existing recovery policy checks; actual timed restore/drill and production authorization remain external.                             |
| BC-27 Product/SRE accepts peak workload                    | Product/Operations define journey objectives; SRE/Data define workload, capacity and safe instrumentation.                                  | Missing target/window makes a result non-evaluable; overload protection cannot drop durable business outcomes or infer Payment failure.                           | [WP-0045](../work-packages/WP-0045.md), [WP-2065](../work-packages/WP-2065.md). Proposal/Source decision DC-08.                                                                | SC-PERF-01–04; load implementation and measured results belong to a future accepted SLO/capacity WP.                                  |

## Current scenario evidence view

This is the single current implementation/evidence summary for BC-02–05. Accepted decisions,
implemented components and observed test layers are separate columns; none implies the others.
The linked WPs retain each original command, result, tested revision/diff, log and reuse rationale.
WP-2400 reads those historical records and runs no business acceptance on their behalf.
Unchanged baseline rows elsewhere retain their owning WP evidence and explicit gates.

| Scenario                                          | Accepted decision / source                                                                                                                                                                                                                                                                                                                                                             | Service and HTTP evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Isolated PostgreSQL evidence                                                                                                                                                                                                                                                                                                                                                                                                                          | Browser evidence                                                                                                                                                                                      | Remaining owner work / gate                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BC-02/03 Cart identity, binding and edits         | DEC-H01/H02 accepted in [WP-2228](../work-packages/WP-2228.md); the product choices stay closed.                                                                                                                                                                                                                                                                                       | [WP-2326](../work-packages/WP-2326.md) composes the current Dining binding guard into the local API. [WP-2331](../work-packages/WP-2331.md) and [WP-2332](../work-packages/WP-2332.md) cover Pickup Add/Update/Remove authority, expiry and original replay across waits, with API regression.                                                                                                                                                                                                                                                                                                                                                      | WP-2326/2327 use real Identity/Dining/Ordering owner stores; WP-2331/2332 record actual Cart PostgreSQL acceptance. Staff, QR, selection and policy inputs remain synthetic.                                                                                                                                                                                                                                                                          | [WP-2327](../work-packages/WP-2327.md) proves two simultaneous browser contexts on one table, actual invitation regeneration, shared Cart and own-line/note isolation through real local HTTP/stores. | Identity-owned cross-document credential continuity remains separate from acknowledged foreground recovery. Current authorization observations do not establish an atomic commit-time lease. Real Store/operator/QR evidence remains external.                                                                                                                                                                                                                     |
| BC-03 Quote continuity and current Catalog inputs | Existing Catalog selection/availability and Pricing Quote rules remain authoritative; no new sellability or pricing decision is accepted here.                                                                                                                                                                                                                                         | [WP-2328](../work-packages/WP-2328.md)/[WP-2329](../work-packages/WP-2329.md) cover current Pickup Quote authority/expiry. [WP-2333](../work-packages/WP-2333.md) covers closed Catalog collections and pure Catalog/Ordering composition. [WP-2334](../work-packages/WP-2334.md)/[WP-2335](../work-packages/WP-2335.md) add an internal rule reader/current-availability service; no new HTTP surface.                                                                                                                                                                                                                                             | [WP-2268](../work-packages/WP-2268.md) proves continuous Cart mutation/Quote behavior through actual HTTP and owner stores; WP-2328/2329 cover affected Quote acceptance. WP-2334's WSL continuation and WP-2335 prove real Catalog rule reads/composition with explicitly synthetic Inventory/KillSwitch evidence.                                                                                                                                   | WP-2327 covers Cart edits. WP-2268 is an HTTP/store scenario; it supplies no new Quote/Checkout browser proof.                                                                                        | Inventory/KillSwitch evidence still needs authoritative mappings, owner expiry and producer wiring; conditional selection publication and commercial inputs remain separate. Dining Quote/Checkout and connected browser acceptance need bounded owning work. Availability observations grant no selection or checkout lease.                                                                                                                                      |
| BC-04 Scheduled capacity                          | [DEC-H03](./capacity-source-decision.md), accepted in [WP-2336](../work-packages/WP-2336.md), names Fulfillment ownership and owner commitment plus atomic Ordering linkage. [WP-2342](../work-packages/WP-2342.md) records clock sequencing; [DEC-H03-DINING](./capacity-checkout-handoff.md#proposed-dine-in-interpretation-dec-h03-dining) was subsequently accepted on 2026-09-10. | [WP-2337](../work-packages/WP-2337.md) supplies the pure lifecycle; [WP-2340](../work-packages/WP-2340.md), [WP-2343](../work-packages/WP-2343.md), [WP-2344](../work-packages/WP-2344.md) and [WP-2347](../work-packages/WP-2347.md) supply internal owner read, Hold append/transition and Allocation terminal adapters. No customer HTTP command is enabled.                                                                                                                                                                                                                                                                                     | [WP-2338](../work-packages/WP-2338.md)/[WP-2339](../work-packages/WP-2339.md) prove serialized admission/accounting and atomic conversion. WP-2340/2343/2344/2347 prove actual adapter reads/writes, public Audit atomicity, contention, rollback and exact lost-ack recovery. Slot/configuration and progress evidence are synthetic.                                                                                                                | These capacity WPs provide no connected capacity/Checkout browser acceptance.                                                                                                                         | Fulfillment current authority and authoritative InProgress/release coordination; application compensation; exact immutable Payment clock seal and Ordering linkage; final Inventory. ASAP requires its distinct direct-allocation contract. Dine-in requires implementation and evidence for its accepted owner commitment; Delivery's Pilot gate remains.                                                                                                         |
| BC-04 Order submission and recovery               | [WP-1221](../work-packages/WP-1221.md)–[WP-1224](../work-packages/WP-1224.md), accepted DEC-H03 and original immutable Order/Batch/Money/time contracts.                                                                                                                                                                                                                               | [WP-2345](../work-packages/WP-2345.md)/[WP-2346](../work-packages/WP-2346.md) prove submission integrity and fresh authority/expiry checks. [WP-2348](../work-packages/WP-2348.md)/[WP-2349](../work-packages/WP-2349.md) close snapshot serialization/record consistency. [WP-2350](../work-packages/WP-2350.md) adds an internal original-history reader; [WP-2351](../work-packages/WP-2351.md) preserves Checkout evidence through the write fence, and [WP-2352](../work-packages/WP-2352.md) implements the internal atomic writer with explicit Created/Existing results. Existing QR/Menu/Cart/Order HTTP/service e2e uses synthetic ports. | WP-2348 proves lossless JSONB Money and immutable Item ordinal storage; WP-2350 proves scoped complete-history recovery, legacy/malformed rejection, timestamp precision and read-only transaction behavior against actual PostgreSQL. WP-2352 proves atomic Audit/Outbox/counter rollback, contention with one Created/one Existing, original lost-ack recovery, and current Cart/deadline denial; its owning WP records the actual PostgreSQL pass. | The Vitest QR/Menu/Cart/Order e2e is not a browser or real capacity/submission composition. No new Order/Payment browser proof is recorded by these WPs.                                              | [WP-2353](../work-packages/WP-2353.md) completes Created/Existing application integration and scoped replay reauthorization, with 135 focused tests and actual PostgreSQL service creation/replay/race evidence. Current Guest/capacity/Inventory/Payment-clock linkage remains. WP-2352's unused owner writer supplies no independent current external authority; no new runtime route or Provider preparation is enabled. DEC-H04/H05 finality remains separate. |
| BC-05 Payment creation and reconciliation         | [WP-1302](../work-packages/WP-1302.md) and accepted DEC-H03 retain the original request/Intent instant and exact 30-minute expiry; existing terminal/reconciliation contracts remain.                                                                                                                                                                                                  | [WP-2341](../work-packages/WP-2341.md) proves current clock checks after preparation/Audit/claim waits, original replay and late response handling. A newly claimed operation that expires before Provider invocation retains Processing and makes no Provider call. This is service evidence with synthetic ports.                                                                                                                                                                                                                                                                                                                                 | WP-2341 changes no database path and records reuse of unchanged isolation evidence; it supplies no new real Ordering/capacity-to-Payment transaction proof. Earlier owning Payment WPs retain their scoped persistence/reconciliation evidence.                                                                                                                                                                                                       | Existing synthetic Payment e2e scripts are not a live Provider/browser checkout acceptance. WP-2341 records no new browser run.                                                                       | Owner-issued preparation/clock seal and connected durable recovery/compensation must precede runtime enablement. Processing/Unknown and late success require existing authoritative reconciliation. Provider/Store/Pilot evidence remains external.                                                                                                                                                                                                                |

### Acceptance anchors for the current view

These are existing executable files/commands, not runs performed by this reconciliation.
Results and exact run-specific evidence remain in the owning WPs above.

| Coverage                                             | Existing acceptance file / command                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cart mutation authority / real Cart storage          | `packages/rms/ordering/src/tests/pickup-cart-item.test.ts`, `pickup-cart-removal.test.ts`; `pnpm ordering-cart:acceptance` (WP-2331/2332).                                                                                                                                                                                                                                                          |
| Bound Dining API and shared browser                  | `apps/api/src/customer-dining-binding-composition.test.ts`; `apps/customer-pwa/scripts/local-customer-lab.mjs`; `pnpm customer-lab:acceptance` (WP-2326/2327).                                                                                                                                                                                                                                      |
| Quote service, continuous HTTP and owner stores      | `packages/rms/ordering/src/tests/cart-quote-attachment.test.ts`; `packages/database/test/quote-http-store-acceptance.test.mjs`; `pnpm pricing-quote:acceptance` (WP-2268/2328). WP-2329 ran the affected `pnpm exec vitest run --config packages/database/vitest.price-quote.config.ts`, not a fresh composite command.                                                                             |
| Catalog selection / current availability             | `packages/rms/catalog/src/tests/selection-validation.test.ts`, `current-availability-query.test.ts`; `packages/database/test/availability-rule-acceptance.test.mjs`; `pnpm --filter @rms/catalog test` and `pnpm exec vitest run --config packages/database/vitest.availability-rule.config.ts` (WP-2333/2334 WSL/2335).                                                                            |
| Capacity lifecycle and owner adapters                | `packages/rms/fulfillment/src/tests/scheduled-capacity.test.ts`; `pnpm --filter @rms/fulfillment test`; `pnpm exec vitest run --config packages/database/vitest.capacity-hold.config.ts` and `pnpm exec vitest run --config packages/database/vitest.capacity-allocation.config.ts` (WP-2337–2340/2343/2344/2347).                                                                                  |
| Order integrity / snapshot / recovery                | `packages/rms/ordering/src/tests/order-creation.test.ts`, `order-item-snapshot-codec.test.ts`, `order-creation-query-store.test.ts`, `order-creation-store.test.ts`; `pnpm --filter @rms/ordering test`; `pnpm exec vitest run --config packages/database/vitest.order-submission.config.ts` (WP-2345/2346/2348–2352). `pnpm e2e:qr-menu-cart-order` is the separate synthetic HTTP/service anchor. |
| Payment creation freshness / existing reconciliation | `packages/rms/payment/src/tests/payment-intent-creation.test.ts`; `pnpm --filter @rms/payment test` (WP-2341). `pnpm e2e:payment-success`, `pnpm e2e:duplicate-webhook` and `pnpm payment-reconciliation:acceptance` remain earlier scoped anchors, not WP-2341 or WP-2400 new runs.                                                                                                                |

## Mapping gaps and intentional exclusions

- The ordinary-refund attribution to WP-2045 is corrected in WP-1301. The canonical Refund Wizard
  still requires a real owning workflow WP, not a renaming of webhook security or automatic
  compensation.
- APPROVAL-INBOX points only to WP-0125, which explicitly separates Task from Approval and defers
  screens. ALERT-CENTER points to the narrower technical alert-routing WP-0045. AOD records the
  proposed follow-up scope; no false replacement WP mapping is inserted here.
- At the baseline, OUT-JOB-LIST references WP-1501 through WP-1506 and OUT-TEMPLATE references
  WP-1502, whose local briefs are absent. Existing device/output gates remain controlling. This is
  an explicit source/deferred-scope check for future output work, not authorization to implement it.
- The original review counted nine inherited Screen records, including five Customer pages and
  four shared surfaces. [WP-2400](../work-packages/WP-2400.md) reconciles the five standalone
  Customer contracts against Section 88; use the current registry for mappings. Neither the
  historical count nor recovered source fields establish implemented customer self-service.
- Delivery implementation contracts do not enable Delivery for the current Pilot. Generic
  microservices, accounting, workforce scheduling and device-fleet platforms remain subject to
  their existing [ADR register](../../adr/README.md) Future Triggers.

## Maintenance and acceptance rule

For every future owning WP, identify affected BC rows in its brief and include their bounded
documentation update in its allowlist. At closeout, update the affected row of the
[current evidence view](#current-scenario-evidence-view) and its acceptance anchor; add a row
there when another BC scenario first changes. Update the accepted decision/source, owning WP,
implemented file/command, observed evidence layer and remaining dependency, including the resolved
baseline. Keep exact run/revision/diff/log and reuse details in the owning WP rather than duplicating
its chronology here. Preserve the historical appendix without appending a paragraph for every new WP.

Distinguish service, HTTP, isolated persistence, continuous browser and real operational evidence.
A row cannot become complete merely because a component is present, a demo injects data, a command
name exists or the Screen Registry passes its structural validator. A newly accepted decision closes
only that choice; it does not execute an acceptance scenario or discharge external evidence.

New in-scope business scenarios must be added here before claiming overall design coverage. A
negative source result, blocked gate or dependency is recorded explicitly with its owner and next
action in the [decision register](./README.md); no blank cell is interpreted as not applicable.

## Historical implementation appendix

The following entries preserve the earlier WP-2228–2325 implementation record, reconciled by
WP-2330 on 2026-09-10 against `fab611e67b14474642a677754e5379f07edc2c6a`.
Their present-tense status, next steps, test counts and pass claims apply only to each cited
historical WP/run. They are not current outstanding-work or freshly executed test lists.
Use the [current evidence view](#current-scenario-evidence-view) for status through WP-2350.

### BC-02 implementation evidence after the baseline

WP-2228 accepted shared Dining Session ownership and credential recovery. WP-2234–2240 implement
initial Pickup credential preparation, persistence, activation and same-origin transport; they do
not implement general basket recovery or the browser journey. WP-2241 adds Ordering's authorized
current-binding reader: live Identity resolution before and after reading, exact immutable Pickup
creator/scope, uniform missing/other-reference result and effective expiry without Session renewal
or Cart mutation. The owning [WP-2241](../work-packages/WP-2241.md) records actual final verification.
Unit acceptance is `packages/rms/ordering/src/tests/pickup-cart-read-service.test.ts`; real isolated
Identity/Ordering/HTTP composition is `packages/database/test/cart-binding-store-acceptance.test.mjs`.
Store/QR and policy evidence remains synthetic. Safe display DTO production, PWA recovery,
DineIn shared binding, replacement/cancellation and production evidence remain unfinished; BC-02
is not complete merely because this internal reader exists.

[WP-2242](../work-packages/WP-2242.md) supplies the next Catalog dependency for BC-02: an internal
version-pinned display query backed by Active/Retired projection generations. It returns historical
item/option names only and preserves the existing current-menu query's failure behavior. Its owning
WP records unit and actual PostgreSQL evidence. This does not establish Ordering display DTO or
browser integration, current availability, prices, allergen decisions or complete Cart recovery.

[WP-2243](../work-packages/WP-2243.md) composes the existing safe Cart view in Ordering, with a
final authorized reread, public Store branding, batched historical Catalog display and an exact
Cart-version Quote reader. Isolated HTTP acceptance exercises the resulting empty/expired view
after real Identity/Ordering credential activation; Store branding and empty Catalog responses in
that composition are explicitly synthetic. Nonempty display and exact monetary output have unit
coverage, and Quote storage has actual PostgreSQL coverage. General production/browser composition,
DineIn ownership and complete recovery remain unfinished; this is not a full customer-journey claim.

[WP-2245](../work-packages/WP-2245.md) adds an optional local-runtime Cart read composition and
the production API bridge. Its owning WP records bounded local HTTP/Identity/Ordering persistence
evidence. No Cart/item write, recovery, DineIn, browser or production completion is inferred.

[WP-2246](../work-packages/WP-2246.md) supplies strict browser credential transport for initial
Pickup binding, with explicit calls and bounded unknown outcomes. Its owning WP records actual
HTTP/Identity/Ordering evidence under a synthetic cookie boundary. Page orchestration, reload
recovery, shared DineIn and overall browser journey acceptance remain unfinished.

[WP-2247](../work-packages/WP-2247.md) connects explicit binding write/policy/audit providers
to the optional local runtime. Its owning WP records bounded production-composition evidence;
no default configuration, full browser orchestration or real Store readiness is inferred.

### BC-03 foreground retry hardening

[WP-2248](../work-packages/WP-2248.md) hardens in-memory Cart/Configurator uncertain-outcome
retry and disables superseding mutations. This does not supply reload recovery or live item writes.

[WP-2249](../work-packages/WP-2249.md) extends the Cart deadline through complete response-body
consumption and cleanup. It preserves foreground-only retries and does not provide live write wiring.

### BC-02 foreground creation coordination

[WP-2250](../work-packages/WP-2250.md) connects private browser binding transport and current-Cart
reads in an opt-in foreground coordinator. Its evidence remains bounded; default App integration,
item writes, shared DineIn and general reload recovery are separate.

### BC-03 authorized removal integration

[WP-2251](../work-packages/WP-2251.md) adds current-Session/CSRF removal authorization and optional
local HTTP write composition. Current Catalog eligibility for Add/Update remains separate.

### BC-03 foreground response isolation

[WP-2252](../work-packages/WP-2252.md) prevents old Cart responses from changing a newer
Session context or returning an old Cart after credential replacement. Reload recovery stays separate.

### BC-03 Quote response boundary

[WP-2253](../work-packages/WP-2253.md) bounds the complete foreground Checkout Quote response
and isolates Session context changes. Controller orchestration and live pricing wiring stay separate.

### BC-03 Checkout intent continuity

[WP-2254](../work-packages/WP-2254.md) retains the original foreground Quote request across
uncertainty, refresh and reconnect. Synthetic browser evidence does not enable live payment.

### BC-03 complete Quote evidence encoding

[WP-2255](../work-packages/WP-2255.md) preserves and validates complete historical Quote snapshots
without floating-point money or current-configuration reconstruction. Atomic persistence remains separate.

### BC-03 complete Quote history reads

[WP-2256](../work-packages/WP-2256.md) reads complete historical snapshots with exact Brand/Store
isolation and rejects partial legacy or inconsistent data. Atomic application writes remain separate.

### BC-03 atomic Quote snapshot persistence

[WP-2257](../work-packages/WP-2257.md) appends complete Quote facts and Audit atomically, preserves
logical Cart line identity across Quotes and rejects conflicting history. Application wiring remains separate.

### BC-03 original Quote request recovery

[WP-2258](../work-packages/WP-2258.md) persists exact scoped request identity and original Quote
result in one transaction. Current Session authorization and runtime composition remain separate.

[WP-2259](../work-packages/WP-2259.md) denies new attachment for selected options that the v1
Quote cannot price explicitly. Empty selections remain supported; exact authorized history replay
is unchanged. Versioned option-price facts and their authoritative producer remain required.

[WP-2260](../work-packages/WP-2260.md) supplies Ordering's current Session/CSRF-authorized Pickup
Quote entry, including authorization before original-history lookup and request-local Pricing identity.
Authoritative pricing facts, HTTP composition and end-to-end customer journey remain separate.

[WP-2261](../work-packages/WP-2261.md) supplies explicit local Quote HTTP composition with current
authorization before and after original-result lookup. It requires an authoritative candidate
producer; default Quote creation remains unavailable. Real Store facts and full journey are unclaimed.

[WP-2262](../work-packages/WP-2262.md) exercises the actual multi-owner Quote HTTP composition in
isolated PostgreSQL, including lost commit acknowledgements. Commercial and policy inputs remain synthetic.

WP-2263 implements an Ordering-owned expiry fence for the WP-2262 partial-commit boundary.
Expiry and late attachment serialize with atomic Audit; Ordering455/455, Quote PostgreSQL5/5,
Cart PostgreSQL6/6, full verification and forced uncached integration pass.
Current authorized reconciliation and an explicit browser terminal receipt remain future work.

WP-2264 connects the committed expiry fence to current authorization, an exact HTTP terminal
receipt and explicit Checkout recovery. Ordering490/490, API326/326, PWA404/404, browser42/42,
Quote PostgreSQL5/5, full verification and forced uncached integration pass. Generic errors remain
insufficient to release an unknown request. Commercial and Provider evidence remain gated.

WP-2265 connects current-authorized Pickup Add/Update with original-operation recovery and
optional local HTTP providers. Ordering518/518, API360/360, Cart PostgreSQL6/6, full verification
and forced uncached integration pass. Displayed menu data does not establish
current Catalog eligibility, conditional activation or option prices; those authorities remain explicit.

WP-2266 adds explicit Session generation ownership to opt-in Pickup creation plans. PWA417/417,
Cart PostgreSQL6/6, PWA security111/111, full verification and forced uncached integration pass.
Original-candidate recovery remains possible only within the owning context.

WP-2267 connects Pickup product configuration to foreground Cart binding and creation. PWA430/430,
browser48/48, PWA security111/111, full verification and forced uncached integration pass. All
public menu and browser interception evidence remains explicitly synthetic.

WP-2268 verifies current Cart views across item changes, historical Quote retries and a delayed
Pricing candidate. Pricing248/248, Quote API9/9, Quote PostgreSQL5/5, full verification and forced
uncached integration pass; this is local synthetic-source persistence acceptance.

WP-2269 adds the Dining-owned current participation query required before shared Cart decisions.
Dining97/97, full verification and forced uncached integration pass. Identity authorization and
the coherent Dining persistence producer remain separate.

WP-2270 corrects the accidental Cart revision999 limit; quantity limits remain unchanged.
Ordering535/535, Cart PostgreSQL7/7, full verification and forced uncached integration pass.

WP-2271 hardens Dining Table/Move replay scope and object identity. Dining154/154, full verification
and forced uncached integration pass.
At WP-2271, Dining persistence still required a separate owning schema/namespace declaration.

WP-2272 materializes Table configuration and immutable operation history in Dining-owned storage.
Dining179/179, actual PostgreSQL acceptance1/1, full verification and forced uncached integration pass.
Session, Join, shared Cart and live activation remain separate.

WP-2273 repairs Staff start/regeneration authorization and exact original-result validation.
Dining238/238, full verification and forced uncached integration pass.
Guest Join recovery and Session persistence remain separate.

WP-2274 validates current Guest authority and complete original Join results.
Dining315/315, full verification and forced uncached integration pass.
Identity credential recovery and Session persistence remain separate.

WP-2275 implements atomic Session start, Table occupancy, initial capability and Audit storage.
Dining345/345, Table/Session-start PostgreSQL2/2, full verification and forced uncached integration pass.
Join/Closing persistence and live activation remain separate.

WP-2276 repairs fresh Join generation after consumption/expiry and current pepper metadata.
Public Capability101/101, Dining352/352, full verification and security/Session acceptance pass.
Join/regeneration persistence remains separate.

WP-2277 implements atomic Join regeneration, original-operation recovery and Audit storage.
Dining380/380, Dining PostgreSQL3/3, full verification and forced uncached integration pass.
Guest Join/Closing persistence and live activation remain separate.

WP-2278 implements atomic Guest Join, Participant/Host and admission issuance persistence.
Dining410/410, Dining PostgreSQL4/4, full verification and forced uncached integration pass.
Identity rotation, shared Cart and live activation remain separate.

WP-2279 binds admission consumption and evidence to the exact current Guest Session.
Identity200/200, Guest22/22, joint acceptance, full verification and forced integration pass.
Durable consumption and Identity flow activation remain separate.

WP-2280 supplies coherent current Session/Participant/Table evidence for the Cart Query.
Dining442/442, Dining PostgreSQL5/5, full verification and forced uncached integration pass.
Caller authorization and Closing/write coordination remain separate.

WP-2281 corrects Closing current authority, scoped history and complete commit acknowledgements.
Guest Host Audit uses Restricted System identity. Dining489/489, Task32/32, full verification
and forced uncached integration pass. Durable Closing commands and shared Cart fencing remain separate.

WP-2282 implements atomic Closing Session/history/Audit storage and original-result recovery.
Dining526/526, Dining PostgreSQL6/6, full verification and forced uncached integration pass.
Join/Closing competition is serialized on the Dining Session. Shared Cart coordination,
Table release/cleaning policy and live operational authority remain separate.

WP-2283 retains the full Move command and verifies its canonical digest against complete result
facts. Current actor/scope authorization remains required. Dining547/547, full verification and
forced uncached integration pass. Atomic Move storage and post-move Join credentials remain separate.

WP-2284 persists source/target Tables, Session, immutable Move history and Audit atomically.
Concurrent retries return the actual original receipt; Closing and target competition are fenced.
Dining573/573, Dining PostgreSQL7/7, full verification and forced uncached integration pass. Post-move Join credential
reissuance, shared Cart write coordination and UI activation remain separate.

WP-2285 adds a dedicated pure Join reissue policy for changed assignment facts without weakening
legacy same-assignment regeneration. Public Capability145/145, full verification and forced integration pass; committed Move/current Staff checks
and atomic Dining service/storage composition remain separate.

WP-2286 connects current Staff authority and committed Move facts to atomic fresh Join generation.
Dining610/610, Dining PostgreSQL8/8, full verification and forced integration pass; Identity consumption and shared Cart remain separate.

WP-2287 binds Staff regeneration to the exact predecessor generation, including original retry and
returned receipt identity. Dining623/623, Dining PostgreSQL8/8, full verification and forced
uncached integration pass. Identity consumption and shared Cart remain separate.

WP-2288 adds the pure Active-to-Consumed admission transition with exact current Session,
Participant and Table assignment facts. Dining678/678, full verification and forced uncached
integration pass; Guest authority, durable consumption recovery and Identity/public-context
composition remain separate.

WP-2289 connects current Guest authority, original Join identity and current Dining facts to
the admission-consumption service and complete original receipts. Dining760/760, full verification
and forced uncached integration pass; atomic persistence and Identity/public-context composition
remain separate.

WP-2290 adds the Dining-owned transactional admission consumption adapter, scoped immutable
receipts and Audit, with current Closing/Move fences on writes and retries. Dining785/785,
Dining PostgreSQL9/9, full verification and forced uncached integration pass;
Identity evidence, public Table mapping and shared Cart composition remain separate.

WP-2291 exercises actual Identity ContextOnly creation, Dining Join/consume and Identity
DiningBound rotation, including the inter-owner failure window and lost Identity acknowledgement.
Dining785/785, Dining PostgreSQL9/9, full verification and forced uncached integration pass. Exact replay returns metadata,
not recovered raw credentials; production public mapping and credential delivery recovery remain open.

WP-2292 rejects malformed outer binding commands and nonboolean possession comparisons without
executing caller getters. Identity264/264, full verification and forced uncached integration
pass, including64 new boundary cases. Pickup-only preparation policy and stored lifecycle formats remain unchanged.

WP-2293 captures complete binding store commands and constructor scope before database waits.
Identity291/291, actual PostgreSQL proof/evidence/CSRF/scope mutation-barrier acceptance,
full verification and forced uncached integration pass. The original invalid input cannot become authorized by later mutation.

WP-2294 adds pure DiningSessionBinding Prepared/Acknowledged/Activated contracts with exact
admission/Guest/public Table/Session/Participant evidence and active-candidate response-loss
continuation. Identity402/402, full verification and forced uncached integration pass. This is not live persistence,
credential transport, current Dining command authority or completed browser recovery.

WP-2295 implements independent Identity Dining preparation persistence with atomic predecessor
revocation, DiningBound candidate installation, Session/preparation history and public Audit.
Identity431/431, Identity PostgreSQL6/6, full verification and forced uncached integration pass. Actual Dining evidence
production, application coordination and browser transport remain separate.

WP-2296 adds an independent Identity coordinator and Dining-purpose recovery credential provider.
Read-only preparation precedes admission consumption; exact acknowledgement, consumed evidence and
atomic Identity activation preserve the delivered candidate through owner failure, rollback and
lost commit acknowledgement. Identity476/476, actual PostgreSQL acceptance, full verification
and forced uncached integration pass. Owner reservation/current Dining evidence remains synthetic in these composition tests;
actual public Table mapping, production policy, transport and browser recovery remain separate.

WP-2297 adds current-authorized read-only Dining admission reservation. Repeated observations
preserve admission, consumption history and Audit; consumed, Closing, moved or inactive eligibility
is denied. Consumption still revalidates atomically and original recovery remains unchanged.
Dining821/821, actual PostgreSQL acceptance, full verification and forced uncached integration pass. The receipt
is internal owner evidence, not public Table mapping, finite Identity evidence or a write lease.

WP-2298 composes real Identity credential coordination and Dining reservation/consumption through
public ports. Dining owns current context lifecycle/revocation/expiry validation; each API request
reauthorizes its own Guest and preserves distinct public/internal Table IDs. API388/388, Dining843/843
and real combined PostgreSQL acceptance, full verification and forced uncached integration pass. Synthetic current QR
mapping and bound-session validation remain explicit test inputs, not operational producers.

WP-2299 requires a distinct current Dining-bound identity query backed by coherent Session,
Participant, Table and original consumed admission. Closing preserves identity facts while the
separate Cart gate stays Active-only. Actual Move away/back cannot revive the old binding merely
by restoring the same Table ID. Dining928/928, API393/393, real PostgreSQL acceptance,
full verification and forced uncached integration pass. Read denial does not claim a persisted revocation or grant write authority.

WP-2300 adds separate same-origin Dining preparation, acknowledgement and completion transport.
Candidate Session uses an operation-specific HttpOnly cookie distinct from Pickup; JSON carries
only ephemeral CSRF/recovery material. API431/431, Identity476/476, privacy8/8, actual owner/Identity
HTTP recovery, full verification and forced uncached integration pass. After lost activation
acknowledgement, both staged and published-main cookie recovery preserve consumption/Audit10/10
and preparation/Audit3/3. Browser client/UI and production activation remain separate.

WP-2301 adds independent PWA Dining binding transport with exact admission input, bounded response
and deadline handling, and no credential storage or automatic retries. PWA476/476, security111/111,
actual client/HTTP/PG recovery, full verification and forced uncached integration pass. Late and
rejected response bodies are cancelled. This does not enable UI, reload recovery or operational configuration.

WP-2302 adds private foreground Dining binding coordination: exact single-flight intent, original
candidate recovery, current-context generation fences and confirmed-only CSRF publication.
PWA508/508, security111/111, actual coordinator/client/HTTP/PG recovery, full verification and
forced uncached integration pass. Exactly one CSRF publication and original preparation survive
unknown activation; repeated success reauthorizes. UI/runtime activation remains separate.

WP-2303 adds Dining-owned current-version joining from a separate credential, retaining current
Guest/abuse gates, original replay and exact atomic write versions. Dining951/951, actual
PostgreSQL replay/race acceptance, full verification and forced uncached integration pass.
This does not add Guest self-start, HTTP/UI or Identity binding authority.

WP-2304 composes real current Identity/QR authority with owner-selected Dining Join versions and
an explicitly separate trusted request abuse port. API456/456, actual PostgreSQL cooldown/
recovery/revocation acceptance, full verification and forced uncached integration pass. HTTP/UI
and production abuse/context providers remain separate.

WP-2305 adds fixed same-origin Join HTTP with request-bound server abuse context and no Cookie
mutation. API500/500 and actual PostgreSQL/HTTP Join response-loss-to-binding acceptance pass:
original admission is recovered with one Join Audit, then the existing client/coordinator rotates
identity once. Full verification and forced uncached integration pass. Production context/abuse
providers and customer UI activation remain separate.

WP-2306 supplies stateless browser Join transport with strict closed input/result, finite response
bounds and explicit retry only. PWA561/561, security111/111/build and actual PostgreSQL/HTTP
Join-client-to-binding recovery pass; one Join and one consumption remain. Full verification and
forced uncached integration pass. UI coordination and production runtime activation remain separate.

WP-2307 composes foreground Join and binding recovery with explicit start/resume, original-operation
single-flight and opaque CSRF generation guards. Raw Join credential is released after validated
admission; binding recovery never rejoins. PWA596/596, security111/111/build and actual PostgreSQL/
HTTP double-lost-ack recovery pass with original one-Join/one-consumption history. Full verification
and forced uncached integration pass. UI, cross-document/replacement recovery and runtime remain separate.

WP-2308 embeds optional admission UI in eligible CUST-ENTRY-CONTEXT with protected transient input,
explicit original recovery, offline controls and honest unavailable state. PWA612/612 and53/53
browser cases (desktop/mobile/production exclusion) pass; security111/111/build pass. Reviewed
empty-input recovery/confirmation screenshots, keyboard focus and320px reflow. Real entry/menu lab, full verification
and forced uncached integration pass. Local synthetic preview is excluded from production; runtime remains gated.

WP-2309 assembles optional Join/binding handlers in the scoped local runtime, fixing Session store,
scope/clock/Origin over sub-configuration. API508/508, real PostgreSQL/runtime double-ack recovery
and existing HTTPS browser entry/menu lab pass. Full verification and forced uncached integration pass.
Dining UI browser-to-database lab activation remains the next distinct scope; no production providers.

WP-2310 connects main.lab admission to real scoped owner stores behind explicit local bootstrap.
Desktop/mobile Chromium establishes Guest entry, joins and rotates to DiningBound, then reads persisted
menu. Separate public Table/Staff-start fixtures preserve each QR mapping. Two Join/consumption and
six Identity preparation/Audit records are observed; proof stays out of bootstrap/URL/storage/artifacts.
PWA612/612, browser53/53, local browser acceptance, security/build, full verification and forced
uncached integration pass. Production providers,
shared-cart writes, cross-document recovery and deployment remain separate.

WP-2311 guards CUST-ENTRY-CONTEXT result publication by mounted client generation. Callback updates
do not restart entry; stale start/retry success or failure cannot publish to a replacement or unmounted
page. Duplicate retry is collapsed and synchronous/asynchronous failures remain explicitly recoverable.
PWA613/613 and desktop/mobile/production browser76/76 pass. Transport credential publication and
cross-document recovery are separate from this page lifecycle boundary. Security/build, real Dining lab,
full verification and forced uncached integration pass.

WP-2312 fences entry credential publication with the shared opaque generation and coalesces in-flight
start/retry requests. Entry transport now bounds complete response reads to15 seconds/16 KiB and
requires the existing no-store JSON/status contract; stale/offline/malformed/oversize responses cannot
publish Established credentials. PWA634/634 and browser76/76 pass. Two existing browser fixtures now
include the canonical Entry no-store response header. Browser-managed Cookie arrival and general
cross-document recovery remain separate. Real Dining lab, security/build, full verification and forced
uncached integration pass.

WP-2313 adds Ordering's owner-internal shared Dining Cart read service. Live Identity and exact public
purpose-Cart participation precede lookup and are rechecked afterward, including absent Cart results.
Two current Participants can read one Cart without rewriting creator/item attribution; scope, Guest,
assignment and membership-version drift deny. Ordering591/591 tests pass. Persistence/current-slot
production, creation, safe DTO/browser integration and atomic shared writes remain distinct unfinished
work; this read observation is not a Closing write lease. Full verification and forced uncached
integration pass.

WP-2314 supplies the scoped PostgreSQL current Dining Cart adapter. Existing Dining Session association
selects exactly one Active, unexpired Qr/Web DineIn Cart; absent/ineligible history is not selected and
multiple eligible candidates deny. One read-only transaction reconstructs the aggregate and rechecks
ID/version; real between-statement version drift denies. Ordering618/618 and Cart PostgreSQL8/8 pass;
focused final query/race file2/2 passes. Identity/Dining authority inputs in this repository test are
explicitly synthetic. No creation, uniqueness writer, HTTP/browser or atomic Closing lease is claimed;
full verification and forced uncached integration pass.

WP-2315 defines the pure initial shared Cart decision: select a unique active historical Cart unchanged,
or construct an empty version1 Cart from explicit current policy only when owner history is absent.
Expired, abandoned, legacy or ambiguous history cannot be silently replaced. Authorization, serialized
creation and operation/Audit persistence remain separate. Ordering660/660, full verification and
forced uncached integration pass.

WP-2316 implements the owner-local initial Dining Cart selection writer with exact Session serialization,
minimal immutable operation receipts and atomic public Audit append. Current Identity/Dining authorization
and customer runtime remain separate prerequisites. Ordering704/704, Cart PostgreSQL9/9, 101 migrations,
full verification and forced uncached integration pass.

WP-2317 shares current Identity/Dining authorization between Cart reads and selection. Historical
operation lookup follows current authority, and post-effect authority drift prevents receipt publication.
Safe customer views and runtime activation remain separate. Ordering753/753, Cart PostgreSQL9/9,
full verification and forced uncached integration pass.

WP-2318 adds a safe shared Dining Cart display with current viewer checks and participant note minimization.
HTTP/runtime and item-edit UI remain separate. Ordering790/790, Cart PostgreSQL9/9,
full verification and forced uncached integration pass.

WP-2319 composes current-authorized Dining Cart selection/read with the existing API routes.
Local opt-in and synthetic-provider acceptance pass: API551/551, Cart PostgreSQL9/9, existing customer
lab, full verification and forced integration. Dining item mutations and new browser activation remain open.

WP-2320 interprets shared Cart ownership in the UI and blocks new foreign-item intents.
PWA639/639, selected browser50/50 and build/offline security pass. Verification reuses unchanged backend
evidence under the Owner-approved affected-check plan; no new full uncached regression is claimed.

WP-2321 binds Dining command aggregate reads to the authorized session in owner SQL, retaining
expired/terminal history for original-operation recovery. Current caller authority remains required;
item command composition is subsequent work. Ordering796/796, Cart PostgreSQL9/9 and affected
static/security checks pass. No new full-repository regression is claimed.

WP-2322 adds current Identity/CSRF and Dining authority around item Add/Update/Remove, with
pre-history, pre-commit and post-result checks. Real owner-store/API wiring remains separate.
Ordering816/816, final affected20/20 and static/security gates pass. No real-service PostgreSQL
composition or new full-repository regression is claimed for this application-only work.

WP-2323 limits operation snapshot reads by Cart/Guest before restricted data retrieval, including
Dining writer retries. Real owner-store composition with synthetic authority providers passes,
including shared participant edits and lost-commit-ack recovery without duplicate history/Audit.
Ordering829/829, final affected41/41, Cart PostgreSQL9/9 and static/security gates pass.

WP-2324 connects optional Dining item commands to the API and current safe views. Actual API/owner
persistence with synthetic public providers passes, including participant note minimization and
post-effect read-loss recovery without duplicate Audit. API563/563, final affected12/12 and Cart
PostgreSQL9/9 pass; browser activation remains next.

WP-2325 activates the existing Dining configurator and Cart controls in the isolated browser lab,
with real participation and consumed-admission reads. Desktop/mobile admission, menu add, quantity,
removal and empty-state guidance pass against real owner stores; the discovered last-item UI gap is
fixed. Lab1/1, PWA646/646, complete stage regression components and non-forced integration pass.
Viewport runs use separate DiningSessions, not simultaneous shared-table browsers; launch gates remain.

Customer submission HTTP progress (WP-2402): POST /api/v1/orders now has actual PostgreSQL
Dining/Pickup response-loss recovery evidence for both quote versions. The customer projection
reports Submitted/NotReported only. Production PWA client/controller recovery also passes in both modes against real HTTP/PostgreSQL.
Default runtime activation, rendered browser submission and final Inventory-to-Payment readiness remain incomplete; see WP-2402 for commands and evidence.

Checkout details (WP-2402): internal Ordering snapshot persistence now has real PostgreSQL replay, revision contention, Audit rollback and scoped-read evidence. The tested synthetic Pickup case does not establish Guest/CSRF authorization, current policy completeness, rendered form or production contact handling; those compositions remain open.

Checkout details authenticated composition (WP-2402): both Dining/Pickup and both Quote versions
now pass actual Identity/CSRF, Cart/Quote and detail-store save/recovery. Wrong CSRF and
foreign/expired synthetic policy evidence reject. Pickup binding history is explicitly seeded
test data; complete public entry rotation, real policy publication, Order detail binding and
rendered form activation remain unproved.

Order detail linkage (WP-2402): the explicit pilot repository now atomically links original
checkout detail revision with Order/Audit/Outbox. Both modes/Quote versions pass Audit rollback
after link write and lost-response HTTP/client recovery against actual PostgreSQL. This does
not establish current production policy approval, request-local detail selection or rendered
form/runtime activation.

### WP-2402 current checkout submission update

Both Dining and Pickup now select persisted checkout details within each Order repository request,
check the exact current policy and database deadline, and reauthorize after policy lookup.
Actual two-mode/two-quote-version PostgreSQL journeys reject invalid policy or changed authorization,
and recover the original Order/detail revision after a newer receipt choice is saved.
WP-2402 records exact logs and synthetic authorization/policy limits. Public checkout details
HTTP/form, real Store policy publication, Inventory-to-Payment and downstream full pilot acceptance
remain outstanding; this is not a Ready or production status.

### WP-2402 checkout details customer transport

The supporting BFF and PWA save/retry client now use actual authorized persisted detail services
in both Dining/Pickup and quote versions. Commit-response loss remains unknown until same-operation
retry recovers the original acknowledgement; no contact/email or internal Guest/scope is returned.
The WP records the single local database connection failure and successful failed-case-only rerun.
This advances customer transport evidence, not rendered CheckoutPage/current-policy publication,
canonical full CheckoutSession or final Inventory-to-Payment/fulfillment readiness.

### WP-2402 current checkout form values

The current-detail query and PWA read client now recover the authorized Guest's saved form values
and actual revision through HTTP/PostgreSQL in both modes/quote versions. Read absence creates
nothing; older Cart/Quote/policy versions are preserved for review. Internal Guest/Brand/Store
are excluded and responses remain private/no-store. WP-2402 distinguishes port-level denial tests
from actual successful read composition. Policy publication/presentation, rendered checkout form,
full session/Payment and downstream pilot acceptance remain open.

### WP-2402 policy presentation transport

Policy requirements now join explicit versioned document presentations through an owner source
and authenticated private query. Both actual mode/version database journeys prove current
no-document policy success and missing/foreign/expired/missing-publisher refusal. Nonempty text
binding is synthetic source/HTTP-port evidence only. Actual publisher, customer rendering and
confirmation, full checkout/Payment/fulfillment and pilot acceptance remain open.
