# Project completion review

Baseline review 2026-09-22 under [WP-2402](../spec/work-packages/WP-2402.md),
baseline `23e5925`; date-stamped source and evidence addenda through 2026-09-27
appear below. This is a source and evidence review, not a new runtime acceptance run.
The accepted composite baseline in the [spec index](../spec/README.md) remains
authoritative. The local single-Store InternalTest milestone is one subset of the
whole product. No overall completion percentage is justified by the evidence.

Current Customer recovery update (2026-09-27): normal-entry history restoration now covers private
content with a neutral status and reloads through the existing server Session bootstrap. Eighty
affected unit cases, Customer lint/types, production/PWA policy verification, import validation
and the current-source secret scan pass. Real isolated PostgreSQL/Chromium Pickup receipt reads
at 1440/390/320 preserve the original/refund history through offline, reconnection, explicit refresh,
reload and synthetic persisted history events, with exact owner-derived financial amounts and no
API write or private storage/cache. The prior complete Profile/Dining/Pickup config passes 3/3;
the final changed-handler Pickup case passes 1/1. Inspected screenshots remain synthetic. These
checks do not prove native browser bfcache eligibility, multi-browser support, real Store/Provider,
v14 runtime, UAT or release readiness. Exact selection, failed diagnostic runs, source changes and
limits: [WP-2402 recovery evidence](../spec/work-packages/WP-2402.md#customer-history-restoration-boundary-2026-09-27).

## Current assembled-source checkpoint — 2026-09-29

[WP-2421](../spec/work-packages/WP-2421.md) now coordinates whole-project continuation on the retained main checkout. Selected Catalog WP-2407→2420, Recipe source coverage, Feature Control administration query and historical Task filters are assembled; Supplier source was already present. [The candidate register](project-candidate-register.md#wp-2421-source-assembly-checkpoint--2026-09-29) and [fingerprint manifest](../spec/history/WP-2421-assembly-inputs.json) identify original source versus current inputs and check scope. This supersedes earlier statements that those selected components exist only outside main; all dated earlier tests keep their original candidate/host limits.

The ordinary `/app/commerce/products` route/page, owning Product list store, authenticated BFF query and configured runtime composition now exist. Actual synthetic SQL/BFF/production-build browser list acceptance passed at1440/390/320 and200% zoom. Unconfigured runtime still fails closed. This closes the earlier route-absence claim, but does not supply complete nine-area Product editing, effective/future publishing, real current IAM/topology/policy or real Store readiness. Recipe now has source-coverage/core query/rebuild components; its normal pages still lack the complete authorized source feeds/runtime composition. Feature Control administration history is not a Phase-capability result. Task has authenticated bounded filtering and owner SQL/controller evidence; visible controls, mutations and source routing remain unavailable.

Owner-selected Product/Store-capability continuation now adds normal Product publication command and current/future query routes, complete recorded owner history, held current resolution, due-schedule discovery/System activation and the normal current Store capability observation/backend guard. The isolated journey uses actual encrypted sessions, current Brand action policy, HTTP, owning RLS SQL, atomic Audit/Outbox, cancellation/rescheduling, replay/revocation and narrower Store coverage; capability tests prove Store Disable overrides Brand Enable and backend Deny/frontend Hide agree. Its mapping, validation/topology/policy/approval leases and rollout facts are explicitly synthetic test composition, not real Store activation. Publication content remains the supported Draft profile, not proof of complete nine-area editing. UI publishing controls/Store capability page composition and rendered acceptance, full-content validation feeds, production configuration/scheduler activation, accepted mapping/trigger facts and release gates remain open. Details and exact check inputs are in [WP-2421](../spec/work-packages/WP-2421.md#owner-selected-product-publication-and-store-capability-continuation--2026-09-29).

Whole-product gaps below remain the continuation inventory. Earlier chronological diagnoses describe their dated inputs and are superseded only by the specific source/evidence updates above. Local assembly and component acceptance do not complete the whole project or certify production readiness.

Owner-delegated design update (2026-09-29): missing Figma/local design baselines, product rules, capability mappings and repository configuration are delivery tasks, not artifacts to request from the Owner. [The design closure inventory](../spec/design/whole-project-design-closure.md) separates remaining software design from already-designed but incomplete runtime workflows and actual external evidence. The selected Product/Store Registry mapping is now explicit versioned repository configuration; it supplies no default enablement or dependency/trigger receipt. The normal STORE-CAPABILITY route now consumes the authenticated current observation endpoint with exact selected Store/returned Brand, its own capability gate, bounded payloads, stale/offline cancellation and explicit refresh. This is current decision observation, not complete configuration draft/impact/approval/publish administration. Owning evidence is retained in WP-2421.

## Confirmed implementation gaps

Normal [merchant startup](../../apps/merchant-web/src/main.tsx) renders `App` without
demo injection. The [router](../../apps/merchant-web/src/App.tsx) mounts the following
pages without a client override. Their defaults reject loading; page and Domain
existence therefore does not establish a usable normal-entry workflow.

| Surface                                | Current source evidence                                                                                                                                                                                                                   | Remaining implementation                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purchase orders                        | List, detail and editor normal routes render Registry/Figma source-unavailable states; responsive Review hierarchy covers all three screens                                                                                               | Trace accepted Procurement projection/commands, implement authenticated transport and runtime composition for list/detail/editor, then verify receipt/discrepancy handoffs; unavailable visual states are implemented, data/action workflows are not                                                                                  |
| Loyalty programs                       | `LoyaltyProgramListPage` defaults to `unavailableLoyaltyProgramClient`, which rejects `FeatureDisabled`                                                                                                                                   | Resolve activation scope, connect authorized owner reads/actions and immutable points-related handoffs; preserve Customer self-service source gates                                                                                                                                                                                   |
| Communication history                  | `CommunicationHistoryPage` defaults to `unavailableCommunicationClient`; permission-derived resend, suppression and template buttons are now disabled with a visible explanation                                                          | Connect scoped history/template reads and approved commands; real sending/provider evidence remains separate                                                                                                                                                                                                                          |
| Dining Table List                      | `/app/operations/tables` mounts `DiningTableListPage`, which defaults to the unavailable client; the Dining owner can list scoped Table snapshots, but no `dining_table_admin_v1` Merchant query is composed                              | Resolve the Store phase-capability owner query, then compose the Screen's `dining.operate` read contract; do not reuse the Staff floor query's DTO or bypass the Phase 2 gate. The existing `StoreCapabilityPage` also defaults unavailable; the current Feature Control query is Kill-Switch-specific, not a Phase capability reader |
| Privacy requests                       | `PrivacyRequestPage` defaults to `unavailablePrivacyRequestClient`; permissioned action controls are now visibly disabled with an explanation until authenticated command composition exists                                              | Resolve owner coverage and accepted commands, connect authenticated flow, then verify partial/hold/export outcomes before claiming fulfillment                                                                                                                                                                                        |
| Inventory items / stock overview       | `InventoryPages.tsx` defaults to `unavailableInventoryClient`; both ordinary routes now render their Registry/Figma source boundary and disabled fields without a connected client                                                        | Resolve the phase capability and authorized owner projection before connecting reads; reservation persistence does not implement this workspace                                                                                                                                                                                       |
| Recipe list / editor                   | Normal routes still default to `unavailableRecipeClient`; WP-2402's internal Brand-bound generation reader has isolated PostgreSQL evidence. Handoff 88.25 / Registry assign the feature to WP-2105, whose brief says locally implemented | Reconcile the WP-2105 status against normal-route acceptance. WP-2421 adds versioned core query/rebuild and coverage; complete source feeds and normal API/runtime composition remain absent; do not claim route completion or fabricate Inventory, cost, Supplier or allergen summaries until authorized source coverage exists      |
| Report catalog / builder / run history | Pages default to unavailable read clients; permission-derived draft, certification, schedule, Run and artifact buttons are now disabled with a visible explanation                                                                        | Compose authorized Business Intelligence projections and authenticated command transport; persisted definitions do not prove report execution or delivery                                                                                                                                                                             |

Sources are the matching `*Pages.tsx` / `*-pages.ts` files under
`apps/merchant-web/src`, with singular `PrivacyRequestPage.tsx`. These are eight
confirmed examples, not a count of every incomplete page. Disabled controls alone
do not establish a defect: intentional phase gates must remain explicit.

## Additional normal-entry route gap

Catalog Products is a further confirmed normal-entry gap beyond the eight surfaces above. The
Screen Registry defines `CAT-PRODUCT-LIST` at `/app/commerce/products` with Product identity,
localized name, type, lifecycle, SKU/Menu counts, availability, version/update fields, and Catalog
search/filter/export behavior. The registry assigns implementation to WP-1020, WP-1027 and WP-1802.
At the original review, the Merchant router/source lacked the matching route/page. The 2026-09-29 WP-2421 checkpoint above supersedes that absence: the ordinary list entry and configured owning SQL/BFF composition now exist with synthetic rendered evidence. Full Product authoring/publication and real configured runtime readiness remain incomplete.

Customer Dine-in Session is now recognized at `/dine-in/session` and renders a source-limited
unavailable state. It uses the Review hierarchy and names the four registered field groups, but no
Customer-safe current-session query/projection or authorized Batch/payment/Staff commands are wired.
The page therefore does not yet satisfy the active Guest Session, exact Store scope or Closing-lock
contract in Section 88.6; its visibility is not Dining workflow acceptance. Editable Review frames
`216:213`/`216:243`/`216:272` are design artifacts, not an Accepted Screen.

Source recheck (2026-09-24): `createDiningGuestBindingQuery` and
`createPostgresDiningGuestBindingStore` do exist, but they return internal current-binding evidence
(opaque Session/Participant/Table references, lifecycle phase, versions and observation time) for
Identity binding and Dining checkout authorization. They are not the Registry's customer read model:
they expose no safe participant presentation, active Order batches, shared payable summary or
service/allergen notices, and the current Customer binding composition uses them to authorize rather
than render a Session page. Do not turn the opaque references into display fields or mislabel this
helper as `query.cust_dine_in_session`. The remaining projection spans the Dining owners in WP-1006 /
WP-1007 and Ordering/Payment sources in WP-1220–1226 / WP-1703; an owner-authorized Customer-safe
composition contract is needed before this route can show business data or actions. Current
Ordering helpers do not fill this gap: the Dining Session order lookup returns at most one opaque
Order reference, and the multi-order inventory reader locks Order rows for closeout rather than
serving a Customer read.

Ordering source follow-up (2026-09-26): `createCustomerDiningCartViewQuery` is a Customer-safe read
for one DineIn Cart, but returns Cart contents rather than the Session, participant summary,
active Order batches or shared payable summary; its Dine-in Quote port deliberately returns `null`.
It supplies neither the complete `query.cust_dine_in_session` contract nor an authorized substitute
for it. The existing customer Cart display should remain scoped to the Cart.

Current owner-source recheck (2026-09-27): the normal `/dine-in/session` page remains presentation-only.
`createDiningGuestBindingQuery` returns current opaque Session/Participant/Table references and
versions for authorization; it does not return customer-safe presentation fields. The Customer Order
Status read and Payment status store require a specific Order reference, while the Dine-in Session
Order lookup is identity-only and supplies at most one opaque Order reference. These readers do not
provide the registered participant summary, active session-wide Order batches, shared payable summary,
or service/allergen notices. Do not wire the partial readers as `query.cust_dine_in_session` or show
identifiers as labels. The Customer-safe owner composition remains an implementation gate for the
owning Dining and Ordering/Payment packages; this WP-2402 review has not implemented or accepted it.

Responsive regular Figma Design Review frames now cover the unavailable Product List state at
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=143-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=143-266), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=143-323). The desktop frame lists
the Handoff's default Product columns; mobile frames group the same source-limited identity,
availability, counts, coverage and update fields. Search, filters and Create remain unavailable, with
no sample Product/SKU/Store facts. These frames add a design artifact only; the route, authorized
Product Search projection, commands and normal Merchant composition remain unimplemented.

## Pickup and exception command composition

Source reconciliation under [WP-2402](../spec/work-packages/WP-2402.md#pickup-action-route-source-reconciliation)
on 2026-09-23 found that the Pickup UI/client and Merchant BFF compose queue reads,
proof verification and explicit handoff, but no Claim or Report Exception route. Accepted
Fulfillment WPs 1600–1605 own creation, readiness, proof, handoff and completion; they do
not define Claim or generic exception Task commands. Handoff Section 80.9 explicitly says
no standalone Pickup Task ID is shown or persisted. WP-1805 explicitly limits its allowlist
to the Merchant UI and records authenticated Projection/client composition as future work.
The shared Task Domain already provides assigned-task Claim and versioned, idempotent,
audited Assign/Claim/Complete commands, but no acknowledgement operation; the Merchant BFF
only exposes `GET /tasks`. Its current Pickup projection carries no Task reference/source
binding. Therefore the generic Task capability cannot be wired directly to a Pickup row.
Resolve whether Pickup Claim is a source-bound Task claim or a Fulfillment-owned command,
and define acknowledgement semantics instead of treating Claim as Acknowledge. Keep Claim
and Report Exception unavailable until a properly scoped owner/API WP composes source
mapping, Task creation/assignment and authenticated commands.
WP-0125 explicitly excludes persistence adapters and production routes/API; its fixed
implementation allowlist does not include the current Task store or Merchant BFF. Do not
extend that completed minimum-contract WP implicitly. The confirmed Task assignment replay
boundary and required owner follow-up are recorded in the
[WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#task-assignment-transport-idempotency-boundary-2026-09-24).
The local queue adds public-reference search, current-page phase and wait filters, and
Claim/exception filters. The focused production-preview journey verifies those loaded
projection filters and synthetic query/proof/handoff behavior. It does not supply real
Claim, exception creation or Store-operation evidence.

The Claim and Report exception controls now state why they remain unavailable: no authorized
source-bound Task or Fulfillment command is defined for the Pickup row. This improves the
current screen's explanation without changing either command's availability or closing the
source-mapping gap. Focused render and synthetic browser checks cover the disabled state and
its accessible description only.

The earlier local UI labeled active rows Overdue after 15 minutes and used that cutoff for
Waiting/Overdue filtering. No accepted numeric Pickup SLA appears in the Screen Registry,
Handoff Sections 80.6/88.10, WP-1805 or the current queue DTO; the DTO has `readyAt` but no
`dueAt`/SLA. WP-2402 removes that invented cutoff: cards retain elapsed wait minutes and
show active rows as Waiting, while the Overdue option is disabled with the reason. The
Registry's Overdue requirement remains open until Fulfillment supplies an accepted due-time
source and the authorized projection carries it. This is separate from the absent Claim/
Report Exception commands.
The disabled Overdue choice now references its visible reason on the Current page filter
control, so keyboard and assistive-technology users can discover why the option is unavailable.

## Kitchen safe display references and queue filters

The Screen Registry `KIT-KITCHEN-QUEUE` requires ticket/item context and Order/ticket
reference search. The current authorized `KitchenBoardItem` DTO carries UUIDv7
`ticketReference` and `orderReference`, but no distinct permission-trimmed display fields.
WP-2402 keeps those raw identifiers out of cards, detail labels, URLs and browser storage;
they remain bound only to the existing scoped actions and canonical `KIT-WORK-ITEM`
route. On 2026-09-26 the Merchant queue added exact Order-or-Ticket UUIDv7 search using
the already-authorized `ListKitchenQueue` filters, with the reference sent only in the
authenticated same-origin POST body and cleared from the input after submit. Search and
clear-search behavior is covered by the production Kitchen journey; this closes Registry
exact-reference lookup for the current projection, not safe public-number display. Station,
allergen and exception remain unavailable when their facts are absent. Course, priority
and overdue filters remain unavailable: the projection has no such facts or accepted
overdue/SLA threshold. Do not join private Ordering data in the UI/BFF, infer age as
overdue, or relabel an internal UUID as a public Order/ticket number. The inspected
1440/390/320 screenshots and browser data are synthetic fixtures, not Store evidence.

The focused production journey now also covers keyboard-only Unknown recovery: Enter submits
Accept, focus deliberately moved to Refresh stays there after Unknown, and Enter retries the
identical intent; when Retry owns focus, a second Unknown restores it. This proves current
synthetic command-panel focus behavior only. The current projection supports exact UUIDv7
Order/Ticket lookup, but it still has no permission-trimmed public-reference labels. Course,
priority and overdue facts or thresholds also remain unavailable.

Keyboard route follow-up (2026-09-24): the same production journey now opens Work Item Details
using the focused Details link plus Enter, then returns using the focused return link plus Enter. It
asserts the prior `Queued` filter is restored. The journey passes 2/2; fresh detail captures at
1440/390/320 were inspected with no new layout issue. This verifies the synthetic route-state and
keyboard interaction only; it does not complete all Kitchen keyboard/route coverage or live KDS
acceptance.

Keyboard Tab-path refinement (2026-09-26): the prior assertions used Playwright `.focus()` and did
not prove that keyboard users could reach those controls in document order. The existing Kitchen
journey now traverses by Tab to the filter dialog, Work Item detail, return link, and command/recovery
controls; it exercises Enter/Escape and checks visible focus outlines. The Kitchen
`production-fail-closed` spec passes 4/4, Merchant typecheck, E2E ESLint/Prettier, Screen Registry
validation (210 records) and `git diff --check` pass, and fresh 1440/390/320 Work Item captures were
inspected. This verifies the covered synthetic Tab route only; broader screen-reader, zoom/reflow,
WCAG, Store/UAT, Accepted Screen, KDS authority and release evidence remain open. See the [dated
WP-2402 result](../spec/work-packages/WP-2402.md#kitchen-keyboard-journey-acceptance-refinement-2026-09-26).

Current KDS continuity/source check (2026-09-23): API source inspection found
`createMerchantKitchenQuery` assigning `operatorStatus: Named` from Workforce `kitchen.operate`
authorization alone. WP-2402 corrects the query and normal Merchant display to `Unverified`, which
keeps that route read-only and tells the operator that KDS Session/lock status cannot be verified.
Kitchen command authorization has one current implementation improvement (2026-09-24):
`createMerchantKitchenCommand` now rejects any authenticated Session whose policy is not
`NamedKdsOperator` before opening the business transaction; the focused API test also proves denied
policies do not reach the transaction or lifecycle service. This closes only the Session-kind
condition. The command still cannot resolve WP-1808's active named-operator Session, selected-Store
binding, device visibility lock or lock-before-handover state. The current
`kds_operator_handover` table is immutable history, not an active lock source. Keep ordinary
workforce authorization distinct from the managed KDS continuity gate; resolve and compose the
owner-backed session/device evidence and transaction-bound command fence before claiming actionable
KDS acceptance. A policy label alone cannot replace that server fence. The checked-in
`packages/rms/kitchen/src/domain/kds-continuity.ts` supplies only evidence parsers and the pure
continuity-state function; it has no application service, session source port or persistence
reader. `named_operator_session_summary_reference` exists on Device assignment rows, but no
current API/query composition consumes it. Closing this requires the owner-backed KDS session
source and a server command fence in the owning WP, followed by named-session/lock and visibility
acceptance; synthetic browser tests cannot substitute for that source.

KDS source ownership re-audit (2026-09-23): Identity's current browser-session source exposes the
`NamedKdsOperator` authentication policy, actor, session version and expiry, but not the selected
Store or a device/visibility lock. Printing Device's assignment contract carries a nullable
`namedOperatorSessionSummaryReference`; its README explicitly says Printing Device does not own
human Sessions, and its current management repository has mutation-oriented load/commit methods,
not a scoped query for the referenced live summary. The Device reference therefore cannot be
treated as proof that this browser's actor holds the active Store-bound KDS lock. The Merchant
Kitchen API continues to return `operatorStatus: Unverified`. Do not map `policy.code` alone to
`Named`; an owner-approved session-summary read and atomic server command fence are still needed.

Cross-WP source recheck (2026-09-23): [WP-2180](../spec/work-packages/WP-2180.md) owns Device
assignment history and stores only the named-operator Session summary reference on an assignment;
[WP-2181](../spec/work-packages/WP-2181.md) adds Device-owned Profile, assignment and UAT
persistence but still treats real named operator Sessions and accepted Store UAT as unavailable
external evidence. [WP-1808](../spec/work-packages/WP-1808.md) defines browser
lock/visibility/handover behavior, but its checked-in runtime remains an injected UI contract and
does not consume a server-trusted active Session source. The summary reference therefore identifies
a future owner association, not proof that a named Session is active or entitled to issue Kitchen
commands. The present permission-only API mapping and command fence remain an implementation gap;
the local device/profile packages do not currently provide the active-session input needed to close
it without inventing authority.

## Dining floor projection boundary

`DIN-FLOOR-BOARD` requires area/table/session context, elapsed time, Order/Payment
summary, reservation/waitlist handoff, attention cues, and filters for area, state,
server/owner and attention. The `/operations/dining` route reads the authorized
`StaffDiningTable` source and now batches matching Active/Closing Dining Session reads
through the Dining-owned adapter inside the same current-Store `dining.operate`
transaction. It returns elapsed whole minutes using the persistence clock, and fails
closed on missing, mismatched, duplicate or future-dated current Sessions. It groups
tables by area, supports table-label/area/operational-state filtering with selected-table
details, and preserves Staff Session start, one-time-code recovery and Host Transfer.
This closes the elapsed-time field only. Owner/server, Order/Payment,
reservation/waitlist, attention facts/filters, and the complete `query.din_floor_board`
projection composition remain unavailable. Do not infer them from a Session reference
or attach the separate unconnected rich projection. The owning floor-board query/API
contract must compose those remaining authorized fields and states before this can claim
full Registry coverage. Current 1440/390/320 browser screenshots and E2E rows are
synthetic, not Store evidence; see the [dated owner-read implementation record](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#dining-owner-backed-elapsed-time-field-selection-2026-09-25).

Reservation/Waitlist handoff has a distinct source gate: `@rms/reservation-waiting` is
runtime-inactive, and its README explicitly excludes persistence and Provider integration;
its owning WPs are WP-2113–WP-2115. Its in-memory aggregates cannot supply current floor
rows. Complete that owner-backed persistence/query contract before composing these facts
into Dining.

Screen-level access alignment: `DIN-FLOOR-BOARD`, `DIN-SESSION-START` and `DIN-TABLE-LIST`
declare `dining.operate`; WP-2402 now uses that registered action for table reads, Session Start,
join-state and credential regeneration. The BFF still fails closed without that permission and no
role grant was added. The local InternalTest setup still names the unregistered
`dining.session.manage` action in its role/bootstrap. The WP-2402 InternalTest helper now also
requires `dining.operate`; that identity cannot pass the corrected routes until an authorized
role/bootstrap change is made. No live Store or DEMO authorization read was available in this
checkout. The current test evidence is synthetic route/browser evidence, not identity or operational
acceptance; see the [API implementation result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#dining-screen-permission-composition-alignment-selection-2026-09-25)
and [InternalTest helper result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#dining-internaltest-helper-permission-alignment-selection-2026-09-25).

Table availability command implementation (2026-09-25): WP-2402 now composes the existing
Dining `SetBlock`/`ClearBlock` lifecycle through a same-origin, CSRF-protected Merchant route.
It resolves the current selected Store with `dining.operate`, derives candidate state from the
scoped Dining owner table, and delegates expected-version/idempotency/audit/event handling to
`DiningTableService`. The read exposes the affordance only when both the command handler is
configured and the current Store policy allows `dining.operate`; the pilot composition now
registers that handler. No role grant was added, so a user without the distinct action remains
denied and sees no command. Focused synthetic composition/route/browser evidence covers Set,
Clear and unknown-result retry; screenshots at 1440/390/320 were inspected. The explicit
InternalTest DEMO role has only the previously authorized `dining.session.manage` grant, so
this does not make the availability action usable for that identity. Owner/server, Order/Payment,
reservation/waitlist, attention, complete floor query and current Store operational acceptance
remain open; see the [WP-2402 command selection and result](../spec/work-packages/WP-2402.md#continuation-selection--dining-table-operation-bff-2026-09-25).

Exception actions have the parallel gap recorded below: Payment-specific follow-up is
not generic Task acknowledgement/assignment or Ordering write-off. Keep those actions
disabled until their owner commands and evidence contracts are composed.
The shared unavailable-actions explanation is now programmatically associated with each
disabled generic action; this improves accessible context without changing availability or
closing the owner-command gap.

The current Exception card now shows both validated creation time and due time. It still
has no permission-trimmed public Case/Order reference for safe-reference search, and the
generic Task actions remain unavailable pending source mapping and authorized command
composition. Its current filters do not substitute for those missing references or write
routes.

The Registry also requires Order/Payment/Dining references, an owner and a timeline.
`OrderExceptionView` currently has an opaque exception UUIDv7, an opaque Order UUIDv7 or
null, `sourceOwner` and `ownerStatus`, but no permission-trimmed display references,
Payment/Dining reference fields, assigned-owner identity or general case timeline. The
view does carry type, severity, status, Provider/compensation state and created/due times;
the root Store label is supplied by the selected Store scope. Payment follow-up panels are
source-specific and do not fill the generic case-timeline contract. Keep each missing
field visible as an owning-projection requirement; do not derive references or owner
identity from UUIDs or private Domain tables.

The Registry's Store selection is supplied by the existing authenticated workspace
scope-switcher: `MerchantShell` lists only authorized Stores, and `App.tsx` remounts the
Exception page with the new Store reference and CSRF context after a successful switch.
The page then reloads `/merchant/order-exceptions` for that selected Store; it does not
offer an all-Store projection query. Treat Store as the global authorized scope selector,
not a missing local filter or permission to broaden the query.

Accepted source contracts sharpen this gap: WP-0125 defines no Task Acknowledge operation;
Task Complete stores an opaque completion reference/result code and does not establish the
source Domain's business outcome. WP-1809's Exception acknowledge/assign/resolve mappings
are intent routing only, with no executable Task mutation adapter. Keep Exception
Acknowledge and Resolve disabled until an owner-scoped Task contract and authorized API
composition exist. Claim is not Acknowledge, and Complete is not source resolution. See
[WP-2402 Exception action-route reconciliation](../spec/work-packages/WP-2402.md#exception-action-route-source-reconciliation)
for the route and projection trace.

The Screen Registry currently declares `ordering.operate` for this Screen, but the normal
Merchant navigation/BFF and Exception readers/commands require
`operations.order-exception.manage`; that permission is absent from the Registry catalog.
Handoff Section 88.10 specifies Store Manager / Authorized Support roles but does not
name either permission string. Keep the narrower implemented server check in place and do
not infer that `ordering.operate` alone authorizes compensation review. Reconcile the
Registry and approved role grant through the authorized owner decision before claiming
normal Exception access is aligned; the existing Store-scoped permission proposal remains
unexecuted pending approval. Evidence is source comparison only, not a grant or live access
test.

### Exception route-mode reconciliation

Handoff Section 88.10 and WP-1809 identify `/operations/order-exceptions` as the Order
Exception Workbench route; the current Merchant App mounts it and both API and Merchant
`merchantNavigation` maps expose it as an independent navigation item.
The machine Screen Registry instead marks `OPS-ORDER-EXCEPTION` as `kind: contextual` and
`route_mode: contextual`, names `OPS-ORDER-DETAIL` as its parent/navigation target, and
Section 88.19 says contextual utilities inherit the parent Route rather than stand alone.
These sources do not presently establish whether the workbench is a contextual Order Detail
utility or an independent page. Do not change the route or Registry from code alone; resolve
the semantic and navigation contract through its authorized owner first. This is a source
contract discrepancy, not evidence that the current isolated route test passes the full
Section 88 journey.

### Customer menu Feature Disabled contract

Verification selection: compare Screen Registry `CUST-MENU` states with Handoff
Sections 88.6/88.24 and the Catalog result, API error and Customer PWA parsing/rendering
contracts. This is source reconciliation only; format this review and WP-2402 and run
`git diff --check`. No application suite applies because this pass changes documentation
only.

The Registry requires a distinct `Feature Disabled` state. Catalog's current
`CustomerMenuQueryResult` is limited to `Found`, `NotFound`, `ProjectionStale` and
`Unavailable`; `apps/api/src/customer-menu.ts` maps those to request-invalid,
not-found, projection-stale and service-unavailable errors, with no feature-gate result.
The PWA menu client parses not-found/stale explicitly and maps other responses to
`Unavailable`, rendered as “Menu is unavailable.” The UI therefore cannot distinguish
a deliberately disabled ordering feature from a service failure. The Make preview's
`Feature Off` scenario returned to its T-07 entry without an explanation, but that is
fictional preview behavior and does not establish the PWA's contract or runtime result.
Before changing code, the Catalog/API owners must identify the authoritative capability
signal and customer-safe disabled response; do not infer it from an unavailable service,
an absent menu, or the Make scenario. Keep the registry state unresolved until a
versioned result/error path and normal-route rendering are accepted and verified.

Customer Menu visual continuation (2026-09-24): ordinary Figma Design Review frames now cover
`CUST-MENU` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=152-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=152-275), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=152-337). The existing menu page
adopts their BOP/Inter hierarchy, active browse navigation, card layout and source-safe Quote/allergen
copy. The focused browser journey inspects the read-only synthetic fixture and fresh screenshots at
all three widths. This visual result does not fill the Registry's Feature Disabled state, establish
Catalog projection/Store acceptance, or alter the separate private Figma Make edit/save gate.

Customer Menu Search contract reconciliation (2026-09-24): `CUST-MENU-SEARCH` requires query,
section, dietary tag and available-now filters. The current WP-2402 review frames and PWA implement
query plus section and display matched term, result section and the Available-only result state. The
integrated WP-1026 query accepts only bounded `q` and `section` inputs and omits hidden/configured-
unavailable Sellables; its DTO exposes no dietary tags or availability choice. WP-1028 expressly
excludes Customer allergen filtering/accommodation, and completed WP-1701 did not authorize a DTO
extension. Do not infer available-now filtering from a result label or add dietary/safety filters from
Figma alone. Keep the remaining Registry/Handoff dimensions open until the owning Catalog/Customer
WPs reconcile them and authorize any query/DTO extension. See the scoped implementation and browser
evidence in [WP-2402](../spec/work-packages/WP-2402.md);
the synthetic visual journey is not a Catalog query or Store acceptance test.

The adjacent QR-entry failure is governed separately by WP-1004 and WP-1700: invalid,
expired, revoked, copied, mismatched and otherwise unusable QR credentials intentionally
collapse to the same `entry_unavailable` response and `RescanOrAskStaff` recovery. The
entry port exposes only `InvalidRequest` and `EntryUnavailable`; it has no SessionExpired
or FeatureDisabled result. Preserve this non-oracular contract. In particular, the Make
`Session Expired` branch returning silently to its fictional entry must not be translated
into a cause-specific production message or treated as evidence that the real Guest
session expired. That preview behavior remains unresolved presentation evidence; a
customer-safe distinction requires a separately accepted owning signal.

[WP-2134](../spec/work-packages/WP-2134.md) explicitly excluded persistence,
migrations and Event transport. Current Procurement sources contain the purchase-order
aggregate, service, contracts and ports. A targeted search of `apps/api/src` and
`packages/database/src` found no purchase-order implementation matches. The next
slice must therefore establish the actual read source and API contract before wiring
the UI; this is not demonstrated to be a client-only fix. Do not replace unavailable
reads with synthetic production data or infer that the old WP authorized persistence.

Follow-up manifest inspection used the installed TypeScript AST parser across 33
BOP/RMS module declarations. Procurement, Customer/Loyalty, Privacy Governance,
Compliance/Food Safety and Reservation/Waiting declare `Later`, no owned schema
and zero owned tables. These are next-phase persistence/ownership investigations,
not permission to activate or invent a namespace. Conversely Reporting and Recipe
are also `Later` but declare schemas and tables: phase labels alone cannot measure
implementation. Shared platform storage may live outside a Domain manifest; zero
owned tables is not universal proof of no persistence.

### Inventory, Recipe and Reporting follow-up

The ordinary routes above were inspected again on2026-09-22. This is source
evidence, not a new browser or persisted-workflow acceptance. The Inventory finding
is limited to the item/overview pages; count, waste, transfer and movement routes
need their own client and authority review before any assembled-completion claim.

[WP-2120](../spec/work-packages/WP-2120.md) explicitly left Item persistence,
Stock projection and usage/supplier feeds as injected ports. The later accepted
[DEC-PILOT-INV-01](../spec/design/inventory-pilot-persistence-decision.md) authorizes
namespace1900 and narrowly scoped pilot persistence, not automatic activation of
advanced procurement, supplier catalogs or multi-warehouse transfers. Registry
`INV-ITEM-LIST` remains `phase_2` with `phase_capability`. Existing owner Item
repository reads and submission reservation checks cannot stand in for a scoped,
permission-trimmed merchant projection. The stock-overview Domain contract and
merchant Item view also differ: the latter requires policy and supplier/usage
summaries. Missing source facts must not become zero quantities or invented text.

Inventory phase-capability source recheck (2026-09-24): DEC-PILOT-INV-01 approves the scoped
Inventory persistence, but Registry `INV-ITEM-LIST` remains Phase 2 with the
`inventory.inv_item_list` capability gate. Feature Control has generic Release Flag contracts and
persisted control definitions, while its checked-in runtime query adapter reads current Kill Switch
definitions only; no current Brand/Store-scoped phase-capability reader or Merchant composition was
found. The Item owner repository does not prove the capability is active. Do not expose Item reads
through a route that bypasses the Phase 2 gate or query Feature Control private tables from the API.
WP-2193 owns Release Flag / Store Capability and its exact allowlist excludes `apps/api`; extend that
owner read contract in an authorized follow-up before Merchant composition. Resolve and compose the
authorized capability source before connecting the Inventory Item client.

[WP-2105](../spec/work-packages/WP-2105.md) excludes a production BFF. Recipe has
owner persistence and declared admin-projection tables, but a table declaration
alone does not establish a populated read model or API. The next investigation
must resolve its owning query contract, builder/checkpoint, authorized source feeds
and normal-route transport before changing the UI. Publication and dual-review
commands remain separate from list/editor reads.

### Recipe read-chain implementation boundary

Follow-up source tracing distinguishes declared storage from executable reads:

| Layer                      | Current evidence                                                                                                                          | Required completion                                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner aggregate repository | `createPostgresRecipeQueryStore` provides `load`, `resolveOperation` and `codeAvailable`; its comment requires callers to authorize first | Keep this internal boundary; do not expose it as a merchant endpoint or treat its aggregate snapshot as the admin view                                                |
| Projection storage         | Migration `1250_001_create_recipe_management.sql` defines generation, recipe rows, ingredient rows and checkpoint                         | Implement an owning rebuild/replace path that publishes a complete generation and checkpoint atomically, preserving Brand isolation                                   |
| Event consumption          | Event Catalog and consumer compatibility register `recipe.admin-projection:v1` / `replace_recipe_admin_projection`                        | Implement and verify the consumer and its runtime registration; declarations are not execution evidence                                                               |
| Merchant query             | Registry specifies `recipe_admin_v1`, `recipe.manage`, explicit scope, freshness and phase capability                                     | Resolve the closed public query/result and current authorization before reading; verify denied scope, unavailable generation and stale/rebuilding outcomes            |
| Transport and UI           | App mounts list/editor without clients; fallback rejects `Unavailable`                                                                    | Connect authenticated transport and exact route/reference binding only after the owning projection exists; verify ordinary navigation, reload and context replacement |

The inspected projection row has display name, yield/cost/usage summaries, lifecycle,
mapping/cost flags, aggregate/version references, digest and timestamps. Ingredient
projection rows contain references, source kind, allergen count and unresolved flag.
They do **not** contain the editor's source display name, preparation/substitution,
cost derivation, review and history summaries. The aggregate supplies structured
requirements, exact cost inputs, steps and version references, not all display or
usage facts. Resolve these through approved owning sources and version bindings;
never synthesize a Verified allergen state, zero usage or a supplier/source name.

No implementation references to these admin tables or consumer were found in the
searched `packages` and `apps` source beyond declarations, catalog tests, README and
screen labels. This is a bounded source finding, not proof about an external runtime.
That finding predates the subsequent WP-2402 internal admin-reader implementation:
`createPostgresRecipeAdminQueryStore` now reads one exact row and its active generation
metadata. It does not implement the builder, public authorization, list/editor query
or normal-route composition. WP-2402's isolated PostgreSQL acceptance now exercises the
admin reader with a persisted synthetic generation, exact numeric text, absent checkpoint
versus missing Recipe row, cross-Brand RLS and checkpoint mismatch; this verifies the
internal read adapter only, not the complete admin workflow. The existing
`recipe-management:acceptance` composite also runs Recipe, event-contract and Merchant
tests. In the current run those component suites passed, its database stage first failed
to start inside the sandbox, and the same existing database config passed when rerun with
approved local Docker access. No normal-route/API or builder acceptance is implied.

Before the next admin read/API code slice, refresh WP-2402 with the complete owning
read-model contract and exact source mappings. Required evidence still includes
authorized version2 query parsing, field trimming, freshness/partial state, route and
permission changes, publication/replacement replay, interrupted rebuild, and an
assembled normal-entry browser journey. The current internal database reader test is
not that milestone. Phase2 activation, real source facts and publication commands
remain separately gated.

Builder readiness has a concrete source-ordering implementation question:
[Recipe admin ordering proposal](../spec/design/recipe-admin-projection-ordering.md).
The Brand-wide checkpoint requires a source sequence absent from the current event
contract. A per-Recipe version cannot replace it. The recovered Handoff at03ad510
already specifies source/checkpoint rebuild and Shadow Table / Version Switch;
approval of that general direction is not required again. Resolve the concrete
source-coverage representation and compatible schema before generation writes.
The source-sync change itself does not alter schema or accept a new business policy.

WP-2402 now implements and verifies an internal Brand-bound reader for one existing
Recipe admin generation. It does not connect the normal Recipe pages. The source map
in the proposal confirms the current row has no cost currency/valuation source, no
per-object Inventory/Supplier/allergen source-version manifest, and no field-trimmed
version2 query. `RecipePorts.facts.validate` provides validation booleans and Recipe
graph snapshots only; it is not a read-model feed. The Catalog allergen facts reader
is owner-specific to its review flow and is not a Recipe cross-domain query contract.
Keep those routes unavailable until the complete owner query contract and current
source coverage are implementable. Handoff evidence and exact test scope are recorded
in [WP-2402](../spec/work-packages/WP-2402.md).

[WP-2161](../spec/work-packages/WP-2161.md) explicitly allows unavailable read-only
runtime clients and owns persisted Report definitions and schedule intent. Its
reported local verification does not establish a working report catalog under the
normal App composition. Report runs, artifacts and delivery belong to separate
contracts and cannot be inferred from a successful definition read.

Current source reconciliation against Handoff sections 38.20–38.24 and 88.15/88.22
confirms the UI defines and parses the expected Catalog/Builder payloads, but repository
search found no implementation of either named `reporting_report_*_v1` query outside
the UI types/tests and Screen Registry. The normal routes therefore remain unavailable;
WP-2161's unavailable-client boundary is still respected. Before wiring them, resolve
the owning scoped/fresh reporting projection and its authorized normal-App transport.
Definition persistence alone is not a run path; Report Runs/artifacts remain WP-2162,
and certification, schedules, delivery and current external Dataset/Metric evidence
remain independently open.

### Communication activation boundary

Fresh source tracing on2026-09-22 resolves this example as an explicit activation
gate, not a missing HTTP client alone. [WP-2145](../spec/work-packages/WP-2145.md)
states that Notification remains runtime-inactive and port-backed because no accepted
persistence namespace exists. Its current
[manifest](../../packages/bop/notification/src/module.manifest.ts) declares Phase0
but no schema/tables; Phase0 does not supersede that WP gate. The API/database source
search finds no Communication history/template implementation. The only API
Notification match is a failing escalation port in Dining exception composition,
not a Communication adapter.

The existing [governance service](../../packages/bop/notification/src/application/communication-governance-service.ts)
requires authorization and injected history/template projections. Its public
[contracts](../../packages/bop/notification/src/contracts/communication-governance.ts)
already pin projection names/versions, Brand, Actor, purpose, permission, freshness,
partial state and permission trimming. The
[merchant client](../../apps/merchant-web/src/communication-pages.ts) currently exposes
only `load`; it is not an implementation of resend, suppression or template commands.

Proposed bounded execution after source reconciliation and Owner approval:

1. Approve Notification storage ownership/namespace and activation scope without
   allocating a number in this review. Preserve Request, immutable Attempt and
   append-only Template Version facts in their owning Domain; no cross-domain SQL.
2. Implement owner repositories and read projections, then authenticated API
   composition using server-derived scope/Actor. Preserve masked recipient values,
   exact projection contracts and explicit unavailable/stale/partial responses.
3. Wire normal history/list/editor reads and verify scope denial, malformed input,
   permission trimming, navigation and reload against persisted synthetic fixtures.
   An empty source or FeatureDisabled fallback cannot pass this acceptance.
4. Implement resend/suppression/template commands as separate slices with current
   authority, expected version, idempotency, distinct approval and atomic audit.
   History reads do not authorize actual sends or make command buttons functional.
5. Retain real recipient, Consent/Preference, approved test sink, Provider and content
   approval as external gates. No email, SMS, Push or Marketing activation is
   authorized by this investigation.

Owner clarification has been requested for proposing the formerly inactive modules'
activation/persistence decisions. No response or decision acceptance is recorded.
The complete Handoff source is now present in the repository after the Owner-authorized
sync. Its self-reported version does not replace the accepted composite baseline in
the spec index; use that index and later accepted sections to resolve any proposal.

## Whole-product scenario coverage

IDs and owner boundaries come from the existing
[business scenario matrix](../spec/design/business-scenario-coverage.md).
The historical evidence paragraphs in that document retain their dates; its reconciled current view owns the consolidated rows. For the named pilot flows, use the
[current pilot acceptance table](./single-store-pilot.md#current-acceptance-and-remaining-work)
and exact batch limitations. Do not overwrite historical test results.

The consolidated progress rows are now maintained once in [the current scenario evidence view](../spec/design/business-scenario-coverage.md#current-scenario-evidence-view). This review retains its source-specific observations and chronological diagnostics below.

The [system completeness proposals](../spec/design/system-completeness-contracts.md)
and [design decision register](../spec/design/README.md) retain their recorded status.
Source reconciliation precedes implementation of unresolved policy. Delivery remains
phase-gated; whole-project review does not activate it or add it to single-Store launch.
Multi-Store release applicability and cross-Store operator journeys also need a
separate coverage pass; existing scoping contracts alone do not certify them.
Bounded synthetic route journeys now cover authorized Store switching in Dining, Kitchen,
Exceptions, Orders, Pickup, and Task Inbox. Dining, Kitchen, Exceptions, Orders, and Pickup verify
the selected Store's current row replaces the prior row without caller-supplied Store authority;
Pickup also checks the current CSRF on its POST. Task Inbox verifies the prior task view is cleared
when a second Store has no configured queue, leaving its read-only unavailable state visible. This
improves client route/session continuity evidence across six Merchant surfaces. It does not prove
actual Store membership, BFF authorization, RLS, production per-Store Task Queue provisioning, or cross-Store
release applicability; other registered Merchant screens still need a coverage pass. Exact commands
and limits: [WP-2402 cross-Store journeys](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#cross-store-orders-and-pickup-journey-coverage-2026-09-26) and [Task Inbox stale-view check](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#task-inbox-store-switch-stale-view-clearing-2026-09-26).

Persisted Store-switch follow-up (2026-09-26): the isolated `current-permission-policy` PostgreSQL
acceptance now also rotates a real persisted Merchant session from Store One to Store Two and reads
Kitchen through the normal BFF against Store Two's builder-generated `initializedEmpty` generation.
The revoked Store One cookie is denied, and the query rejects a body-supplied Store reference. This
extends the six synthetic client journeys with persisted Kitchen session/permission/query composition;
it still does not prove live membership, production RLS, KDS device authority, or cross-Store release
applicability. Exact acceptance and fixture limits are in the [dated WP-2402 result](../spec/work-packages/WP-2402.md#persisted-kitchen-store-switch-boundary-selection-2026-09-26).

Persisted Dining floor follow-up (2026-09-26): the same isolated acceptance now queries the ordinary
`/merchant/dining/tables` BFF route before and after Store-session rotation. Store One returns its
persisted Table; Store Two returns only its separately persisted Table; the previous cookie and a
body-supplied Store reference are denied. This is synthetic BFF/owner-reader evidence for the
`DIN-FLOOR-BOARD` table read, not live membership/RLS or Store/UAT acceptance. See the [dated WP-2402
result](../spec/work-packages/WP-2402.md#persisted-dining-floor-store-switch-boundary-selection-2026-09-26).

Persisted Exceptions Store-switch follow-up (2026-09-26): the same isolated acceptance now calls
the authenticated `/merchant/order-exceptions` BFF before and after persisted Store-session
rotation. Store One and Store Two return their selected labels with Stale, empty source projections;
responses are `no-store`, and the revoked cookie and query-supplied Store scope are denied. This
proves local Session/Permission/BFF scope composition only; the source table has no coverage
generation, so empty Stale output does not establish that the Store has no exceptions. Actual source
coverage, live membership/RLS, Store/UAT and cross-Store release applicability remain open. See the
[dated WP-2402 result](../spec/work-packages/WP-2402.md#persisted-exceptions-store-switch-boundary-selection-2026-09-26).

Persisted Task Inbox Store-switch follow-up (2026-09-26): the same isolated acceptance now resolves
one server-configured Task Queue per authenticated Tenant/Brand/Store and calls `/merchant/tasks`
before and after persisted session rotation. Store Two returns its own empty queue with `no-store`;
the revoked cookie and caller-supplied Store query are denied. This proves configured local
Session/Permission/Queue routing only; it does not prove production Queue provisioning, populated
Task facts, Manager mutations, live membership/RLS or Store/UAT. See [WP-2402](../spec/work-packages/WP-2402.md#task-inbox-persisted-store-switch-read-composition-selection-2026-09-26).

Task Inbox filter contract follow-up (2026-09-26): Section 88.7 requires safe-reference search and
status/type/severity/owner/Store/overdue filters. The WP-2402 Merchant read currently exposes only
an authenticated, Store-bound cursor page; `createPostgresTaskQueueReader` has no filter contract.
Filtering that 50-row page in the browser would silently omit matches on later pages, so the controls
remain unavailable. WP-0125 explicitly excludes Task Inbox projections, search, persistence, API and
UI; its domain minimum contract cannot authorize those additions. A source-owned query/projection WP
must define exact filter semantics and extend the Task Owner reader before the Merchant route can
enable them. This is a repository implementation gap requiring its owning WP, not external Store
evidence; Claim/Assign/Acknowledge/source resolution remain separate command gaps.

## Execution order and next slice

Owner update on 2026-09-22 deferred Figma Make edits while repository delivery continued.
The 2026-09-24 Chrome recheck opens Preview, the Version29 conversation and Code view.
The 2026-09-26 follow-up confirmed manual source save/reload persistence with a reversible
temporary comment in `KitchenWorkspace.tsx`; the probe was removed and a second reload confirmed
the original source. The AI prompt remains disabled until the displayed Sep 30 credit reset. The persisted
Pickup/Exceptions source edits below are earlier observed work. Source ZIP/export is not a
prerequisite for unrelated repository work.
The Customer receipt offline/reconnection freshness slice has since been implemented and
verified with 38 focused tests plus PWA lint/type/build. A later lifecycle follow-up passes
82 focused Order-status/Receipt client/controller tests plus PWA typecheck/lint and formatting.
These local checks do not substitute for live pilot Guest context replacement, device-offline
behavior or receipt rendering/authorization.

1. Continue repository implementation and source reconciliation now. Current Make source
   access and manual save/reload persistence are confirmed, so direct Code-view edits may
   proceed when they advance authorized project work. AI prompt/Build remains unavailable
   until the displayed Sep 30 credit reset, and full draft acceptance stays open. Do not
   make prototype work a prerequisite for repository delivery.
2. Finish the bounded pilot operational acceptance questions, preserving completed
   orders and historical evidence. Never replay payment/refund to fill a checklist.
3. Close normal-entry composition gaps one owned workflow at a time. Procurement
   requires unresolved persistence authority; Inventory requires a bounded scope
   reconciliation rather than automatic workspace activation. For Recipe, map the
   available owner source versions to the Handoff's version2 authorized view and
   identify unavailable summaries before API/composition work. Verify scope denial,
   unavailable/stale, navigation and reload; authoring/publication remain distinct.
4. Resolve compatibility, privacy coverage and performance decisions from accepted
   sources; prepare bounded implementation/acceptance against the resulting contracts.
5. Assemble the release candidate with applicable full regression, real integration
   evidence, deployment/recovery and release approval. A passing validator is not an
   actual scan, signature, production observation or approval.

This ordering proposes implementation slices, not new accepted WP numbers. Refresh
the owning brief before business code changes and keep one WP per worktree. The
[external inventory](./pilot-integration-readiness-inventory.md) remains the owner of
real Store/Provider/professional evidence, not a substitute for implementation tracking.

## Figma Make reconciliation

The [first-round brief](../spec/design/bop-rms-figma-make-brief.md) deliberately asks
for complete Orders first; Kitchen, Dining, Pickup and Exceptions were outside that
first-round build. The project was subsequently recovered from task `01a0cacd-ddfa-7d22-a324-9caa44e96887`
("拉取最新代码覆盖本地项目"):
[High-Fidelity Restaurant Order Prototype](https://www.figma.com/make/u5gjkcwfARvEqaiUKnCJnp/High-Fidelity-Restaurant-Order-Prototype).
An initial read found literal TBD navigation labels for those four workspaces. Later
Version29 observations and route journeys recorded in WP-2402 show the labels are gone
and each route has generated demo content. This supersedes the earlier “not yet built”
state; it does not establish complete Screen coverage or acceptance. The first-round
brief's earlier status paragraph is historical and must not be read as a current
acceptance claim. The user-authorized preview remains private, synthetic and unconnected.
Earlier direct Code-view edits added Pickup search and Exceptions filters; other screen
reconciliation and full draft acceptance remain open. Current preview/source read access and
the manual editor control are available to this authenticated Full-seat/admin account; the
2026-09-26 reversible save/reload check confirms manual writeback. AI generation remains
quota-gated until Sep 30. The MCP source-resource read still fails, and full draft acceptance
remains open.
The preview remains private, synthetic and unconnected.

| Workspace  | Canonical Screen                     | Known route                                                 | Resolution boundary                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders     | OPS-ORDER-QUEUE / OPS-ORDER-DETAIL   | `/operations/orders`, `/operations/orders/:id`              | Preserve batch eligibility, same-intent Unknown recovery, conflict refresh and page-local filtering. PaymentStatus has an owner reader in Customer Guest context, but Merchant queue lacks its own payment scope/field authorization; keep Payment filters unavailable until that read contract is approved. Kitchen, overdue, exception, claim and full-database search facets also remain source-gated |
| Kitchen    | KIT-KITCHEN-QUEUE / KIT-WORK-ITEM    | `/operations/kitchen`, `/operations/kitchen/work-items/:id` | Preserve station/state actions and operator lock; Order/ticket search, course, priority and overdue need approved display fields/threshold before design can claim them                                                                                                                                                                                                                                  |
| Dining     | DIN-FLOOR-BOARD / DIN-SESSION-DETAIL | `/operations/dining`, `/operations/dining/sessions/:id`     | Preserve selected Table/Session ownership, start/recovery/Host Transfer and paid-batch blockers; owner, elapsed, Order/Payment, reservation/waitlist and attention facts remain absent from the current floor source                                                                                                                                                                                     |
| Pickup     | FUL-PICKUP-QUEUE                     | `/operations/pickup`                                        | Preserve proof verification and server-confirmed handoff; current-page Waiting and other existing filters use only loaded authorized projection rows; Claim and Report Exception stay unavailable pending source-bound Task/action mapping and authorized commands                                                                                                                                       |
| Exceptions | OPS-ORDER-EXCEPTION                  | `/operations/order-exceptions`                              | Created and due time plus type/severity/status/owner/Provider/overdue filters render from the current DTO; keep Payment follow-up separate from generic Task actions, and leave safe-reference search open pending an authorized display field                                                                                                                                                           |

Route/ID mapping is checked against
[Screen Registry](../product/screen-registry.yaml). This table is an intake map,
not a complete Screen contract or a remote Make acceptance report. Unknown amounts
must remain unavailable, implementation gaps must not masquerade as permission
denials, and undecided policy cannot be resolved by replacing TBD with invented text.
Keep the draft private and unconnected to real services; publication is not requested.

Dining preview boundary recheck (2026-09-23): Version29's `/operations/dining` shows
Main/PATIO/BAR; selecting T-02 opens `/operations/dining/sessions/SES-002`. That
synthetic detail displays elapsed time, guest count, DEMO-1008, CAD19.00 and an unpaid
close blocker. Those fields are not available from the repository route's current
`StaffDiningTable` source and are not production facts. The observed Make floor had no
visible table/area/state/server/attention filters, and the selected detail exposed no
action controls in its accessibility tree. Merchant Dining separately implements
table-label/area/state filtering and preserves its Session start, one-time-code recovery
and Host Transfer flows. Full Registry field/action and Make responsive/keyboard/failure
state coverage remain open. No Make action beyond selecting the table was invoked.

Initial same-day preview inspection: the linked file opened at Version29 in read-only preview; its
left editor asked the user to sign up and the AI prompt was disabled at that time. The operations shell
now exposes Orders, Kitchen, Dining, Pickup and Exceptions routes, and no longer shows
TBD labels. The preview labels the Store/date and data as fictional demo content. Orders
shows eight page-local rows and explicitly says full server pagination is unavailable.
Kitchen shows station lanes/tickets. Dining shows area tables and a selected Session with
an unpaid Order blocker. Pickup detail requires simulated verification before handoff.
Exception detail distinguishes simulated acknowledgement/assignment from resolution and
keeps Resolve unavailable while source finality/evidence are missing. Its scenario panel
offers the named global failure/recovery states plus separate Pickup verification
outcomes, and explicitly says transactions remain in memory and are not persisted. These
are current prototype observations only; no external business fact or successful live
operation is established.

The fresh inspection covered routes, representative selected details and scenario
inventory only. Recorded preview journeys later exercised Orders Unknown/conflict and
fail-closed states; Kitchen's one queued ticket through complete; Pickup's selected proof,
retry and handoff branches; and Exception acknowledgement/self-assignment on synthetic
cases. The exact branches and limits are recorded below and in WP-2402. No journey proves
server authorization, persistence, real Store/Provider outcomes or source finality. Full
Screen field/filter coverage, all state branches and complete responsive/keyboard
acceptance remain open. A later same-day editor check supersedes that sign-up state: the
authenticated editor opens but its AI credit notice runs until September 30. Continue
repository work in the meantime. Do not treat local browser tests or the Make route
inventory as Make acceptance.

Orders Unknown recovery was then exercised in the read-only preview's explicitly
in-memory scenario: DEMO-1001 acceptance showed a pending state with duplicate submission
blocked, then `Acceptance could not be confirmed` with a not-failure explanation and
refresh/retry choices. The simulated retry resolved to Accepted, batch1 changed from Not
accepted to Accepted, and the order projection version advanced from1 to2. Its History
tab showed the updated point-in-time projection and warned it is not a live subscription.
This verifies that one synthetic path's visible states connect; it does not prove the
server reused an identical operation identity, persisted once, or produced a real server
confirmation. All preview data remain fictional and in memory. Full Orders recovery,
conflict/permission/stale branches, viewport/accessibility and the other workspace
journeys remain open.

Additional Orders scenarios exercised in preview: stale/offline retained a visibly stale
snapshot and disabled `Accept batch`; Permission denied showed an empty queue and an
`ordering.operate` explanation, while a direct demo-order route resolved to not-found;
Conflict kept the batch unaccepted and offered refresh. These visible branches behave
fail-closed in the synthetic UI only; they do not prove real authorization or server
version fencing. Session expiry, partial/unavailable, feature-disabled, pending, failed,
rate-limited, remaining workspace journeys and all viewport/accessibility checks remain
unverified.

Customer-shell follow-up (2026-09-23): the linked Version29 preview also exposes the
fictional QR entry `/` and `/menu`. `QR Invalid` ended with an invalid/expired message
after View menu; `QR Denied` showed staff-assistance guidance. Menu Empty showed its empty
copy. Menu Error advised “try again or ask staff,” but the accessible tree and screenshot
showed no actionable Retry or staff-contact control. `Session Expired` left the root showing Open
T-07 and View menu after two attempts, with no visible explanation; expiry recovery is
unresolved. No cart/checkout/payment action was invoked. The Make editor still requires
sign-up and disables its prompt; opening the file-edit menu also displayed a sign-up
modal, and no credentials were entered. `Feature Off` followed the same Verifying-then-
return-to-entry path without a visible unavailable explanation. These observations do
not establish the PWA route, session enforcement, live Guest/Store authority or payment
outcomes; keep Make acceptance open until customer-facing disabled/expiry behavior is
resolved and editing access is available.

Further Customer checkout preview checks (2026-09-23): `Pay Timeout` ended with
`Payment could not be completed` / `Payment timed out. (simulated)` and a Back to checkout
control; no payment retry control was visible. `Price Increased` announced CAD14.00 →
CAD16.00 and offered explicit confirmation while item/subtotal stayed CAD14.00. The
increase was unexplained, so it was not confirmed. `Quote Expired` displayed an expired
summary and Recalculate; that action returned a fresh quote and the original CAD14.00
total for the same fictional cart. No real or repeated payment occurred. These states do
not establish provider, quote-authority or persistence behavior; Make acceptance and
normal Customer PWA checkout remain open.

Pickup Make follow-up (2026-09-23): selected PU-007 and confirmed that an unknown
ready quantity blocks handoff. On fully-counted fictional PU-001, a Failed verification
left handoff blocked; Unknown displayed a no-handoff warning and simulated same-operation
retry. The retry displayed Verification passed, then separately required recipient and
item-count confirmation before its simulated handoff changed PU-001 to Completed/read-only.
This is an in-memory prototype journey only; it does not verify production proof,
recipient identity, durable idempotency or a real handoff. Expired/zero-ready/delegate,
viewport/keyboard and other Pickup outcomes remain open.

Fresh branch follow-up (2026-09-23): Expired on PU-001 showed a `Verification expired`
message, denied handoff and offered `Restart verification`. PU-006 still displayed
`None ready` and kept completion disabled after synthetic proof passed. On PU-001,
Delegate displayed a masked recipient label while the separate confirmation remained
unchecked; no handoff was submitted. These current Version29 observations remain
fictional and do not establish expiry timing, delegation authority or server behavior.
At the time of this observation, editing access appeared unavailable. A later same-day
Code-view recheck enabled direct edits, but that does not close Make acceptance.

Exceptions Make follow-up (2026-09-23): on synthetic EXC-001, acknowledgement added a
timeline event while status stayed Open and financial Resolve remained disabled because
source finality and evidence summary were absent. Simulated self-assignment changed it to
Assigned / You without resolving it. This establishes only visible behavior in this
in-memory fictional case; Store authorization, durable audit, payment source resolution,
other case types/actions and responsive/accessibility coverage remain unverified.

Further Exceptions preview check (2026-09-23): synthetic EXC-003 (`Paid Without
Fulfillable Order`) showed an unlinked demo reference, Unreconciled state, no compensation,
source finality `No`, and no evidence summary. Resolve stayed unavailable pending both
finality and evidence; acknowledge/assign remained simulated follow-up actions. The
visible route snapshot exposed no search/filter controls beside its four demo rows, so
compare the draft with the Registry; `UNMATCHED-1` is
not established as a production-safe public reference. No action was invoked; all facts
remain fictional preview state.

Kitchen Make follow-up (2026-09-23): the preview showed station lanes, an explicit
empty lane, and terminal cancelled/completed details as read-only. One in-memory
fictional queued ticket completed the visible Accept → Start → Complete sequence with
timeline entries and 1/1 done, then became read-only and left the active queue. Another
in-progress item displayed a lock to another synthetic operator. These observations do
not establish server-side permission/idempotency or downstream service, Pickup or
payment completion; failure/recovery, other lifecycle branches and responsive/keyboard
coverage remain open.

Earlier same-day Make route reconciliation (2026-09-23): the linked preview was at
Version29. Its five Operations routes are present and both shell and workspaces identify
fictional/demo data. A read-only pass revisited Kitchen KT-002 (locked to another demo
operator; freshness SLA unavailable), Dining T-02 (linked Order has a pending unpaid
close blocker), Pickup PU-007 (unknown ready quantity blocks handoff), and Exceptions
EXC-003 (source finality/evidence absent; acknowledgement/assignment are simulated).
The Pickup list exposed no search or Claim/Exception filters; the four-item Exceptions
list exposed no search/filter controls, while Screen Registry requires those filters.
Local Merchant filtering is separately implemented and tested; it does not repair the
remote Make draft. That earlier inspection showed a sign-up gate; a later same-day check
opens the authenticated editor but shows depleted AI credits through September 30. All
observed records remain fictional and in-memory. Make remains open for generation access,
Orders recovery, all-route failure outcomes, and
responsive/keyboard acceptance; the visible removal of TBD labels is not completion.

## Make-to-repository acceptance crosswalk (2026-09-23)

Verification selection for this update: inspect the WP/brief/runbook claims against the
current Version29 editor and Preview evidence, repair stale source-state wording, verify
relative references and Markdown formatting, and run `git diff --check`. Only Markdown
changes are expected in this repository; business suites and local app builds do not apply.

Historical access snapshots on 2026-09-23 alternated between a sign-up gate and an
authenticated Version29 editor; they describe those sessions, not current access. The
current 2026-09-27 authenticated browser opens both Preview and Code, and selecting
`src/components/KitchenWorkspace.tsx` opens a settable source editor. The separate
2026-09-26 reversible comment/reload/remove/reload check confirms that manual source edits
persist. This recheck made no source edit. The AI prompt, Build, model and Send controls
remain disabled until the displayed 2026-09-30 credit reset; `get_design_context` source
resource links returned `Unknown resource` on the last documented attempt (2026-09-26); that
MCP resource read was not repeated in this browser check. No Publish or Share action was used
and sharing settings were not changed.
The previously observed direct edits persist in
`PickupWorkspace.tsx` and `ExceptionsWorkspace.tsx`: Pickup has page-local Order-number
search/count/empty/Clear; Exceptions has fictional type/severity/status/owner
filters/count/empty/Clear. Preview checks verified Pickup PU-007, no-match and reset
behavior, and Exceptions type/combined filters, empty and reset behavior. No business
command, publish or share action occurred. All demo rows remain fictional. The route and
scenario rows below combine same-day Version29 inspections in WP-2402 with current local
source review. Previously recorded Merchant 67/67 and Customer 91/91 repository results
are separate from this Make UI verification.

| Screen                                           | Version29 preview evidence                                                                                                                                                                                                                                                                                                  | Current local implementation / evidence                                                                                                                                                                                                                                                                                                                                      | Remaining reconciliation                                                                                                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Orders — `OPS-ORDER-QUEUE`, `OPS-ORDER-DETAIL`   | Eight page-local demo rows; Unknown retry, stale/offline, failed, conflict, and rate-limit branches; the private draft now displays a simulated five-second `Retry-After` countdown and manual retry gate                                                                                                                   | `CurrentOrderQueuePage.tsx` filters the loaded page by public Order number/type/channel/phase, preserves server pagination, and states unavailable facets; exact-intent retry and production-preview coverage are in WP-2402                                                                                                                                                 | Remaining no-fabrication details, other scenario branches, responsive/keyboard coverage and complete Make acceptance remain open; the simulated retry delay and pending timeout are not production evidence                                                                                            |
| Kitchen — `KIT-KITCHEN-QUEUE`, `KIT-WORK-ITEM`   | Station lanes and one fictional KT-001 completion; stale state is read-only, and Permission Denied shows `kitchen.operate`. The shared selector claims only `ordering.operate` is missing but denies Kitchen, Dining and Pickup, whose Registry permissions differ; KT-002 remains locked and its freshness SLA unavailable | `KitchenBoardPages.tsx` groups by station, filters loaded work by station/state/allergen cue/exception, and protects command intent/operator locks; WP-2402 records browser evidence at 1440/720/390/320 for Store-switch, lookup, keyboard and command states, verifies 44×44 controls, aligns reviewed typography, and inspects Queue/Work Item at actual Chrome 200% zoom | Opaque Order/Ticket lookup, responsive control sizes and reviewed typography are covered. Physical-device touch, screen-reader/full WCAG, source-backed course/priority/overdue, Accepted Screen and live KDS/device acceptance remain open                                                            |
| Dining — `DIN-FLOOR-BOARD`, `DIN-SESSION-DETAIL` | Area-grouped fictional tables and selected Session; observed T-02 case includes an unpaid Order close blocker                                                                                                                                                                                                               | `/operations/dining` groups the authorized table source by area, filters table/area/state, shows selected-table detail, and preserves Session start, one-time-code recovery and Host Transfer; latest 1440/390/320 screenshots were reopened                                                                                                                                 | Elapsed/owner, Order and Payment summaries, reservation/waitlist handoff and attention fields/filters are absent from the current source. Make did not establish those fields or a full Session command journey                                                                                        |
| Inventory — `INV-STOCK-OVERVIEW`                 | Current Make project Code/source access is readable and manually editable; AI generation remains quota-gated. No Inventory-specific Make screen was reconciled                                                                                                                                                              | `/operations/inventory` now adopts a source-limited Operations hierarchy at 1440/390/320; balances, alerts, scope and filters remain unavailable; Figma Review frames `64:2`/`64:55`/`64:107` show the same safe field hierarchy                                                                                                                                             | The authorized overview query/projection and phase capability are absent; Stock Scope, ledger balances, freshness, alerts and commands remain unavailable. Inventory value remains separately gated                                                                                                    |
| Pickup — `FUL-PICKUP-QUEUE`                      | Preview has seven fictional cards/six active; page-local Order-number search was added and verified: PU-007 returns one row, no match returns the empty state, Clear restores seven. PU-007 still has unknown quantity; earlier PU-001 verification/retry branches are distinct                                             | `PickupPages.tsx` supplies current-page public-reference/phase/wait/claim/exception filters, source refresh and existing proof/server-confirmed handoff; Overdue is visibly unavailable without an authorized due time; filtered-out cards remain mounted for exact Unknown proof retry                                                                                      | Registry Claim and Report Exception commands are not composed; keep unavailable until Task/source mapping and authorized owner command exists. Overdue needs an accepted due-time source. More Make screen states and full-page accessibility/layout acceptance remain open                            |
| Exceptions — `OPS-ORDER-EXCEPTION`               | Fresh Version29 Preview shows four fictional rows and Type/Severity/Status/Owner filters; its copy explicitly marks Provider state, overdue SLA and safe public references unavailable. Scenario Browser has Pickup outcomes and global Order states, but no Exception-specific failure/conflict/unknown retry              | `OrderExceptionPage.tsx` displays Created/due times, filters type/severity/status/owner/Provider/overdue; global authorized Store switch remounts and reloads the selected scope (covered by the production E2E); internal references stay masked and Payment follow-up remains separate                                                                                     | Safe public-reference search, Payment/Dining refs, assigned-owner identity, general case timeline, and generic acknowledge/assign/resolve routes need owner contracts. Make action failure/retry branches remain absent; source-owned financial finality and full-page keyboard acceptance remain open |

Local Exception keyboard evidence now traverses Type, Severity, Status, Owner, Provider state,
Overdue and Clear in sequence. Typeahead selects each native filter, Space toggles the overdue
checkbox, and Enter clears every control. Synthetic rows verify empty and restored results.
This focused filter path does not establish full-page accessibility or live Exception behavior.

The source-specific compensation-reconciliation path also has keyboard E2Es for Review,
operator confirmation, submission, Unknown and same-intent Retry. Focus returns to Retry only
when the browser dropped it to the page body; focus moved to another control stays there.
The routes are intercepted fixtures, and this does not establish full-page accessibility or
live financial behavior.

Pickup proof verification now has a keyboard E2E for opening the form, submitting the exact
credential, and retrying the same Unknown operation. It preserves focus in page search when the
operator moves there during a pending request, and returns focus to Retry after a second Unknown
only when the browser dropped it to the body. Three intercepted requests carry the same body;
this remains synthetic proof behavior, not actual handoff or fulfillment evidence.

Pickup queue keyboard coverage now also exercises native Waiting filter typeahead, sequential
Tab navigation through Claim and Exception to Clear, Enter to clear, and Space to toggle
Include completed. The page refresh moves focus to Refresh after the completed-inclusive query
loads. This is focused synthetic browser coverage, not full-page accessibility or proof of an
authoritative Fulfillment Overdue policy.

Make Orders follow-up: synthetic DEMO-1007 exercised Unknown → Retry acceptance and showed
an explicit uncertain outcome followed by a simulated Accepted confirmation; duplicate
submission is blocked while retry is pending. Stale/Offline displays its snapshot and
disables Accept; Command failed says the order is unchanged and requires Refresh. After the
Unknown → Refresh path, the mock returns a new version still Not accepted and re-enables
Accept, which does not establish the prior operation's finality/idempotency and remains a
Make reconciliation question. Restoring Normal returned all eight original demo rows.
These actions changed only unpersisted fictional state.

Make Exceptions follow-up: the current Version29 type filter leaves fictional EXC-001, and
activating Clear filters with Enter restores all four rows. Its detail states Payment is
unreconciled, the source is not finalised, the evidence summary is absent, acknowledgement
and assignment are simulated, and Resolve is gated on finality/evidence. No simulated
action was invoked; this proves only the preview's local presentation.

Make responsive follow-up used Preview options → Viewport → Custom. At 1440×956 both
pages show their desktop work areas. At 390×844 and 320×720, Pickup uses a compact shell,
search field and single-column cards, with measured body/client widths of 391/391 and
320/320. Exceptions wraps filters into two columns and stacks cards at both configured
viewports; visual inspection found no horizontal clipping, though frame metrics were
unavailable after route change. A follow-up hides the prototype-owned Spec pill at widths
up to 640px: PU-007's Ready status is unobscured at 320px, all seven Pickup cards/statuses
fit at 390px, and the Spec entry remains at 1440px with corrected simulated-action/source-
gate copy. Make Preview keyboard coverage remains limited to Pickup search/clear and
Exceptions type/clear. The local Merchant Pickup E2E now separately covers keyboard
verification, exact same-operation retry, handoff confirmation and focus recovery after
success and rejection; its intercepted responses remain synthetic. The Make draft remains
private and all rows fictional.

This crosswalk resolves the old literal TBD navigation status at the route-presence
level only: all five Operations entries have been observed in the prototype, and the four
former TBD areas now have demo screens. It does not resolve every Registry field/action,
prove parity with local code, certify production behavior, or complete Make acceptance.
Continue local changes where an accepted owner contract permits them. Current Make access
supports manual Code-view edits with reload persistence, while AI generation remains
quota-gated and the latest documented MCP source-resource read returned `Unknown resource`.
The global Permission
denied scenario still describes only missing `ordering.operate`,
although denial is applied across Kitchen, Dining, Pickup and Exceptions with distinct
Registry permissions. Keep source-data, Task mapping and launch gates explicit until
authoritative evidence resolves them.

Orders rate-limit follow-up (2026-09-23): the current private Version29 draft now presents
an explicitly simulated five-second Retry-After countdown and enables a manual retry only
after it expires. Preview showed the control disabled during cooldown and enabled after
the delay; it was not clicked, and Normal was restored with all eight fictional rows.
This fills the prototype's missing visible retry-delay affordance only. The countdown value
is not an observed HTTP header or production policy; command-pending timeout-to-unknown and
broader Make route/state/accessibility coverage remain open.

Orders pending-timeout follow-up (2026-09-23): `Command pending` now reaches the existing
Unknown presentation after its simulated response delay instead of incorrectly reporting
Accepted. Preview showed the submitting/duplicate-blocked state, then an uncertain
not-failure message with explicit Refresh and Retry controls; neither was invoked, and
Normal restored all eight demo rows. This closes only that visible Make scenario mismatch.
It does not establish a production timeout, source result or durable idempotency.

Dining Make filter follow-up (2026-09-23): the private Version29 floor now has local
search by table/Session, Area, state and attention-only filters, plus an explicit demo-row
count, empty state and keyboard-operable Clear filters. Verified search, combined filters,
empty/clear, and 320×720 wrapping (44px controls; no visible horizontal overflow). This
addresses the observed lack of floor filters only. Data and Session details are fictional;
no business action or publish/share occurred. Full Registry action/field, broader viewport
and failure coverage, and Make acceptance remain open.

Pickup Make follow-up (2026-09-23): the private Version29 Pickup preview now filters the
seven fictional cards by their existing Ready/In Progress/Completed/Cancelled status and
combines that with Order-number search. PU-004 is the sole In Progress row; adding a PU-002
search yields the empty state; keyboard Clear filters restores all seven. The 390px custom
preview showed no horizontal clipping. Claim and exception fields remain explicitly
unavailable in this source, and no pickup action was invoked. This is synthetic UI evidence
only; safe source mapping and full Make acceptance remain open.

Exceptions Make keyboard follow-up (2026-09-23): Critical + Assigned returned the explicit
empty state; keyboard Clear filters restored all four fictional rows. The 390px preview
showed a two-column filter layout and stacked cards without visible clipping. Provider
state, overdue SLA and safe public references remain unavailable, and no exception action
was invoked. Preview-only evidence; source-owned reconciliation/finality and Make acceptance
remain open.

Orders Figma Design continuation (2026-09-23): the shared Operations Queues review page also
contains source-limited `OPS-ORDER-QUEUE` examples at 1440/390/320. The local Order queue uses
the same black/white shell header; existing exact search, loaded-page filters, compact native
disclosures and mutation recovery remain intact. Its focused synthetic production journey passes
3/3 and fresh screenshots were inspected without horizontal overflow. Server-side search and
Registry-required Payment/Kitchen/overdue/exception/claim facets, full Make acceptance and live
Store evidence remain open.

Pickup visual continuation (2026-09-23): a separate Figma Design review page now holds synthetic
Pickup Queue examples at desktop, 390px and 320px. The repository page uses its black header and
neutral queue/card hierarchy while preserving the existing `FUL-PICKUP-QUEUE` projection, filters,
proof and confirmed-handoff behavior. The production-fail-closed synthetic journey passes with
fresh 1440/390/320 screenshots inspected for overflow. This does not close Figma Make editor/write
access, source-bound Claim/Report exception composition, the missing Pickup due-time source, live
Store evidence, full Screen acceptance or any production gate.

Kitchen Make follow-up (2026-09-23): Version29 now filters its fictional station lanes by
existing ticket state (Queued, Held, In Progress, Completed, Cancelled). In Progress showed
KT-002; Completed showed existing completed ticket(s); All restored the full queue. At
320×720 the station tabs remain horizontally scrollable with a 44px state selector; at
1440×956 the selector sits above all five lanes. Course/priority/overdue rules, allergen
facts and safe-reference search remain unresolved rather than invented. No ticket action,
publish or share occurred; the preview remains synthetic.

Dining browser rerun (2026-09-23): the existing production-fail-closed session-start E2E
passed 1/1 after confirming the 13rem grid track cap and ≤216px geometry assertion. Its
keyboard, filter/empty-state, initial/refresh read count, same-operation retry, one-time
code recovery, and 1440/390/320 overflow checks passed. All three newly generated screenshots
were reopened; the single desktop tile is compact next to the detail panel and mobile board
and detail stack without horizontal overflow. This is synthetic intercepted-response
evidence, not Store acceptance. No source changed for this rerun. Proceed with the open
Pickup and Exceptions source/action reconciliation and remaining Make TBD/coverage work,
then continue the whole-project release-gap inventory; no overall completion or release
approval follows from this browser pass.

Make responsive/keyboard continuation (2026-09-23): freshly inspected the authenticated
Version29 Pickup and Exceptions previews at the configured 320×720 width. Pickup In Progress
showed PU-004; combined search for PU-002 returned the explicit empty state; keyboard Enter
on Clear restored six active/seven shown. Exceptions Critical + Assigned returned zero
rows; keyboard Enter on Clear restored all four. The screenshots show Pickup's single-column
cards and Exceptions' two-column filters/single-column cards without visible horizontal
clipping; the current 1440px Exceptions view also fits the full filter grid and rows. These
remain synthetic local filters. Pickup Claim/exception and Exceptions Provider, overdue,
public-reference search and generic action mapping remain unresolved. No business action,
source edit, share or publish occurred; Make AI credits are still unavailable until Sep 30.

Exception filtered-empty correction (2026-09-23): final source review found the local
workbench reused its “no exceptions in this view” message after active filters excluded all
loaded rows. It now reports “No exceptions match these filters” and offers Clear guidance,
while preserving the source-empty message for a truly empty Store result. The existing
full-backlog browser journey asserts both the empty heading and guidance; it passes 1/1
against intercepted synthetic data. Merchant typecheck, targeted ESLint, Prettier and
`git diff --check` pass. Fresh 390/320 screenshots show the copy wrapping without horizontal
overflow. This display correction does not implement safe public-reference
search or generic Task/financial actions, and it establishes no Store or Provider fact.

Make QR-origin customer route follow-up (2026-09-23): the private Preview root shows a
fictional T-07 Dine-in context, Open hours and an explicit simulated/no-real-orders notice;
following `View menu` reaches `/menu`, where the header retains table/channel context and the
cart is empty. The menu shows fictional CAD prices. The 1440 layout uses a wide card grid;
390×844 and 320×720 show two-column item cards. Category chips extend past the visible edge;
their scroll and keyboard behavior were not verified. No item or Cart/Quote/Checkout/Payment
action was invoked. This confirms route and shell continuity only, not QR authority, source
freshness, Customer Feature Disabled behavior or full CUST-MENU acceptance. The Operations
nav is a separate five-route Make surface; Communication History is not in its current
route set and remains gated by the Notification source/activation decision recorded above.

Current Chrome Make access/Customer-denial recheck (2026-09-23): the linked Version29 file
opens its Preview, but this browser session's left pane shows “Sign up to use Figma Make”
and disabled AI Prompt/Send; editable Code view was not available in this session. Earlier
authenticated Code-view edits remain recorded evidence of that earlier session and are not
recast as current access. In the synthetic `Permission Denied` Customer scenario, activating
`View menu` briefly showed `Verifying…` then returned to the ordinary T-07 entry without a
visible explanation/recovery. This differs from the separate `QR Denied` scenario, which
shows an access-denied/staff-assistance message. Neither outcome establishes production
authorization behavior. Keep Session permission-denial presentation open for Make review;
preserve the accepted uniform QR-entry failure contract and do not add cause-specific
production messaging from this preview.

Menu-state parity follow-up (2026-09-23): rechecked the synthetic `Menu Empty` and `Menu
Error` routes. Empty retained the fictional menu shell and category/filter controls with
“No items available right now.” Error showed retry/staff advice as text only, with no
retry/staff action in the screenshot or accessibility tree. The repository PWA's Menu
Unavailable/Offline/Stale branches include a `Try again` button, and its empty branch has
separate published-menu copy. This is a Make presentation/recovery gap; it is not evidence
of a real Menu failure and does not imply a repository behavior change. Follow up in Make
when editable Code view is available; current Chrome session is sign-up gated.

Make Customer category keyboard follow-up (2026-09-23): in the readable private Version29
`/menu` Preview, selecting Mains showed only that section. Tab from Mains moved focus to Sides;
Enter selected Sides and showed its three fictional items, with focus remaining on the tab.
The narrow Preview screenshot shows the horizontal category row clipped while the focused
tab remains visible. Sequential Tab/Enter works through Sides; ArrowRight from Mains did not
change selection. Roving-arrow navigation, automatic horizontal scrolling, every category,
and full CUST-MENU acceptance remain open.
The current editor is sign-up gated, so no source edit was possible. No item or order flow was
invoked. This is synthetic presentation evidence only.

Repository comparison for the Make category finding (2026-09-23): local `CUST-MENU` does not
implement these categories as a tablist. `MenuPage.tsx` renders a labelled navigation list of
anchor links to each section heading, so native Tab/Enter link behavior is the repository
interaction contract; a roving-arrow expectation from Make's tab-style chips does not apply.
The local `.menu-sections` styles allow wrapping and links have 44px minimum height. This is a
source comparison only; rendered keyboard focus, zoom and narrow-screen acceptance for the
Customer route remain open. No application source changed in this review.

This distinction narrows only the Make/repository keyboard comparison. It does not close the
Make preview's clipped category row, nor certify local rendered focus, zoom or narrow-screen
behavior. Preserve those as separate Make and repository acceptance questions.

Downloaded Make source verification continuation (2026-09-23): a fresh Version29 code ZIP
was checked in an isolated local copy (SHA256 `68932276586297bacd261f06b82b60447007bfead53226dfd1d700b568a810c0`). Its Customer source now has an explicit transition clock and direct production-transition test import; exact expiry is covered. Two unrelated DiningWorkspace syntax errors in the ZIP were corrected only in that local copy. Full `tsc --noEmit`, 189/189 logic tests, and Vite build passed; build retains its 525.91 kB chunk warning. These checks and hashes identify the ZIP/review copy only. No source was uploaded or changed remotely, so Make write-back and fresh Preview acceptance remain open. All records and outcomes remain fictional.

Make Customer transition source check (2026-09-23): the latest private Version29 session
opens both Preview and Code view; AI Prompt/Send report exhausted team credits until
2026-09-30. The visible `src/customer/CustomerApp.tsx` imports the six transition functions
from `./transitions`, so the application handlers do call the new production module. The
Make conversation reports 170 passing tests and 11 new Customer-transition cases. A read-only
scroll through the full `src/logic.test.mjs` editor buffer confirms its import from
`./customer/transitions.ts`, with direct calls to the same six functions imported by
`CustomerApp.tsx`. The visible new cases cover pending/unknown mutation guards, duplicate-result
protection, expiry, scope mismatch/recovery, committed-item snapshots, command failure and
terminal-history preservation. The Make test/build report was not independently executed.
Source inspection also found that `canWrite` defaults its clock to `Date.now()`: several
transition functions call it without a supplied clock, and their app handlers call those
functions inside React state updaters. `applyRequote` receives a captured clock but does not
pass it into `canWrite`. The explicit-clock requirement remains open; no Make code changed.
This was observed read-only;
no Make source changed and no Make test command was run. Do not conflate this prototype
source evidence with the repository's Customer PWA tests.

Make explicit-clock source recheck (2026-09-23): opened the private Version29 Code view in
the current in-app browser and selected `src/customer/transitions.ts`. The editor source
confirms `applyRequote` still defaults `nowMs` to `Date.now()`, and its `canWrite` call
omits that captured value. `applyCartChange`, `applyTipChange` and `applyContinueOrdering`
also call `canWrite` without an explicit clock; the visible `applyCartChange` guard and
`applyRequote` implementation therefore do not meet the prior pure-clock requirement.
The AI prompt remains disabled until the team credit reset, while Code view is readable.
No source was changed and no Make test/build was run. Treat the earlier chat report of a
pure-clock refactor as unverified and keep this correction open; all behavior remains
fictional preview behavior, not production evidence.

Make latest-export follow-up (2026-09-23): exported the subsequent private Version29 ZIP (4),
SHA256 `defe70d6371244636ef21a668e2d840d5dbd52118e7e734730ca1d0345e70080`. It includes the
named DiningWorkspace types, and `tsc --noEmit`, `tsx --test src/logic.test.mjs` (189/189) and
`vite build` pass against this exact extracted artifact; build warns that its 525.98 kB JS chunk
exceeds the current advisory limit. `oxfmt --check` still fails only `CustomerApp/pureLogic.ts`
and `logic.test.mjs`; CustomerApp, DiningWorkspace and transitions pass. `handlePaymentSubmit`
still calls `Date.now()` separately for its guard and intent clock, leaving a boundary
inconsistency open. This updates only the ZIP (3) source/test evidence above; no source was
uploaded, published or shared, all data remains synthetic, and production acceptance plus
Make-wide Screen/keyboard/responsive coverage remain open.

Current continuation evidence (2026-09-23): the latest repository Dining rerun passes its
focused production-fail-closed session-start journey and freshly inspected 1440/390/320
screenshots confirm the existing 13rem table-tile cap and narrow-screen reflow. WP-2402 now
also records Pickup handoff terminal focus after success/rejection and Exception
acknowledgment focus after recorded completion, including preserving focus moved during an
unknown request. The Exception client parser now rejects impossible calendar dates in its
Store Business Date while accepting a real leap day. These checks do not establish the
server's Store-day source, timezone configuration or live Exception behavior. The focused
Pickup/Exception journeys use intercepted synthetic responses; they do not
close Claim/report-exception/Task mapping, Overdue policy, Payment/Provider finality,
whole-page accessibility or live Store acceptance. The Make editor is currently sign-up
gated, so preview TBD routes have screens but the documented global permission-copy mismatch
and remaining Make acceptance cannot be edited or closed from current access. The pilot
integration inventory and explicit owner/release evidence rows remain authoritative for
production go/no-go; these local UI reruns do not advance them.

Dining Figma shell continuation (2026-09-23): a new screenshot review found that the previous
local Dining page still had its old two-tier header and no session navigation. The route now
uses the shared Operations Queues header/sidebar hierarchy, with only current-session navigation
rendered. The focused session-start journey passes and fresh 1440/390/320 screenshots show the
desktop sidebar and narrow-screen reflow with no page overflow. The navigation DTO does not
include `DIN-FLOOR-BOARD`; no local grant or Screen ID union was invented. The current view remains
limited to its real Table/Session source; Registry-required parties, Orders, payments, reservations,
elapsed time and attention fields remain absent. This is shared visual direction, not an accepted
Dining Figma frame or Make write-back. See WP-2402 for command and screenshot evidence.

Make submission-clock correction and current source checks (2026-09-23): the private Customer
submit handler now captures one `nowMs` and uses it for both the submit guard and immutable
intent. `CustomerApp.tsx` and `pureLogic.ts` were formatted in Code view; the formatter's
`keyof CustomerScope[]` rewrite was corrected to `ReadonlyArray<keyof CustomerScope>`. The
subsequent exported artifact (SHA256
`233128ee046f10ab5ae655ba218ecdb28b61f451c7eafbda7e4523fed9deacc7`) passes `tsc --noEmit`,
189/189 direct logic tests and Vite build; the build keeps its existing 525.97 kB chunk warning.
`oxfmt --check` now fails only `src/logic.test.mjs`; the editor exposes no Format code control
for that file. This closes the earlier duplicate-clock issue in the exported source, not the
other remaining Make or production gaps. The exported preview values are synthetic; no
publishing or sharing occurred.

Kitchen Figma Design implementation (2026-09-23): the Owner asked to continue the whole project
and apply the available Figma direction. A separate review file,
[BOP-RMS Kitchen Queue](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=4-2), now
contains 1440, 390 and 320 queue layouts plus the mobile filter-sheet state. Its visual hierarchy
is implemented in the local `/operations/kitchen` route. Session-validated navigation is rendered
from the current authorized workspace list, and the source projection still controls visible data
and command states. The complete focused Kitchen render/browser/type/lint/format checks pass;
synthetic browser screenshots were inspected at all three widths. This is a local review design
and UI migration, not an Accepted Screen baseline, real Store/Operator evidence or whole-project
completion. Figma Make Version29's editor/write gate, unavailable Kitchen reference/course/
priority/SLA/claim/hold sources, the other repository composition gaps and pilot production gates
remain open.

Exception Workbench visual continuation (2026-09-23): the shared review page also includes
source-limited `OPS-ORDER-EXCEPTION` frames at 1440/390/320. Its card keeps the Order display
unavailable, shows Provider/compensation/owner states and calls out unavailable generic actions.
The local screen uses the black header and neutral filters/cards; a longest-option select overflow
was fixed by constraining it to the filter column. The 12-case production-fail-closed journey,
focused render tests and screenshot inspection pass. This does not implement Task
acknowledgment/assignment or exception closure, prove Payment/Provider/Store outcomes, or complete
Make and production acceptance.

Private Figma Make access recheck (2026-09-23): the current account opens the private
`High-Fidelity Restaurant Order Prototype`, its `/operations/dining` preview, and the Make Code
view. The Code view lists project files and opens `src/components/DiningWorkspace.tsx` in a
settable text editor. No source was changed, so durable manual-write permission remains untested;
the AI prompt is disabled until its displayed September 30 credit reset. The preview uses
synthetic `Occupied`, session-age and attention cues that do not exist in the authorized Dining
table projection. Keep those out of the repository UI until Handoff/Registry and the owning
projection supply them. The regular Operations Queues Figma page holds the adapted Review frames;
no Make edit, publish or share occurred.

Recipe administration design continuation (2026-09-23): the persistent Operations Queues Figma
page now also contains `RECIPE-LIST` and `RECIPE-EDITOR` review frames at 1440/390/320
([Recipe list desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=27-2),
[Recipe editor desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=27-74)). The
frames preserve Registry phase and permission context, show source values as unavailable, and
leave edit/publish commands unavailable. The compact warning overlap was corrected and all six
frames inspected. This is visual review progress only; the normal Recipe route and authorized
cross-domain source composition remain unavailable, so the Recipe UI is not complete.

Recipe source recheck (2026-09-25): the current facts port has no source identity/version,
coverage time or invalidation revision; the inspected Inventory, Supplier and allergen readers
are not Recipe-scoped versioned feeds, and no commit-ordered Brand-wide checkpoint producer or
Recipe admin-projection consumer is implemented. Wiring those readers directly would not prove
freshness or coverage. Keep builder persistence, authorized query and the normal route open until
the accepted source-version/checkpoint contract is implemented. The exact repository evidence and
WP-2402 documentation-only verification are recorded in the
[Recipe ordering design](../spec/design/recipe-admin-projection-ordering.md#wp-2402-repository-source-inventory-2026-09-25).

Reporting catalog Figma review (2026-09-23): the Operations Queues Figma page now contains
`RPT-REPORT-CATALOG` desktop/390/320 review frames. They retain the BOP Operations shell,
Registry catalog filters and fields, show an unavailable authorized-source state, and keep
unsupported actions disabled. All three screenshots were inspected for responsive fit. This
does not wire the normal route or close WP-2161/WP-2162; the report catalog, builder and run
history still need authorized BI query/command composition.

Kitchen Figma hierarchy correction (2026-09-23): visual comparison of the Figma desktop/mobile
frames with local screenshots found a remaining mismatch in the local AppFrame header and page
heading despite the earlier responsive/action checks. The Kitchen route now adopts the Figma
`BOP / OPERATIONS` header, `Kitchen` page title, queue eyebrow/section, compact desktop filters and
soft full-width mobile filter entry. It retains the actual selected Store label, session-authorized
navigation, projection freshness/time, privacy omissions and command gates. Fresh component tests,
Merchant typecheck/lint/format, and the production preview E2E pass; inspected 1440/390/320 captures
have no horizontal overflow. This corrects the earlier overstatement that the visual migration was
already fully aligned. It still uses synthetic browser responses and does not supply Kitchen's
missing public references, course, priority, SLA, claim/exception sources or named-session command
fence.

Kitchen Figma source-truth recheck (2026-09-23): a fresh Figma render exposed stale desktop footer
copy claiming actions were enabled. The desktop/mobile review frames now show a prominent
read-only board explanation, disabled actions, and matching unavailable-source language; the
desktop navigation position was corrected after layout insertion. Fresh 1440/390/320 Design
renders and existing current-checkout browser screenshots were visually inspected. This fixes
the review artifact's semantic mismatch but does not add the owner-backed KDS session/lock source
or the server-side command fence; no live operator or Store acceptance follows from the renders.

Dining Figma migration recheck (2026-09-23): fresh source comparison against `DIN-FLOOR-BOARD`
and Handoff 88.11 confirms the local page keeps to the current StaffDiningTable facts and makes
missing Order/payment/reservation/waitlist/elapsed fields explicit. Its existing production-
fail-closed journey passes 1/1 and freshly captures 1440/390/320; all three screenshots were
inspected for the Figma hierarchy, mobile reflow and overflow. The interactions and rows are
synthetic fixtures, so this does not prove live Store acceptance or close the owning full-floor
projection gap.

Recipe Review visual migration (2026-09-23): the accessible Operations Queues Figma design's
Commerce/Review header, Phase labels, source-limit callouts and vertical Recipe sections are now
represented in the repository's existing Recipe pages. The unavailable list/editor routes show
no synthetic sample rows, preserve navigation, and keep write actions absent/disabled. Focused
component, type, lint/format checks pass; a fresh production-fail-closed browser run captured and
inspected list/editor at 1440/390/320 without overflow or overlap. Normal-route Recipe reads and
authorized cross-domain projection sources remain unavailable, so this visual migration does not
close Recipe workflow acceptance.

Reporting Catalog visual migration (2026-09-23): the existing Operations Queues Figma
`RPT-REPORT-CATALOG` Review hierarchy is now represented in `/app/reports`. The route shows
the Operations shell, Registry filters and catalog columns, an authorized-source unavailable
state, and disabled unsupported actions. It omits fixed workspace navigation without a
permission-trimmed navigation input and omits opaque owner references. Focused component,
type, lint/format checks pass; a fresh production-fail-closed browser run captured and
inspected 1440/390/320 with no overflow. The normal BI catalog/query and owner display
projection, builder, run history and authenticated commands remain uncomposed, so this is
not reporting workflow acceptance or whole-project completion.

Kitchen Review responsive refinement (2026-09-23): fresh comparison of Figma nodes `4:2`,
`4:86` and `4:128` with current local captures found the shared StatePanel default left the
read-only notice much taller than the Review design and the mobile Filters trigger followed it.
Scoped Kitchen styles now use the compact accent notice; a dedicated mobile trigger appears after
the page header and before the notice, with the redundant mobile Queue heading hidden. The source
boundary note follows the cards. Focused Kitchen tests pass 7/7, typecheck and targeted lint/format
pass, and the production-fail-closed journey passes 2/2 with fresh 1440/390/320 screenshot review.
This is visual parity work only. Projection-safe public refs, course, priority, SLA/overdue,
Claim/Hold/Prioritize source commands and the server-enforced named KDS session/device lock remain
gaps; intercepted rows remain synthetic.

Communication History visual continuation (2026-09-23): source-limited Design Review frames were
added to the existing Operations Queues Figma file at `47:2`/`47:66`/`47:123` and inspected at
1440/390/320. The private Make artifact remained unavailable; no Make publishing or sharing
changed. The local history page now follows the Inter/neutral hierarchy, keeps all filters disabled
when the authorized projection is unavailable, shows explicit unavailable-source/action states,
and omits opaque request/source/template UUIDs. Focused page tests pass 5/5, Merchant typecheck,
targeted lint/format and whitespace checks pass; the production-fail-closed Playwright journey
passes 1/1 and the screenshots show no horizontal overflow. Normal Notification persistence,
history client, safe source-reference projection and authorized resend/suppression/template
commands are still missing; WP-2145 and project acceptance remain open.

Kitchen Figma/source projection continuation (2026-09-23): reread the current `KIT-KITCHEN-QUEUE`
Review frames `4:2`, `4:86`, `4:128` and Registry 88.10. The authorized queue projection includes
`createdAt`/`projectedAt` (supporting display age as of projection time) and an opaque Station
reference, but no safe Station name; Course, Priority, SLA/overdue, Claim, Hold and Exception
sources remain marked unavailable. The Merchant client previously mapped every opaque Station ref
to the same “Station name unavailable” string, merging distinct records into a misleading lane and
leaving a nonfunctional Station filter. It now represents missing labels as null, groups rows under
“Station labels unavailable,” and disables Station filtering if any current row lacks a safe
label, so filtering cannot silently hide work whose Station is unknown. Focused
Kitchen parser/client/render tests pass 22/22, Merchant typecheck, targeted ESLint/Prettier and
whitespace checks pass; the production-fail-closed Kitchen journey passes 2/2. Fresh 1440/390/320
captures were inspected and preserve the Figma hierarchy without horizontal overflow. This is a UI
projection-honesty correction; Store responses are synthetic, and the Station display projection,
named KDS Session/visibility-lock command fence, operational lifecycle/UAT and other project gaps
remain unresolved.

Kitchen detail Figma continuation (2026-09-23): KIT-WORK-ITEM now carries the verified same-query
projection metadata into its local screen, calculates work age as of `projectedAt`, and renders
through the current Store's authorized Operations navigation for success and unavailable states.
The duplicate fixed refresh action found in initial screenshot review was removed. Recipe/handling,
allergen acknowledgements, timers, dependencies, work history and authenticated detail commands
remain unavailable and visibly gated. Focused tests pass 22/22, Merchant typecheck/lint/format and
`git diff --check` pass, and the production-fail-closed Kitchen journey passes 2/2. Inspected fresh
1440/390/320 queue/detail captures show no horizontal overflow or duplicate refresh action. Browser
responses are synthetic; the underlying Station display source and server-side named KDS session/
device lock fence remain unimplemented, alongside the wider repository and pilot gates above.

Kitchen child-route continuation (2026-09-23): addressed two local Screen/Handoff gaps surfaced
while applying the Figma queue hierarchy. The Queue now passes validated Station/state/allergen/
exception filter context through router history into KIT-WORK-ITEM and back, including the denied
read state; no Order/item identifier or query parameter was added. Kitchen cards now show only the
state-eligible lifecycle intent supported by execution metadata, omit queue commands from the
read-only detail card, identify missing lifecycle metadata truthfully, and use readable Quantity,
allergen and exception labels. Focused Kitchen tests pass 22/22, Merchant typecheck/lint/format and
`git diff --check` pass, and the production-fail-closed journey passes 2/2 with existing command,
conflict, denial and responsive cases. Fresh 1440/390/320 Queue/detail screenshots were inspected.
This remains local Merchant UI over synthetic browser responses; the dedicated
`kitchen_work_item_detail_v1`, safety/Recipe/history fields, Station display source, named KDS
Session/device lock server fence, and full Kitchen UAT remain open.

Kitchen detail responsive follow-up (2026-09-23): a fresh comparison against the added
`KIT-WORK-ITEM` Review frames found Queue-only mobile heading-grid styles had reversed the
detail's Screen ID/title order and the route's Return/Refresh actions stayed intrinsic width.
The styles are now Queue-scoped; at 390/320 the detail retains Screen ID then title and uses a
full-width action column. Production-fail-closed browser assertions verify the order at
1440/390/320 and action widths at 390/320; the Kitchen journey passes 2/2, focused tests pass
22/22, and Merchant typecheck/lint/format/diff checks pass. Fresh screenshots were inspected.
This closes two local visual differences only; projection/source/session/UAT gaps above remain.

Kitchen mobile filter-sheet keyboard and Figma continuation (2026-09-23): comparison with
Review node `8:8` found that a later shared responsive rule had collapsed the local two-column
mobile filter sheet to one column, split Clear/Done actions across rows and left its source note
outside the modal. Keyboard review also found initial focus did not enter the native dialog.
The sheet now restores its two-column field/action layout, shows its field labels and source note,
opens with focus in the first enabled field and restores focus on Escape. Focused render tests pass
8/8; Merchant typecheck, targeted lint/format and diff checks pass; both existing Kitchen
production-fail-closed journeys pass 2/2. Fresh desktop/390/320 board screenshots and 390/320
open-sheet captures were inspected. Store values and command outcomes remain synthetic; public
references, course/priority/SLA, supported Kitchen task actions and owner-backed named KDS
Session/device-lock enforcement remain gaps.

Loyalty Programs Design Review (2026-09-23): added source-limited `LOY-PROGRAM-LIST`
frames to the existing Operations Queues Figma Design file at `56:2`, `56:66` and `56:123`,
then inspected rendered 1440/390/320 views ([desktop frame](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=56-2)). They reuse the established neutral BOP hierarchy,
show Registry-defined fields and name/code, status, Store scope and scheduled filters as
unavailable, and contain no fabricated program, membership or points data. This is a Review
artifact only: it has not been migrated into the
local Loyalty route or accepted as the Screen baseline. Phase 3 capability activation, the
authorized `customer_loyalty_*_v1` query/projection and authenticated commands remain open.

Customer receipt responsive actions (2026-09-23): screenshot review of the current
`CUST-RECEIPT-SUPPORT` production-exclusion route found its Print and disabled email actions
touching at narrow widths and the disabled reason exposed only through a title. The actions now
have visible separation, minimum 44px hit targets and a programmatically associated unavailable
reason; 390/320 stacks them, while desktop retains a row. The existing browser journey passes
1/1 with 1440/390/320 geometry and zero-overflow assertions; typecheck, targeted lint, formatting
and diff checks pass. Captures are synthetic, so actual current Pickup Guest receipt rendering
and receipt delivery remain unverified.

Loyalty Programs repository visual continuation selection (2026-09-23): the source-limited regular
Figma Design Review frames `56:2`/`56:66`/`56:123` already show a Phase 3 boundary and unavailable
name/status/Store/scheduled filters. `/app/customers/loyalty-programs` currently renders only the
generic StatePanel when its normal client is unavailable. Align that one state with the Review
hierarchy and explicit disabled fields/actions; retain all other typed error states and do not add
sample program/member/points data. Verify existing render tests, Merchant typecheck, focused lint/
format and a production-fail-closed route journey at 1440/390/320. This is Design Review parity only;
WP-2142's authorized query/projection/commands and Phase 3 activation remain external implementation
gaps.

Loyalty Programs visual migration (2026-09-23): the normal list route now renders the source-limited
Review hierarchy: independent disabled name/code, status, Store-scope and scheduled filters; catalog
field headings and a no-data state; plus an explicit action boundary. It preserves the current
`FeatureDisabled` result as a Phase 3 gate and renders a distinct projection-unavailable message for
`Unavailable`. No sample program, member, points or command data is introduced. Focused page tests
pass 5/5, Merchant typecheck, targeted lint/format pass, and a production-fail-closed journey passes
1/1 with inspected 1440/390/320 captures and no overflow. This is local Review parity; WP-2142's
capability, authorized query/projection and commands remain absent. The previous Design Review
artifact still is not an Accepted Screen baseline.

Dining responsive Design Review refinement (2026-09-23): the editable regular Figma Dining frames
`24:60`/`24:109` were clipping after the third sample table and omitted the mobile Selected table
empty-detail prompt. Their canvases now contain the full clearly labelled Review samples and the
route's initial detail empty state. Final frames were inspected at 390/320; the repository's fresh
production-fail-closed `/operations/dining` journey passes 1/1 and its 1440/390/320 captures were
inspected. The existing route already represents `StaffDiningTable` fields and unavailable Registry
facts faithfully, so no business UI change was appropriate. This regular Design Review is not the
private Make source, an Accepted Screen baseline or Store evidence. Dining owner/elapsed/Order/payment,
reservation/waitlist and attention projection and filter requirements still need the owning query/API;
Make editor/read/write remains sign-up/credit gated.

Merchant Overview visual and scope recheck (2026-09-23): regular Figma Review frames `31:2`/`31:47`/
`31:88` were compared with the normal Merchant route through its fresh production-fail-closed journey,
which passes 1/1. Inspected 1440/390/320 captures confirm the current selected-Store/session snapshot,
permission-trimmed navigation and responsive four-card dashboard boundary. No UI change was needed.
Frame/session values and browser-authorized Stores are synthetic; today metrics, task/exception and
Provider-health projections remain unavailable under WP-1905. This does not establish live Store scope
or current business authorization.

Figma Make access and Purchase Order Review continuation (2026-09-23): the private Make
Operations/Dining preview and Version 29 history remain readable. The current editor UI requires
“Sign up to use Figma Make” and disables its prompt/context/build/model/Send controls. Source-file
resource links are listed by the design-context tool, but the MCP reader rejects the Make `file://`
URI as `Unknown resource`; component source bodies were not freshly read. No source edit, signup,
publish or share occurred. Separately, the regular Operations Queues Design file now contains
`PROC-PO-LIST` Review frames `82:2`/`82:44`/`82:83` at 1440/390/320, and the normal Purchase Order
list's unavailable state follows that visual hierarchy. Its fresh production-fail-closed journey
passes 1/1 with disabled filters, no sample business data and inspected responsive captures. This
does not connect the authorized Procurement projection, commands, Supplier commitment or Inventory
receipt facts; WP-2134 and normal Purchase Order workflow acceptance remain open.

Kitchen verification continuation (2026-09-23): fresh production-fail-closed
`kitchen-queue.spec.ts` passes 2/2; inspected the 1440/390/320 queue and item detail captures and
390/320 filter-sheet captures. The route represents only its available projection and keeps KDS
read-only while operator status is `Unverified`. Regular Figma Design Review detail frames `51:3`
and `51:4` were adjusted to leave 8 px between the design-review sample note and the read-only
notice; the final 390/320 renders were inspected. The queue still cannot display real station labels,
SLA, claim, acknowledgement or named device-lock facts without their owning authorized source.
This is local visual Review work; it does not complete Kitchen acceptance, Make access, or Store/device
readiness.

Kitchen mobile shell parity continuation (2026-09-23): fresh Figma Review frames `4:86`/`4:128`
show `BOP / KITCHEN`, while desktop `4:2` shows `BOP / OPERATIONS`. The normal queue now uses an
optional decorative mobile brand label for `KITCHEN`, preserving the accessible Operations heading,
desktop presentation, current Store label, permission-derived navigation and work-item detail shell.
Focused Kitchen render tests pass 8/8, Merchant typecheck and scoped lint/format pass, and the fresh
production-fail-closed browser journey passes 2/2 with inspected 1440/390/320 screenshots. This is
local parity with editable regular Design Review frames; sample queue content remains synthetic,
Make access remains unresolved and this does not establish accepted-screen, Kitchen owner-source or
live Store/device acceptance.

Reporting Run History Design Review continuation (2026-09-23): added editable regular Figma
frames `90:2`/`90:3`/`90:4` for 1440/390/320 and aligned the normal route's existing
`Unavailable` state with its registered hierarchy. All six filters remain disabled; no run rows,
references/digests, requester IDs, artifacts or action affordances are fabricated. Component tests
pass 13/13, Merchant typecheck/scoped lint/format pass, and the production-fail-closed route journey
passes 1/1 with all three screenshots inspected and no overflow. This is a local Review migration;
the authorized Reporting projection/commands and WP-2162 acceptance remain open, as do private Make
editing and Accepted Screen status.

Report Builder Review continuation (2026-09-23): added regular Design Review frames
`96:90`/`96:174`/`96:258` for 1440/390/320, corrected two compact-canvas overflow/overlap issues,
and migrated the normal route's `Unavailable` state. All 21 registered input fields remain disabled;
no report values, permission result, preview or action is fabricated. Report page tests pass 14/14,
Merchant typecheck/scoped lint/format pass, and the production-fail-closed route journey passes 1/1
with inspected screenshots and no overflow. The WP-2161 authorized Report Builder read/command
composition and Phase 3 feature gate remain open; this does not change private Make availability or
Accepted Screen status.

Privacy Request Design Review continuation (2026-09-23): added regular Review frames
`101:213`/`101:277`/`101:334` for 1440/390/320 and aligned the normal route's actual
`FeatureDisabled` state with its Phase 3 Registry gate. The six registered filters remain disabled;
no case, contact, rights, owner, export or audit data is fabricated. Component tests pass 5/5,
Merchant typecheck/scoped lint/format pass, and the production-fail-closed route journey passes 1/1
with all three screenshots inspected and no overflow. WP-2146's authorized query/Commands, Phase 3
activation, private Make editing and Accepted Screen status remain open.

Kitchen source-parity recheck (2026-09-23): high-resolution Figma node text and fresh 1440/390/320
renders all confirm the Review's KDS status is `unverified`; the earlier thumbnail discrepancy was
not present in the current design. The production-fail-closed Kitchen journey passes 2/2 on the
current uncommitted tree. Fresh 1440/390/320 queue and detail, 390/320 filter-sheet, and 390 command
screenshots were inspected for layout and overflow. Ordinary queue/detail status remains `Unverified`
and read-only. The command screenshot's `Named operator` fixture is synthetic UI/HTTP interception;
the real API still lacks the owner-backed active KDS Session/device-lock source and command fence.
Safe public Order/ticket references, course, priority and overdue/SLA projection fields also remain
unavailable. No live Store/device or production acceptance is established.

Private Make access recheck correction (2026-09-24): the private project now opens in
Chrome without a sign-up gate. Preview, Version 29 history and the Code view are readable;
`src/components/DiningWorkspace.tsx` source is visible in the editor. The MCP source URI
still returns `Unknown resource`. Although the code editor exposes a settable text area,
manual write permission and persistence have not been tested. The AI prompt/context/Send
controls are disabled, with the project showing team AI credits reset Sep 30. This
supersedes the earlier current-session “Sign up” observation; source readability is
confirmed, Make editability remains unverified, and no source, publication or sharing
change occurred. See the exact WP-2402 access recheck for the UI evidence and scope.

Current private Make check (2026-09-24): the preview and Version 29 history still load, and the
design-context tool lists current source resources including Dining. Figma identity shows a Full
seat/admin role on the `yashirq's team` Education plan; the page reports AI credits exhausted until
Sep 30 and disables prompt/context/build/model/Send. Source edit/save persistence remains unverified.
Do not describe the Make source as edited or the screen as completed there.

Catalog Menu list visual continuation (2026-09-23): added source-limited regular Design Review
frames `111:213`/`111:214`/`111:215` at 1440/390/320 and migrated only the ordinary
`/app/commerce/menus` route's existing `Unavailable` state. Search/filters and Create Menu remain
disabled; no Menu, Store, channel, version, placement or validation values are fabricated. Focused
component tests pass 4/4, Merchant typecheck, targeted ESLint/Prettier and whitespace checks pass,
and the fresh production-fail-closed journey passes 1/1 with inspected 1440/390/320 captures and no
overflow. WP-1802's authorized Menu query/BFF/Command envelope and Catalog/UAT evidence remain
unimplemented or unverified; this is not an Accepted Screen or whole-project completion claim.

Inventory Item List visual continuation (2026-09-23): added editable regular Design Review frames
`118:213`/`118:257`/`118:308` at 1440/390/320 and migrated only `/app/supply/items`'s normal
`Unavailable` state. The Phase 2/source boundary, disabled search/filters/Create Item and unavailable
identity, quantity, reorder, Store, usage, supplier and history fields are explicit; no Item or stock
facts are fabricated. The focused Inventory component suite passes 7/7, Merchant typecheck and
targeted ESLint/Prettier and whitespace checks pass, and the production-fail-closed journey passes
1/1 with inspected 1440/390/320 captures and no horizontal overflow. WP-2120 still requires the
authorized Inventory query, explicitly scoped Ledger projection/freshness and enabled owner commands;
the Review frames do not imply their availability or Accepted Screen status.

Kitchen current-state Figma/source revalidation (2026-09-23): reopened Review frames
`4:2`/`4:86`/`4:128` and re-read the API query, client mapper and Screen Registry. The route's
1440/390/320 screenshots match the current Figma hierarchy for projection-backed item label,
lifecycle, age and quantity; opaque station references remain omitted and allergen/exception fields
remain unavailable. Fresh component/client tests pass 22/22, Merchant typecheck, targeted ESLint,
Prettier and whitespace checks pass, and the production-fail-closed Kitchen journey passes 2/2; queue,
detail and mobile filter captures were inspected without overflow or clipping. The preview has the
existing large-chunk warning. Test payloads are synthetic. This adds no live Store, operator, device,
source-coverage, Accepted Screen or production evidence, and no new application/Figma edit was needed.

Exact-worktree regression (2026-09-23): the existing `CI=true pnpm verify` aggregation passed
repository guidance, module/ownership/permission/domain checks, migration catalog/config, database
foundation/helpers, OpenAPI/event catalog and formatting. The first test run stopped with 114
failures/1956 passes and localhost `listen EPERM`. The elevated retry, using the repository-pinned
toolchain through `.local/activate.sh`, removed that socket error but still ended with 110
failures/1960 passes; pilot installation/workload/process tests could not use their local fixtures
and the maintenance exclusion test timed out. The aggregate therefore did not reach Screen Registry
or package build. This full-repository gate remains unresolved; it is not represented as a pass.
Focused screen suites, Kitchen browser journey and Merchant type/lint/format results listed above
remain scoped evidence only.

Remaining exact-worktree contract/build checks (2026-09-23): after the aggregate stopped at its
failing test stage, `CI=true pnpm screen-registry:check && CI=true pnpm build` passed. Registry
validation covers 210 Section 88 records; all 41 package build tasks succeeded, with 37 matching
Turbo cache entries and four executed tasks including changed API/UI/Merchant/Customer PWA builds.
Merchant emits the existing greater-than-500-kB chunk advisory. The root test failures remain open,
so the full `pnpm verify` gate is unresolved.

Catalog Menu Builder visual continuation (2026-09-24): added regular Operations Queues Design Review
frames `123:213`/`123:264`/`123:310` at 1440/390/320, then aligned only the normal builder's
`Unavailable` state. Identity/scope, Menu structure, Validation rail and Publish workflow follow the
Commerce hierarchy, while Menu/placement/validation data and commands remain unavailable. No route
Menu reference or sample Menu facts are displayed. Merchant component tests pass 776/776; typecheck,
lint and the 82-case browser suite pass. The new production-fail-closed builder journey captures and
checks all three widths without overflow; captures were inspected. This remains local Review parity.
The authorized Catalog browser composition, live/UAT data, Accepted Screen and Make edit/save
permission remain unverified; the Make AI controls show reset September 30.

Cross-slice verification continuation before the Menu Builder visual edits (2026-09-24): fresh Linux
frozen installation, 41/41 builds,
41/41 format, lint and typecheck tasks and the 210-record Screen Registry passed. Root Vitest also
passed 110 files / 2070 tests when the exact snapshot ran from container-local Linux storage with
`.local` present. The full `CI=true pnpm verify` on the macOS shared bind-mounted snapshot instead
stopped at root Vitest (7 failures / 2063 passes across three pilot recovery files). Its package test
and database acceptance stages therefore did not execute in the aggregate. Keep this full-project
gate unresolved; local build and browser success do not establish Store/Provider/device/UAT,
Accepted Screen, release or production readiness.

Kitchen projection-filter continuation (2026-09-24): closed a repository-completable source-boundary
gap in the normal Kitchen queue. Station, allergen and exception filters are disabled whenever a
loaded item lacks the relevant value, so unavailable cues cannot make real work disappear behind
an empty filter result. Focused Kitchen tests pass 23/23; Merchant typecheck, scoped lint/format and
the 2-case responsive production-fail-closed Kitchen journey pass, and fresh 1440/390/320 captures
were inspected. Synthetic browser responses are not Store evidence. The current projection still
lacks Station labels, allergen/exception cues, course/priority/overdue, safe display references,
and the KDS session/device lock source; detail Recipe/handling snapshots, acknowledgements, timers,
dependencies and history remain unavailable. These owner/data and external acceptance gaps remain
open alongside the full-project verification and release gates above.

Recovery-test environment classification (2026-09-24): the three recovery owner/resume/takeover
files were rerun on native macOS and all 38 cases failed because the owner safety boundary explicitly
requires Linux and the recovery integration depends on Linux process/`/proc` semantics. Do not treat
that unsupported-host run as a product defect. The pre-UI container-local Linux root run passed
110/2070 tests, but an exact-final-tree Linux `pnpm verify` result is still missing. Docker control
is denied by this task sandbox, so the repository-wide gate stays unresolved.

Exact-snapshot Linux verification continuation (2026-09-24): ran frozen install and `CI=true pnpm
verify` in a disposable container-local Linux copy of the current repository snapshot. Repository
guidance, module/ownership/permission/domain checks, migration catalog/config, database foundation
and helpers, OpenAPI/event catalog, Screen Registry (210 records), formatting, lint, root Vitest
(110 files / 2070 tests) and all 41 Turbo package test tasks passed. The aggregate stopped at
`pnpm audit-record:acceptance` because the container lacks a `docker` executable (`spawn docker
ENOENT`); database acceptance and the aggregate's final build stage did not run. This does not
establish a database acceptance pass or a full `pnpm verify` pass. The earlier 41/41 package build
evidence predates the latest Kitchen UI source change. A current root build is recorded below.

Purchase Requisition list visual continuation (2026-09-24): editable regular Operations Design
Review frames `128:213`/`128:256`/`128:299` cover `PROC-REQUISITION-LIST` at 1440/390/320. The
normal route's default `Unavailable` state now shows its registered request/approval/allocation and
filter hierarchy with disabled controls and no Requisition samples; other typed states and Found
rendering remain unchanged. The production-fail-closed journey passes 1/1 and all three fresh
screenshots were inspected against the Review frames. Focused component tests (4/4), Merchant
typecheck/lint, formatting and whitespace checks pass. A fresh root `CI=true pnpm build` passes all
41 package tasks, with 40 unchanged cache hits and Merchant rebuilt; the known Merchant chunk-size
advisory remains. Procurement query/command integration and the other recorded source, Make, UAT,
Accepted Screen and production gates remain unresolved.

Supplier List visual continuation (2026-09-24): editable regular Operations Design Review frames
`130:213`/`130:256`/`130:299` cover `SUP-SUPPLIER-LIST` at 1440/390/320. The normal route's default
`Unavailable` state now presents source-bound identity, qualification, performance and filter groups
with disabled controls and no Supplier/contact examples; its no-physical-delete rule is visible.
Other typed states and Found rendering remain unchanged. The new production-fail-closed journey
passes 1/1; all three fresh screenshots were inspected against the Review frames. Focused component
tests (4/4), Merchant typecheck/lint, formatting and whitespace checks pass. WP-2131's authorized
projection/query/commands and live Store, Accepted Screen, Make write/save and production evidence
remain unresolved. A subsequent exact-tree `CI=true pnpm build` passes all 41 package tasks (40
unchanged cache hits; Merchant rebuilt); its existing greater-than-500-kB chunk advisory remains.

Supplier query ownership audit (2026-09-25): `packages/rms/procurement/src` contains the Supplier
contract, application service, Domain and unit tests, but no persistence/query adapter. The Merchant
web package exposes a typed projection client and an explicit unavailable client; the repository
search found no Supplier projection composition to connect to the normal List route. Keep the route
source-unavailable until WP-2131 supplies its authorized projection/query composition. Do not fill it
from demo fixtures or another Domain's private tables.

Receiving Discrepancy visual continuation (2026-09-24): editable regular Operations Design Review
frames `132:213`/`132:256`/`132:299` cover `PROC-DISCREPANCY` at 1440/390/320. The normal route's
default `Unavailable` state now shows the authorized case/variance/resolution and filter hierarchy
with disabled controls and no case or permission-trimmed data examples; other typed states and Found
rendering remain unchanged. The production-fail-closed journey passes 1/1 and all three fresh
screenshots were inspected against the Review frames. Focused component tests (5/5), Merchant
typecheck/lint, formatting and whitespace checks pass. WP-2134 source composition/commands, persistent
discrepancy handling, live Store/UAT, Accepted Screen, Make write/save and production gates remain
unresolved. Figma Make's save/persistence permission was not tested and AI generation remains quota-
disabled until the displayed reset date.

Verification follow-up (2026-09-24): the post-Discrepancy current-tree root `CI=true pnpm build`
passes all 41 package tasks (40 cached; Merchant rebuilt), retaining the existing 1,213 kB
JavaScript chunk advisory. Native-host `CI=true pnpm audit-record:acceptance` passes 1 file / 1 test
with local Docker access. The exact-final-tree Linux `pnpm verify` aggregate remains unresolved; this
isolated database pass does not replace it or close Store/Provider, device/UAT, Accepted Screen,
release or production gates.

Kitchen detail Figma parity continuation (2026-09-24): fresh Figma Review frames `51:2`/`51:3`/`51:4`
show the sourced work-item title at left and status/elapsed time at right. The detail-only
`WorkCard` variant now follows that hierarchy without changing queue cards, query fields, actions or
permissions. The production-fail-closed Kitchen journey passes 2/2 at 1440/390/320 with geometry
assertions; fresh queue, detail and mobile filter-sheet screenshots were inspected. Focused Kitchen
tests pass 23/23, Merchant typecheck/lint/Prettier and whitespace checks pass, and the Screen Registry
validates all 210 records. Store-station display labels, structured allergen/exception cues, safe
references, course/priority/SLA, owner-backed KDS session/device lock, and Recipe/handling/timer/
dependency/history detail data remain unavailable in the current authorized source. These browser
fixtures are synthetic; no Accepted Screen, live KDS, Store UAT or production readiness is established.
The subsequent current-tree `CI=true pnpm build` passes all 41 workspace tasks (40 cached; Merchant
rebuilt) and emits the known 1,213.38 kB Merchant JavaScript chunk advisory. The exact-final-tree
Linux `pnpm verify` aggregate remains unresolved.

Dining Make visual migration (2026-09-24): the current private Make project's `/operations/dining`
preview and Code view are accessible in Chrome; the floor sample contains 11 fictional tables and
shows the Make-only table/session search, attention filter, elapsed time and session references.
`src/components/DiningWorkspace.tsx` opens in an editable `contenteditable` code surface, but no
write/save was attempted, so persistence permission is unverified. Figma MCP exposes source links but
reading their `file://figma/make/...` URI returns `Unknown resource`. The AI prompt is disabled for
the displayed team-credit reset on Sep 30. The repository adopts only the Make compact area-grouped
card hierarchy, retaining source-backed table state/capacity/current-session association and the
current confirmation/retry/Host Transfer flow. Unavailable owner, elapsed, Order/Payment,
reservation/waitlist and attention data remain absent. `dining-session-start.spec.ts` passes 1/1 at
1440/390/320; component tests pass 4/4; Merchant typecheck, scoped lint/format and whitespace checks
pass. Fresh responsive captures were inspected. This is local visual migration and synthetic browser
evidence, not a Make edit, Accepted Screen, Store acceptance or full project completion.

Kitchen Figma desktop parity continuation (2026-09-24): freshly read Operations Design Review
nodes `4:2`/`4:86`/`4:128` against the current production-preview captures. The queue heading's
bottom divider and 20px padding plus the shared 24px heading margin left an extra gap before the
read-only notice. The queue-only header now has no divider and a 16px margin; the mobile and
work-item layouts remain unchanged. The production-fail-closed Kitchen journey passes 2/2,
including a new desktop status-to-notice geometry assertion and mobile filter, keyboard and overflow
checks. Focused Kitchen tests pass 23/23, Merchant typecheck and targeted lint/format pass, and the
Screen Registry validates 210 records. The full Merchant workspace passes 106 files / 777 tests,
and a fresh `CI=true pnpm build` passes all 41 workspace tasks (40 cached; Merchant rebuilt) with
the existing 1,213.38 kB bundle advisory. Fresh 1440/390/320 screenshots were inspected. Current
Station labels, allergen and exception cues remain unavailable in the client mapping; review-frame
sample names and work facts were not introduced. Browser data is synthetic. A root Vitest run on
this host is not a valid Linux pilot-maintenance run because the activated Node is 24.18.0 `darwin`
and those test paths require Linux `/proc`; full Linux verification and project acceptance remain open.

Customer and API current-tree revalidation (2026-09-24): Customer PWA full tests pass 54 files /
887 tests; lint, both TypeScript projects and production PWA/service-worker build pass. Its two
production-exclusion browser journeys pass for revoked Order access and inaccessible Receipt
history removal; their HTTP calls are intercepted, so they do not establish live Guest or device
offline acceptance. API full tests pass 183 files / 1844 tests with local loopback access, and API
lint/typecheck/build pass. The first unsandboxed API test invocation timed out on local HTTP;
rerunning the same command with loopback authorization passed. The root Linux `pnpm verify` gate,
actual Store/Provider evidence and production readiness remain unresolved.

Inventory Count List Figma continuation (2026-09-24): editable regular Operations Design Review
frames `136:213`/`136:256`/`136:299` cover `INV-COUNT-LIST` at 1440/390/320. The normal route's
default `Unavailable` state now renders the registered Count scope/status/snapshot hierarchy with
disabled filters and Create action, no Count/Store/assignee/progress/variance/due examples, and
explicit command boundaries; Found and other typed states are unchanged. Focused component tests
pass 6/6, Merchant typecheck/lint/Prettier and the 210-record Screen Registry pass, and the new
production-fail-closed responsive browser journey passes 1/1 with inspected screenshots and no
horizontal overflow. The current-tree root `CI=true pnpm build` passes all 41 workspace tasks (40
cache hits; Merchant rebuilt), with the existing 1,216.65 kB Merchant bundle advisory. WP-2122's
authorized query/projection/commands, live Store/UAT, Accepted Screen, full `pnpm verify`, release
and production gates remain unresolved; regular Figma Review and synthetic browser evidence are not
project completion.

Inventory Count Workbench Figma continuation (2026-09-24): editable regular Operations Design Review
frames `137:213`/`137:256`/`137:299` cover `INV-COUNT-WORKBENCH` at 1440/390/320. The normal route's
default `Unavailable` state now shows source-limited Count/scope/snapshot/progress fields, explicit
blind expected-quantity policy, disabled line filters and scan/save/recount/submit/approve/reject/post
controls, plus an empty no-sample line state. Found and other typed states remain unchanged. Focused
component tests pass 7/7, Merchant typecheck/lint/Prettier and Screen Registry (210 records) pass,
and the production-fail-closed route journey passes 1/1 with inspected responsive screenshots and no
horizontal overflow. Current-tree `CI=true pnpm build` passes all 41 tasks (40 cached; Merchant
rebuilt), retaining the existing 1,220.57 kB bundle advisory. WP-2122 source projection/commands,
live Store/UAT, Accepted Screen, full `pnpm verify`, release and production gates remain unresolved.

Linux full-verification container access (2026-09-24): the pinned Node 24.18.0 Linux image is
available, and previous isolated Linux runs completed repository checks, package tests and root
Vitest but stopped before the database acceptance because the container lacked a Docker CLI. A retry
requiring the host Docker socket was rejected by automatic approval review due to broad host Docker
control and possible container/volume side effects. No command ran and no database/container state
changed. Keep aggregate `pnpm verify` open; do not forward the socket indirectly. Explicit user
approval is required before any future host Docker socket access. Other repository work continues.

Customer Order Status visual continuation (2026-09-24): regular Operations Design Review frames
[`170:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=170-213),
[`170:245` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=170-245), and
[`170:276` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=170-276) document
the current unavailable state using the existing Customer Inter/BOP palette and source-approved
copy. The existing page now carries that state-card hierarchy, current retry action and neutral
Pickup/Dine-in intro. It renders no Order/payment/Batch/ETA facts. `OrderStatusPage` tests pass 24/24,
typecheck, targeted lint/format and whitespace checks pass, and the production-exclusion browser
journey passes 1/1 with inspected 1440/390/320 screenshots and no horizontal overflow. Its Entry
and 503 responses are intercepted synthetic fixtures. This is local visual parity plus one
fail-closed state, not loaded-order, Guest/session, Receipt, Pickup proof, Dine-in, live Store,
Accepted Screen or project acceptance. Figma Make access/edit persistence remains separately
unresolved; the regular Design Review file is editable.

Customer Order Status loaded-view continuation (2026-09-24): editable Review frames
[`176:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=176-213),
[`176:247` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=176-247), and
[`176:281` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=176-281) use clearly
synthetic Order 1001 / CAD 25.98 / Synthetic tea data. The existing ready page now presents progress,
Payment updates, batches, refresh and receipt/support with the established Inter/BOP hierarchy;
null ETA wording, the individual-payment disclaimer, and hidden Pickup proof boundary remain intact.
The 390/320 frame summary rows were adjusted after visual inspection found overlap. OrderStatusPage
tests pass 24/24; typecheck, targeted ESLint/Prettier and default production PWA build pass. The
production-exclusion browser journey passes 1/1 at 1440/390/320 and its screenshots were inspected
for hierarchy and overflow. Requests use intercepted fixtures and prove no live Guest, Store,
Payment, Order or Pickup proof acceptance. Figma Make edit access, Accepted Screen and project gates
remain unresolved.

Kitchen Figma current-checkout revalidation (2026-09-24): freshly read Review frames `4:2`/`4:86`/`4:128`
and compared them with current source and rendered output. The Merchant route keeps the Inter/neutral
hierarchy, responsive three-column desktop/single-column mobile work-card layout, projection-backed
status/quantity fields, disabled command controls and dynamic authorized-workspace navigation. The
Figma sample's station/item names, times, allergen/exception values and links were not promoted to
business facts. Fresh production-fail-closed `e2e/kitchen-queue.spec.ts` passes 2/2 and generated
inspected queue/detail/filter captures at 1440/390/320 with no horizontal overflow. No Kitchen source
changed, so the recorded 9/9 focused component tests and type/lint/format evidence were reused. The
normal Merchant build was restored after Playwright's demo preview. Remaining Registry fields and
named KDS session/device lock need authorized owner sources; synthetic browser proof is not live KDS,
Store acceptance, Accepted Screen or production readiness.

Recipe Figma current-checkout revalidation (2026-09-24): `e2e/recipe-review.spec.ts
--project=production-fail-closed` passes 1/1 for both Recipe List and Editor, capturing 1440/390/320
screenshots. The journey asserts each registered route's source-unavailable boundary, no sample Recipe
rows and no horizontal overflow. Inspected captures preserve the existing Commerce/Review header,
source limitation callout, unavailable state card and return navigation. The default Merchant production
build was restored and passes with its existing 1,220.57 kB chunk advisory. The query remains unconnected:
the internal Recipe aggregate reader, Inventory's pinned item/configuration resolver, and Catalog's
selected allergen-review reader do not form a complete versioned admin projection or Brand-wide
source checkpoint. Keep the route fail-closed; this is local Figma fallback behavior, not source coverage,
external evidence, live acceptance or production readiness.

Kitchen read-only-to-queue spacing parity (2026-09-24): the current 1440 render placed Queue 18px below
the lock notice, while Figma node `4:2` uses about 32px. The scoped CSS now uses a 28px top margin and
the production-fail-closed Playwright journey asserts the actual gap is 28–36px. The journey passes 2/2;
new screenshots at 1440/390/320 were inspected. Desktop Queue hierarchy now aligns with the frame;
mobile filter/lock/lane order is unchanged and has no horizontal overflow. Kitchen component tests pass
9/9, Merchant typecheck/targeted ESLint/Prettier pass, and the default build was restored (existing
1,220.57 kB chunk advisory). No business source fields, permissions, or command authority changed.

Dining Make access and visual recheck (2026-09-24): the current Figma account resolves to a Full
seat/admin on `yashirq's team`. The private Make preview is readable at `/operations/dining`; its
Code view opens `src/components/DiningWorkspace.tsx` in a settable text area. The preview shows 11
fictional tables, Session references/elapsed values, and Area/State/Attention filters. The AI prompt
and generation controls remain disabled until the displayed Sep 30 reset. No Make source was changed,
and manual-save persistence is not verified. These Make-only Session/elapsed/Attention values are not
provided by Merchant's current `StaffDiningTable` projection and were not copied into the application.

The fresh local 1440 screenshot exposed a mismatch left by the earlier Dining migration note: a single
authorized table still rendered in a 175px-wide, 160px-tall card with vertically stacked values. The
Merchant floor board now uses 112–144px compact desktop cards with table label and state on one row,
capacity and Session-presence on a compact value line, and the same accessible selection action. The
390/320 layouts remain full-width single-column. The current production-fail-closed
`dining-session-start.spec.ts` journey passes 1/1 after asserting compact geometry and keyboard
selection, while retaining filtering, denied refresh, retry/recovery, session start, and 1440/390/320
no-overflow checks. Fresh screenshots at all three widths were inspected. `DiningPages.test.tsx` passes
4/4, Merchant typecheck, targeted ESLint/Prettier and `git diff --check` pass. The journey uses
synthetic rows and the existing >500 kB preview chunk advisory remains. This corrects local visual
parity only; owner/elapsed/Order/Payment, reservation/waitlist and attention projection fields, Make
save persistence, Accepted Screen, Store/UAT and whole-project release gates remain open.

Recipe List/Editor Figma hierarchy migration (2026-09-24): re-read Review frames `27:2`/`27:30`/
`27:52` and `27:74`/`27:100`/`27:126`. The normal `Unavailable` branches now use their title, source
notice and bordered field-group hierarchy. List search/status/review controls and Create stay disabled;
the page reports no Recipe records loaded. Editor exposes all five registered field groups, preserves
All Recipes navigation, and leaves editing/publish unavailable. No placeholder rows, sample Recipe
facts or enabled commands are rendered. The production-fail-closed `recipe-review.spec.ts` journey
passes 1/1 with group/control/no-sample assertions and no horizontal overflow at 1440/390/320; fresh
captures were inspected. `RecipePages.test.tsx` passes 30/30, Merchant typecheck, targeted ESLint and
Prettier pass. These are source-unavailable screen states, not an admin read path: the Recipe builder,
complete authorized owner-source version bindings, Brand-wide ordering, API composition, live Store,
Accepted Screen and full-project gates remain unresolved.

## Catalog Product Detail Figma Review continuation (2026-09-24)

The regular Operations Design Review file now has editable responsive `CAT-PRODUCT-DETAIL` frames:
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=180-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=180-394), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=180-579). The design follows the
adjacent Catalog Product List Review palette and typography, separates read-only Product Detail from
Draft editing, shows the Screen Registry / Handoff field groups, and marks unavailable data and the
Draft action as unavailable/disabled. It includes no invented Product, SKU, price, Menu, Store,
approval or audit facts. First-pass visual review found and corrected mobile off-frame columns and
missing value labels; final Figma renders show the responsive groups and unavailable values at all
three widths.

This fills a design-artifact gap only. The normal Product Detail route is still absent; Registry assigns
its implementation to WP-1020/1021/1022/1023/1024/1802. The current Registry `catalog.manage` permission
reference also differs from Handoff Section 67's read-only Detail permission `catalog.product.read`;
the owning Catalog WP must resolve that before runtime implementation. No Catalog source/query/command,
Store evidence, Accepted Screen or whole-project completion is established.

## Catalog Product Create/Edit Figma continuation (2026-09-24)

The same regular Design Review file now includes responsive Product Create and Draft Edit frames. Create:
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-283),
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-360). Edit:
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-437),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-560),
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-692). They follow Handoff 67.5–67.6:
creation remains an unpublished Draft and does not automatically create price/Menu/Recipe/Inventory
records; editing is an explicit Draft with concurrency and unsaved-change handling. Every field remains
unavailable and all commands are disabled because the authorized source and runtime composition are
absent. The first 320px screenshots exposed clipped source notices; final frames expand the callout
height and fit all content within the viewport. These are review designs, not functional screens,
Accepted Screen evidence or completion of the Catalog-owning WPs.

## Kitchen work-item surface Figma parity (2026-09-24)

Freshly reopened Figma Review frames `51:2`/`51:3`/`51:4` and current production-browser output. The
queue's white shell/canvas remains aligned with `4:2`; the `KIT-WORK-ITEM` route now uses the frames'
light-gray `#f5f5f5` content canvas with white information cards. The existing production-fail-closed
Kitchen journey passes 2/2 and freshly captures queue/detail/filter screens at 1440/390/320; detail
screenshots were inspected after this change. The focused Kitchen render suite passes 9/9, Merchant
typecheck, scoped lint/format and default Merchant build pass (existing 1,223.08 kB chunk warning).
Browser responses are synthetic. Safe Station/Order references, course/priority/SLA, structured
allergen/exception facts, named KDS Session/device lock enforcement and additional detail fields still
require authorized owner projections/sources. No Store/UAT, Accepted Screen, complete verification or
production readiness is established.

## Customer Cart Figma migration (2026-09-24)

Added editable regular Design Review frames for `CUST-CART` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=189-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=189-254), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=189-295), reusing the Customer
green/neutral hierarchy. The regular Cart page now follows its heading, canvas, card, journey-link and
checkout visual layers while preserving read-only and unavailable action states. A local-synthetic
browser journey passes at 1440/390/320 with no horizontal overflow; screenshots were inspected at all
three sizes. The 29 Cart component tests, Customer PWA typecheck, scoped lint/format, diff check, and
normal build pass. Fixtures are synthetic only. Cart owner projection/live Store evidence, Figma Make
quota and save-persistence access, Accepted Screen, and whole-project gates remain unresolved.

## Customer Checkout Figma migration (2026-09-24)

The editable regular Design Review file now has inspected `CUST-CHECKOUT` frames at
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=191-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=191-271), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=191-329). The runtime page now
uses the same Customer green/neutral hierarchy with progress, journey links, summary cards and clear
source boundaries. The adjacent Cart/Checkout local-synthetic browser regression passes 2/2 at
1440/390/320; screenshots were inspected and show no horizontal overflow or clipped content. The Checkout component
suite passes 14/14, and Customer PWA typecheck, scoped lint/format and normal build pass. Checkout
details are unavailable in this demo, and Capacity Hold is missing from the current customer-safe
Checkout projection; the UI leaves these facts unavailable and payment disabled. Figma Make quota and
source-save persistence, live Projection evidence, Store/UAT, Accepted Screen, aggregate verification
and whole-project completion remain open. Build retains the existing Vite `inlineDynamicImports`
deprecation advisory.

Checkout details local journey follow-up (2026-09-26): the isolated Pickup Customer Lab now composes
the existing authenticated Checkout details BFF with the Ordering-owned PostgreSQL store. Chromium
reads the synthetic empty policy, saves and reloads an `example.invalid` Pickup contact, and the
isolated database assertion confirms its persisted snapshot. This closes that local Checkout details
journey only. It does not connect the normal Customer demo's details port or enable CheckoutSession,
Order, Payment, legal-policy, live Store/UAT or release behavior; those remain open.

## Customer Receipt Figma migration (2026-09-24)

Created editable regular Design Review frames for `CUST-RECEIPT-SUPPORT` at
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=197-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=197-259), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=197-305). Migrated the green/neutral
Customer visual hierarchy to the receipt page while preserving immutable receipt snapshots, current
state unavailable messaging, disabled email, print, refresh and back behavior. Receipt component tests
pass 10/10, Customer PWA typecheck and scoped ESLint pass, the production-exclusion local-synthetic
browser journey passes 1/1 at 1440/390/320, the normal build passes, and final captures were visually
inspected with no clipping or overflow. Build retains the existing Vite `inlineDynamicImports`
deprecation advisory. Screenshots: `apps/customer-pwa/test-results/receipt-1440.png`,
`receipt-390.png`, and `receipt-320.png`. Fixtures and screenshots use synthetic/stale records, not
live transaction proof. Make quota and source-save persistence, live receipt state, Store/UAT, Accepted
Screen, aggregate verification, and whole-project completion remain unresolved.

Exact checkout build revalidation (2026-09-24): `source .local/activate.sh && CI=true pnpm build`
passes all 41 workspace build tasks on the current shared checkout (39 cached, two executed). This
covers the current Kitchen/Dining and Customer Receipt visual continuation sources. Merchant retains
the existing 1,223.08 kB chunk advisory; Customer PWA retains the Vite `inlineDynamicImports`
deprecation advisory. The full `pnpm verify` remains unresolved: exact-snapshot container-local Linux
verification previously passed through the 41 package test tasks but stopped at `audit-record:acceptance`
because the Docker executable is absent; database acceptance and final aggregate build stage did not run.
Store/UAT, Accepted Screen and production readiness are independent gates.

Current-tree Dining responsive revalidation (2026-09-24): the production-fail-closed
`dining-session-start.spec.ts` passes 1/1 on the exact current checkout and freshly captures 1440/390/320.
Inspected screenshots show compact desktop table cards and one-column mobile cards with no horizontal
overflow. The route uses synthetic Store/table fixtures and existing `StaffDiningTable` facts, so this
is local UI evidence only.

Native-host root test diagnostic (2026-09-24): `CI=true pnpm test` on Darwin exits 1 with 92/110 files
and 1968/2070 tests passing. Observed failures include Linux `/proc/self/stat` assumptions, process
identity checks and sandbox-denied loopback binds (`listen EPERM`), with the QR journey timing out.
This host run is not product acceptance and does not establish that every failure is environmental. The
exact-snapshot container-local Linux root test evidence predates current UI changes; exact-current-tree
Linux test execution and the full `pnpm verify` remain unresolved. The latter also stopped at the
Docker-dependent audit-record acceptance stage because the Linux container has no Docker executable.

Dining confirmation control accessibility correction (2026-09-24): current screenshot review found
that the selected-table confirmation checkbox and wrapped copy were visually adjacent and the label had
no explicit minimum hit area. The label now has an 8px gap and 44px minimum height, with a fixed-size
native checkbox; confirmation semantics and command payload are unchanged. The production-fail-closed
Dining journey passes 1/1 and checks those bounds at 1440/390/320; inspected captures show readable
wrapped copy and no horizontal overflow. Merchant typecheck, targeted ESLint, Prettier and normal build
pass (existing 1,223.08 kB chunk advisory). Synthetic route data is not Store acceptance.

Current-tree Linux test verification selection (2026-09-24): native Darwin `pnpm test` is invalid for
Linux `/proc` process-identity tests. To resolve the exact-tree root/workspace test question, use the
locally cached pinned Node 24.18 image; expose the checkout read-only solely for a snapshot copy,
exclude host `node_modules`, `.local` secrets/business data and generated artifacts, and run the frozen
install plus `CI=true pnpm test` in container-local storage. This does not copy or touch the active
v14 installation. Docker-backed acceptance subcommands remain separate gates unless the container has
a valid safe Docker client/API.

Linux snapshot test preparation correction (2026-09-24): the first disposable Linux attempt installed
the lockfile successfully but omitted workspace `dist` outputs and invoked `pnpm test` before building.
Root Vitest loaded 69/110 files (1856 passing tests) and 41 suites failed to import required workspace
build artifacts. This does not establish the suite result. Rebuild the exact source snapshot before its
root/workspace test run; `.local` business data remains excluded.

Current-tree Linux root/workspace tests (2026-09-24): after a fresh frozen install and 41/41 workspace
build in container-local Linux storage, root Vitest passes 110 files / 2070 tests and all 41 Turbo
workspace test tasks pass. `CI=true pnpm test` stops at `audit-record:acceptance` because the disposable
container lacks Docker CLI (`spawn docker ENOENT`). The Customer PWA shell test had one stale Order
Status subtitle assertion; updating only its expected string restored the full Customer PWA suite to
54/54 files and 890/890 tests. The root/workspace passes are exact-tree evidence; the aggregate command
and Docker acceptance remain incomplete.

Isolated audit-record acceptance continuation (2026-09-24): the exact named
`pnpm audit-record:acceptance` command passes 1 file / 1 test on the host with Docker access using the
WP-0024 isolated PostgreSQL harness. `.local/pilot-v14` was not read or modified. This closes only that
single database acceptance after the container-local `pnpm test` lacked Docker CLI; remaining acceptance
scripts and full `pnpm verify` stay open.

Customer PWA test drift correction (2026-09-24): current `/orders/:orderReference` UI says “Check your
order progress and available next steps.” Its shell test still expected older Pickup-only wording; the
assertion now matches the rendered shared-channel copy. Customer PWA passes 54 files / 890 tests,
typecheck, targeted ESLint and Prettier. No customer runtime behavior changed.

Current-tree root static verification (2026-09-24): root `CI=true pnpm lint`, `typecheck`,
`format:check`, and `screen-registry:check` all pass on the current shared checkout; the 41-workspace
lint/typecheck/format tasks pass and the Registry validates 210 records. `git diff --check` passes.
This closes those static gates only. Exact Linux root/workspace unit tests passed in the snapshot run,
but the full `pnpm verify` remains unresolved at Docker-backed acceptance: the container lacks Docker
CLI, and automatic approval review rejected forwarding the host Docker socket for broad control and
side-effect risk. No additional host socket access was attempted. Store/UAT, Accepted Screen, release
and production readiness remain separate gates.

Kitchen Figma revalidation (2026-09-24): reopened the regular Design Review Queue `4:2`/`4:86`/`4:128`
and Work Item `51:2`/`51:3`/`51:4` frames, refreshed the current production-fail-closed browser
journey (2/2), and inspected 1440/390/320 queue/detail/filter captures. Current code retains the
Figma's compact neutral queue hierarchy and gray detail canvas with white cards; unavailable station,
allergen and exception facts stay unavailable, and controls remain disabled while named KDS session
and device lock are unverified. No source change was necessary. The normal Merchant production build
was restored successfully (existing 1,223.08 kB chunk advisory). Synthetic intercepted rows are not
Store/KDS acceptance; remaining safe references, course/priority/SLA, typed safety cues and lock
authority still require authorized projections/contracts.

Dining Make recheck and responsive preview (2026-09-24): the private Make project opens to the current
`/operations/dining` preview and Code view; `DiningWorkspace.tsx` appears as a settable source editor.
The preview labels its 11-table data fictional. The Make AI prompt, model and Send controls are disabled
until the displayed Sep 30 credit reset. No Make source edit/save/publish/share operation was attempted,
so persistent write permission remains unverified. Re-ran the production-fail-closed Dining journey
(1/1), inspected fresh 1440/390/320 captures and restored the default Merchant build. The local page
retains only authorized table/state/capacity/session-presence facts and the compact card hierarchy; it
does not copy Make-only elapsed, owner, Order/Payment, reservation/waitlist or attention facts. This is
local synthetic visual evidence, not Store/UAT, Accepted Screen or project completion.

Kitchen Work Item modifier projection continuation (2026-09-24): `KIT-WORK-ITEM` now carries the
projection's validated selected option names and quantities to a detail-only Modifiers section; opaque
option references are discarded before rendering. The queue remains unchanged. A present empty list
renders “No selected modifiers”; absent or malformed source fields fail closed. Editable Review frames
`51:2`/`51:3`/`51:4` were updated in the established neutral style, and fresh 1440/390/320 Figma views
were inspected. Focused tests pass 35/35; Merchant typecheck, targeted lint/format, production build and
`git diff --check` pass. The production-fail-closed Kitchen browser journey passes 2/2 and the detail
screenshots at all three widths were inspected. Its fixture is synthetic. Recipe/handling snapshots,
structured allergen acknowledgements, timers/dependencies/history, safe references, station labels,
course/priority/SLA and KDS operator/device authority remain unavailable or owner-gated; this increment
does not resolve those Registry requirements, Store acceptance or the full-project `pnpm verify` and
release/production gates.

Modifier transport regression (2026-09-24): the Merchant Kitchen BFF test now verifies selected option
reference, localized name and quantity are preserved through both List and Get responses for the UI
client. Focused API tests pass 9/9 with targeted ESLint, Prettier and whitespace checks. The fixture is
synthetic and confirms mapping only, not a live projection or Store acceptance.

Dining current-checkout visual revalidation (2026-09-24): screenshot artifacts were missing, so the
existing production-fail-closed Dining journey was rerun (1/1) to create fresh 1440/390/320 captures.
Inspected results show bounded desktop cards, one-column mobile flow, selected-table details and the
confirmation target without overflow. Figma Review frames `24:60`/`24:109` were freshly reread at
390/320 and their area/table/filter/selected-detail hierarchy remains represented. Repository status
colors remain additional styling; this is responsive hierarchy alignment, not pixel identity or Make
code parity. Dining component tests pass 4/4; Merchant typecheck, scoped ESLint/Prettier, normal build
and whitespace checks pass with the existing 1,225.12 kB chunk advisory. Synthetic fixtures are not
Store/UAT evidence, and the private Make save/persistence and wider Dining projection requirements stay
unverified.

Customer Delivery Status Figma continuation (2026-09-24): the regular editable Design Review file now
has responsive `CUST-DELIVERY-STATUS` `FeatureDisabled` frames `205:213`/`205:245`/`205:276`, using the
Customer Order Status green/neutral hierarchy. The ordinary route now renders its Guest Session
boundary, Customer journey navigation and state card while preserving the existing fail-closed disabled
state and Back to order action. Focused page tests (4/4), Customer PWA typecheck, scoped lint/format,
production-exclusion browser journey (1/1) at 1440/390/320 with inspected screenshots, default PWA build,
and whitespace checks pass. Screenshots are under
`apps/customer-pwa/test-results/delivery-status-{1440,390,320}.png`. No Delivery query, API, business
facts or commands were added; owner source/feature acceptance, Accepted Screen, full `pnpm verify`,
Store/UAT and production readiness remain open.

Kitchen current-checkout visual review (2026-09-24): production-fail-closed Kitchen journey passed 2/2;
Queue and Work Item captures at 1440/390/320 and Filter captures at 390/320 were inspected, with no
horizontal overflow. Current UI presents only projection-backed name/state/quantity/age/modifier values
and explicit unavailable station/capability states. Figma Queue `4:2` and Work Item `51:2`/`51:4`
hierarchy remains represented; this is responsive hierarchy alignment, not pixel parity. Normal Merchant production build, targeted Prettier and `git diff --check` pass. Screenshots are under
`apps/merchant-web/test-results/kitchen-{board,detail}-{1440,390,320}.png` and
`kitchen-filter-sheet-{390,320}.png`. Projection gaps, device/session authority, live Store acceptance,
Accepted Screen, full verification and release readiness remain open; the local synthetic journey is not
project completion.

Cross-surface exact-tree regression recheck (2026-09-24): current full Customer PWA unit/component suite
passes 54 files/890 tests; its TypeScript, ESLint and Prettier checks pass. Current full Merchant suite passes 106
files/781 tests; its TypeScript, ESLint and Prettier checks pass. Screen Registry validation passes all 210 records;
changed documentation passes Prettier and `git diff --check`. This strengthens local UI regression evidence for
the present checkout only. Browser coverage remains limited to the scoped journeys recorded above;
synthetic fixtures do not establish DB, Store/Provider/UAT or production acceptance. Reuse the existing
exact-checkout 41-workspace build evidence because app inputs did not change in this recheck. The
later isolated Linux `CI=true pnpm build && CI=true pnpm verify` pass recorded under
`Exact-tree recheck — 2026-09-24` supersedes the earlier snapshot that stopped during Docker-backed
acceptance. That pass covered its observed source snapshot; later scoped changes have component
evidence, but no final monolithic `pnpm verify` has been run after the latest Kitchen CSS/E2E slice.

Recipe admin reader current-tree recheck (2026-09-24): full Recipe unit/component tests pass 9 files/98
tests, with Recipe typecheck, ESLint and Prettier passing. Database ownership validation passes 1,087
rule tests and the live validator. Reused the recorded isolated PostgreSQL acceptance (1/1) because
reader/SQL/helper/acceptance integration inputs were unchanged; no Docker-socket access was attempted.
That was the evidence available at this checkpoint. The later current-checkout ordered database run
also freshly passed `recipe-management:acceptance` among all 41 remaining acceptance commands, so the
reader's isolated PostgreSQL integration is now fresh current-checkout evidence. The internal
generation reader is still not the public version2 Merchant view or a projection builder; permission
trimming, source coverage/freshness, API transport and normal-route composition remain open.

Customer Menu permission-refusal rendering (2026-09-24): the PWA now maps explicit HTTP 403 to a
body-independent `PermissionDenied` state and renders generic session refusal with return-to-entry
recovery and no same-context retry. Focused Menu tests pass 35/35; PWA typecheck, lint, format and
normal build pass, and `git diff --check` is clean. The current Express public-menu route itself has no
authorization middleware or 403 outcome; this closes client rendering/recovery only. A server-owned
permission signal remains needed to demonstrate the path end to end. Feature Disabled and Conflict
remain without accepted query/error outcomes and are unchanged.

Customer Menu Permission Denied responsive Figma continuation (2026-09-24): added editable Review
frames `212:213`/`212:281`/`212:349` at 1440/390/320, adapting the established Customer Menu shell and
generic HTTP 403 recovery. The repository CTA geometry and generic copy match; the page suppresses
unrelated allergen help and offers return to entry without retry. The synthetic production-exclusion
browser journey passes 1/1 and fresh screenshots were inspected at all three widths with no horizontal
overflow. Focused Menu tests pass 35/35; Customer PWA typecheck, ESLint, Prettier, normal build and
`git diff --check` pass. The HTTP 403 is intercepted and synthetic: the current public-menu route has
no permission middleware or denial outcome. This closes a client visual/recovery increment only;
server permission behavior, Feature Disabled/Conflict contracts, live Store acceptance and the broader
project verification/release gates remain open.

Exact-current-tree repository gate (2026-09-24): `CI=true pnpm verify` passed its ordered repository,
contract, format, lint, typecheck and 210-record Screen Registry stages, then failed during root
Vitest before workspace tests, database acceptance and build. The test report recorded 1,967 passes
and 103 failures. One confirmed repository cause was the tracked WP-2402 file exceeding the
secret-scan's 2 MiB bound; dated continuation records were moved to
`docs/spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md` while retaining stable heading
anchors, reducing the main WP to about 1.63 MB. The focused secret-scan now passes 2/2 and full
repository format check passes after the move. Remaining root-test failures include Linux `/proc` and
process-identity checks unavailable on this Darwin host, plus loopback tests denied by sandbox
(`EPERM`). Do not treat the aggregate as passed; run the designated Linux/WSL gate to determine the
remaining exact-tree result. This local repository gate does not establish Store/UAT, release or
production acceptance.

Exact-current-tree workspace build (2026-09-24): ran `CI=true pnpm build` after the aggregate stopped.
All 41 workspace build tasks passed; 38 were valid Turbo cache hits and Customer PWA plus Merchant Web
rebuilt for their current source changes. Existing advisories remain: Customer PWA Vite
`inlineDynamicImports` deprecation and Merchant Web 1,225.12 kB JavaScript chunk. This supplies fresh
build evidence, not root/workspace test completion, database acceptance, Store/UAT, release approval or
production readiness.

Kitchen Work Item Figma implementation refinement (2026-09-24): the current Work Item detail now puts
the Return and Refresh controls in the Review frame's stacked desktop order and compacts the detail-only
safety cues/modifier group; queue cards and projection semantics remain unchanged. The production-
fail-closed journey passes 2/2 with assertions for heading controls, card density and 1440/390/320
overflow. Screenshots at all three widths were inspected. Desktop detail card height is approximately
208px against the Figma frame's 210px; mobile remains single-column. Kitchen component tests pass 10/10,
Merchant typecheck/lint/Prettier and normal build pass, with the existing 1,225.12 kB bundle advisory.
These captures use synthetic records and do not establish missing Kitchen source fields, live KDS
operator/device authority, Store acceptance, Accepted Screen or production readiness.

Customer Payment responsive Figma continuation (2026-09-24): regular editable Review frames
`223:213`/`223:248`/`223:282` now represent 1440/390/320 configured-unavailable payment, using the
Customer green/neutral hierarchy and exact Guest/Store boundary. Repository code adds that bounded
presentation without changing same-intent retry, payment creation, secure Provider handoff, offline or
result handling. Focused payment tests pass 4/4; PWA typecheck/lint/Prettier/build and `git diff --check`
pass. Existing Checkout continuity journeys pass 8/8 and the new configured-unavailable browser journey
passes 2/2. Final screenshots were inspected with no horizontal overflow or invented payment details.
The 1440/390/320 screenshots are in `apps/customer-pwa/test-results/customer-payment-unavailable-*.png`.
This remains an editable Review state and local code verification only. Figma Make availability,
real Provider integration/UAT, Accepted Screen, exact-tree aggregate verify, Store acceptance and
project-level release readiness remain open.

Exact-current-tree escalated test diagnostic (2026-09-24): re-ran `source .local/activate.sh && CI=true
pnpm test` with loopback execution authorized after the Customer Payment changes. Root Vitest passes
95/110 files and 1,972/2,070 cases; 15 files fail 98 cases and one unhandled error. Remaining failures
are concentrated in pilot supervisor/maintenance/recovery tooling on Darwin: Linux `/proc/self/stat`
and process-identity requirements are unavailable, spawned children return nonzero, maintenance-lock
failures cascade and its concurrency test times out. Elevation did not resolve those platform semantics.
Turbo workspace tests, database acceptance and aggregate build remain unexecuted because the root
Vitest stage fails. Keep the exact-tree gate open for a designated Linux/WSL run; do not remove Linux
identity checks to make this host green.

Customer Menu Empty/Unavailable continuation (2026-09-24): the regular editable Design Review now
has Empty and Unavailable frames for 1440/390/320, and the production Menu branch uses the matching
message-card hierarchy while preserving the current no-action Empty result and same-read Retry. The
focused component suite passes 22/22, Customer PWA typecheck/lint/format/build pass, and the synthetic
production-exclusion browser journey passes 1/1 with inspected six state/width screenshots and no
overflow. This is a local state/UI increment; live Catalog source, Store acceptance, Accepted Screen,
private Make persistence, aggregate Linux verification, and whole-project/release acceptance remain
open. The isolated Recovery test file reproduces 12/12 Darwin failures at the Linux-only maintenance
guard; exact-tree Linux/WSL execution remains required.

## Customer Checkout Result Unknown-state Figma migration (2026-09-24)

The editable regular Design Review file now has `CUST-CHECKOUT-RESULT` Unknown-state frames at
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=234-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=234-248), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=234-282). The ordinary result page
now follows that Customer green/neutral hierarchy with a single-row journey, scoped result card and
explicit same-payment status check. Pending, Unknown, Failed and Succeeded remain distinct; amount and
Order navigation appear only from the authoritative success result. The production-exclusion recovery
journey passes 6/6 and captures inspected 1440/390/320 Unknown views without overflow or synthetic IDs/
amounts. Customer Payment tests pass 16/16, typecheck, scoped lint, formatting and diff checks pass, and
the preview build completes with the existing Vite advisory. The original frames cover the Unknown
state; the subsequent Pending/Failed/Succeeded continuation is recorded below. These frames are not
an Accepted Screen. Figma Make remains AI-quota gated until Sep 30; Make
editing persistence, real Provider/Store/UAT, exact-tree Linux verification and whole-project/release
acceptance remain unresolved.

### Customer Checkout Result Pending/Failed/Succeeded continuation (2026-09-24)

Added editable regular Review frames at 1440/390/320 for Pending, Failed and Succeeded. The ordinary
Customer result page uses the BOP semantic status palette while preserving its existing session-backed
read and explicit same-payment reconciliation. Pending does not offer another payment, Failed is
terminal guidance without a pay-again action, and only authoritative Succeeded results expose amount
and Order navigation. Focused payment tests pass 16/16; responsive production-exclusion journey passes
6/6 and inspected captures show no overflow at the three widths; Customer PWA typecheck, targeted lint,
Prettier and diff checks pass. Review examples are synthetic; these frames are not an Accepted Screen
or Provider/Store acceptance. Figma Make persistence, live Store/Provider/UAT, Linux exact-tree
verification and project/release completion remain open.

### Dining Make design recheck and repository migration (2026-09-24)

The authenticated private Make preview `/operations/dining` and `DiningWorkspace.tsx` source are
readable; the Code editor exposes a settable source field, but no edit/save was attempted and durable
save persistence remains unverified. AI Build/model/Send controls are disabled until the displayed
Sep 30 credit reset. The Make screenshot contributes its dark Operations header, compact filters and
area-grouped Table tiles. The repository Dining route adopts the header and desktop side-by-side
floor/selected-Table hierarchy, keeping mobile single-column. It deliberately omits fictional
Store/date, Occupied and attention states, Session references/age, and unregistered navigation; it
retains only current authorized `StaffDiningTable` values and Handoff 88.11 start/recovery/Host
Transfer semantics. The existing local-synthetic Dining journey passes at 1440/390/320 and final
screenshots were inspected; focused Dining tests, Merchant typecheck/lint/format/build and
`git diff --check` pass. This is a regular repository UI migration, not a Make-source write, Accepted
Screen, full Dining projection, live Store/UAT or whole-project/release acceptance. See WP-2402
continuation evidence for exact commands and screenshot paths.

Kitchen queue Figma copy-parity follow-up (2026-09-24): shortened the source-limit footer to match
the compact Review hierarchy while preserving every unavailable reference/filter/action group and the
fuller mobile filter-sheet explanation. The production-fail-closed journey passes 2/2; fresh Queue
1440/390/320, Filter 390 and Work Item 1440/320 captures were inspected. The 1440 footer stays on one
line and mobile wraps without horizontal overflow. Kitchen component tests pass 10/10; Merchant
typecheck, scoped lint/format, normal build and `git diff --check` pass. This is local UI parity only;
Kitchen projection fields, named operator/device authority, Accepted Screen, Store/UAT and project
acceptance remain open. Exact selection and evidence are in
[`WP-2402 continuation evidence`](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md).

Kitchen Figma/Make access recheck (2026-09-24): the authenticated private Make preview and current
`/operations/kitchen` route are readable; its Store/date and ticket/order samples are explicitly
fictional. Code view exposes a settable `src/App.tsx` editor, but no edit/save/publish was attempted,
so persistence is still unverified; AI Build/Send remains quota-disabled until Sep 30. Current regular
Review contexts `4:2`/`4:86`/`4:128` freshly show the Kitchen Queue at 1440/390/320. The repo follows
their supported responsive hierarchy while leaving unsupported sample fields unavailable. Separately,
the current Docker CLI is present but `docker version` cannot access the Docker Desktop socket; no
container-backed verification was run. Neither UI evidence nor the socket limitation closes the
Accepted Screen, live Store/UAT or whole-project gates.

Merchant Overview current Figma parity (2026-09-24): the authorized Store label and freshness value now follow Review `HOME-OVERVIEW` frames `31:2`/`31:47`/`31:88`: separate Store heading plus neutral desktop freshness badge, with the badge hidden on mobile. The production-fail-closed journey passes 1/1 and inspected 1440/390/320 captures show no horizontal overflow. Focused shell tests pass 4/4; Merchant/UI typecheck, scoped lint/format and builds pass. Only existing workspace fields were used; no dashboard source or business behavior was added. Review frames do not establish Accepted Screen, live Store/UAT or project/release acceptance. Exact evidence is in [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md).

Kitchen Work Item detail Figma parity (2026-09-24): aligned the Registry-required unavailable-detail group with Review `51:2`/`51:3`/`51:4`, using four independent bordered rows in a padded card and stacked mobile field/value rows. Updated the heading and explanation to identify missing authorized Kitchen detail projection fields. Kitchen component tests pass 10/10, and the production-fail-closed browser journey passes 2/2 with fresh inspected Queue/Work Item/Filter screenshots at 1440/390/320 (Filter at 390/320); no horizontal overflow. Merchant typecheck, scoped lint/format and normal build pass. No data or command behavior changed. Sample browser data remains synthetic; real KDS authority, Registry field coverage, Accepted Screen, Store/UAT and full project verification/release gates remain open. See [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md).

Procurement Purchase Order Detail design artifact (2026-09-24): added regular editable Review frames for `PROC-PO-DETAIL` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=251-213), [390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=251-302) and [320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=251-389). The frames cover the Screen Registry/Handoff 88.12 field groups, including the separately required Supplier performance timeline; all unsupported projection values remain Unavailable and registered actions disabled. Final screenshots at all widths were inspected after correcting clipping. This is an editable design artifact only: normal PO projection/command composition and WP-2134 runtime completion remain unverified and open.

