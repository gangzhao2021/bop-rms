# BOP-RMS Specification Index

## Authority

- Source document ID: `BOP-RMS-HANDOFF`.
- Accepted composite baseline: the Owner-confirmed Handoff `0.5.3` Sections `0–91`
  plus repository-accepted Sections `92–97`.
- Repository source reference: `BOP-RMS Complete Handoff Package.md` identifying
  itself as `0.5.9`, used for the scoped reconciliation recorded in
  [WP-2336](./work-packages/WP-2336.md) and [WP-2400](./work-packages/WP-2400.md).
- Current discussion node: `WP-2402 - Pilot submission preparation`.

The 2026-07-23 Owner decision established the composite baseline because no newer Library file was
then confirmed available. Current local availability and formal acceptance are separate facts:
a file's self-reported version does not accept a replacement complete baseline. The local file
supplies source text for bounded comparison; later accepted ADR/WP records and scoped addenda
supply the acceptance evidence. On 2026-09-22 the Owner explicitly authorized tracking and
syncing the complete Handoff source to the existing public GitHub repository for development
on another computer, superseding the earlier instruction to keep this document outside Git.
This changes source availability only, not acceptance of its entire self-reported baseline.
Never commit Library credentials, signed URLs, account identities or private access metadata.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Sections 89–91 govern repository execution、Codex / Figma operation and GitHub Free solo governance; Sections 92–94 govern database ownership、Domain dependency enforcement and Migration Runner behavior; Section 95 is authoritative for WP-0021 foundation schema behavior；Section 96 is authoritative for WP-0022 helper objects、ownership、ACL、Tenant Context and verifier behavior；Section 97 is authoritative for WP-0024 reusable seed、fixture and parallel isolated-test-database behavior.

