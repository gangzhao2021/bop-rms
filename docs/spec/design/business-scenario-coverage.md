# Business Scenario Coverage

Baseline: `main@cedc44c9b6a6a1b389f77342078cc6f2d540dabe`. Package and status definitions are in
the [design index](./README.md). This is a maintained review matrix for the principal journeys,
not a replacement for the 210-row [canonical Screen Registry](../../product/screen-registry.yaml)
or the full external Handoff. Inventory completeness is not a runtime or production claim.

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

No prior WP test count is reproduced as a new pass. All AC-H, AOD and SC scenarios below are newly
designed acceptance requirements and remain unexecuted. Their documents map them to existing
regression commands and explicitly identify missing future acceptance implementation.

## Customer and transaction journey

| ID / initiating role                                   | Owner and bounded input/result                                                                                                                        | Failure and recovery contract                                                                                                                                           | Source / design status                                                                                                                                                          | Acceptance and remaining evidence                                                                                                                                                                         |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-01 Guest scans and browses                          | Public Capability + Store + Identity establish a scoped Guest; Catalog supplies the published menu through public queries.                            | Invalid/expired QR or Session denies uniformly; preserve rotation, revocation and source-scoped menu parsing.                                                           | [WP-1003](../work-packages/WP-1003.md), [WP-2221](../work-packages/WP-2221.md), [WP-2222](../work-packages/WP-2222.md). Baseline.                                               | Existing local Entry/Menu PostgreSQL lab is bounded synthetic evidence, not real Store readiness; continue `customer-lab:acceptance` when behavior changes.                                               |
| BC-02 Guest creates/resumes Cart                       | Ordering owns Cart/current lookup; Identity owns Session rotation and credentials. Exact authorized binding is required before read/mutation.         | Concurrent creation, partial binding and lost response must converge without granting authority from a Cart reference or reviving a revoked Session.                    | [WP-2223](../work-packages/WP-2223.md), [WP-1003](../work-packages/WP-1003.md). Decision DC-01; H-CART-01.                                                                      | AC-H01–04 in [handoff proposal](./customer-order-payment-handoffs.md); no current-Cart producer or HTTP reader wiring is claimed.                                                                         |
| BC-03 Guest changes Cart and reviews Quote             | Ordering owns item/version intent; Catalog validates selection; Pricing owns exact amount, tax, Quote and expiry.                                     | Same business intent replays without duplicate mutation; stale version/selection requires refresh; changed/expired Quote requires accepted review flow.                 | [WP-1201](../work-packages/WP-1201.md), [WP-1205](../work-packages/WP-1205.md), [WP-1104](../work-packages/WP-1104.md). Baseline with prior implementation findings still open. | Future continuous Cart/Quote test must include different server observation times under one retry key and same-session return to menu. Existing `ordering-cart:acceptance` alone is not this composition. |
| BC-04 Guest submits for Payment                        | Ordering public preparation must prove immutable submission plus accepted capacity allocation; Payment owns Intent/Attempt claim before Provider use. | Hold expiry, duplicate preparation and commit-unknown must not create a second submission or charge; source identity/scope/amount mismatch denies.                      | [WP-1220](../work-packages/WP-1220.md), [WP-1224](../work-packages/WP-1224.md), [WP-1302](../work-packages/WP-1302.md). Integration/Decision DC-04; H-PREP-01.                  | AC-H05–07 preparation scenarios; named capacity producer/transaction boundary required; existing 30-minute rule retained.                                                                                 |
| BC-05 Payment progresses and reconciles                | Payment processes verified Provider observations through durable Inbox and publishes only canonical terminal facts.                                   | Unknown remains unknown; duplicate/conflicting webhook cannot create duplicate financial effect; reconciliation reads Provider truth before eligible retry.             | [WP-1303](../work-packages/WP-1303.md), [WP-1304](../work-packages/WP-1304.md), [WP-1307](../work-packages/WP-1307.md). Baseline/Gate.                                          | Existing `e2e:payment-success`, `e2e:duplicate-webhook` and `payment-reconciliation:acceptance` have bounded synthetic scope; live Provider evidence remains gated.                                       |
| BC-06 Merchant accepts/cancels; Order reaches finality | Ordering owns acceptance, cancellation, confirmation and closure; downstream Payment/Kitchen/Fulfillment consume exact public facts.                  | Cancellation, payment success, capacity expiry and kitchen start need one owner-issued disposition; fulfillment evidence alone cannot close financial history.          | [WP-1309](../work-packages/WP-1309.md), [WP-1310](../work-packages/WP-1310.md), [WP-1605](../work-packages/WP-1605.md). Integration DC-04; H-ORDER-01.                          | AC-H08–10 transition/race scenarios; required fact producers and close/reopen execution remain separate follow-up scope.                                                                                  |
| BC-07 Kitchen prepares and hands over                  | Only Ordering-confirmed source releases Kitchen work; named operator uses authorized station/ticket state and immutable outcome.                      | Stale/disconnected KDS is read-only; ownership handover locks and refreshes; duplicated events do not duplicate preparation.                                            | [WP-1400](../work-packages/WP-1400.md), [WP-1408](../work-packages/WP-1408.md). Baseline.                                                                                       | Existing `kitchen-confirmed-order:acceptance` and `kds-continuity:acceptance`; AOD-08 extends continuous operating acceptance.                                                                            |
| BC-08 Pickup recipient receives order                  | Fulfillment owns proof checking, eligible handoff and completion; Ordering/Payment remain source owners.                                              | Wrong/expired proof denies; partial/replayed handoff respects existing remaining-item and version rules.                                                                | [WP-1602](../work-packages/WP-1602.md), [WP-1603](../work-packages/WP-1603.md), [WP-1605](../work-packages/WP-1605.md). Baseline.                                               | Existing `pickup-proof:acceptance` / `pickup-fulfillment:acceptance`; real Store device/operator evidence is not supplied here.                                                                           |
| BC-09 Guest retrieves Receipt/recovery                 | Ordering owns immutable Receipt source snapshots/version history; Notification delivers a purpose-bound recovery capability.                          | Expired/consumed recovery or lost Session never authorizes by Order ID alone; correction/reissue preserves prior receipt facts.                                         | [WP-1709](../work-packages/WP-1709.md), [WP-1723](../work-packages/WP-1723.md), [WP-2028](../work-packages/WP-2028.md). Baseline/Gate.                                          | Existing `e2e:receipt-resume-email`; actual deliverability, consent/legal policy and production evidence retain their gates.                                                                              |
| BC-10 Merchant requests ordinary refund                | Payment owns refundable balance and financial outcome; Pricing supplies accepted allocation; source approval policy governs request/review/execution. | Concurrent ordinary/compensation refunds share cumulative protection; Pending/Unknown is reconciled before another execution; final source evidence closes the request. | [WP-1301](../work-packages/WP-1301.md), [WP-2045](../work-packages/WP-2045.md), [WP-1310](../work-packages/WP-1310.md). Mapping DC-02; H-REFUND-01.                             | AC-H11–14 refund scenarios; ordinary workflow/approval needs its own execution WP. Existing paid-unfulfillable compensation does not prove this journey.                                                  |

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
- Nine Screen records inherit scope, including five Customer account/profile/reservation/waitlist
  records and four shared surfaces. They are not counted as independent completed journeys.
- Delivery implementation contracts do not enable Delivery for the current Pilot. Generic
  microservices, accounting, workforce scheduling and device-fleet platforms remain subject to
  their existing [ADR register](../../adr/README.md) Future Triggers.

## Maintenance and acceptance rule

For every future owning WP, identify affected BC rows and add the exact accepted decision/source,
implemented acceptance file/command and observed evidence. Preserve older evidence as historical,
and distinguish a pure service test, HTTP test, isolated persistence test, continuous browser test
and real operational evidence. A row cannot become complete merely because a component is present,
a demo injects data, a command name exists or the Screen Registry passes its structural validator.

New in-scope business scenarios must be added here before claiming overall design coverage. A
negative source result, blocked gate or dependency is recorded explicitly with its owner and next
action in the [decision register](./README.md); no blank cell is interpreted as not applicable.

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