Purchase Order Detail Figma-to-repository continuation (2026-09-24): the normal `/app/supply/purchase-orders/:id` route now renders the reviewed source-unavailable hierarchy instead of a generic error panel when the current read is unavailable. It covers the Registry fields and close invariant while keeping every PO/Supplier/receipt/performance value unavailable, never echoing the route reference, and keeping all registered actions disabled. Production-fail-closed browser journey passes 2/2 for PO List/Detail and the detail screenshots at 1440/390/320 were inspected; Merchant test run passes 781 tests across 106 files, typecheck, scoped lint/format and whitespace checks pass. The default route still has no authorized Procurement projection/client or command composition; WP-2134 business acceptance and actual supplier/receipt facts remain open.

Purchase Order Editor Figma-to-repository continuation (2026-09-24): the normal `/app/supply/purchase-orders/:id/edit` route now renders the Screen Registry source-unavailable editing hierarchy in the migrated Review visual language. Supplier/Buyer/Ship-To/currency, workflow/revision, Offering lines and allocations, terms/tolerance, totals/validation impact are explicitly unavailable; Save, Validate, Submit, Approve and Issue remain disabled, with approval/issue semantics stated. No route reference or synthetic business facts are shown. Production-fail-closed browser journey passes 3/3 for List/Detail/Editor; final Editor screenshots at 1440/390/320 were inspected and the journey asserts no horizontal overflow. Focused Purchase Order component tests pass 4/4; Merchant typecheck, scoped ESLint, Prettier and whitespace checks pass. The ordinary authorized Procurement projection/client, commands and WP-2134 business acceptance remain open; this is a UI source-boundary migration only.