Accepted scoped addenda remain effective within their recorded scope:
[WP-2228](./work-packages/WP-2228.md) records DEC-H01/H02 product choices;
[DEC-H03](./design/capacity-source-decision.md) is the accepted capacity topology addendum.
Do not reopen them because an implementation or acceptance test remains unfinished.
[DEC-H03-DINING](./design/capacity-checkout-handoff.md#proposed-dine-in-interpretation-dec-h03-dining)
is an accepted scoped interpretation (Owner approval on 2026-09-10).
WP-2402 records original-clock and commitment implementation, multi-batch expiry and
paid-batch preservation (438–448), and the v14 Dining sale/refund/closure journey (571).
These are local InternalTest evidence; remaining pilot acceptance is tracked in the
[current acceptance table](../runbooks/single-store-pilot.md#current-acceptance-and-remaining-work).

[DEC-PILOT-INV-01](./design/inventory-pilot-persistence-decision.md) was accepted by the Owner on
2026-09-11: Inventory namespace 1900 and scoped pilot persistence are authorized.
WP-2402 now includes persisted submission flows, actual API-role Inventory cancellation
rollback/replay and reservation release (425–426), and multi-batch preservation (438–448).
Authorization, recorded implementation evidence and complete pilot acceptance remain
separate; these local scenarios do not supply real Store inventory facts.

Agents must read root `AGENTS.md`, this index and their assigned WP before editing.
If a newer source introduces a conflicting rule, establish its exact section, scope and acceptance
evidence, apply the precedence above and refresh only the affected brief before implementation.
A changed availability label alone does not supersede accepted decisions.

## Current Owner-selected deployment phase

On2026-09-22 the Owner selected the current Windows/WSL host and existing local test
employee for the immediate InternalTest demonstration, with cloud Linux migration
later. Follow the [accepted deployment and login scope](../runbooks/single-store-pilot.md#accepted-deployment-and-login-scope-2026-09-22).
Enterprise employee-directory, real Payment/Store activation and cloud host gates
remain future phase requirements, not missing prerequisites for opening the local
demo. This decision does not authorize live deployment or manufacture operator
handover evidence.

## Current repository stage

[WP-2402](./work-packages/WP-2402.md) is the current implementation work on
`codex/wp-2402-pilot-submission`, based on local HEAD
`a0f35440cacff1ab55be78edfb08cb4de90c1a26` with uncommitted work. Component
implementations and their scoped evidence do not establish an assembled pilot.

The current local runtime is v14 with198 canonical migrations (batch546), using
`.local/pilot-v14`. A fresh quiesced paired snapshot preserved383 business
tables/8709 rows, original354 ACL entries/16 column grants, all30 installation
files and the simulator. Both new Payment tables received the Owner-approved
SELECT/INSERT grants. All seven services passed startup/readiness. Original v13
and recovery-546 remain retained; do not restart v13 after v14 writes without
reconciliation. Owner-authorized local simulated automatic compensation is enabled
(batch553); fresh worker health and existing refund readback pass. Batch554 proves a new
late Pickup simulated capture automatically creates a capacity-expired disposition,
blocks Kitchen release, refunds CAD22.60 and appends Original/Refund receipts.
Batches555–556 complete actual workbench acknowledgement and automatic case
closure; a numeric lease-history ordering defect was fixed and covered by actual
PostgreSQL regression. Workbench reload and final refund allocation readback pass. Isolated batches543–545
prove unmatched capture discovery and actual HTTPS follow-up; livev14 financial
review and full pilot acceptance remain unfinished.

Current later milestones:571 completes a new v14 Dining sale through ordinary refund,
originalGuest rendered Original/Refund receipts, Order/Session closure and table release.
572–573 confirm persistedMatched results for both complete Store days2026-09-20/21
and provide a read-only operator status command.561/563 enable tested local process
supervision with maintenance exclusion;569 verifies supervisor stale-lock cleanup, while574
adds read-only diagnosis for interrupted maintenance. It does not safely auto-release a
maintenance lock while Docker work could survive the parent. Employee directory UI/HTTP
components564–568 still lack an actual multi-employee identity source. Assembled release
checks575–579 cover types, lint, format components,41workspace builds/tests and root tests with repaired fixtures. Batch580 covers67Merchant and91Customer browser cases through the full runs plus focused repairs; normal frontend artifacts are restored. Batch581 covers isolated database/browser Dining and Pickup flows plus the direct restartable HTTP consumer, using focused repaired runs. Batch584 proves actual partial-stop recovery and full service/supervisor resumption;585 closes current structural, migration, screen and OpenAPI/event contract checks. The Owner subsequently selected manual Windows/WSL startup and the local DEMO identity (598).
The five-workspace read-only walkthrough and operational status review are recorded in608.
Interrupted resume takeover has implementation and isolated test evidence (612), followed
by the Owner-authorized actual before-start controller interruption and original-source
resumption (615); see the [takeover scope and result](./design/pilot-v14-resume-takeover-proposal.md).
Operator responsibility acknowledgment, remaining recovery acceptance and applicable
release/external gates keep full pilot acceptance open. Refer to the
[current runbook acceptance table](../runbooks/single-store-pilot.md#current-acceptance-and-remaining-work)
for consolidated current state; the older paragraphs below are historical evidence.

Earlier v13 started with196 canonical migrations (batch491), using
`.local/pilot-v13`. Final quiesced transfer preserved381 business tables/8173 rows,
354 object ACL entries, original keys and the paired simulator. Configured daily
source reads and all six service startup/readiness checks passed. The original v12
and recovery-491 snapshot remain retained; new v13 writes require reconciliation
before any return to the old runtime. Batch494 enables an independent daily
settlement worker with durable restart reuse and actual completed background cycles;
batch498 adds bounded oldest-first backlog from the original supported Sep20 window.
Earlier partial-day coverage, broader worker recovery and full pilot acceptance remain unfinished. Earlier milestones below describe their original evidence.
Batches404–410 move all active service entry points into repository code with
protected installation data. Batches415–416 exercise the migrated composition:
actual local Pickup checkout, simulated Payment, acceptance, Kitchen preparation,
proof/handoff, Original receipt and ordinary CAD11.30 refund with pending0 and
Original/Refund receipt history. Batch417 fixes the observed merchant financial
summary refresh; scoped browser recovery and actual read-only refresh pass.
Batches343–346 complete rendered Dining service and closure; batch395 completes
the earlier Dining refund through staff execution and owner receipt history.
These are InternalTest results, not real Store activation.

Batches412–413 prove isolated local PostgreSQL/SQLite content restoration and
restricted API-role isolation for three restored owner tables. They do not prove
fresh-machine provisioning, key recovery or a restored application cutover.

Batch393 executes the specifically approved Dining exception single-table SELECT.
Batches400–404 connect and run the independent Dining exception recovery worker;
actual discovery is empty, so positive exception persistence is not yet proven.
Batch423 records Owner approval and execution of the four exact local authority
proposals. The employee workbench now renders Stale/read-only/empty, effective
publication permissions pass, and reconciliation owner reads succeed with no rows.
Batches424–426 publish the unchanged cancellation workflow, verify actual API-role
Inventory failure rollback and replay, commit one real failed/expired cancellation
and enable its worker with fresh readiness. Automatic compensation remains disabled;
mixed paid/unpaid batch preservation still needs actual acceptance. Batch427 starts reconciliation recovery with a fresh completed cycle; actual
reconciliation discovery is empty, not positive journey evidence. Batches428–430
create a real late simulated payment, repair its expired-order disposition and
complete CAD22.60 simulated compensation. Batches431–434 compare every configured
owner source in one authorized snapshot and recover current reads under Section88.22;
initial activation SLA is unchanged and historical first-alert timing is not certified.
Batch435 records the DEMO employee operations acknowledgment, closes that same Case
without another refund, and renders Fresh/Resolved/Completed. Batch436 connects
compensation receipt recovery, appends the actual CAD22.60 Refund after the preserved
Original and verifies retry without duplication. Batch440 uses a new legitimate Guest
and real unmodified deadline to complete late simulated payment, compensation,
rendered Original/Refund receipts (confirmedCAD11.30/pending0), operations acknowledgment
and Case closure without another refund. Batch439 repairs queue reads for the existing
terminal batch cancellation. Batches441–443 verify unknown-payment timeout preserves
paid facts/table/session, repair first-batch acceptance after an additional submission,
and prove stale-version rejection, actual acceptance at version3, exact idempotent replay
and rendered first Accepted/second Not accepted. Batch448 completes scenario438 financial closure and session closing after
correcting the cancelled-batch current price deduction; actual table is Available
and unlinked, with original paid and submitted facts preserved. Batch446 exercises a
controlled local Provider decline, proves automatic second-batch cancellation and
Inventory handling with first paid facts/table/session preserved, and repairs two
cancellation revision readers. Batch447 locates the close refusal in cancelled-batch pricing; batch448 fixes it
and proves normal order/session closure and table release. Batch445 proves first-batch serving
completed1/1 while paid facts/table/session remain unchanged and the second payment
remains unresolved. Batch444 fixes
initial Dining payment-confirmation and Kitchen source version assumptions, recovers
the original events, and proves one paid first-batch work item completed1/1 and ready.
Batches455–459 complete an actual local Dining exception refund, financial closure,
operations acknowledgment and resolved workbench. Batches461–469 persist operational
reconciliation runs and enable its scheduler; actual results include25 matched checks
and2 unresolved customer-action checks, not a completed positive healing journey.
Batches470–480 add owner-derived closed Business Date totals and persist one matched
DailySettlement run with duplicate replay and complete readback. Daily scheduling remains
unfinished. The additional migration1400_021 cannot be applied in place to v12 because
it precedes the installed global migration high-water mark.

Batch484 proves isolated data-preserving upgrade from the421 backup to all196 migrations:
381 business tables/7054 rows match,420 foreign keys validate, and trigger definitions
match the new canonical schema. At that milestone v12 remained on195 migrations; batch491 later completes the
fresh transfer described above. This older-backup
rehearsal does not establish fresh snapshot transfer, restored permissions/key provisioning
or application cutover. Compensation allocation/automatic activation, positive reconciliation
healing, worker failure recovery and final release readiness remain unfinished. See the
[current pilot runbook](../runbooks/single-store-pilot.md#current-local-candidate-2026-09-21)
for startup commands, acceptance limits and the remaining work.

Earlier runtime milestones below remain historical evidence:

WP-2402 batch256 switches the local InternalTest runtime to v11 with194 canonical
migrations. Transfer evidence matches377 source business tables and5322 rows;
v10 remains a preserved rollback database. Existing runtime permissions and the
simulated Payment store were preserved. Four services are running, with current
business and Kitchen worker cycles observed. Actual employee HTTPS Host transfer,
exact operation replay and current single-Host selection passed. The original
Guest then recovered the expired Cart using the previously saved operation;
HTTP200 and an identical receipt on retry confirm persistent recovery. These are
InternalTest HTTP results; rendered recovery and the complete pilot release
journeys remain unfinished. Batch257 confirms the original Guest renders an Active empty Cart and enables
the existing batch-expiry observation loop with per-loop health reports. Actual
processing records five PaidBeforeDeadline observations, each with Audit; this
does not cancel any batch. Cancellation dispatch, Inventory release, ordinary
refund execution/reconciliation/receipt and durable operation recovery still
require work.

WP-2402 batches205–214 add authenticated refund item selection, non-persisting
amount/component preview and request APIs, plus contextual employee Payment and
Refund pages in the local v10 runtime. Actual browser evidence covers a partial-item
preview and explicit confirmation; synthetic browser journeys cover request retry, history lookup recovery and reload.
The wizard exposes the latest20 persisted request summaries without treating them
as completed refunds. Per-request execution status now reads owner dispatch and
observation facts, separating unsent, reconciliation-needed and confirmed payment
legs. Persisted preparation is distinguished from no preparation; the employee
preparation button supports exact retry and explicit unconfigured/denied states.
After request confirmation, employees can refresh records and continue on the same
page; failed refresh preserves the recorded state and blocks duplicate submission.
Real local evidence currently covers only an unprepared request under rollback;
preparation/dispatch remain unavailable pending the separate authority setup.
Real rollback evidence covers Pickup and three-batch Dining requests and occupancy.
No refund was dispatched. Durable request recovery, execution/reconciliation and
refund receipt remain unfinished. The separately reviewed local MFA access change was pending at that historical
milestone. The Owner subsequently authorized the exact v12 change; batch355 records
its execution and the completed ordinary simulated refund journey. It is no longer
an outstanding approval. Other local permission proposals remain separate.

WP-2402 batches215–216 add guarded start/stop/restart for the configured local
API, HTTPS, business and kitchen workers. Actual recovery evidence includes
missing worker PID adoption without a duplicate process. This is recovery of
existing v10 configuration, not portable provisioning or complete workload health.

The current `pnpm dev` supervisor still starts the foundation API/Worker entry
points and expects API readiness to remain `503` with database `not_configured`.
The separate local Customer runtime composes entry, menu, Dining admission, Cart
and quote, and accepts explicit checkout-session creation/read, Order status and
receipt read configuration, plus grouped payment intent/handoff/result configuration.
These routes require explicit owner ports. WP-2402 internal assembly batch48 now
records one complete local Pickup browser journey using persistent API/Worker
composition and simulated Payment: order, acceptance, Kitchen, verified handoff,
customer completion and original DEMO receipt. It also records same-session page
reload recovery. The active isolated configuration is now `.local/pilot-v10` (WP-2402 batch186),
with prior v9 data and runtime files preserved. The v10 database contains all 191 current
migrations; 376 business tables and 5,119 rows were transferred with matching row counts
and content digests before startup. It is not the normal `pnpm dev`
supervisor or a production deployment. Batch90 (2026-09-20) records a fresh
persistent Dining browser journey on DEMO-03: session join, initial payment,
acceptance, Kitchen preparation and employee serving, then an additional batch
with separate payment and partial/final serving. Both batches reached the Customer
view and immutable original/correction receipts without manual event recovery.
Batch173 records a persistent HTTPS close of the fulfilled three-batch Dining Order,
with linked Settled finality, employee Audit and idempotent replay. Batch180 closes that Dining session through the persistent HTTPS Begin/Finalize path.
Batch186 releases the linked table through an authorized HTTPS Finalize retry, with immutable release history and exact replay. Batch187 records persistent next-party start and guest QR/join, plus old Closed Order HTTPS reads after table reuse. Batches188–192 add employee Order/session closing controls and focused browser recovery evidence. Batches193–200 add employee table selection, product session start and entry-code replacement; fresh HTTPS start/replacement and persistent new-guest joining are recorded separately from mocked browser interaction evidence. Ordinary refunds, expired shared-cart continuation,
operational recovery and supported runtime packaging remain required. Real
Provider, Store and legal evidence remain external pilot gates.
See [local environment behavior](../../tooling/environment/README.md).

[DEC-PILOT-BATCH-PHASE-01](./design/pilot-multi-batch-phase-proposal.md) and
[ordinary refund RF-D01–06](./design/pilot-ordinary-refund-policy-proposal.md) were
explicitly accepted by the Owner on 2026-09-13. Additional-Batch phase/payment
activation and ordinary refund implementation/acceptance remain in WP-2402. Receipt issuance additionally needs complete pending
refund evidence; compensation-only state cannot establish that none are pending.
Docker was restored on 2026-09-13; checkout-session store/adapter PostgreSQL
acceptance now passes through the unified local Customer runtime. Remaining
business journeys still require their own actual database acceptance. Existing
scoped evidence remains recorded in WP-2402; no new full journey or live Provider
result is implied by this status update.

[WP-2400](./work-packages/WP-2400.md) is integrated locally with the Screen Registry repairs,
current design/evidence views and explicit verification selection/stop rules in root AGENTS.md.
The history archive retains its original WP-2350 snapshot. Local integration does not establish
remote PR/main, release or production readiness.

Read the [design decision register](./design/README.md#current-decision-implementation-and-evidence-state)
for accepted versus pending decisions, the [business scenario evidence view](./design/business-scenario-coverage.md)
for service/API/database/browser progress, and the
[Pilot readiness inventory](../runbooks/pilot-integration-readiness-inventory.md) for external gates.

## Latest Work Package Status

- [WP-2402](./work-packages/WP-2402.md), in progress: accepted DEC-H03-DINING, owner commitment
  lifecycle and PostgreSQL history/Audit, current-authorized preparation and Identity/CSRF
  composition, plus atomic Ordering capacity linkage with real PostgreSQL evidence.
  Current-authorized owner receipts and fixed Order/Batch service binding are also verified.
  Dining initial operation/ID recovery is implemented using the existing unique owner record.
  Internal final Dining submission now composes actual Checkout and Ordering services.
  Persisted Identity/Dining/Cart/Quote/Ordering submission and response-loss recovery are verified.
  The original Payment clock is durably sealed and recovered without renewal.
  Payment-owned explicit tip choices now have immutable PostgreSQL/Audit persistence, with actual
  Identity/CSRF and Dining/Ordering composition verified through PostgreSQL response-loss recovery.
  Original Order allocation plus the explicit saved tip now derives exact payment amounts, with
  composed PostgreSQL evidence; these amounts alone do not establish current payment eligibility.
  Current Dining payment authority is now distinct from historical recovery and verified with
  real Identity/CSRF and PostgreSQL owner state.
  Pickup now composes persisted Identity/CSRF, Cart/Quote, shared ASAP capacity and atomic Order
  creation with original response-loss recovery. Fresh capacity use and historical recovery remain
  distinct. Pickup original payment-clock sealing and lost-response recovery are also verified;
  explicit Pickup tip persistence, exact amounts and current held-capacity payment permission are
  also verified. Payment Intent/Attempt/operation/Audit now have an actual PostgreSQL adapter,
  with service-to-store claim-before-Provider and unknown-response recovery evidence using a
  synthetic Provider. Request-local Dining and Pickup Payment authorization ports now verify
  actual Identity/CSRF and original Ordering ownership, including PostgreSQL revocation evidence.
  Catalog now has an actual scoped current-release authority reader with PostgreSQL expiry,
  applicability and withdrawal evidence. Actual current Product/SKU lifecycle and exact sale-unit
  reads are also verified in PostgreSQL. The current selection facts adapter now joins release, published membership, SKU and bindings in one read-only Repeatable Read transaction, with actual PostgreSQL/validator evidence; availability safety remains separate. Complete current option binding/set reads now preserve
  quantity/default/conflict/trigger and SKU/channel rules with PostgreSQL evidence.
  Both Dining and Pickup Checkout now compose actual current Catalog release/SKU/option reads:
  withdrawing a SKU refuses new Order creation, while original submission recovery remains verified.
  Both modes use the production API Order source and persist actual Catalog snapshots and
  original Pricing Quote lines into Orders, including response-loss recovery. PriceBook and
  TaxConfiguration now come from their owned PostgreSQL tables in the composed acceptance cases;
  complete tax evidence must match persisted references and validity. Configuration/evidence
  values remain synthetic, so real Store commercial approval is not established.
  Configured v2 Quote entry now composes current Identity/CSRF, Pickup binding or Dining participation,
  actual Catalog snapshots and persisted Quote/request/Cart attachment, including response-loss recovery
  and current denial. The entry now reads persisted PriceBook, TaxConfiguration and Option rules in
  one read-only database snapshot; concurrent price updates cannot mix versions within a Quote.
  Store/QR/admission, safety, approved commercial configuration and Option publishing remain open,
  with public runtime activation still open. Configured customer submission now composes actual
  Identity/CSRF, Cart/Quote, Catalog and capacity-linked Ordering in both modes, with PostgreSQL
  submission/response-loss and original Payment-clock recovery evidence. Configured tips, exact
  original amounts and current Payment access/kill-switch/revocation now have both-mode persisted
  evidence; final Inventory and Payment preparation/Provider activation remain open. The production configured Order
  source now reads actual Cart, original Pricing history and current Catalog, with both-mode
  PostgreSQL evidence and SKU withdrawal rejection. The configured Quote HTTP port returns persisted v2
  totals with current authorization, original replay and durable 410 expiry in both modes;
  production runtime activation and complete customer checkout/submission remain open.
  Customer Order HTTP submission and production PWA client/controller now have actual both-mode
  PostgreSQL response-loss recovery evidence. Final Inventory, Payment preparation/activation,
  runtime activation and the rendered checkout submission action remain.
  [DEC-PILOT-INV-01](./design/inventory-pilot-persistence-decision.md) is accepted. Inventory now has
  scoped Item/ledger/reservation persistence and transaction-bound demand/allocation validation with
  synthetic PostgreSQL evidence recorded in WP-2402. Actual Store/Recipe source composition,
  final Inventory validation and complete pilot acceptance remain in progress.
- [WP-2401](./work-packages/WP-2401.md): locally integrated persisted Pickup Cart/Quote browser
  lab, with desktop/mobile evidence; synthetic commercial inputs do not establish pilot readiness.

- [WP-2353](./work-packages/WP-2353.md): scoped service/repository composition, with 135/135
  focused tests and actual PostgreSQL application creation/replay/race evidence.
  The brief owns verification details and remaining activation gates.

- [WP-2352](./work-packages/WP-2352.md): committed atomic Order writer.
  Its recorded Ordering 1014/1014, ownership 230/230 and actual PostgreSQL rollback/concurrency/
  recovery passes remain the owning evidence; they were not rerun by this merge.
- [WP-2351](./work-packages/WP-2351.md): committed Checkout evidence/write-fence prerequisite.
  Its original Ordering 998/998 and HTTP/service e2e evidence retains its stated scope.
  The downstream owner writer is now recorded in WP-2352.

- [WP-2400](./work-packages/WP-2400.md): locally integrated design consistency and Screen contract repair.
  Its brief owns the fresh check results and any remaining limitations.
- [WP-2350](./work-packages/WP-2350.md): baseline scoped immutable Order recovery.
  Its recorded Ordering 979/979, ownership 219/219 and actual PostgreSQL recovery evidence is
  historical; none is rerun or relabeled by this documentation/tooling task.
- [WP-2336](./work-packages/WP-2336.md): accepted DEC-H03 topology.
  Producer clocks, durable composition and race/compensation evidence are implementation
  requirements, not pending topology approval.

Older progress and original evidence remain in the
[historical index snapshot](./history/README.md) and individual [work packages](./work-packages/).
Keep this section bounded to the active WP and relevant baseline; update the scenario evidence
view for affected journeys instead of copying every past result into this index.

## Accepted technical floor

The accepted floor is：PostgreSQL `18.4`；application-owned business、Command、Event and Correlation IDs use UUIDv7 through `uuid 14.0.1`；a database default may call built-in PostgreSQL 18 `uuidv7()` only for migration / repair paths；the extension allowlist remains only `pg_trgm` and `unaccent`。Money facts use `amount_minor bigint` plus ISO 4217 `currency_code char(3)` and never PostgreSQL `money` or binary floating point。Instants use UTC `timestamptz`，Store zones use IANA identifiers，local operating dates use `date` and wall-clock configuration uses `time without time zone`。Brand is the primary Tenant boundary；Store-owned facts carry both required scopes；critical uniqueness and query indexes include scope；future Brand / Store tables require application authorization plus RLS defense in depth using transaction-local server-resolved context。Cross-domain private-table access remains prohibited。All mutable Aggregate Roots continue to require `version bigint not null`、conditional update by expected version and an explicit conflict instead of last-write-wins；WP-0023 supplies bounded synthetic integration evidence for that rule。WP-0024 now owns the reusable synthetic-only、parallel-safe isolated PostgreSQL lifecycle and does not create a business seed or production fact。

## WP-0022 accepted decision record

[ADR-0033](../adr/ADR-0033-database-helper-type-tenant-context-boundary.md) and
[WP-0022](./work-packages/WP-0022.md) own the current helper contract under Section 96.
The [original seven-point decision record](./history/README.md#wp-0022-accepted-decision-record)
is preserved for traceability. Archiving progress does not change the accepted helper inventory,
Money/time/Tenant boundaries, ACL, migrations or future business-table ownership.

## Verification and maintenance

For each bounded WP, identify the acceptance questions, affected files and existing checks before
running them. Reuse valid evidence with its command, result, revision/diff and unchanged-input
rationale. A new worktree needs its own valid frozen installation. Run remaining affected checks
once on their final inputs; rerun only after a relevant change, failure or unresolved concern.

Documentation repairs need source/link/format review, not business regression. Tooling changes
need their behavioral regressions, affected consumers and applicable lint/type checks.
Shared contracts, persistence or authorization changes require reassessing integration scope.
Full `pnpm verify` and `pnpm test:integration` belong to the named complete business journey or
release/merge milestone unless a higher gate or concrete cross-module risk requires them earlier.
Mandatory CI remains binding; do not force cache bypass without a specific freshness concern.

Each affected scenario row links its current decision, evidence by layer and remaining dependency.
Every decision has one authoritative disposition record; summaries link to it and distinguish
decision acceptance, implementation progress and observed acceptance evidence.

Customer submission HTTP progress (WP-2402): POST /api/v1/orders now has actual PostgreSQL
Dining/Pickup response-loss recovery evidence for both quote versions. The customer projection
reports Submitted/NotReported only. The production PWA client/controller also passes both-mode real HTTP/database recovery.
Default runtime activation, rendered browser submission and final Inventory-to-Payment readiness remain incomplete; see WP-2402 for commands and evidence.

Checkout detail snapshots now have internal append-only PostgreSQL save/replay/version/Audit evidence in WP-2402. Actual Identity/CSRF and Cart/Quote/details adapter composition now passes both-mode PostgreSQL save/recovery and policy-scope/expiry rejection. An explicit pilot repository now binds the exact saved detail revision atomically with Order/Audit/Outbox, with both-mode rollback and response-loss evidence. Request-local Order repositories now select saved details, enforce current policy and repeat Identity/CSRF authorization around the policy lookup; original replay keeps its original detail revision. Both modes and quote versions have PostgreSQL evidence. Production policy publication and public checkout HTTP/form activation remain open.

Checkout details now also have a customer BFF save handler and production PWA save/retry client,
with actual client-to-HTTP-to-PostgreSQL evidence in both modes and quote versions. Responses expose
a minimal saved acknowledgement only. Current-detail reload now has an authenticated query and production client with both-mode PostgreSQL evidence, preserving the original saved versions. Policy presentation now has an explicit source and authenticated HTTP query, with exact version/deadline binding and no missing-policy default. The real document publisher and customer rendering, plus the actual
CheckoutPage form/full session, remain incomplete; the unconfigured runtime stays unavailable.