PROC-PO-EDITOR now also has dedicated editable regular Figma Review frames at
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-306) and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-398). The final mobile frames
follow the sibling Purchase Order Review's single-column pattern and display every registered editor
group with unavailable values and disabled actions. A fresh List/Detail/Editor production journey
passes 3/3 and inspected Editor captures have no horizontal overflow. This adds the missing design
artifact only; Procurement reads/commands and WP-2134 workflow acceptance remain unconnected.

Inventory Item Create/Edit now have their own editable Design Review frames at 1440/390/320 and the
normal routes show their unavailable-source field hierarchy with all actions disabled. The six
production-fail-closed captures were inspected and the two-route journey passes 1/1 with no
horizontal overflow. Item quantity/opening balance remain outside the Item form. WP-2120's authorized
owner query/commands and Store facts are still absent; these frames are not Accepted Screens. Exact
nodes, scoped checks and screenshot paths are in [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md).

Purchase Order Editor now follows its regular Figma Review hierarchy at 1440/390/320 in the
ordinary unavailable-source state: Registry groups remain explicit, line fields use compact
read-only rows, Goods Receipt ownership remains with Inventory, and registered write actions stay
disabled. The existing production-fail-closed List/Detail/Editor journey passes 3/3; all three Editor
captures were inspected with no horizontal overflow. This is visual/source-boundary work only. The
authorized Procurement projection/client, commands, WP-2134 business acceptance and Accepted Screen
remain open. See [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md).

## Exact-tree recheck — 2026-09-24

The isolated Linux snapshot run `CI=true pnpm build && CI=true pnpm verify` passed repository/
architecture/schema checks, all root and 41-workspace format/lint/typecheck/test tasks, Screen
Registry (210 records), 2,070 root tests, the ordered PostgreSQL acceptance chain through Dining,
and the final 41-workspace build. The first aggregate attempt stopped at PostgreSQL Compose startup
because its temporary Linux CLI lacked Compose plugin registration; the corrected rerun passed.
Ordering's Dining Cart eligibility query and acceptance fixtures were corrected against WP-2314.
Exact snapshot scope and commands are in the
[dated continuation log](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-linux-exact-tree-full-verification-rerun-2026-09-24).

That aggregate run predates subsequent scoped source edits and is not a fresh monolithic pass for the
latest dirty checkout. Later current-checkout evidence includes root Vitest (2,070/2,070), 41/41
workspace test tasks, Audit plus all 41 remaining isolated database acceptances, and a full 41-task
build; the latest Kitchen freshness change additionally passes its production-fail-closed browser
journey, 10 focused tests, Merchant typecheck/lint/format and preview build. Treat the latest
repository status as assembled component evidence, not a new final `pnpm verify`. Procurement/
Catalog/Inventory normal-route owner composition, live Store/UAT, Accepted Screens, Provider/device/
staffing evidence and release/production gates remain open; no whole-project completion claim is
supported.

Kitchen Queue desktop Figma width correction (2026-09-24): Queue workspace now matches Review frame `4:2` at 1120px wide on 1440px viewport; production-fail-closed responsive journey passes 2/2 and current Queue/Work Item screenshots at 1440/390/320 were inspected. Merchant typecheck, scoped ESLint/Prettier and `git diff --check` pass. Full evidence and remaining Registry/KDS/project gates: [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md).

Kitchen current Figma parity and responsive recheck (2026-09-25): current rendered Design frames `4:2` and `51:2` were compared with fresh repository screenshots at 1440/390/320. The existing production-fail-closed journey passes 2/2; Queue and Work Item visibly remain unverified/read-only, disabled actions stay disabled, and no horizontal overflow appears. The UI preserves the available projection fields and explicitly unavailable station/detail facts. This is local synthetic visual evidence only; Registry source coverage, owner-backed KDS session/device enforcement, Accepted Screen, Store/UAT and release gates remain open. No application code changed. Exact command, sandbox loopback failure/retry, screenshot paths and the design-context timestamp-node discrepancy are recorded in the [dated WP-2402 evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-current-figma-parity-and-responsive-recheck-2026-09-25).

Supplier Detail visual design continuation (2026-09-24): editable regular Figma Review frames were added at 1440/390/320 for `SUP-SUPPLIER-DETAIL`, covering the registered identity, field-masked contact/address, qualification/evidence, relation/performance summaries and history/Audit groups. Unsupported facts and actions remain unavailable; no sample Supplier data was introduced. This is design-only, marked Not Accepted; owner/runtime and Store acceptance remain open. Details: [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#supplier-detail-figma-review-selection-2026-09-24).

Supplier Detail Figma-to-repository continuation (2026-09-24): the default Supplier detail `Unavailable` route now follows the 1440/390/320 Review hierarchy, with explicit unavailable/restricted values, registered actions marked unavailable, and no URL or synthetic Supplier facts displayed. Found and typed error states remain unchanged. The production-fail-closed responsive journey passes 1/1; Supplier tests pass 5/5; Merchant typecheck/lint/format and diff checks pass. Figma frames remain Review / Not Accepted; Supplier owner acceptance and project gates remain open. Details and screenshots: [WP-2402 continuation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#supplier-detail-figma-to-repository-selection-and-result-2026-09-24).

## Current-checkout verification update (2026-09-24)

The earlier exact-tree aggregate stopped on environment boundaries and its dates remain historical. A
later current-source validation now passes the component test/build stages independently: pinned Linux
root Vitest passes 110 files / 2,070 tests after building all 41 workspaces; the host Turbo run reports
41/41 workspace test tasks successful; Audit Record passes 1/1 isolated PostgreSQL test; and every one
of the 41 remaining existing `pnpm test` acceptance commands passes against its isolated database
harness. The stages were run against the current application/package source and use no `.local`
pilot data. The Linux test used a read-only source/Git snapshot, an empty container-local `.local`
fixture parent, and no Docker socket; isolated database acceptances used the existing namespaced cleanup
harness.

This is assembled component evidence, not a single end-to-end `pnpm test` or `pnpm verify` execution.
It is current through the Kitchen freshness badge slice except for whole-repository format/lint/type
and aggregate re-execution: that final CSS/E2E-only slice was separately checked by Merchant
typecheck, scoped ESLint/Prettier, focused component/browser tests and its production preview build.
The latest documentation-only status reconciliation was checked with Prettier and whitespace scans.
Real Store/Provider UAT, Accepted Screen and release/production gates remain separate and open. These
results do not close the owner-composed normal routes identified above or the cross-WP source/API/
permission gaps.

Kitchen screenshot artifacts were absent when the latest source-only records were revisited, so the
existing production-fail-closed journey was freshly rerun on temporary ports 5175/4175 without stopping
existing listeners. Both tests pass; Queue and Work Item captures at 1440/390/320 and filter-sheet
captures at 390/320 were inspected. The current responsive hierarchy remains consistent with the
Review references and keeps unsupported source facts unavailable. This verifies the local synthetic
screen only; Kitchen owner projection coverage, named KDS session/device authority, Accepted Screen,
Store/UAT and production gates remain open. See the dated WP-2402 evidence for the exact paths.

Kitchen compact Fresh badge correction (2026-09-25): a fresh read of Design Review nodes `4:2`,
`4:86` and `4:128` found that the 320px Queue frame specifies a 76px Fresh badge, while the 1440px
and 390px frames specify 78px. The Queue now follows that responsive width; the production-fail-closed
journey asserts it and passes 3/3. Merchant page tests pass 11/11, typecheck, targeted lint, Prettier
and whitespace checks pass, and fresh 1440/390/320 captures were inspected. No projection data or
command/permission behavior changed. These remain synthetic visual checks; all Kitchen source,
operator/device authority and Store/release gates above remain open. Full evidence: [WP-2402 dated
continuation log](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-fresh-badge-320px-figma-alignment-2026-09-25).

The same frames specify a `#e8f7ed` background and `#14784a` text for Fresh; Queue CSS and the
responsive E2E now use/assert those exact colors, and fresh 1440/390/320 captures were inspected.
This closes that local palette mismatch only; it does not establish an Accepted Screen or Kitchen
operator/Store/release acceptance. See the [color alignment evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-fresh-badge-color-figma-alignment-2026-09-25).

### 2026-09-25 current-checkout recheck

The exact checkout was rebuilt and checked in native Linux arm64. The prebuild, static/
contract/format/lint/type/screen-registry stages, root Vitest (110 files / 2,070 tests),
workspace tests and database unit tests (119) passed. The five failures from an initial
bind-mounted run were Docker Desktop filesystem artifacts; the affected recovery tests
passed 21/21 after extracting source into the container-local filesystem. The monolithic
`pnpm verify` stopped at Audit Record PostgreSQL acceptance because Docker Desktop could
not resolve the container-local secret path. Running Audit Record on the host and then
the remaining 41 existing acceptance commands through Dining passed. The build and all
acceptance stages therefore have current evidence, but `pnpm verify` itself is not
reported as passing. Exact selection, failure details and command boundary are in the
[WP-2402 continuation record](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-checkout-full-verification-selection-2026-09-25).

Kitchen Queue card Figma alignment (2026-09-25): current Review values for card borders/dividers,
disabled fill and 1440/390/320 action geometry are implemented and covered by 3/3 browser journeys;
focused tests pass 11/11 and fresh Queue/Work Item screenshots at all three widths were inspected.
This remains synthetic visual verification. Figma Review is not an Accepted Screen; source fields,
named KDS operator/device authority and Store/release gates remain open. See [dated evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-queue-card-figma-alignment-2026-09-25).

Kitchen Queue lane gutter Figma alignment (2026-09-25): a fresh read of Review frame `4:2` showed
desktop lane starts at x=260/638/1016, 354px lane widths and 24px gutters. The repository now matches
that geometry, with the browser journey asserting measured boxes. The existing production-fail-closed
Kitchen journey passes 3/3; fresh 1440/390/320 Queue captures were inspected and the mobile stack is
unchanged. This visual-only correction does not supply named station labels or KDS/device authority;
the frames remain Review, and Store/UAT/release gates remain open. See [WP-2402 evidence](../spec/work-packages/WP-2402.md#kitchen-queue-lane-gutter-figma-alignment-2026-09-25).

Private Figma Make access recheck (2026-09-25): the private Dining Preview, Version 29 history,
Code file tree and a settable source editor load in authenticated Chrome. Source is readable and a
manual edit control is present, but no write was made, so persistence is unverified. The Make AI
prompt/context/Send controls remain disabled until team credits reset September 30, 2026. No source,
publication or sharing state changed; Make AI work and any unverified code transfer remain open.
See [dated access evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#private-figma-make-access-recheck-2026-09-25).

Private Dining Make source recheck (2026-09-25): authenticated Preview and Code views load, with
current `src/customer/transitions.ts` readable in a settable editor. The AI prompt/context/Send
controls remain disabled until the displayed September 30 credit reset. The visible QR Dining
session labels itself simulated and fictional. The Version 29 chat reports 170 tests/build success,
but this checkout did not verify those claims; no Make edit/save/publish/share action was taken and
the prototype remains separate from repository or production acceptance. A source comparison found
the normal Customer PWA already retains owner-backed Payment operation references for same-operation
recovery and blocks new Cart commands while an unknown operation is unresolved; no Make transition
code was copied. The comparison did not rerun those repository tests. Details are recorded in
[WP-2402](../spec/work-packages/WP-2402.md#private-dining-make-source-recheck-2026-09-25).

Kitchen Work Item current-frame controls (2026-09-25): fresh reads of Review frames `51:2`/`51:3`/`51:4`
found the desktop Return link left-aligned in a 340px control group while Refresh stays 186px at the
right edge; mobile keeps Return left-aligned and Refresh full-width. Repository CSS and its
production-fail-closed assertions now match. The Kitchen journey passes 3/3, page tests 11/11,
typecheck/lint/Prettier/build pass, and detail screenshots at 1440/390/320 were inspected. See [dated
implementation evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-work-item-current-frame-control-alignment-2026-09-25).

Current-checkout browser evidence refresh (2026-09-25): the prior screenshot artifacts were absent,
so the existing Dining Session Start and Kitchen Queue production-fail-closed journeys were rerun
with local loopback permission; 4/4 pass and fresh 1440/390/320 screenshots were visually inspected.
Both keep unsupported facts unavailable; Kitchen commands remain locked pending verified KDS/device
authority. The runs are synthetic browser evidence and do not close DEMO authorization, owner-backed
projection, Accepted Screen, Store/UAT or release gates. See the [dated WP-2402 refresh record](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-checkout-dining-and-kitchen-browser-refresh-2026-09-25).

Kitchen Work Item history copy correction (2026-09-25): the current projection can carry acceptance
and Order-item-ready timestamps, so its detail screen now distinguishes recorded milestones from
unavailable Kitchen start/progress/completion times. Focused component tests pass 11/11, the existing
Kitchen production journey passes 3/3, and fresh 1440/390/320 detail screenshots were inspected.
No projection or business behavior changed; live KDS authority and Store/release gates remain open.
See [WP-2402 milestone evidence](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-work-item-milestone-explanation-accuracy-2026-09-25).

Current-candidate Merchant production browser milestone (2026-09-25): the complete existing
`production-fail-closed` Playwright project passes 65/65 against the current worktree and builds the
normal Merchant preview. It covers the current synthetic Orders, Dining, Kitchen, Pickup, Exceptions,
Review-route and production demo-exclusion journeys. The build retains its >500 kB chunk advisory.
This is not a Customer-suite run, `.local/pilot-v14`/DEMO identity check, live Store/UAT, Accepted
Screen or release approval. Full scope and exclusions are in the [dated WP-2402 browser result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-candidate-merchant-production-browser-milestone-2026-09-25).

Current-candidate Merchant assisted-demo browser milestone (2026-09-25): the existing `demo-desktop`
and `demo-mobile` projects pass 28/28 across configured 1440px/390px viewports. The tests exercise
13 local showcase screens plus one keyboard-accessible workflow link; they do not use the actual
Windows/WSL DEMO identity or pilot runtime. See the [dated WP-2402 result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#current-candidate-merchant-assisted-demo-browser-milestone-2026-09-25).

### Customer and Kitchen browser evidence refresh (2026-09-25)

The current Customer PWA browser projects were rerun after correcting three stale E2E expectations. The complete `demo-desktop`, `demo-mobile`, and `production-exclusion` project set passes 107/107; changed E2E lint/Prettier and `git diff --check` pass. This is local synthetic browser evidence and demo exclusion, not actual Guest, Store, Provider, or payment acceptance. The Production build retains its existing `inlineDynamicImports` deprecation warning. Exact counts, original failure diagnosis, and repaired selection are recorded in [WP-2402](../spec/work-packages/WP-2402.md#current-candidate-customer-pwa-browser-milestone-2026-09-25).

The existing Kitchen `production-fail-closed` journey was also rerun and passes 3/3. Fresh Queue and Work Item screenshots at 1440/390/320 and filter-sheet screenshots at 390/320 were inspected. The current Figma-supported hierarchy is intact, with source-limited fields and KDS/device authority remaining explicit and read-only. This does not close Kitchen source coverage, named operator/device lock, Accepted Screen, Store/UAT, or release gates. See [WP-2402 Kitchen revalidation](../spec/work-packages/WP-2402.md#current-kitchen-figma-parity-revalidation-2026-09-25).

Customer browser follow-up: after the 107/107 project run, the product-detail heading assertion was tightened from a first-match locator to the semantic item `article`; other routes now require a unique heading. The affected `customer-demo.spec.ts` passes 30/30 across desktop/mobile, with scoped ESLint/Prettier/whitespace checks passing. The latest 107-case result is assembled from the original full pass plus this rerun of the only changed spec; no Customer production source changed. The Vite preview retains its existing deprecation advisory. Detailed selection and evidence are recorded in [WP-2402](../spec/work-packages/WP-2402.md#customer-demo-route-heading-locator-refinement-2026-09-25).

Kitchen Queue station partition follow-up (2026-09-25): the current projection's opaque station references now preserve separate lanes when authorized display labels are missing. References remain internal; visible labels and the Station filter stay unavailable. The focused board tests pass 12/12, Merchant typecheck/scoped lint/format pass, and the production-fail-closed journey passes 3/3 with inspected 1440/390/320 captures. This repairs a local display hierarchy mismatch only. The eight normal-entry implementation gaps above, cross-WP Product route, Customer Dine-in owner-safe projection, real KDS/device authority, Accepted Screens, live Store/Provider/UAT and release/production gates remain unresolved. Detailed selection and results are recorded in [WP-2402](../spec/work-packages/WP-2402.md#kitchen-queue-station-reference-lane-grouping-2026-09-25).

Kitchen exact-reference search follow-up (2026-09-26): the Registry Order/ticket lookup now submits a
validated UUIDv7 as an exact Order or Ticket filter to the existing authenticated `ListKitchenQueue`
query. It does not expose an internal ID as a public display number. The focused component/client
tests pass 25/25; the production-fail-closed Kitchen journey passes 3/3 and inspected synthetic
screenshots at 1440/390/320 remain overflow-free. Merchant lint, changed-file format, preview build
and `git diff --check` pass. Merchant typecheck is still blocked by four existing undefined-value
diagnostics in `e2e/dining-session-start.spec.ts:286–287`; no Kitchen diagnostics remain. Course,
priority, overdue/SLA, full keyboard/route acceptance, the Make draft, named KDS/device authority,
Accepted Screens, live Store/UAT, and pilot/release readiness remain open. See the [WP-2402
continuation result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-exact-reference-search-continuation-2026-09-26).

Kitchen exact-reference PostgreSQL follow-up (2026-09-26): the existing isolated projection
acceptance now queries the seeded Order and Ticket references independently and verifies a valid
no-match result under the restricted owner role (2/2). The adjacent immutable Ticket acceptance
passes 1/1 after its schema-wide historical inventory assertions were scoped to the original
Ticket/projection tables; required immutability, Tenant/Store scope, same-Kitchen-schema foreign
keys and prohibited-column checks remain. ESLint, Prettier and `git diff --check` pass. These are
synthetic database results; source completeness, live KDS/Store/UAT, Accepted Screen, release and
production acceptance remain open. See the [dated WP-2402 database result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-exact-reference-postgresql-projection-acceptance-2026-09-26).

The Kitchen Queue Design Review now includes the implemented exact Order/Ticket lookup in its
desktop toolbar and mobile open filter sheet. Unsupported source filters are marked unavailable;
the footer and mobile notes keep internal UUIDs hidden and preserve the KDS/device-lock boundary.
Screenshots of the desktop and 390/320 mobile frames plus the open sheet were inspected. This
alignment does not change Review/Not Accepted status or establish Store/UAT. See the
[dated Figma reconciliation](../spec/work-packages/WP-2402.md#kitchen-review-search-alignment-2026-09-26).

The private Make `/operations/kitchen` preview and `KitchenWorkspace.tsx` are also readable. The
preview uses fictional `Grill`/`Fryer` station labels, KT/DEMO identifiers, a fixed demo Business
Date and simulated actions; these are not Kitchen owner facts. The repository preserves the supported
station-grouped hierarchy, state/age/quantity/status fields, safe-reference search and read-only KDS
fence while withholding missing station display names and internal UUIDs. The existing
1440/390/320 repository screenshots show the responsive layout and current Registry search. Make
AI generation remains quota-gated through its displayed reset date. Manual edit/save persistence
was verified in the follow-up below. See the [dated WP-2402 comparison](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-make-preview-and-repository-projection-comparison-2026-09-26).

Private Figma Make access recheck (2026-09-26): reopening the private link in the current
authenticated Chrome session loads its Preview, which still displays fictional The Elm / Table T-07
demo content. The Make design-context call returns a source-file manifest including
`src/App.tsx` and `src/components/KitchenWorkspace.tsx`, but the provided resource reader returns
`Unknown resource` for their `file://figma/make/source/...` URIs, so this recheck did not read those
source bodies. The browser exposes the Code view; an earlier same-day check saw a settable editor,
but durable save/reload permission remains unverified. AI prompt/context/Build/model/Send are still
disabled until the displayed Sep 30 reset. No Make source, publication or sharing state changed.
This establishes current project/Preview and manifest access only, not full Make acceptance. See the
[dated WP-2402 access result](../spec/work-packages/WP-2402.md#private-make-current-project-access-recheck-2026-09-26).

Merchant typecheck follow-up (2026-09-26): the four Dining E2E unchecked-index diagnostics noted in
the Kitchen search run were corrected with explicit measured-box presence guards. Merchant
typecheck, lint, formatting, and the focused responsive Dining journey now pass. This only removes a
test-source typecheck blocker; it does not alter application behavior or close full-project gates.

Kitchen Figma hierarchy revalidation (2026-09-26): fresh Review contexts for Queue `4:2`/`4:86`/`4:128` and Work Item `51:2`/`51:3`/`51:4` were compared with newly generated repository screenshots at 1440/390/320. The supported responsive hierarchy matches: three desktop lanes at the measured 1120px/24px-gutter geometry, one mobile lane per row, compact Refresh label at 390, full-width source Refresh at 320, and matching Work Item detail groups. The existing Kitchen journey passes 3/3; screenshot inspection found no horizontal overflow or new supported visual mismatch. Current projection-derived values render, while absent safe labels/references, allergen/exception/course/priority/SLA and detail sources remain unavailable and commands remain locked pending verified KDS/device authority. No application source changed. This is synthetic local visual evidence only; the frames remain Review artifacts and Store/UAT, Accepted Screen, external and release/production gates remain open. Exact record: [WP-2402 Kitchen comparison](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#kitchen-figma-hierarchy-and-projection-revalidation-2026-09-26).

Current Merchant production browser suite revalidation (2026-09-26): after adding the Kitchen Store-switch route case and Task Inbox, the complete existing `production-fail-closed` project was rerun and passes 67/67, including current Orders, Dining, Kitchen, Pickup, Exceptions, Task Inbox, Review-route and production demo-exclusion cases. The normal Merchant preview builds with its existing >500 kB chunk advisory. This is synthetic local browser evidence; it does not establish actual DEMO runtime use, Store membership, BFF authorization, RLS, Store/UAT, Accepted Screen or production/release readiness. See the [dated WP result](../spec/work-packages/WP-2402.md#current-merchant-browser-regression-after-task-runtime-and-kitchen-toolbar-changes-2026-09-26).

Current Merchant production browser suite follow-up (2026-09-26): after adding the Dining authorized Store-switch case, the complete existing `production-fail-closed` project passes 68/68 against the current checkout and rebuilds the normal preview. Fresh Kitchen Queue captures at 1440/720/390/320 and Dining Store-switch captures at 1440/390/320 were inspected; no horizontal overflow appeared. This adds synthetic assembled-route evidence only. It does not establish actual Store membership, BFF authorization, RLS, KDS/device authority, Store/UAT, Accepted Screen or production/release readiness. See the [current WP result](../spec/work-packages/WP-2402.md#current-merchant-production-browser-regression-after-dining-store-switch-addition-2026-09-26).

Current Merchant assisted-demo browser regression (2026-09-26): the existing `demo-desktop` and `demo-mobile` projects pass 28/28 against the current checkout, covering 14 showcase routes and the keyboard-accessible workflow link at both configured viewports. The normal preview builds with its existing greater-than-500-kB advisory. This is repository-local synthetic demo evidence, not actual Windows/WSL `.local/pilot-v14` or DEMO identity acceptance, Store/UAT, or production readiness. See the [current WP result](../spec/work-packages/WP-2402.md#current-merchant-assisted-demo-browser-regression-2026-09-26).

Persisted Dining Table HTTP composition revalidation (2026-09-26): the existing isolated `current-permission-policy` PostgreSQL acceptance passes 1/1 against the current checkout. It exercises SetBlock, exact replay, ClearBlock and permission-denied SetBlock through the actual Merchant HTTP/runtime composition, backed by synthetic persisted session/Store/membership/permission rows and the Dining/Audit PostgreSQL owners. The changed helper's ESLint, Prettier and whitespace checks pass. This closes that local composition evidence gap only; live Store authority, UAT, the complete Dining floor projection and production/release readiness remain open. See the [dated WP result](../spec/work-packages/WP-2402-continuation-evidence-2026-09-24.md#persisted-dining-table-http-composition-revalidation-2026-09-26).

Persisted Kitchen queue BFF composition (2026-09-26): the isolated `current-permission-policy` PostgreSQL acceptance exercises populated `List` and Work Item `Get` requests through `createMerchantRuntime`, using a persisted synthetic Merchant session, selected Store, current CSRF, `kitchen.operate` policy and an owner-built active generation with one synthetic Ticket/Work Item projection row. Both wrong-CSRF calls return 403; both authorized calls return 200/no-store with the selected Store and expected projection fields, while `operatorStatus` remains `Unverified`. Queue fields include status, quantities, localized display name and opaque station reference; unavailable preparation/history/safety values are not inferred. This adds local BFF-to-populated-projection readback evidence without inventing production Kitchen data or station labels. KDS/device authority, live Store/UAT, Accepted Screen and production/release acceptance remain open. See the [dated WP result](../spec/work-packages/WP-2402.md#persisted-kitchen-work-item-detail-query-composition-2026-09-26).

Private Make access follow-up (2026-09-26): a fresh Chrome open still loads the current private
project and Preview; the authenticated Figma plan reports a Full team seat/admin role. The current
source manifest includes `App.tsx` and `KitchenWorkspace.tsx`, but reading the returned Make source
resource URI fails with `Unknown resource`. AI generation controls remain disabled until the displayed
2026-09-30 credit reset. At this point no edit/save/publish/share action had been taken. The later
manual persistence check below resolves the save-permission question. Current result and exact
boundary are recorded in
[WP-2402](../spec/work-packages/WP-2402.md#private-make-source-and-edit-access-recheck-2026-09-26).

Private Make manual persistence follow-up (2026-09-26): the Code view exposed the actual
`KitchenWorkspace.tsx` body. A temporary nonfunctional comment persisted across a full reload; after
removing it, a second reload confirmed it was absent. This verifies current manual editor writeback
only. The MCP `file://figma/make/source/...` resource still returns `Unknown resource`, and AI
generation remains unavailable until the displayed credit reset. No Publish or Share action was
used; sharing settings were not changed. The Preview's fictional Store/Table/sample data remain
excluded from the repository. See the [WP-2402 result](../spec/work-packages/WP-2402.md#private-make-manual-edit-persistence-recheck-2026-09-26).

Persisted Pickup queue Store-switch boundary (2026-09-26): the isolated
`current-permission-policy` acceptance passes 1/1 through the actual Merchant BFF and persisted
session. Store One and the authorized switched Store Two each return their persisted empty Pickup
queue; the prior cookie is denied and a caller-supplied Store field is rejected. This proves the
current local Session/Permission/Store/query composition only. No Ready Pickup row or handoff was
seeded; populated queue behavior, real Store membership/RLS, Store/UAT and production/release gates
remain open. See [WP-2402](../spec/work-packages/WP-2402.md#persisted-pickup-queue-store-switch-boundary-2026-09-26).

Kitchen Figma/browser revalidation (2026-09-26): fresh authenticated Review reads for Queue desktop,
390px, 320px, and Work Item desktop/390px/320px returned current screenshots. The existing
`production-fail-closed` Kitchen journey passes 4/4, with freshly inspected Queue and Work Item
renders at 1440/390/320. The supported page/card hierarchy and mobile reflow remain aligned; the
Registry exact-reference search and explicit unavailable projection data remain intact. No current
visual code correction was indicated. The Figma frames remain Review-only; Accepted Screen, actual
zoom and screen-reader verification, KDS/device authority, Store/UAT and release/production gates
remain open. See [WP-2402](../spec/work-packages/WP-2402.md#current-kitchen-figma-and-browser-revalidation-2026-09-26).

Current Kitchen Figma and repository refresh (2026-09-26): fresh design contexts and screenshots for
Queue `4:2`/`4:86`/`4:128` and Work Item `51:2`/`51:3`/`51:4` were compared with the existing
`production-fail-closed` Kitchen journey. It passes
4/4 and rebuilds the Merchant preview; newly generated Queue captures at 1440/720/390/320 and Work
Item captures at 1440/390/320 were inspected, together with the status palette, mobile filter sheets,
Store-switch and command views. Figma-supported hierarchy and current projection fields remain
aligned, with no source change justified. Review remains Not Accepted; sample values are synthetic,
and named KDS/device authority, actual zoom/screen-reader acceptance, Store/UAT and release readiness
remain open. Exact result: [WP-2402](../spec/work-packages/WP-2402.md#kitchen-current-figma-context-and-repository-revalidation-selection-2026-09-26).

Owner-generated Ready Pickup with persisted Merchant Store rotation (2026-09-26): the final
browser-enabled `public-store-profile` PostgreSQL acceptance passes 3/3. In the same database, the
Pickup Owner path creates a Ready Fulfillment, Merchant reads it at the original Store, then the
persisted session rotates to the authorized target Store; the old cookie is denied, the target Store
returns an empty queue, and a caller-supplied old Store is rejected. This resolves the prior
unreproduced `BROWSER_SESSION_DENIED` report for this acceptance and proves isolation after an
Owner-backed Ready read. It does not prove a populated target-Store queue or cross-Store handoff.
See [WP-2402](../spec/work-packages/WP-2402.md#owner-generated-ready-pickup-across-persisted-merchant-store-rotation-2026-09-26).

Owner-generated Kitchen rows across persisted Merchant Store rotation (2026-09-26): the same
isolated `public-store-profile` PostgreSQL acceptance now reads the Owner-produced Active Kitchen
generation through the authenticated Merchant BFF at Store One, observes the separately
initialized-empty Store Two projection after rotation, then rotates back and reads the same Owner
rows under the replacement session. The revoked intermediate cookie is denied, responses are
`no-store`, caller-supplied Store scope is rejected, and `operatorStatus` remains `Unverified`.
This closes the local populated-row-after-rotation evidence gap; it does not establish live Store
membership/RLS, KDS/device authority, Store/UAT or cross-Store release applicability. See
[WP-2402](../spec/work-packages/WP-2402.md#owner-backed-kitchen-projection-after-store-switch-2026-09-26).

Populated Pickup owner-to-Merchant response revalidation (2026-09-26): the browser-enabled isolated
`public-store-profile` acceptance passes 3/3. Its Owner-generated Ready Fulfillment is read through
the authenticated Merchant BFF; phase, aggregate version, ready time, proof metadata and item
quantities match a fresh Owner read. Pre-issuance proof absence and post-issuance raw-credential
exclusion are covered, then the same browser flow verifies proof and completes handoff. This remains
synthetic Store/runtime evidence and does not prove real membership/RLS, live KDS/device authority,
Store/UAT or release readiness. See [WP-2402](../spec/work-packages/WP-2402.md#persisted-ready-pickup-response-field-coverage-2026-09-26).

Current candidate root verification refresh (2026-09-26): repository guidance, module and boundary
checks, migrations, foundation/helpers, OpenAPI/event catalog, full format, lint, typecheck and the
210-record Screen Registry validation pass. The exact host `pnpm verify` still exits 1 at root
Vitest on Darwin (15/110 files, 98/2,070 tests), where Linux pilot-process tests cannot read
`/proc/self/stat`. Current exact-tree Linux build/root/workspace tests and isolated PostgreSQL
acceptance remain separately recorded component evidence; the aggregate is not a pass, and none of
these results establish Store/UAT or production readiness. Detailed result: [WP-2402](../spec/work-packages/WP-2402.md#current-candidate-root-verification-refresh-selection-2026-09-26).

Database tooling integration follow-up (2026-09-26): the existing `pnpm test:integration` passes its
database workspace task in 2m6s, including Migration Runner integration and WP-0024 isolated-database
parallelism, failure injection, signal, timeout, redaction and cleanup. It uses disposable synthetic
databases and does not close business-domain Store/UAT, external Provider or release gates. Exact
selection and result: [WP-2402](../spec/work-packages/WP-2402.md#current-isolated-database-integration-gate-selection-2026-09-26).

Current-clock Dining and Pickup Entry regression (2026-09-26): the complete isolated
`public-store-profile` configuration passes 3/3 after the fixture separated monotonic
Identity/Permission time from deterministic Store Business Date and service windows. Both Entry
journeys pass checkout allocation and reach their Owner workflow; the browser-enabled Pickup path
also reads its Owner-generated Ready projection through the persisted Merchant BFF. This resolves
the prior synthetic fixture regression only. It does not establish live Guest/Store authority,
Store/UAT, production membership/RLS or release readiness. Exact selection and result: [WP-2402](../spec/work-packages/WP-2402.md#current-clock-owner-entry-regression-follow-up-selection-2026-09-26).

Current Customer local CheckoutSession recovery and Linux software gate (2026-09-26): the synthetic
Pickup browser journey passes at 1440/390 with same-operation retry recovery, persisted
CheckoutSession/allocation/capacity commitment, and no Order, reservation or PaymentIntent write;
the DineIn journey passes at the same widths after shared lab bootstrap changes. The current
212-path exact-tree Linux snapshot passes frozen install, all 41 builds, root Vitest 110/110 files
and 2,070/2,070 tests, and all 41 workspace test tasks. These results update local software evidence
only. The scripts did not capture screenshots or cover 320px; no live Guest/Store, Provider, UAT,
runtime, handover, exact-head CI or release/production acceptance is established. See [WP-2402
results](../spec/work-packages/WP-2402.md#pickup-checkoutsession-monotonic-clock-follow-up-selection-2026-09-26).

Pickup CheckoutSession authorization recheck (2026-09-26): the fresh retry passes the existing
isolated PostgreSQL/browser acceptance 1/1, including current Guest/Cart scoping, persisted
CheckoutSession/allocation/capacity commitment, exact operation recovery, and zero Order,
reservation or PaymentIntent writes. The initial failure did not reproduce after Docker successfully
started; source review found no reason to weaken or change authorization. This updates only synthetic
local evidence; widths were 1440/390 with no screenshots, and live Store/Guest, Provider, UAT,
production and release gates remain open. See [WP-2402](../spec/work-packages/WP-2402.md#pickup-checkoutsession-post-clock-authorization-recheck-selection-2026-09-26).

Figma Make access refresh (2026-09-27): the authenticated Preview and Code views open, and
`src/components/KitchenWorkspace.tsx` opens in the settable editor. A separate reversible edit
and full-reload check on 2026-09-26 proved manual source persistence; this refresh made no edit.
The AI prompt, Build, model and Send controls remain disabled until the displayed 2026-09-30
credit reset. Preview remains fictional The Elm / Table T-07 content. The most recent documented
MCP source-resource read returned `Unknown resource` on 2026-09-26; it was not repeated in this
browser refresh. Publish and Share were untouched. Make acceptance, Store/UAT, Accepted Screen,
KDS/device authority and release/production evidence remain open.

Dining Figma Make and repository recheck (2026-09-26): the current Make Code view exposes
`src/components/DiningWorkspace.tsx` in a settable editor, while the latest MCP source URI read
remains `Unknown resource`; prior Kitchen save/reload evidence is the only persistence check. The
Make preview's desktop area cards and sample fields are visible, but its phone preview uses three
narrow columns and includes fictional Session, elapsed-time and attention values. The repository
retains only fields supplied by its current Dining projection, with the unavailable-field note and
single-column mobile card layout required by Handoff 88.27. A fresh `dining-session-start.spec.ts`
production-fail-closed run passes 2/2; inspected 1440/390/320 board and Store-switch captures show
the expected responsive flow and only synthetic Store Two data. No code change was justified by the
unaccepted Make geometry. These browser fixtures do not establish live Dining/Store data, Accepted
Screen, UAT or release readiness. See [WP-2402](../spec/work-packages/WP-2402.md#dining-make-code-view-and-current-repository-recheck-2026-09-26).

Kitchen Figma and current render revalidation (2026-09-26): fresh Review contexts/screenshots for
Queue `4:2`/`4:128` and Work Item `51:2` were compared with newly generated Merchant
production-fail-closed captures. The focused Kitchen journey passes 4/4; Queue captures cover
1440/720/390/320, and Work Item captures cover 1440/720/390/320. Inspected Queue 1440/720/390/320,
Work Item 1440/390/320 and the 320px filter sheet. The current hierarchy remains aligned with the
Review and Handoff: the search/filter band and Queue lanes, KDS read-only explanation, current
projection fields, responsive single-column cards and unavailable owner facts are preserved. No app
change was justified. Local rows are synthetic; the design remains Review/Not Accepted, and real
KDS/device authority, zoom/screen-reader acceptance, live Store/UAT and release readiness remain
open. See [WP-2402](../spec/work-packages/WP-2402.md#kitchen-figma-hierarchy-and-current-render-recheck-2026-09-26).

Kitchen mobile filter-sheet parity (2026-09-27): the current Figma Review's 390px open-sheet
geometry and paired Search/Clear controls now match the Merchant implementation at 390px and
320px. The production-fail-closed Kitchen journey passes 4/4 with exact viewport-width/bottom
alignment, equal action widths, local-only clearing before submit, applied-filter clearing, keyboard
focus restoration and overflow checks. Fresh 1440/390/320 Queue and 390/320 filter-sheet screenshots
were inspected. Registry-backed unavailable values and the KDS/device read-only fence remain intact.
This is synthetic local visual/interaction evidence; Review remains Not Accepted, and source
coverage, KDS/device authority, screen-reader/physical-device acceptance, live Store/UAT and release
readiness remain open. Exact evidence: [WP-2402](../spec/work-packages/WP-2402.md#kitchen-mobile-filter-sheet-parity-2026-09-27).

Kitchen actual browser zoom (2026-09-27): real Chrome UI confirmed 200% zoom while the local
synthetic Queue and Work Item were inspected. Queue uses the compact mobile filter entry and one
card column; Work Item details stack vertically, with no visible horizontal clipping in the captured
views. Chrome was restored to 100%. This closes only the local browser-zoom visual inspection item;
no DOM scroll-width measurement, screen-reader/physical-device/WCAG, live Store/UAT, Accepted Screen,
KDS/device or release acceptance is claimed. Exact evidence: [WP-2402](../spec/work-packages/WP-2402.md#kitchen-actual-chrome-200-zoom-acceptance-2026-09-27).
