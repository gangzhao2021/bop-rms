# WP-2402 Continuation Evidence — 2026-09-24

Linux exact-tree verification selection (2026-09-24): the latest full root `CI=true pnpm verify`
on this checkout stopped in Vitest on Darwin-specific `/proc`/process-identity assumptions and
sandbox-denied loopback. Acceptance question: does the exact current 42-workspace source tree pass
the repository's existing Linux aggregate gate under the pinned Node 24.18.0 and pnpm 11.13.0?
Inputs are all tracked and nonignored uncommitted files copied to an isolated temporary checkout
with the current Git metadata; `.env` and host-specific `.local` contents are excluded. Create an
empty `.local/` test-fixture parent (the full suite creates and removes its isolated temporary
fixtures there). Use the existing
`CI=true pnpm verify` after a frozen install seeded from the copied package cache; missing
lock-pinned artifacts were fetched from the configured registry. The isolated copy omits ignored
`dist/` outputs, so run the existing `CI=true pnpm build` first to provide the same current-tree
inputs the import-boundary gate expects. Provide test-only Docker access for acceptance suites that
explicitly require Compose. This broad gate is necessary for the
previously unresolved Linux-specific root tests; no production/pilot data or source changes are
inputs.

Private Figma Make and Kitchen recheck (2026-09-24): freshly opened `High-Fidelity Restaurant
Order Prototype` in authenticated Chrome. Its Dining preview, Version 29 chat/history, source tree,
and `src/components/DiningWorkspace.tsx` are readable. The Code view exposes a settable text editor,
but no edit was made, so cloud save persistence remains unverified. Build/model/Send are disabled by
the displayed team-credit limit through September 30, 2026. No Make content, publish state or share
setting changed. In the repository, the current Kitchen production-fail-closed journey passes 2/2;
fresh Queue and Work Item captures at 1440/390/320 were visually inspected with no horizontal
overflow. Dining's `dining-session-start.spec.ts --project=production-fail-closed` passes 1/1;
fresh 1440/390/320 captures confirm the dark Operations header, area-grouped table tiles, current-
session source-limit notice and selected-table panel, with no horizontal overflow. These journeys
verify the migrated visual hierarchy and current route behavior only. The exact Figma Review/project
history, settable editor and quota state are direct UI observations; no new Kitchen source or Figma
file edits were made in this recheck.

Dining Make visual migration verification selection (2026-09-24): freshly opened the authenticated
private Make preview at `/operations/dining` and read its `DiningWorkspace.tsx`. The transferable
visual hierarchy is the Operations shell, compact filter row, area-grouped Table tiles and explicit
status legend; exclude fixed demo date/Store, Occupied/attention states, Session references/age and
synthetic records because the authorized repository source does not supply those facts. Preserve
Registry `DIN-FLOOR-BOARD` / Handoff 88.11 semantics, current `StaffDiningTable` fields, Session
selection/start/recovery/Host transfer, paid-batch blockers and the existing absent-source disclosure.
Inspect the current repository view first, then migrate only hierarchy/styles that remain supported.
Run existing `dining-session-start.spec.ts --project=production-fail-closed` to answer whether the
selected hierarchy fits the actual route at 1440/390/320 and capture screenshots; visually inspect
all three. If presentation changes are needed, run only directly affected Dining page tests,
Merchant typecheck, scoped lint/format, the same browser journey, normal Merchant build and
`git diff --check`. No Dining projection, authority, command or source-field changes.

This companion preserves the detailed selections, implementation results and verification evidence added during the current WP-2402 continuation. These records were moved out of the main Work Package because its original secret-scan size limit is 2 MiB. The headings remain linked from [WP-2402](./WP-2402.md). Relative links retain the same directory context. Screenshot files under ignored `test-results` folders are ephemeral; this companion records their inspection at the time of each run, not current artifact availability.

Private Figma Make access and edit-capability recheck (2026-09-24): reopened the exact private
`High-Fidelity Restaurant Order Prototype` project in the authenticated Chrome session. Preview
loaded the fictional Customer entry for The Elm / Table T-07; the Code view loaded the source tree,
including `src/components/DiningWorkspace.tsx`, and Figma MCP returned source-resource links for
the Make project. In Code view, `src/components/ScenarioPanel.tsx` and `src/data.ts` appeared in
settable text-entry editors, so source editing is available in the current UI. No text was changed;
therefore successful save/persistence is still unverified. The Build prompt, Send and model controls
are disabled with the explicit team-credit-unavailable message through 2026-09-30. Publish and Share
were not used and their settings were not changed. Preview values remain fictional and establish no
backend behavior. Verification selection: record only the current preview, source-tree/editor and
quota evidence; no repository test applies to this read-only external check.

Customer Order Status Figma continuation selection (2026-09-24): Screen Registry
`CUST-ORDER-STATUS` and Handoff 88.6 require Customer-safe Order/Batch progress, ETA range,
ready/exception-safe messages, permission and offline recovery. The regular Operations Design
Review file already establishes the Customer Inter/BOP palette; add only the current `Unavailable`
state at desktop/mobile/compact sizes, preserving its exact retry and navigation semantics and
showing no Order, payment, Batch or ETA facts. Migrate the state-card hierarchy to the existing
Customer PWA page without carrying the Review-only preview banner/navigation into production.
Selection: focused `OrderStatusPage` tests, Customer PWA typecheck/format/lint, and one existing
production-exclusion browser journey capturing 1440/390/320 and checking no horizontal overflow.
No query, authorization, projection, mutation, synthetic business record or other typed state changes.

Customer Order Status Figma continuation result (2026-09-24): created Review frames
[`170:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=170-213),
[`170:245` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=170-245), and
[`170:276` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=170-276). The design
uses the existing Customer Inter/deep-green/neutral hierarchy and exact unavailable-state copy. The
first compact render overlapped text; it was corrected and the final 1440/390/320 captures were
visually inspected. The actual page now uses the same bounded unavailable card with a decorative,
non-semantic warning mark, accessible alert text, the existing retry command, and Back to menu;
the intro is neutral for Pickup and Dine-in. No order or payment facts were added.
The focused OrderStatusPage suite passes 24/24; Customer PWA typecheck passes; targeted ESLint,
Prettier and `git diff --check` pass. The production-exclusion unavailable-state journey passes 1/1,
asserting the token-backed card, 44px retry target, card/link order and no horizontal overflow at
1440/390/320; the retry target is full width on 390/320, and final screenshots were inspected at
all three sizes. The browser's demo-proof build
was replaced by a successful default Customer PWA build. Screenshots:
`1440`,
`390`, and
`320`. The journey uses a
synthetic Entry response and intercepted 503; it does not prove live Guest, Order, Store or PWA
acceptance. Review frames are not an Accepted Screen; loaded/stale/permission-denied/offline and
receipt/pickup/Dine-in journeys remain separate acceptance coverage.

Customer Order Status loaded-view Figma continuation selection (2026-09-24): Section 88.6 and
Registry `CUST-ORDER-STATUS` require customer-safe Order/Batch progress, Kitchen/Fulfillment phase,
ETA range, safe messages and receipt/support actions. The current `OrderStatusView` supports order
number/type, phase, batch/item name/quantity/line total, per-batch Kitchen status, ETA only as
`null`, and individual Payment updates with their own freshness. Design the existing `ready` view
at 1440/390/320 using only the existing intercepted `Synthetic tea`/Order 1001/CAD 25.98 fixture
and mark it synthetic in the Review frame. Preserve the disclaimer that an individual payment
does not establish full payment or refunds; do not invent ETA, pickup proof, Dining eligibility,
or a whole-order Payment state. Apply the neutral Customer Inter/BOP card hierarchy to the existing
renderer without changing its state/authority logic. Acceptance: existing `OrderStatusPage` tests,
Customer PWA typecheck/lint/format/build and the production-exclusion HTTP journey with responsive
screenshots, card/control geometry and no horizontal overflow at all three widths. Intercepted
browser data is synthetic; no live Guest, Store, Payment or Order acceptance is in scope.

Customer Order Status loaded-view Figma continuation result (2026-09-24): editable regular Review
frames `176:213`/`176:247`/`176:281` cover 1440/390/320 and label all example data as synthetic.
The existing ready renderer now uses the Customer Inter/BOP card hierarchy for progress, separate
Payment updates, batch details and refresh actions; it retains the individual-payment disclaimer,
null ETA wording, receipt/support link and existing hidden Pickup proof panel. No state, authority,
projection or command behavior changed. Mobile summary fields stack without overlap. Focused page
tests pass 24/24, Customer PWA typecheck, targeted ESLint/Prettier and default production build pass,
and the production-exclusion journey passes 1/1 with card ordering and no-overflow assertions at
1440/390/320; the screenshots were inspected. The journey uses intercepted synthetic Order/Entry
responses and does not establish live Guest, Store, Payment, Pickup proof or Order acceptance.

Inventory Count List Figma visual continuation selection (2026-09-24): Screen Registry
`INV-COUNT-LIST` (`/operations/inventory/counts`) and Handoff 88.12 define count reference,
scope, type, status, assignee, frozen snapshot, progress, variance and due fields, plus create/
assign/start/submit/approve/reject/cancel intents. The existing page has a versioned projection
contract and source-limited Found renderer, but its normal unavailable client falls back to a generic
state card and no authorized projection is composed. Add editable regular Operations Design Review
frames at 1440/390/320, reusing the established BOP/Inter/neutral hierarchy. Align only the normal
`Unavailable` state with those frames: show the registered field groups with all filters and action
controls disabled, no sample count/task/Store/assignee/snapshot/variance facts, and an explicit owner
projection boundary. Keep Found and every other typed state unchanged. Verify the focused Inventory
Count component tests, Merchant typecheck, scoped ESLint/Prettier, Screen Registry, and a fresh
production-fail-closed browser journey with disabled-control, no-sample and overflow checks at all
three widths; inspect captures against Figma. No WP-2122 projection/query/command, permission,
inventory-domain or external acceptance change.

Inventory Count List Figma continuation result (2026-09-24): the current Figma account reports a
Full seat/admin role, and the editable Operations Design Review file is writable. Created desktop,
mobile and compact frames `136:213`/`136:256`/`136:299` by adapting the established Supplier Review
hierarchy. The default `/operations/inventory/counts` `Unavailable` state now shows the registered
Count status/scope/snapshot fields, disabled filters and disabled Create action, a no-record message,
and the command boundary. No Count, Store, assignee, snapshot, progress, variance or due sample is
rendered; Found and all other typed states remain unchanged. Focused Inventory Count tests pass 6/6,
Merchant typecheck and scoped ESLint/Prettier pass, and Screen Registry validates 210 records. The
new production-fail-closed browser journey passes 1/1 with disabled-control/no-sample assertions and
no horizontal overflow at 1440/390/320; fresh captures were inspected against the Figma frames.
Loopback was denied in the default sandbox and the same journey passed after authorized local
loopback access. The normal page still lacks its authorized projection/query/commands; this Review
and synthetic browser journey are not Inventory acceptance, an Accepted Screen, or project
completion. Figma Make remains a distinct quota/edit/persistence gate.

Customer Menu Figma visual continuation selection (2026-09-24): `CUST-MENU` `/menu` is a resolved
Phase 1 Customer PWA screen under WP-1025/1026/1701/1707/1708. Handoff 88.6 and the Registry define
published Menu/section/Sellable browse, approved localized search, availability, allergen cues, item
detail, cart and Staff-assistance intents. The current PWA provides a source-backed Found view plus
missing-context/loading/empty/not-found/stale/offline/unavailable states; the local demo's exact
fixture is visibly labeled read-only and synthetic. Add editable 1440/390/320 frames to the existing
Operations Design Review file using its established Inter/BOP neutral hierarchy. Migrate the page
title/navigation/section/category/card/help hierarchy and responsive spacing into `/menu`, retain
unavailable-image and final-Quote wording, never claim allergen absence, and do not add prices,
dietary filters, cart counts or other facts absent from the current screen contract. This slice covers
the Found browse view only; Screen Registry Feature Disabled/Permission Denied/Conflict states and
Catalog projection/source acceptance remain separate gaps.

Verification selection: use the focused Customer Menu render tests for disclosure and existing state
copy; add a production-project browser review for the read-only synthetic `/menu` route, accessible
navigation, exact fixture boundary and no horizontal overflow, capturing 1440/390/320. Then run the
Customer PWA TypeScript check, targeted ESLint/Prettier and `git diff --check`. The browser command
rebuilds the demo-proof artifact and uses only repository fixtures; this visual slice does not change
Catalog/API/domain/persistence/permission code or establish Store/Menu acceptance.

Customer Menu Figma Review migration result (2026-09-24): added editable CUST-MENU frames to the
existing Operations Design Review file at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=152-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=152-275) and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=152-337). The editable hierarchy uses
the repository's Inter/BOP palette, the locally labeled synthetic-preview boundary, full-width
section navigation, current-page browse state, published section/card hierarchy, unavailable-image
placeholders, final-Quote wording and explicit allergen/help boundaries. The `/menu` page adopts the
same title hierarchy and navigation placement, marks the current link with `aria-current`, collapses
the empty desktop grid column, and keeps the item-specific accessible link name with a shorter visual
action label. Token aliases are scoped to the Customer Menu shell; unrelated PWA routes are untouched.
The Customer Menu Found/empty/stale/offline/unavailable render states and query projection contract
were not changed; no price, image, dietary filter, cart count or Store fact was invented.

Fresh verification: `src/menu/MenuPage.test.tsx` passes 18/18; Customer PWA `typecheck` passes;
targeted ESLint and Prettier plus `git diff --check` pass. The local-only browser journey
`e2e/customer-menu-review.spec.ts` passes 1/1 and checks the preview entry-to-menu link, focused
heading, current-page nav state, Quote/allergen copy and no horizontal overflow at all three widths.
Fresh inspected captures are
[1440](../../../apps/customer-pwa/test-results/customer-menu-1440.png),
[390](../../../apps/customer-pwa/test-results/customer-menu-390.png), and
[320](../../../apps/customer-pwa/test-results/customer-menu-320.png). Playwright
recreated its demo-proof build for the test; the configured local InternalTest Customer PWA artifact
must be restored before handover. These are synthetic browser visuals, not Store acceptance. The
Registry's Feature Disabled/Permission Denied/Conflict states, Customer Catalog source acceptance,
private Make editing/persistence and whole-project release gates remain open.

## Make-led UI alignment - Orders slice

Owner selected the existing Make UI as the visual/interaction reference while
retaining Handoff business authority. Fresh read-only inspection of Make file
u5gjkcwfARvEqaiUKnCJnp (version29) shows compact desktop Order rows and mobile
stacked rows, restrained phase labels and separate details. Make credits remain
unavailable; no remote prompt, publish or share change is required for this slice.
Apply that hierarchy to the actual CurrentOrderQueuePage at /operations/orders,
not just the demo-only OrderQueuePage. Preserve current cursor/API/permission,
acceptance idempotency and serving/refund behavior. Use native keyboard-operable
disclosures; keep contents mounted so collapsing does not reset in-flight actions.
Single-order pages open their details initially. Do not invent missing Table,
Business Date, SLA or collaborating summary facts. This is a first scoped alignment,
not full visual parity or complete Section88.10 coverage.

Verification selection: focused CurrentOrderQueue render tests, affected Merchant
lint/typecheck/build, existing production queue browser scenarios and responsive
inspection at desktop/mobile widths. Add disclosure keyboard/state-retention checks
to the existing browser scenario. Handoff88.10/88.22/88.24 and Registry
OPS-ORDER-QUEUE govern this work. No domain/persistence change; reuse unaffected
backend evidence, not full repository regression. Record actual outcomes below.

Result: the real current-queue component now uses compact neutral rows with phase
labels, authoritative batch counts and explicit UTC time. Native disclosures keep
existing acceptance/payment/serving components mounted. The Orders-only header is
neutral and compact; shared AppFrame and other pages are unchanged. This adopts
Make's visual hierarchy, not its simulated business transitions or exact desktop
table/detail-pane layout. Search/filter/sidebar were subsequent work at that slice; the
bounded current-page field-supported filters and remaining Registry gaps are recorded
below.

Orders local search/filter follow-up selection (2026-09-23): use the Screen Registry
`OPS-ORDER-QUEUE` fields the current authorized page DTO already provides: exact public
Order number, type, channel and current phase. These controls filter only the currently
loaded server page and must say so; retain the existing server cursor, refresh, mutation
locking, ordering and denial behavior. Never search internal UUIDs or add customer contact
without an accepted permission-trimmed source field. Payment, Kitchen, overdue, exception
and claim facets are still required by the Registry but are unavailable in this DTO; do
not infer them from another Domain or claim this local slice completes the Screen contract.
Keep those source/query gaps explicit for owner-authorized projection/API work. Search
must compare exact order number, not substring. Include accessible filter labels, empty
match recovery and Clear behavior. Keep single-result details open and hide nonmatches
without unmounting their in-flight action state.

Verification selection: add focused page behavior tests and extend the existing production
current-order browser journey for exact-match, available type/channel/phase filters, clear
and no-match recovery. Inspect desktop and 390/320 reflow; run Merchant typecheck, scoped
lint/Prettier and production build. Confirm server pagination/cursor and existing denial,
acceptance retry and serving lock paths remain intact. Only UI/local-page filtering changes;
no API, Domain, persistence, permission or database suite applies. All browser rows remain
synthetic intercepted fixtures, not Store evidence.

Orders search/filter follow-up result (2026-09-23): the live CurrentOrderQueuePage now
offers case-insensitive exact public Order-number search and type, source-channel and
current-phase filters over the loaded response page. It explicitly reports the matching
count and page-only scope, provides Clear and a no-match state, and identifies the required
Registry facets whose authorized fields are absent. Nonmatching rows stay mounted with
`hidden`, preserving action and unknown-outcome state while keeping them out of visual and
assistive-technology results. It does not expose internal UUIDs or query other Domains. All
three production current-order browser tests pass, including ORD-1 exact matching among 50
rows, type/channel/status filters, no-match recovery, Clear, next-page cursor, refresh denial
clearing stale rows, keyboard disclosure and the existing acceptance path. The first
focused run exposed a harness assertion counting hidden DOM rows; its screenshot showed one
visible exact match. The assertion now measures visible rows, and a later journey confirms
an Unknown acceptance remains retryable after its row is filtered out and restored.
Screenshots at 1440/390/320 were inspected; filters and rows reflow without horizontal
overflow. CurrentOrderQueuePage unit tests pass (5); direct Merchant TypeScript, scoped
ESLint and Prettier pass. The browser's configured production build succeeds with the
existing >500 kB chunk warning. Playwright uses synthetic intercepted rows; this is not
Store evidence. Registry-required payment, Kitchen, overdue, exception and claim facets,
sidebar alignment and cross-page/server-side search remain open pending authorized queue
fields and query composition. No API, Domain, persistence, permission or external service
changed.

Fresh evidence:4current-queue render tests, Merchant TypeScript, affected ESLint and
normal Vite build pass. Existing Playwright configuration ran current-order-queue,
dining-serving, dining-order-close and dining-session-close production-project specs:
6passed, including new keyboard disclosure, collapse/reopen preserving Unknown
acceptance intent, and1440/390/320 width checks with no document overflow. Captured
desktop/mobile screenshots were inspected; data came from the existing intercepted
synthetic API fixtures, not a real Store or full database journey. Initial sandbox
server startup failed with loopback EPERM; approved execution passed. A second run
was justified by final header and intent-retention test edits and also passed6tests.
Normal production build was restored after the browser harness. Existing chunk-size
warning remains. No remote Make edits, commit, push or deployment. Frontend-only
dev preview is on127.0.0.1:5175; actual session/API composition is not started by it.
Fresh in-app-browser check of that normal route shows the expected session/Store
required state, not a blank page and not a synthetic successful login. The retained
screenshots under apps/merchant-web/test-results/order-make-alignment-{width}.png
show the authenticated fixture-rendered UI; the bare dev URL cannot substitute for
the assembled local runtime.

## Approved Recipe review corrections - 2026-09-22

Owner approved the four review corrections. First executable slice replaces the
Merchant Recipe demo response shape with a versioned, Brand-scoped view boundary:
projection/as-of/scope/partial/freshness metadata, explicit versioned source coverage,
individually unavailable or permission-hidden summaries, and exact cost with explicit
currency and source basis. Both RECIPE-LIST and RECIPE-EDITOR retain their Registry
routes, disabled commands and existing presentation. Safety-source loss or stale
coverage must suppress Verified, including when the Recipe version itself is unchanged.
No client metadata grants authorization. A future authorized application query must
bind the scope to the current session and trim fields before transport.

Verification selection: focused Merchant Recipe parser/render tests cover malformed
metadata, missing and hidden fields, stale safety evidence, exact non-CAD money and
source-version mismatch. Run affected Merchant lint/typecheck/build and workspace
unit tests; format/diff checks cover changed code and this plan. Database reader,
migrations, dependencies and Customer code are unchanged, so their earlier evidence
is not rerun or presented as fresh. This slice is not the builder, HTTP composition,
browser acceptance or a finished admin workflow. Subsequent builder integration must
prove external-source invalidation and atomic publication in PostgreSQL before use.

Slice evidence: the version2 Merchant parser and rendering changes pass30Recipe
contract/render cases within the fresh complete Merchant unit run (106files,
755tests). The Merchant TypeScript command, full workspace ESLint command and Vite
build pass. Commands used the installed Vitest/TypeScript/ESLint/Vite entrypoints
with pinned Node after sourcing the absolute `.local/activate.sh` path. The first
focused attempt used a relative activation path from the app directory and failed
before running tests; the corrected focused run passed28cases before the final
scope/evidence additions. Vite retains its large-chunk warning; no bundle splitting
or dependency change was made. This is not fresh frozen-install evidence.

View scope is compared to the authorized client's Tenant/Brand after asynchronous
load, and changed client/route render identity cannot display the previous result.
Allergen verification and effective editor review/evidence summaries are withheld
when required coverage is stale/missing; known ingredient hazard text is retained.
Available values bind an exact source coverage version, not a comparison of unrelated
aggregate versions. Future clients must be replaced on session/permission/scope
changes and supply server-trimmed data; no HTTP/session adapter is added here.
The changed hook has type/lint and workspace regression coverage, not a new browser
context-switch scenario. Final browser/responsive acceptance, owner query DTO and
builder/invalidation persistence remain open. No commit, push or deployment occurred.

## Sustained completion: four-workspace draft expansion

Owner explicitly requested sustained whole-project completion on 2026-09-22.
Current slice: replace Kitchen/Dining/Pickup/Exceptions TBDs in the existing private
Make draft `u5gjkcwfARvEqaiUKnCJnp`, preserving Orders. No publication, sharing
change, production activation or credentials. Existing review edits remain in this WP.
Sources: accepted index, Registry KIT-KITCHEN-QUEUE/KIT-WORK-ITEM,
DIN-FLOOR-BOARD/DIN-SESSION-DETAIL, FUL-PICKUP-QUEUE and contextual
OPS-ORDER-EXCEPTION; App routes, kitchen-board.ts, pickup.ts, Pickup forms,
DiningSessionWorkspace and OrderExceptionPage. The complete Handoff source is now
checked into this repository by explicit Owner authorization; its self-reported version
does not replace the composite accepted baseline in the spec index.

Verification selection: actual navigable screens and simulated Kitchen completion,
guarded Dining closure, proof-before-handoff and acknowledgement without financial
resolution. Preserve permission/stale/offline/conflict/Unknown outcomes, privacy and
Orders recovery. Fresh preview checks and 1440/1024/390/320 responsive screenshots;
Make-reported type/build checks are separate. Local docs need format/link/diff checks
only. No local business suites for remote draft changes. Overall goal remains active.

Draft expansion checkpoint: Make version9 ("Implement next expansion phases")
created KitchenWorkspace, DiningWorkspace, PickupWorkspace, ExceptionsWorkspace,
shared App state, fixtures and navigation. Make reports zero TypeScript errors and
successful build; these are its report, not locally executed commands. Fresh browser
read confirms all five navigation entries and actual new screens. Kitchen accept
confirmed and start submitted; Dining blocked example displays unaccepted/unserved
items; Pickup verification enters pending; unmatched exception acknowledgement
does not expose resolution. 320px exception detail screenshot and DOM width both
show no horizontal overflow. These observations are partial acceptance only.

Actual defects submitted for correction: invented Kitchen 30-minute freshness rule;
repeatable already-accepted action; table ID in Session route; inconsistent same-order
fixtures across workspaces and closure eligibility based on preset empty blockers;
invented standalone Pickup/Exception detail routes and missing parent links; concurrent
case mutation during pending; unreviewed exception kinds/severity and prototype clock
drift. Requested current-authority/scenario checks across pending callbacks. Make has
accepted the repair request and is working. No new version is accepted yet. Remaining:
observe repair completion, rerun affected full journeys and Orders recovery, then
responsive/keyboard/read-only checks and source/brief reconciliation. Browser draft
and preview retained for continuation; no publish/share/local business code change.

## Full-project continuation review - 2026-09-22

Handoff sync and resumed source reconciliation: Owner explicitly requested pulling
the newly uploaded source and continuing. Fetch found only03ad510 on the current
tracking branch. Preserve all local tracked/untracked work in stash
`d047cbd3508a4b0177c818b55fdec451906a0726`, fast-forward to03ad510, restore the stash
and merge the spec-index conflict using the new source-availability authority while
retaining local delivery notes. Return the index to its prior unstaged state; retain
the stash as a recovery copy. All17nonoverlapping local files match the stash bytes;
the three overlapping documents retain local work plus upstream additions.
The complete Handoff matches the fetched blob with SHA256
`6dff2faf7cbded05018bcc382bac9cb162a42235498d185cebba6b7704bd74f4`.
Sections50.18/50.20 already specify source/checkpoint reconstruction and atomic
Shadow Table / Version Switch;88.22 supplies Recipe Brand scope,30second target,
urgent allergen invalidation and required response metadata. Withdraw the redundant
request for approval of this general direction. Resolve numeric-checkpoint/source
coverage as an implementation compatibility question, not proof the product lacks
specification. Source availability no longer blocks this work. No existing policy
is reopened and the full0.5.9 baseline is not automatically accepted.
Verification selection: original-source blob and local-change preservation checks,
merged-document conflict/diff/format review and the changed upstream secret-scan
test. No business code changed during sync; prior Recipe unit/database evidence
retains its scoped validity because covered inputs are unchanged.
Sync verification result: merged docs pass formatting and Git whitespace checks;
no conflict markers or unmerged index entries remain. The secret-scan test passes
2tests through its exact Vitest command invoked directly with pinned Node and
fallback Git. The initial pnpm wrapper attempts failed on PATH-selected pnpm version
and automatic dependency reconciliation; they are not successful script runs or
fresh installation evidence. Original Handoff bytes are not reformatted. No local
business change was committed or pushed, and the recovery stash remains retained.

Source availability reconciliation: the preceding ordering proposal remains
unaccepted; the automatic goal continuation is not Owner approval. Fresh bounded
filename searches of this Mac checkout/project parent and Downloads found no complete
Handoff, and connected Drive searches for BOP-RMS and Handoff returned no results.
Correct the spec index's present-tense local-readability claim while preserving the
WP-2336/WP-2400 historical source and composite-baseline acceptance. No newer source
or policy was accepted. Verification selection: inspect index/source references,
format and diff only; unchanged code/database checks are not rerun. Builder writes
remain dependent on the pending source-ordering decision, not on Docker (resolved).

Recipe builder source-ordering review: compare current Eventing envelope, Recipe
payload, namespace1250 Brand checkpoint and Catalog's per-Menu projection producer.
The sources do not establish a Brand-wide Recipe event sequence. Per-Recipe
aggregate versions cannot safely order updates across multiple Recipes. Record the
unaccepted alternatives and required concurrency/replay evidence in
`docs/spec/design/recipe-admin-projection-ordering.md`; pause only dependent builder
persistence until accepted source authority or Owner decision resolves the meaning.
No schema/sequence reinterpretation, inferred watermark or runtime activation is
authorized by this review. Verification selection: cited local source comparison,
new proposal/review links, Markdown formatting and diff only. Do not rerun unchanged
reader/package/database tests for this documentation-only decision investigation.

Recipe admin persistence reader slice: implement internal `load(recipeReference)`
for the existing active checkpoint/generation and exact Recipe projection row in
namespace1250. This is a prerequisite of the complete admin read chain, not its
public query contract or UI completion. Reuse the existing Brand-bound transaction
runner and dependency error. A single SQL statement must bind checkpoint, generation
and row to the same Brand/generation, preserving exact numeric text and timestamps.
Distinguish absent checkpoint from a valid generation with no requested row; reject
inconsistent generation/version/sequence metadata and malformed rows. No freshness
TTL, locale fallback, inferred summary, cost permission, schema, builder, API, HTTP
route, runtime activation or external fact is added. Callers must authorize before
repository access, as with the existing internal Recipe aggregate reader.
Files: new Recipe persistence reader and unit test, module export/README and this WP.
Integration extension: add a synthetic admin-generation exercise to existing Recipe
database acceptance through its test-support helper; no production grant/migration.
Ownership checker requires exact persistence-file admission. Extend its existing
Recipe pattern only for this owner/schema/path and the three declared admin tables,
with negative owner/schema/table/path/driver tests. Run `database-ownership:check`;
do not add a blanket persistence exemption. This tooling change is in slice scope.
Verification: fresh frozen offline install (passes, unchanged lock), focused reader
tests then Recipe lint/type/build/full package tests and changed-file formatting.
SQL joins need isolated PostgreSQL evidence before runtime use; expand existing
`recipe-management:acceptance` for that integration milestone rather than claiming
mocked driver results prove RLS. Existing public consumers remain unchanged. Full
admin assembly still requires builder, authorized query, source mapping and browser
acceptance described in the project review.
Reader checkpoint evidence: final Recipe package tests pass9files/98tests, including
34new reader cases. Recipe lint and TypeScript build pass; typecheck uses that same
`tsc --project tsconfig.json` command. Targeted database/helper/tooling ESLint passes.
Ownership check initially rejected the new file; exact owner/schema/table/path
registration and8negative/positive cases now pass1087tests plus the live validator.
Fresh isolated Recipe database execution was attempted with its existing Vitest
configuration and failed before scenarios at `ISOLATED_DB_START_FAILED`: Docker's
daemon socket is absent. Added persisted-generation/RLS/decimal-scale/checkpoint
scenarios therefore remain UNEXECUTED, not passing. No full composite acceptance or
runtime use is claimed. Source review preserves owner-only parameterized SQL,
single-statement snapshot binding, sanitized errors and no new grants outside the
isolated synthetic fixture. New dependency manifests/migrations and runtime clients
are unchanged. Remaining next action: run that integration when Docker is available,
then complete generation construction and the authorized merchant read contract.
Follow-up database evidence: Docker Desktop was started locally, then the same
`CI=true pnpm exec vitest run --config packages/database/vitest.recipe-management.config.ts`
ran with approved socket access and passed1file/1composite scenario in10.38seconds.
This fresh run includes the new admin helper: persisted generation and exact
9007199254740993 minor-unit/sequence values (including numeric scale normalization),
known-generation/missing-item versus absent checkpoint, wrong-Brand RLS on all three
tables and rejected checkpoint sequence mismatch. Tested HEAD23e5925 plus the
uncommitted reader, helper/acceptance invocation, exact ownership admission and docs
listed above. No relevant source changed after the preceding98Recipe tests,
lint/type/build and1087ownership tests, so those results remain reusable, not rerun.
The isolation harness completed cleanup; a fresh Docker container listing shows no
test containers and only the pre-existing stopped local PostgreSQL container.
The earlier Docker failure is resolved for this acceptance run. The full
`recipe-management:acceptance` composite was not run and no merchant/browser,
generation-builder, authorization-service or runtime activation is certified.

Recipe read-chain reconciliation: source tracing confirms the existing query store
is internal aggregate/operation access, not `recipe_admin_v1`. Migration1250_001
declares generation/row/ingredient/checkpoint storage and event compatibility names
the consumer, but searched apps/packages contain no implementation of that admin
builder/query/consumer. Current projection columns cannot directly satisfy every
editor summary; owning display/usage/review/history sources still require mapping.
Update the module README's present-tense query claim and record the implementation
chain in the project review. This is documentation-only, not a replacement for the
planned runtime work. Verification selection: inspect cited schema/contracts/source,
check changed Markdown formatting, local links and diff. No business suites or
database execution apply to these text changes. Next code readiness requires the
complete public read contract/source map and generation publication acceptance;
do not claim existing aggregate acceptance covers the absent admin read chain.

Merchant composition review slice: inspect normal App routes and default clients,
then reconcile Inventory WP-2120 / DEC-PILOT-INV-01, Recipe WP-2105 and Reporting
WP-2161. This slice changes only the project review and this WP: verify source
references, local links, formatting and scoped diff, not business/database suites.
Fresh source evidence confirms unavailable normal-entry clients for Inventory
items/overview, Recipe list/editor and Report catalog/builder. Inventory's accepted
pilot persistence does not automatically activate its phase_2 workspace or supply
usage/supplier projections. Recipe declares admin projection storage, but a builder,
authorized query and transport still need tracing. Reporting definition persistence
is not report execution. No runtime activation, code completion or new database
acceptance is claimed. The review now defers Figma explicitly in execution order;
next allowed investigation is Recipe's accepted owner read/composition boundary.
Documentation verification: local review links resolve and scoped formatting/diff
checks pass. `pnpm exec prettier` attempted automatic dependency reconciliation and
failed on registry access/non-TTY module removal; formatting instead used the
already-installed Prettier CLI directly with pinned Node. No install success is
claimed by that fallback; re-establish dependency validity before future code checks.

Order-status lifecycle slice: existing HTTP reads recheck CSRF across awaits, but
accepted on-screen/offline Order views do not subscribe to context replacement.
Add the existing optional context-change contract used by receipt/pickup clients,
clear accepted Order state and invalidate in-flight/realtime callbacks immediately.
Advance realtime lifecycle on offline so queued callbacks cannot revive after
reconnect. Scope: order-status client/controller plus tests; no API/schema/token
storage or new authority. Verify targeted controller/client/page tests first, then
affected PWA lint/type/build; reuse unchanged frozen install from the receipt slice.
Broaden to full PWA tests for this displayed-private-data lifecycle change, not
database/whole-repository suites whose contracts are unchanged.
Evidence: the new context-change tests failed for both online/offline accepted
views; queued realtime callbacks also caused3loads instead of1 before the repair.
After implementation, targeted controller/client/page tests passed80tests. Additional
in-flight, observer-release and remount coverage is included in the final full PWA
run:54files/887tests pass. PWA lint/typecheck/build pass with the existing build
deprecation warning only. Frozen install from the preceding receipt slice is reused:
same checkout, toolchain, installation, manifests and lockfile, all unchanged.
Security review: displayed Order data now clears on context change; pending reads
and stale subscriptions cannot restore it. Disposal drops retained view and releases
context observers. No credentials/data are added to storage, logs, URLs or events.
Real HTTP authorization is unchanged. No browser/server/WSL pilot acceptance is
claimed by these unit/rendered-component results; release-wide gates remain open.

Fresh revalidation on 2026-09-23 against the current worktree: the complete Customer PWA
suite passes (54 files / 887 tests); ESLint, both TypeScript projects and the production
build pass. Prettier passes for all six changed lifecycle files and `git diff --check` is
clean. The service-worker build retains the existing Vite `inlineDynamicImports`
deprecation warning. These checks cover the current displayed-data lifecycle changes;
they do not add live browser, API authorization, Store or release evidence. No manifest,
lockfile, API contract or schema changed, so the previously recorded valid frozen install
remains reusable; no reinstall was performed.

Customer PWA lifecycle follow-up verification (2026-09-23): after adding explicit
Order-status session-context observer release/remount, stale realtime callback invalidation,
and Receipt reconnect freshness cases, the three directly affected Vitest files pass
82/82. Customer PWA typecheck and full package lint pass. Prettier passes for the six
changed lifecycle source/test files and this WP; `git diff --check` is clean. An initial
root-config Vitest invocation selected no workspace tests and a `pnpm exec` formatting
attempt tried a network metadata refresh before aborting without TTY; neither produced
test/format evidence. The successful run uses the app's Vitest configuration and the
repository-pinned Node24.18.0/pnpm11.13.0; formatting uses the already-installed Prettier
binary directly. No source, manifest, lockfile, API contract or schema changed during
verification. This is focused current evidence and does not claim the live Guest context
replacement, real device offline behavior, or live receipt authorization/financial facts.

Owner redirect: Figma Make is deferred until credits renew next month. No more
remote edits are scheduled now; the320px scenario-toolbar defect is observed but
NOT implemented. Current work returns to repository delivery, not prototype polish.

Next bounded code slice: CUST-RECEIPT-SUPPORT offline/reconnection freshness in
`apps/customer-pwa/src/receipt/receipt-controller.ts` and its tests. Registry88.6,
customer AGENTS Section87.3 boundary and existing receipt rendering distinguish
immutable history from current payment/delivery/eligibility. On network loss retain
history but revoke those live fields; reconnect must not restore them without a
successful authorized load. No API/schema, email, Provider, cache or mutation change.
Verification selection: focused receipt controller/client/render tests, affected
workspace lint/type/build and formatting. Restore frozen installation first because
pnpm reported uncertain dependency state; this is not reuse of the earlier install.
Full-repository release regression remains a later merge/release milestone, not
required for this isolated read-state repair with unchanged external contracts.
Receipt repair evidence: frozen offline install passes across42projects with pinned
Node24.18.0/pnpm11.13.0 and no manifest/lockfile change. The added lifetime test first
failed on retained Fresh/payment/eligibility fields, then all38 receipt controller,
HTTP-client and rendered-page tests passed after the10-line controller repair.
Customer PWA lint, both TypeScript projects and production build pass; build emits
an existing inlineDynamicImports deprecation warning. Scoped Prettier passes.
Final source diff is two receipt files only, with immutable records retained and
no new storage, permissions, requests or background replay. No live browser/WSL
pilot receipt observation or full-repository regression was run in this slice.

Responsive scenario-tool selection: fresh320px screenshot shows the bottom-floating
scenario menu clipped above the viewport and the trigger covering menu-item text.
Move the prototype control into a normal-flow toolbar, constrain menu height with
scrolling, and add focus/arrow/Home/End/Escape behavior. Verify320/390/1440 screenshots,
DOM overflow and keyboard navigation; this affects CustomerApp presentation only.
Current source ZIP is absent from Downloads; pageAssets cannot bundle scripts.
Owner has been asked asynchronously for a Make code ZIP so full type/build/tests
can run. Do not count this export limitation as a completed verification gate.

Customer scope/history repair selection: add explicit synthetic Tenant/Brand/Store/
DiningSession/Guest scope to context, committed intent and Dining session. Scope
comparison must not infer authority from table labels or rotated session tokens.
Retain inactive scoped snapshots and terminal operation history; revalidation may
restore only an exact scope match, without exposing another scope's cart or orders.
Invalidate stale entry callbacks, preserve denied context facts, and fence order
reads/status refreshes. Verify direct production transitions for each scope mismatch,
same-scope recovery, inactive-state preservation and immutable intent clock. This
is private in-memory prototype behavior, not server authorization or persistence.
Independent verification uses exact extracted scope/confirmation/continue-ordering
functions in ignored `.local/customer-scope-review.ts`, plus refreshed authority and
scenario extraction tests. Input aliases are not full TypeScript evidence. This
selection covers individual ownership changes, retained snapshots, stale validation,
terminal records and pending recovery; full Make type/build/tests remain unexecuted.
Result: all15 native Node authority/scope/scenario tests pass on the final extracted
functions. Six remote files (types, EntryContext, pureLogic, transitions, CustomerApp,
logic.test.mjs) have exact editor readback. Fresh browser: Fries1/CAD10 -> Unknown
quote QDF6NRR with deadline9:54:14PM -> Session Expired -> Normal (still requires
entry) -> explicit verification -> cart remains locked -> same quote/deadline on
payment page -> Check status -> ORD-DF7LEV -> session shows exactly1 paid batch/CAD10.
The generation used for a status-query callback is the current query generation,
not the original submission generation; the intent identity/clock remain unchanged.
Cross-scope UI controls, full source/type/build/regression execution, merchant46
callback acceptance and responsive/accessibility review remain open. No real
Provider/server authority, publication or production completion is claimed.

Scenario payment-fact selection: prevent payment_unknown from reopening failed
outcomes, and stop payment_timeout from rewriting the committed deadline. The
existing payment callback already simulates timeout for that scenario. Update the
old epoch-deadline test rather than retaining an assertion for incorrect behavior.
Use exact extracted applyScenarioChange under native Node for terminal preservation,
original-clock preservation and pending-to-unknown simulation; remote full tests and
actual timeout UI remain separately required. No business-runtime/dependency edits.
Result: exact extracted function in `.local/customer-scenario-review.ts` passes all3
native Node tests via `node --test .local/customer-scenario-review.test.mjs`.
Remote pureLogic/tests have exact editor readback. Fresh browser entry -> Fries1
CAD10 -> quote QDEVJ2J -> payment_timeout -> simulated payment yields the explicit
timeout failure. Switching that same operation to payment_unknown preserves the
failure message and quote reference, with no Pay or status-query button. This proves
the observed terminal UI regression fixed, not full payment/history acceptance.
Remote full type/build/test run and cross-context history isolation remain open.

Payment callback guard selection: current applyPaymentResult accepts failed outcomes
and does not recheck write-blocking scenarios. Repair current-authority and terminal
guards using the existing canWrite helper with an explicit captured clock; reject
malformed expiry values and outcome/intent reference mismatches. Add tests importing
these production functions, inspect editor readback and available browser behavior.
Full remote test execution remains unavailable with exhausted Make credits; do not
represent source inspection as passing tests. Scope/history acceptance remains open.
Independent fallback selection: copy the exact two edited authority functions into
ignored `.local/customer-authority-review.ts` with input-only type aliases and use
pinned Node's native test runner on `.local/customer-authority-review.test.mjs`.
This covers expiry boundary, malformed dates/clocks, current scenarios and context
authority without installing dependencies; it does not cover payment transitions.
Result: all3 native Node authority tests pass. Edited pureLogic.ts, transitions.ts
and logic.test.mjs were saved and exactly read back from the Make editor. Seven
new remote regression cases import production functions but have NOT been executed.
The preview still renders the entry screen after hot reload, which is not a full
type/build result. Scenario-driven terminal rewriting and scope/history restoration
remain separate known gaps; this callback fix does not close those acceptance items.

Manual entry callback repair selection: EntryContext compares two values from the
same captured render, so its stale-generation check is ineffective. Replace this
with request invalidation and timer cleanup on scenario/generation change and
unmount. Verify exact editor readback and browser normal entry plus cancellation
during validation. This is fresh component-level evidence, not a full type/build
or payment-scope acceptance; unchanged repository business suites are not applicable.

Entry repair saved in the existing Make editor with exact full-file readback:
request ID invalidation, synchronous lifecycle cleanup and timer-ref duplicate guard.
Fresh preview normal confirmation reaches Menu. During another validation, the
scenario action actually landed on menu_loading (not the requested QR Denied);
entry remained unconfirmed after the old timer window, then Normal still required
an explicit new confirmation. This supports cancellation on scenario change only.
Denied-specific, unmount and full type/build checks remain open; no Make run is
active because credits are exhausted. Payment scope/history repair is still pending.
Docs checks: direct installed `./node_modules/.bin/prettier --check` on this WP
passes; git diff whitespace check passes. The attempted `pnpm exec prettier` did
not reach Prettier: pnpm attempted dependency repair, then aborted on network/non-TTY.
No installation retry or dependency change was performed; installation validity must
be re-established before relying on future code-suite evidence.

Customer main-screen priority: Owner identified the missing QR ordering experience.
Authorized private draft extension stays in this WP and the same Make file. Resolve
CUST-ENTRY-CONTEXT at `/`, CUST-MENU `/menu`, CUST-MENU-SEARCH `/menu/search`,
CUST-SELLABLE-DETAIL `/menu/items/:sellableId`, embedded CUST-SELLABLE-CONFIGURE
and CUST-ALLERGEN-ASSIST, and CUST-CART `/cart`. Sources: Registry88.6 and
customer-pwa EntryContextPage, MenuPage and CartPage. Public permission still requires
exact Guest/Store/journey context. Organization owns entry, Catalog menu/configuration,
Ordering cart; no real service or authority is supplied by simulated draft state.

First customer slice implements these screens with synthetic table context, menu
assets, option validation, exact minor-unit estimates, cart edit/remove/clear-confirm,
and scoped loading/empty/not-found/denied/disabled/stale/offline/conflict/failure
recovery. Entry expiry revokes mutation capability; a dish note never carries allergy
authorization. Checkout/payment/status remain the next contract-bound slice, not a
fake success action. Preserve all merchant handlers and fixtures; customer code must
be separate with minimal route wiring and no merchant shell on customer screens.

Verification selection: fresh generated-source review and browser entry-to-cart,
required options/sold-out/read-only/expiry/cart totals; mobile320/390 and desktop
responsive screenshots, keyboard/focus/error association. Make type/build reports
must be distinguished from independent tests. Re-run merchant callback coverage if
App routing changes affect its actual callbacks. Version21 four-command repair is
generated (App only,196added/127removed), not independently accepted yet. Customer
UI construction does not close that review or overall release gates.

Customer slice dispatched to the existing collaboration tab; latest Make task has
visible Stop control and is planning separate customer files. This is a live run,
not a finished artifact. Scoped Prettier check on this WP and the updated brief
passes; git diff whitespace check passes. Next: observe this same run, verify actual
root/menu/cart behavior and assets, then resolve checkout/payment/status continuation.
No customer screen or test is accepted from the generation plan alone.

Version22 generated13files; Make reports67tests (42existing/25customer) and a461kB
build. Independent browser: root confirmation reaches `/menu`; required Burger
doneness rejects an incomplete add; Well Done+Bacon quantity2 produces CAD44.00
and cart quantity2. Editing that actual line incorrectly resets quantity to1 while
retaining options; accessible action says Add despite visible Update. Menu/cart
lack h1, empty-cart access and detail return are missing, and seven scenarios do not
cover the requested states. Choosing stale/offline resets to entry instead of keeping
the existing cart available read-only. Customer address also diverges from the
fictional merchant location. A390px cart screenshot exposes low-contrast secondary
copy and excess framed summaries/rounding; this is not responsive acceptance.
Submitted these concrete repairs plus expiry/current-authority and merge regression
coverage to the same Make task; Stop is visible. Viewport override reset. Keep
Version21 merchant callback/source acceptance and customer full state/mobile review
open. Agent preview retained for continuation; no publish or business runtime change.

Version23 reports83tests/type/build passing. Fresh browser reproduces and confirms
the quantity fix: Well Done+Bacon quantity2/CAD44 -> Edit retains2 -> Update still2/44.
Menu now has h1/Open/CAD/empty-cart access and filters; cart h1 appears. Offline
preserves2/44 read-only with no edit/remove/quantity/clear controls. However,
Session Expired -> Normal restores all cart mutation controls without entry verification.
That is a failed authority acceptance, not covered by the reported83tests. Submitted
a narrow persistent-revocation/context-generation repair with actual CustomerApp
transition tests (expired/denied roundtrip, explicit revalidation, old async response).
Stop is visible. Customer source acceptance remains open.

Fresh merchant smoke during the isolated customer change: customer-to-Operations
switch works; KT-001 accept -> Unknown -> same retry -> Accepted, then Start ->
Unknown again. This demonstrates recovery does not automatically authorize the next
action in that UI sequence; it does not replace the outstanding46callback suite.
Read and resolved next customer checkout/payment/status contracts in the brief using
Registry, actual customer pages and accepted DEC-H03-DINING. No checkout implementation
dispatched while the authority defect remains. Scoped brief formatting passes.

Version24 reports93tests/type/build passing, adding persistent context expiry/revocation
and a shared scenario transition used by CustomerApp. Independent browser confirms
Truffle Fries1/CAD10 -> Session Expired -> Normal remains read-only with the same
cart; Return to entry displays explicit verification. This closes that observed
roundtrip defect only; denied recovery, source tests and complete responsive/accessibility
acceptance remain open.

Next customer slice: implement CUST-CHECKOUT, CUST-PAYMENT, CUST-CHECKOUT-RESULT,
CUST-ORDER-STATUS and eligible Dine-in batch continuation using the resolved brief.
Keep it a separate in-memory simulated customer transaction flow, with no merchant
fixture mutation, Provider calls or real financial facts. Verification selection:
cart/version-bound Quote, expiry/reconfirmation, integer money/tip, same-operation
Pending/Unknown recovery, late callbacks after authority changes, independent payment/
order/kitchen facts, and prior paid-batch preservation. Fresh directly imported
production-transition tests and actual browser journeys are required; Make reports
alone cannot close these criteria. Keep remaining menu/source/merchant checks open,
and do not repeat unrelated repository business suites for this draft-only scope.

Version25 reports139tests/tsc/build passing, but its implementation used a cart hash
as version and invented13% tax. Queued correction completed as Version26, reporting
140tests/tsc/build passing: monotonic cartVersion, zero synthetic tax/fee and payment
timer moved out of state updater. These remain Make reports, not local verification.
Independent stable-browser journey `/` -> confirmed entry -> Truffle Fries1/CAD10 ->
Cart -> Checkout succeeds. Checkout retains obsolete13% label despite zero tax.
Proceed to payment immediately shows `Your session is no longer active` and no Pay
button despite a newly established normal context. Therefore the normal transaction
journey fails and the140pure tests do not prove UI wiring. Submitted focused
component/guard/prop investigation and rendered/full-journey regression, with explicit
instruction not to remove authority checks. Task Stop is visible.
Source export attempt still has no confirmed local archive; do not report download
success or latest-source local test execution. Earlier extracted copies are not the
current customer implementation. No simulated payment was executed in this journey.

Version27 fixes the optional-isRevoked default (undefined was treated as revoked)
and quote copy; Make again reports140tests/type/build passing. Fresh browser now
executes the first simulated CAD10 payment and creates ORD-DDKLTM, paid Batch1 in
the same Dining Session. No real payment/Provider call occurs. Second batch2/CAD20
enters Unknown for Quote QDDLEIJ with original deadline9:09:59PM. Cross-route
counterexample: View cart -> increase quantity3/CAD30 -> Checkout produces QDDMM7N
-> payment shows a fresh CAD30 Pay button, losing the unresolved CAD20 operation.
Thus complete transaction acceptance fails despite the successful first payment.

Submitted shared-transition/handler repair: freeze all mutation/requote/tip/new-batch
paths while Pending/Unknown, retain immutable original payment/item/Quote snapshot
and clock, restore only the same operation, preserve terminal history and earlier
paid batches. Tests must exercise these actual shared transitions and duplicate
recovery/late-result cases, not only canSubmitPayment. Stop visible; no acceptance
claim for second-batch recovery. Existing browser remains on the counterexample for
continuation. No real checkout or financial operation was performed.

Version28 reports159tests/type/build passing. Independent full editor-source read
of CustomerApp (21189characters) and logic.test.mjs rejects the claimed application
regression: tests locally define applyCartChange/Requote/TipChange/ContinueOrdering/
PaymentResult marked `Simulate`, while App has separate inline handlers. This repeats
the earlier duplicate-implementation test defect;159 is not accepted as application
transition coverage. Actual App still builds payment batches from live s.cart/s.quote,
context confirmation clears intent/outcome unconditionally, and result handling lacks
current authority/expiry/scope checks independent of generation. Submitted a bounded
production-transition extraction used by both App and direct tests, immutable payment
snapshot/history and same-scope recovery. No local source edit races the active Make
run. Stop visible. The editor's `Open <path> in the code editor` diff control reliably
selects a file; tree clicks had returned the previously open file. Clipboard source
inspection is current evidence; there is still no verified latest local archive.

During the active extraction, queued two contract corrections for the same Make run:
recovery scope must include stable Tenant/Brand/Store/DiningSession/Guest ownership,
not just tableNumber or a refreshed session token; and actual parseTipCents uses
parseFloat followed by Math.trunc, accepting trailing junk and potentially converting
1.15 to114minor units. Require strict decimal-string parsing, maximum two fractional
digits, nonnegative safe integers and overflow checks; old truncation tests are not
valid requirements. Both queued items are visible. No corrected-source or test claim
until the main run and these queued corrections complete and are independently read.

Version29 reports170tests/type/build passing and creates transitions.ts; generation
is terminal (Stop absent). Make AI credits are exhausted; queued scope/money corrections
have not executed. Manual money repair selection: current editor parseTipCents and
applyTipToQuote only; strict decimal-to-minor units and checked integer addition.
Use a local ignored extraction of the exact helper text for focused fresh Node tests,
then exact replacement in the existing private editor and readback equality. This is
not a full prototype type/build run and does not close scope/history defects.

Manual money repair complete in current Make pureLogic.ts: decimal-string/BigInt
parsing, at most2fraction digits, safe-integer bound and validated tip/total addition.
Local exact helper extraction `.local/customer-money-review.ts` with
`node --test .local/customer-money-review.test.mjs` passes3/3. Editor full-file
readback equals the intended patched source; changed existing truncation test to
reject fractional minor units and added boundary tests importing production helpers.
Those remote test additions have not been executed (AI quota exhausted).
Fresh preview Checkout: CAD10 item + custom1.15 displays tip1.15/total11.15; entering
1.005 does not change that total. Missing explicit field-error feedback remains a UI
follow-up, not a reason to accept malformed input. No payment submitted in this check.
Full remote build/type/test evidence predates this manual edit and is not reused as
proof for it. Scope recovery still uses table-only matching until separately repaired.

New-session Make version20 finishes: reported `npx tsc --noEmit`0errors,
`pnpm build`413kB JS/17.8kB CSS and `npx tsx src/logic.test.mjs`42/42. These are
Make's reported executions, not local runs. Its only reported edit removes Dining
expired/ratelimited JSX branches: local type and simulator inspection confirms those
outcomes map to failed and are outside DiningActionOutcome. Mirrored the two-line
removal locally. Future delegated commands explicitly require pnpm rather than npx.

Remaining command-intent acceptance selection: actual App callbacks for Kitchen,
Dining-close, Handoff and Exception must reject unsolicited retry, fresh submit while
Unknown and retry adopting a newer source version. Extend the existing local harness;
prior retry-race tests now first establish an actual Unknown original request. Fresh
suite39:27pass/12fail, three failures for each of those four command families.
Submitted bounded App intent/version/pending/Unknown repair to new Make session;
Working/Stop is visible. It must preserve Orders/start/proof fixes, recheck existing
guards, prohibit conflicting per-case exception actions, and not claim execution of
the local harness it does not have. No new results are accepted before source diff
and independent callback verification. No simultaneous local App edit during that run.

Orders callback verification selection: extend existing App harness for same-generation
version drift, accepted-batch replay, unsolicited retry and Unknown identity/version
retention. Initial27 tests:23pass/4fail. Fix only acceptance handlers/state; rerun
affected callback suite, then export equality and browser Unknown recovery. Core,
fixture and money code are unchanged; their evidence remains reusable. Full React
typecheck remains unavailable and must not be inferred from transpiled callback tests.
Fresh local callback suite passes27/27 after retaining initial acceptance version,
blocking fresh submission during Unknown and rejecting lost eligibility/version drift.
Changes manually synced to App. Owner supplied a new collaboration session for the
same Make file on2026-09-22; its enabled AI prompt and code editor were inspected.
That session's App contains acceptanceVersions, diningStartIntents and proofGeneration
at50173 characters, matching the manual editor result length. This is signature/length
inspection, not byte-for-byte export comparison. Previous Downloads archives are no
longer present; ignored extracted review copies remain. Do not claim a new download
was verified where its file could not be found.

New collaboration AI task is visibly Working/Stop available: preserve current source,
run existing full TypeScript/build/core tests, fix only compiler/type errors without
weakening checks, changing behavior, upgrading dependencies or publishing. Remote
commands/results and any generated diff are still pending independent review.

Cross-workspace fixture verification selection: Kitchen currently names unrelated
items under existing Orders IDs, queues the cancelled DEMO-1003 supplemental batch,
and claims DEMO-1004 was voided despite unavailable phase. Correct the synthetic
Kitchen fixture relationships without rewriting accepted Orders fixtures or inferring
payment/service from Kitchen completion. Add direct fixture tests for known parent,
item/modifier/quantity match, accepted-versus-cancelled batch and creation chronology.
Run those tests plus callback/money checks and strict data/core tsc because fixture
inputs change; inspect updated Kitchen preview. This is not a live cross-domain adapter.
Fresh fixture suite initially2pass/5fail, then7/7 after correcting Kitchen parent
references, matching items/modifiers/quantities and cancelled supplemental state.
Callback23 and money4 rerun pass; strict core/data tsc exits0. Archive(10) data.ts is
byte-identical to local source. Final age-only KT-006 correction5100 seconds is not
an input to those tests and does not invalidate their evidence. Preview KT-003 shows
DEMO-1003/Tiramisu2/Cancelled/no further action; no prepare/accept controls remain.
Orders fixtures are unchanged. Ticket subsets are not a claim of full order routing,
and independent PU-prefixed fixtures still lack a shared Orders lifecycle adapter.

Money verification selection: exported Make fixtures calculate subtotals with
parseFloat and OrderDetail formats amounts through floating point. Replace only
those existing helpers with exact minor-unit/string operations. Add direct tests
of exported fixture helper and actual transpiled OrderDetail formatter, including
amounts beyond safe integer precision and malformed input; retain null Unavailable.
Run focused money suite, affected core/data strict tsc and callback suite because
fixture construction is an App input. No pricing/tax/currency policy change.
Fresh results: money4/4, callback23/23 and strict core/data tsc exit0. Archive(9)
data.ts and OrderDetail.tsx are byte-identical to the tested local copies. Browser
DEMO-1001 retains line prices18.00/8.00/9.00/7.50 and subtotal CAD51.50. Age-hours
toFixed calls remain because they are not monetary values. Core logic42 evidence is
unchanged/reused; full React typecheck and build are still not claimed. Money and
callback harnesses remain ignored local review tools, not committed product suites.

Whole-project source checkpoint: Communication normal-route tracing reaches WP-2145's
explicit no-accepted-persistence-namespace/runtime-inactive gate, not an implemented
API waiting for UI wiring. Existing public projections and authorize ports are present;
normal merchant client is load-only and API/database composition is absent in the
targeted search. Project completion review now records the bounded proposed activation
sequence and keeps read acceptance separate from sends/commands. No business code,
namespace, migration, Provider or deployment changed. Owner clarification requested;
no approval inferred. Verification selection: inspect source links and changed Markdown,
run scoped Prettier and diff whitespace check only. Business suites are not applicable
to this documentation/source-classification slice.

Next callback acceptance question: proof recovery must retain the original order
version, reject unsolicited/overlapping retries, and invalidate pending or verified
proof when the selected proof scenario changes. Extend the existing App callback
harness with counterexamples; run only that affected suite and the corresponding
Pickup browser flow after synchronization. Core conversion checks are unchanged.

Pickup callback checkpoint:4 new counterexamples initially fail (late proof on a
newer order, unsolicited/duplicate retry, proof-scenario roundtrip, retry adopting
a newer version). App now retains proof version, checks current proof generation,
requires Unknown before retry, blocks pending duplicates and invalidates proofs on
scenario change. Added a positive unchanged-Unknown recovery/revocation test.
Local23/23 passes; archive(8) exported App also passes23/23, differs from local only
by a trailing blank line. No shared core/type/data change; full React typecheck
remains unverified. These checks control hooks and simulator responses and do not
claim real provider credentials or production authorization.
Fresh preview PU-001: Begin verification -> Verification passed and confirmation
controls; switching proof scenario to Expired revokes that proof and restores
Verification required/Handoff blocked. No items were handed off in this check.

Dining retry verification: three fresh callback counterexamples initially fail:
missing retained start identity, unrelated occupied Session treated as success,
and retry without an original start. App now retains the intended Session ID,
passes explicit recovery state, rejects unrelated occupancy and prohibits fresh
dispatch from retry. Local and Make archive(6) App callback suites pass18/18.
Core42 evidence remains reusable because core/types/data have not changed.

UI consumer audit finds start outcomes read using the table key instead of `new:`
and no Unknown recovery control. Empty tables also still used a Session route.
DiningWorkspace now uses local floor selection for empty/blocked tables, reads the
correct command outcome, exposes recovery/errors, disables fresh start while Unknown,
and navigates to the actual Session after linkage. Archive(7) component equals local
source byte-for-byte. Fresh browser Unknown-start/retry journey is the selected
acceptance check; no complete React typecheck claim. Normal Orders acceptance after
the preceding generation repair was observed v1->v2/Accepted in the browser.
Fresh Dining browser acceptance passes: select T-04 while URL remains the floor;
start -> Unknown with fresh-start disabled and recovery button visible; recovery ->
T-04 Occupied/SES-101 and URL `/operations/dining/sessions/SES-101`. No reload or
second Session creation was needed. This remains a synthetic in-memory journey.

Callback verification selection: execute the actual exported App.tsx after TypeScript
transpilation with controlled React hooks/JSX, deferred simulator responses and fake
timers. Keep real commandCore and fixtures. Assert state and outcome after concurrent
version changes, missing entities, proof expiry, unresolved close blockers and reset.
The harness is local review tooling, not a replacement React/browser/typecheck suite.
Use pinned `node .local/figma-make-review-1855/src/app-callback.test.mjs`; no new
dependencies, package scripts or repository business-code changes.

Fresh callback evidence:15 tests against actual transpiled App with real core/data.
Initial12 four-workspace cases pass; three new Orders reset cases fail (old accept,
retry and refresh mutate the permission-denied reset state). Added captured-generation
checks and hook dependencies to those three handlers. Local rerun15/15 passes.
Sensitivity check against1906 pre-fix App:1pass/14fail, confirming the harness catches
the rejected-transition success bug as well as the Orders reset race. Make App updated
manually; archive(5) re-export differs only by trailing blank line; the same15 tests
against that exported App pass. These are controlled callback tests, not React mount,
browser race, complete typecheck, backend authorization or full integration evidence.
Harness stays in ignored local review storage; no production code imported.

Manual Make synchronization at19:06: downloaded archive(3), extracted only src to
`.local/figma-make-review-1906`. `diff -u` against the tested1855 local copy exits0
for commandCore.ts, types.ts, data.ts and logic.test.mjs. This supersedes the local-only
label below for those four files. Reuse42/42 native Node and strict core/data tsc
evidence: byte-identical source, same pinned installation and unchanged manifests.
No AI credit purchase, publication, backend connection or repository source import.

Next verification selection: App callbacks must not report success after a shared
transition rejects or the target disappears. Edit only affected four-workspace
callbacks, inspect every normal/retry branch, run available TypeScript checks and
fresh affected preview journeys after manual synchronization. Existing core tests
remain valid unless core inputs change; full application build is not yet verified.
Retry identity and Orders/proof callback races remain separate open findings.

App failure propagation checkpoint: normal/retry Kitchen, Pickup, Exception and
Dining-close callbacks now report rejected transitions and missing targets rather
than success; Dining-start detects changed occupancy. Downloaded archive(4) App.tsx
matches local edits except one trailing blank line. Fresh preview renders Kitchen
after reload. Full React tsc attempt exits2: the isolated review copy cannot resolve
react/react-router-dom/types (the repository merchant app uses react-router, not this
Make dependency set). Do not treat cascading diagnostics as a passed app typecheck.
No package installation or lockfile change performed. Application callback behavior
tests and affected browser regression remain required before accepting this slice.

Local exported-draft checkpoint: native pinned Node executed the original18:55
shared-module suite36/36. Added contract counterexamples plus corrected Dining start
expectation:42tests initially35pass/7fail. Manual apply_patch changes in ignored
`.local/figma-make-review-1855/src/commandCore.ts` now block offline retry success,
terminal/invalid Kitchen transitions, unresolved/terminal Dining closure, nonfinal
Exception resolution/reopening, and handoff after proof expiry/cancellation. Start
preserves table operational Available and creates occupancy only via activeSessionId.
The valid Exception success fixture now explicitly supplies sourceFinalized=true.
Fresh same-command rerun passes42/42. These changes are LOCAL ONLY, not synced to
Make, and do not prove application callbacks/UI integration. Original downloaded
archive is retained unchanged. Next targeted check: existing pinned tsc CLI against
commandCore/types with strict noEmit; review consumers and normalize residual
Occupied operational fixtures/types before remote synchronization and browser checks.

Local prototype-source verification selection: Make18:49 tests duplicated application
logic and contained a self-comparison assertion; reject them as application evidence.
Make18:55 now exports commandCore.ts used by App and directly imported by logic.test.mjs.
Preserve the downloaded snapshot and extract only src files to ignored local review
storage. Run the existing `node src/logic.test.mjs` invocation with pinned Node24.18.0
(native erasable TypeScript support), without running downloaded installation/deploy
scripts or changing repository dependencies. This tests the exported synthetic draft,
not the actual BOP-RMS runtime. Review contract counterexamples separately before
acceptance; a passing generated suite cannot override source contracts. Current
source already shows DiningStart assigning Occupied to table.status, despite the
accepted operational state / active Session separation; this remains a correction.
Figma now reports AI credits exhausted until September30, but the already-running
18:55 task completed; future AI generation must not be assumed available.

Navigation repair at18:42 passes fresh four-workspace aria-current checks, Kitchen
detail routing, browser Back to Pickup and Forward to Exceptions. Permission change
during Kitchen acceptance leaves Access denied visible, but this does not prove
callback cancellation; no such stronger acceptance is claimed.

Read-only source audit: Figma get_design_context returned source resource links, but
resource reading returned Unknown resource. The existing Make Download code action
produced `~/Downloads/High-Fidelity Restaurant Order Prototype.zip` at18:45, despite
the browser download observer timing out. Local archive inspection confirms37files;
SHA256 `28ccb6afdb0b7f6ba7f37e1433c1fdcd04c64681a5219791a1f991d5c8f1219d`.
No downloaded toolchain/deploy scripts were executed and no source was imported into
the application. This snapshot predates the repair currently running.

App.tsx audit confirms missing current-generation/version checks in async callbacks,
Kitchen accept retry falling through to Completed, and handoff handlers relying on
UI proof/quantity gates. Submitted coordinated generation/intent/version protection,
correct accept retry, command-level quantity/proof validation and executable regressions
against shared implementation rather than duplicated test logic. Make is editing the
same draft. Tests remain unexecuted/unverified from this coordinator's perspective.
Further confirmed gap: DiningWorkspace's Start session button invokes the start
action, but App's normal/retry success handlers only implement close. Start cannot
create/link a Session despite its success copy. Queue this correction after current
handler edits, with real simulated state transition and duplicate/authority coverage.

Exception source-ownership repair fresh verification: EXC-002 Resolve changes case
Assigned->Resolved/open4->3 while Reconciled, Compensation Requested and sourceFinal
Yes remain unchanged. Four-workspace stale/offline checks expose no mutation controls
in Kitchen/Dining/Exceptions and disable Pickup verification. Permission-denied
scenario hides workspace data in all four and names their required permission.

Current tab5 responsive observations:1440x960 Kitchen board,1024x900 Dining SES-003,
390x844 Pickup confirmation and320x740 Exceptions detail have matching DOM widths
and no horizontal overflow in screenshots. This is a representative page/size matrix,
not every state at every size. ScenarioPanel Escape closes the dialog and restores
focus to its trigger. Initial390 screenshot compositor scaling was rechecked against
visualViewport scale1/main width390 and a fresh correctly framed screenshot.

Remaining defect: sidebar current state lags navigation. Kitchen/Dining screenshots
retain Orders highlight; after Exceptions->Dining the URL is /operations/dining but
aria-current=page remains on Exceptions. Requested reactive route-based desktop/mobile
highlight including detail and browser-history navigation, without business changes.
Make repair running. Reset viewport; retain Make and tab5, close older preview tabs.
Broader keyboard/accessibility and untested scenario combinations remain unverified.

Fresh follow-up after Make18:33 and18:35 fixes: PU-0047of8 handoff now stays
InProgress with6active and no duplicate handoff; PU-007 identifies2known-ready
plus1unknown and still blocks handoff after Passed proof; PU-002 full2item handoff
reaches Completed/read-only and5active. Kitchen KT-001 accept/start/complete now
has queue2/2, each item1/1, Completed/read-only and Cold active0. Command timestamps
remain within the fictional Business Date. These are observed simulated flows.

Orders regression against the current shared App passes normal acceptance(v1->v2),
Unknown recovery to Accepted, and Conflict refresh(v1->v2 while still Not accepted)
followed by explicit acceptance(v3). No automatic acceptance from refresh observed.
EXC-002 source-final resolution becomes read-only and decrements open count, but
also changes financial Reconciliation Pending->Reconciled. Requested a bounded
fix: case resolution must not manufacture source-owned reconciliation/compensation
facts; reconcile the initial final-source fixture and leave those facts unchanged
on Resolve. This repair is running; exception acceptance remains incomplete.

Responsive tooling follow-up: retained preview tab3 ignored requested1440/1024 and
remained1280. A fresh dedicated preview tab4 measured1440 after the same override;
no target-size screenshot acceptance is claimed yet. Override reset. Continue
responsive/keyboard and cross-workspace authority checks after the current repair.

Make "Align Pickup Handoff Form" at18:31: fresh browser confirms per-item2/4/1
quantities, recipient selection, fictional S*** and matching checkbox; submit is
disabled until both confirmations. However, PU-004 handing over7of8 ordered units
incorrectly becomes Completed and active count6->5, although the final item still
has ordered2/ready1/handed-over1. This fails partial-fulfillment acceptance. Requested
completion against every ordered quantity, retaining InProgress for the remaining
unit and blocking repeat handoff with no ready units. PU-007 now has an actual null
ready quantity and a detail-level blocking explanation, but queue2/3ready masks
the unknown component. Requested explicit unknown summary and command/retry guards;
null quantities cannot be ignored for completion. The same draft repair is running.
No completion or full responsive acceptance claimed for this version.

Make "Fix identified defects" at18:25: fresh browser verification confirms PU-003
Unknown recovery reaches Verified, then explicit2item handoff reaches Completed;
both item rows have handed-over1, active count drops to4, and no repeat command
is exposed despite unknown package count. SES-001 now displays Session Closed,
T-05 Available/unlinked and historical read-only facts without a close command.
Stable-version PU-004 Expired proof exposes Restart and no handoff command.

Next source-alignment selection: current PickupHandoffForm confirms every remaining
ready unit per item, recipient type and an explicit matching checkbox. The Make
aggregate quantity stepper instead permits ambiguous partial allocation. Requested
its replacement with exact per-item confirmation, synthetic masked recipient only,
and an independent unknown-quantity fixture. PU-006 currently has known zero ready
units; it cannot establish unknown-data handling. The same Make task is editing;
defer affected preview tests until it completes because hot updates reset fixtures.
No real recipient data, provider or production command is involved. Updated brief
and completion review to distinguish the original TBD intake from generated but
not fully accepted workspaces. Full Handoff location requested without pausing
work supported by existing accepted source contracts.

Make "Implement API Error Fixes" completed at18:21. Fresh preview verifies the
proof-outcome selector and per-item ordered/ready/handed-over quantities. PU-001
Failed verification exposes no handoff command. PU-003 has unknown package count
but known item quantities; Unknown proof blocks handoff. Its recovery command
incorrectly returns to Unknown after pending instead of confirming the existing
operation. T-05 closure releases the floor card to Available with no active Session,
but the retained SES-001 detail still claims the Session can be closed and does not
show Closed. Both reproduced defects were submitted as a bounded follow-up.

Responsive tooling cause resolved: the old preview handle was outside the current
browser session. Rebound the observed Make preview URL to a current tab. Fresh
390x844 and320x740 Pickup detail screenshots and DOM measurements match requested
widths with no horizontal overflow; these are this page's observations, not full
workspace responsive acceptance. Viewport override reset. Remaining acceptance
includes repaired Unknown recovery/closed detail, Expired proof, unknown item
quantity, successful per-item handoff, Orders regressions and other workspace
responsive/keyboard checks. No local application test or publication claimed.

Next Make repair terminated with explicit `API Error: Stream ended without receiving
any events`, observed after planning and before any reported completed repair. Sent
a continuation to the same draft preserving current files and previous passes, focused
on proof scenarios, per-item handoff quantities, valid closure sources and demo clock.
Fresh source reconciliation: DiningTable operationalState is Available/TemporarilyBlocked,
with activeDiningSessionReference separate; PickupHandoffForm derives remaining ready
units from each item's readyQuantity minus handedOverQuantity. Unknown package count
does not imply unknown item quantities or justify defaulting handoff to one package.
The resumed Make task is observed Thinking. No repaired-version evidence or repeated
local business checks claimed; overall goal remains active.

Make version10 (Fix identified issues) follow-up: observed the same live task complete,
then reloaded its preview. Fresh interaction confirms Kitchen Accept is replaced by
Start after confirmation; obsolete30minute SLA is removed. T-07 now opens SES-003,
with unaccepted/unserved blockers. Pickup/Exception selection keeps the queue URL.
PU-001 verification passes separately from explicit two-package handoff; later readback
is Completed/read-only and active count decreases. EXC-001 acknowledgement disables
concurrent Assign; confirmed acknowledgement retains unresolved financial state.
Stale Pickup verification is disabled. These are observed synthetic flows, not local
runtime or real Provider evidence.

Remaining version10 defects: no proof-result scenario selector despite the UI claiming
one; closed T-05 becomes unapproved Clearing rather than Available/unlinked; commands
mix current wall-clock time into fixed-date fixtures; supposedly closeable DEMO-1006
still has held Kitchen and unresolved exception source facts; Pickup handoff quantity
uses package count rather than per-item ready/unhanded amounts. Requested explicit
Failed/Expired/Unknown proof recovery, correct Session identity/available-table context,
consistent source-derived closure, simulated clock and item-quantity gates. The exact
existing Make draft accepted this next repair request. No version10 completion claim.
Responsive attempt requested390px but DOM/screenshot remained1280px; record this as
viewport-control limitation, not a390px pass or product overflow failure. Override
reset and both tabs retained. Prior version9 320px evidence is not reused for new files.

Continuation environment selection: before local implementation verification, repair
the receiving Mac's outdated dependency installation. Node24.18.0/pnpm11.13.0 are
confirmed; node_modules metadata predates the handoff and `pnpm exec` attempted an
implicit install. Existing installation evidence cannot be reused. Run the existing
frozen-install command with CI=true to provide non-TTY consent; preserve lockfile and
manifests. This installation is preparation for continued development, not business
acceptance or a reason to run unrelated suites. Record network/sandbox failures and
validate unchanged dependency inputs after installation.

Receiving-Mac result: initial sandbox install was stopped after DNS ENOTFOUND;
the network-enabled retry of `CI=true pnpm install --frozen-lockfile` completed
with exit0 in5.7s,1672packages and supply-chain policy acceptance for1748entries.
`git diff --exit-code` confirms package.json, pnpm-lock.yaml, pnpm-workspace.yaml,
.nvmrc and .npmrc unchanged. Installation is now fresh for this Mac/toolchain;
it supplies no application test result. Use the normal pnpm formatter invocation
to confirm development command execution no longer triggers implicit installation.

Environment follow-up: ordinary `pnpm exec` still attempted installation. A read-only
diagnostic with `pnpm_config_verify_deps_before_run=error` identified
`enableGlobalVirtualStore` setting drift, not a lockfile problem. Installed pnpm code
disables that option under CI. `CI=true pnpm exec prettier --check` on this WP and
the review passed without reinstall. Keep CI=true consistent for this installation's
subsequent agent commands; do not disable dependency validation or repeat installation.

Updated the receiving-machine handoff with this reproduced CI setting and the recovered
Make draft/status, replacing its stale current claim that generation had not begun.
Fresh CI=true Prettier checks pass for the changed handoff/WP/review; whitespace diff
passes. Make repair is still live at KitchenWorkspace editing after types/data fixes;
no repaired-version acceptance claimed. No application suite or local build required
for this environment/documentation slice. Goal remains active; next action is observe
the same Make task and verify its repaired prototype, without restarting generation.

Owner confirmed that the single-Store InternalTest milestone is not whole-project
completion and requested parallel resolution of Figma Make TBDs where possible.
This bounded continuation reconciles implementation and design gaps before selecting
the next implementation slice. Baseline: `23e5925` on
`codex/wp-2402-pilot-submission`, initially clean. The historical installation below
describes the originating Windows/WSL runtime, not a verified installation on this Mac.

Deliverable: [project completion review](../../runbooks/project-completion-review.md),
linked from the spec index and Make brief. Inspect normal application entry points,
client defaults and existing BC-01 through BC-27 contracts; distinguish confirmed
unwired routes, recorded local evidence, unresolved design and external evidence.
Do not interpret missing assembly as missing Domain implementation. Actual Make TBD
resolution requires the target project and its contents; the local brief is not a
snapshot of the remote draft. No business behavior or accepted decision changes.

Verification selection before edits: acceptance is source-backed coverage of all
27 scenario IDs and a concrete next implementation slice, plus explicit Make target
status. Fresh checks: changed Markdown through the installed Prettier, local relative
link/source review and `git diff --check`. No install, application suite, database,
build or release run applies to these documentation-only inputs. Broader regression
belongs to the assembled-candidate milestone: reassess `pnpm verify` and affected
persisted/browser acceptance after actual composition changes; historical passing
tests are not fresh or exact-head certification.

Review result: 27/27 existing scenario IDs mapped; all 12 local relative links in
the review resolve. Four normal-entry client gaps are confirmed from source; the
purchase-order slice also requires read-source/API investigation because WP-2134
excluded persistence/transport. Make target remains unavailable, so no remote TBD
is reported fixed. `pnpm exec prettier --write` failed before formatting because
pnpm attempted an implicit install (registry fetch failure and non-TTY module purge
refusal). No reinstall was pursued. The installed Prettier CLI under pinned Node
formatted the four Markdown files directly; final `--check` and `git diff --check`
are the selected closeout checks. No application tests, runtime actions, external
writes, commit or push were performed. Overall implementation and release remain open.

## Make alignment - Merchant Kitchen queue

Align the actual Merchant `/operations/kitchen` queue with the inspected Make
station-lane hierarchy. Handoff Section 88.10 and Registry KIT-KITCHEN-QUEUE/
KIT-WORK-ITEM remain authoritative for routes, states, permissions, privacy and
commands. Use only current `KitchenBoardItem` facts: station, ticket/order/work-item
references, name, status, quantities, age, allergen cue and exception status. Do not
invent course, priority, SLA, claims, timer, or operator facts absent from this read.
Keep the registered standalone work-item route and existing command guards.

Verification selection: focused KitchenBoardPages render tests check grouping,
accessible lane names, absent-field restraint and existing states/actions; then run
Merchant typecheck, affected lint/format and production build. No Domain, persistence,
authorization or shared contract changes, so no cross-domain or database suite.
Responsive visual inspection remains necessary before calling the UI aligned.

Slice result: Merchant Kitchen now groups actual work items by their source station
label with compact ticket/order/status/quantity/age rows and a lane count. It omits
the exception line when None and displays unavailable source facts as unavailable.
Existing command guards and KIT-WORK-ITEM standalone details route remain intact.
No course, priority, claim, SLA or operator data was fabricated. Focused Kitchen
render tests pass (5); Merchant TypeScript, affected ESLint and Prettier checks pass;
production build passes with the existing >500 kB chunk warning. The existing
production-fail-closed Kitchen browser specs pass (2), including read/refresh/denial,
command intent/version behavior and 390/320px overflow checks. E2E fixtures are
synthetic intercepted API responses, not a live Store. This slice is Make hierarchy
alignment only, not full Registry coverage or overall project/release completion.

Kitchen reference privacy correction selection (2026-09-23): current queue and work-item
screens render the UUIDv7 `ticketReference` and `orderReference` as display labels, while
the authorized DTO has no separate public-safe display reference. Hide those raw values
and render an explicit display-reference-unavailable label; retain identifiers only in
the existing scoped action payload and canonical work-item route. Update component and
browser assertions to prove neither UUID is rendered. Run the affected Kitchen render
tests and both existing production Kitchen browser journeys, retaining 1440/390/320
screenshots for visual review; run direct Merchant TypeScript, affected lint/Prettier,
production build and diff checks. During screenshot review, also verify that disabled
Kitchen commands are visibly distinct from enabled commands while the board is locked;
use the existing semantic colors and retain readable labels. No projection/API/Domain/
persistence/authorization change is authorized by this correction; record Registry
search/display reference as remaining owner-projection work, not completed coverage. All
browser data stays synthetic.

Kitchen reference privacy correction result (2026-09-23): queue and work-item cards now
show “Ticket display reference unavailable” and “Order display reference unavailable”;
the UUIDv7 values remain only in existing internal command bindings and the canonical
work-item route. Focused Kitchen render tests pass (5), including assertions that both
IDs are absent on the queue and detail screens. Both focused production-preview Kitchen
browser journeys pass (2); the first rerun exposed one stale E2E assertion still expecting
the raw Ticket UUID, which was replaced by the new safe-display/absence assertions before
the passing rerun. The existing behavior still covers refresh, permission-denial cleanup,
keyboard use and command version handling. Fresh 1440/390/320 screenshots were inspected;
the reference labels wrap at 320px and no viewport overflows. Screenshot review also found
disabled actions visually resembled enabled ones; disabled Kitchen buttons now use the
muted raised surface/text tokens. Both production browser journeys passed again after the
style change (2/2), and the read-only journey asserts disabled-button background differs
from the enabled Refresh control; that assertion passed in a fresh rerun (1/1). Merchant
TypeScript, targeted ESLint/Prettier and the browser's production Vite build pass (existing
500 kB chunk warning). The test file received a Prettier-only reformat after the final
focused run; no assertion or behavior changed. Browser data is synthetic. Registry-required
safe reference display/search is still incomplete because no authorized public field exists
in the current projection.

Kitchen current-projection filter selection (2026-09-23): the Screen Registry requires
state, allergen and overdue filters, while the current authorized `KitchenBoardItem` also
contains exception status. Add local current-queue filters for station, state, allergen
and exception, plus a Clear path and a distinct no-match state. Keep controls limited to
loaded DTO rows; do not infer course, priority or overdue without source fields/accepted
SLA. Do not search/display UUIDv7 references. Update the focused render test and the
existing production Kitchen browser journey for combined filter/no-match/Clear behavior,
and retain 1440/390/320 screenshots plus no-overflow assertions. Run direct Merchant
TypeScript, targeted ESLint/Prettier and the production browser build. No API/Domain/
projection/persistence/permission changes; label missing Registry query fields as open.

## Make alignment - Merchant Dining floor

Align the real `/operations/dining` route with Make's area-based floor board and
selected-table detail while retaining the route's existing Staff Dining Session
authority. Handoff Section 88.11 and Registry DIN-FLOOR-BOARD/DIN-SESSION-DETAIL
govern the screen. `StaffDiningTable` is the only current route source: table label,
area, capacity, lifecycle, operational state and current Session reference. Do not
display fabricated party, elapsed, Order, Payment, reservation or Waitlist facts;
the separate rich projection view has no connected client on this route. Preserve
confirmation, idempotent retry, one-time code handling and Host Transfer behavior.

Verification selection: the existing session-start and host-transfer browser specs
are the affected end-to-end workflows; add their viewports to the session-start
scenario and inspect retained synthetic screenshots. Run Merchant typecheck, affected
lint/format and production build. No Domain, persistence or shared authority changes;
do not rerun unrelated business or database suites. Whole-project readiness and live
Store evidence remain separate gates.

Dining layout follow-up: the existing session-start browser journey now asserts that a
single desktop table tile stays within 280px; its CSS grid caps tiles at 17rem while
retaining a shrinkable minimum. This addresses the observed full-row stretch without
changing the registered screen contract or Session command flow. Fresh focused result:
`CI=true pnpm --filter @bop-rms/merchant-web test:browser --grep 'staff starts a table and recovers a lost entry code without duplicate start'`
passed (1). The journey covered keyboard selection, start/retry/code recovery and
1440/390/320px no-overflow checks; all three new screenshots were inspected. Evidence
uses synthetic intercepted API responses. First sandbox run could not bind loopback;
the same command passed with approved loopback access. These UI changes do not alter
Store transaction facts or write the database. The Host Transfer browser journey passed (1) against the production-fail-closed
project. Merchant TypeScript passed; ESLint passed for the Dining route and browser
test; Prettier passed for the scoped CSS, route, browser test and WP brief; Merchant
production build passed with the existing >500 kB chunk warning. All are fresh checks
for their recorded source state. Later Pickup/Exceptions changes are scoped to their
components, additive page-specific `.list-filters` styles and their own browser tests;
they do not change the Dining route, tile selector or Session flow. The final shared
Merchant TypeScript/build/format checks ran after all three page slices; no cross-domain
or database suite applies.

Dining single-tile width follow-up: the 17rem cap still left a lone desktop tile
visually too wide. The grid's maximum track is now 13rem and the browser geometry
assertion is 216px. Verification selection: run the existing session-start journey
because it covers selection, one-time-code recovery, mobile overflow and tile width;
inspect its fresh 1440/390/320 screenshots. No Session authority or data source changed.
Fresh result at current uncommitted source: the default sandbox attempt could not bind
127.0.0.1:5173 (EPERM); the same exact command with approved loopback access passed
1 `production-fail-closed` browser test. It verified the ≤216px desktop tile, keyboard
selection, existing Session start/retry and code recovery, and no horizontal overflow
at 390/320. All three regenerated screenshots were inspected; the tile measures 208px
at desktop and remains compact at both mobile widths. Fixtures are synthetic intercepted
responses. No production Store facts are established. No other business or database
suite was rerun for this CSS-only change. Fresh checks also passed: direct installed
Merchant `tsc --project apps/merchant-web/tsconfig.json`, targeted ESLint for the Dining
route/browser spec, Prettier on the CSS/spec/brief and `git diff --check`. The browser
preview's configured `vite build` completed with the existing >500 kB chunk warning.
The `pnpm --filter @bop-rms/merchant-web typecheck` wrapper did not reach compilation:
pnpm attempted an automatic registry refresh (`ERR_PNPM_META_FETCH_FAIL`) and then
refused non-interactive module removal. The installed compiler ran the same project
tsconfig successfully without changing dependencies.

Fresh continuation check (2026-09-23): reran the corrected session-start journey against
the current worktree with approved loopback access; 1 passed. The regenerated 1440px
screenshot shows the focused selected tile at 208px; 390px and 320px screenshots show
single-column reflow with no horizontal overflow. The existing Host Transfer journey
also passed (1), including unknown-operation retention across denial. Both browser runs
use synthetic intercepted API data and do not establish Store facts. No Dining code
changed during this continuation; the initial sandbox attempt was blocked by loopback
EPERM and the first corrected-command attempt used a stale test-title grep, so neither
is counted as an application test failure.

Fresh screenshot recheck (2026-09-23): after the lifecycle fix, the scoped
`production-fail-closed` session-start journey passed again (1) with approved loopback
access. The fresh 1440px screenshot shows the focused single tile remains compact; the
390px and 320px screenshots show a single-column board and selected-table detail with no
horizontal overflow. The browser assertions also confirm one initial table query and one
additional query after explicit Refresh, keyboard table selection, same-operation
Session retry, and one-time-code recovery. The screenshots and API responses use
synthetic fixtures; they do not establish Store facts. No Dining source changed since
the preceding recorded run.

Continuation rerun (2026-09-23): the exact `dining-session-start` production-project
journey passed again (1) using direct Playwright CLI filtering and approved loopback
access. A first `pnpm ... test:browser -- --project=...` attempt forwarded the extra
separator to Playwright and began the full matrix; it was interrupted at the first
unrelated Host Transfer test and is not counted as an application result. The corrected
focused run passed. Newly regenerated screenshots were inspected: the lone 1440px table
tile is 208px wide; the 390px and 320px board/detail views reflow to one column without
horizontal overflow. Session create/retry, one-time-code recovery and initial/refresh read
count assertions passed. Fixtures are synthetic; no Store evidence is established.

Dining initial-load lifecycle follow-up selection (2026-09-23): source review found the
mount effect depends on a newly created `load` function and its cleanup aborts the
request, so ordinary state renders can restart the initial read. Make the initial load
effect stable, keep explicit refresh/pagination behavior unchanged, and clear only the
request owned by the effect during cleanup. Extend the existing session-start E2E to
assert exactly one initial GET and one additional GET after explicit Refresh, while
retaining Session retry/code and viewport checks. Run affected Merchant unit tests,
focused session-start and Host Transfer browser journeys, direct Merchant TypeScript,
targeted lint/Prettier and production build. No authority/domain/source contract changes;
no database or unrelated business suite. Browser fixtures remain synthetic. Record
whether the focused run uses approved loopback access and inspect only changed
screenshots if the journey regenerates them.

Dining initial-load lifecycle result (2026-09-23): the mount effect no longer depends
on the render-local `load` function. It reads through a stable ref once, and its cleanup
aborts and clears only the currently owned request; explicitly triggered refresh and
pagination still use current state. The expanded session-start E2E passes (1) and asserts
one initial table read plus one more after explicit Refresh, while retaining keyboard
selection, exact same-operation Session retry, one-time-code recovery and 1440/390/320
overflow coverage. Host Transfer regression passes (1), preserving unknown operation
across denial. The Merchant unit command completed the full package (106 files/756 tests);
Merchant TypeScript, scoped ESLint and Prettier pass. Both browser harnesses completed
their production-preview builds with the existing >500 kB chunk warning. Test-result
screenshots were not retained in the workspace after the runs, so this turn makes no
new screenshot inspection claim; the changed source is limited to load lifecycle and
request-count coverage, while earlier visual evidence covers unchanged CSS. All browser
data are synthetic intercepted responses, not Store evidence. No domain, persistence,
permission, session-command or Host Transfer contract changed; no database suite applies.

Dining filter continuation (2026-09-23): extended the existing synthetic Dining table
fixture across MAIN/Available and PATIO/TemporarilyBlocked and verified Area, table-state
and table-label filters plus a no-match recovery state. The same production-preview
journey also verifies selected-table details, keyboard selection, one initial read plus
one explicit-refresh read, exact same-operation Session retry, one-time-code replacement
and code hiding. The Host Transfer journey retains unknown operation across denial. Both
focused production journeys pass (2/2). Fresh inspected 1440/390/320 screenshots show
the desktop single-table tile at 208px and a one-column mobile board/detail layout with
no horizontal overflow. Direct Merchant TypeScript, targeted ESLint and Prettier pass;
the preview's Vite production build completed with the existing >500 kB chunk warning.
Two earlier attempts failed only on Playwright locator strictness (empty duplicate
`status`, then a plural tile measurement); precise message and T1-scoped locators fixed
the harness, and the same focused journey passed. All data are synthetic intercepted
fixtures; no Store facts or commands are established. No Dining API, Domain, persistence,
permission or Session/Host Transfer authority changed.

## Make alignment - Merchant Exceptions workbench

The resolved `OPS-ORDER-EXCEPTION` Screen requires filtering by type, severity, status,
owner, Store, overdue state and Provider state. Store remains the current authorized
App scope. Add local filters only for fields present in the server-authorized exception
projection; do not let the UI change financial finality, acknowledgement, assignment or
source-owned resolution. The DTO has no safe display/search reference, so reference
search remains blocked on an owning projection contract rather than exposing UUIDs.

Verification selection: render/state tests and the existing 500-row production-project
browser scenario cover filter/empty/clear without altering source items; existing
refresh-denial, scope-switch and payment-action browser journeys retain the same
authority semantics. Run Merchant typecheck, affected ESLint/Prettier/build and inspect
390/320 screenshots for reflow. No owner Domain, persistence, financial command or
external Store/Provider action is in scope. Make draft review is a separate gate.

## Make alignment - Merchant Pickup queue

Screen Registry `FUL-PICKUP-QUEUE` requires order-reference search and state, claim and
exception filters. The current page had state filtering and server-side completed/page
controls, but no reference/claim/exception filtering. Add current-page-only filters using
the public Order reference already rendered by this screen and fields already present in
the authorized projection. Do not search or expose internal UUIDs; preserve server
pagination, completed inclusion, proof verification and explicit server-confirmed handoff.

Verification selection: exercise default/filtered/clear behavior in the existing
production-project Pickup browser journey, then retain its proof/unknown retry/handoff,
page, scope and permission-recovery coverage. Add 390/320 no-overflow screenshots.
Run Pickup screen tests, Merchant typecheck, affected ESLint/Prettier and production build. No Fulfillment/Ordering
authority, persistence or shared contracts change; no database suite. Inspect the
390/320 layout during the browser run; Make draft acceptance remains separate.

Pickup result: current-page public Order reference search plus state, Claim and Exception
filters and Clear behavior are implemented; server page/include-completed queries remain
unchanged. The existing Pickup browser journey passes (1), including proof Unknown exact
retry, handoff confirmation/retry, next/previous page, Store mismatch and permission
recovery. Fresh mobile no-overflow checks and inspected 390/320 screenshots pass.
Pickup screen tests pass (3); Merchant TypeScript, targeted ESLint/Prettier and production
build pass with the existing chunk-size warning. A previous failed run was a Playwright
label-locator mismatch; the corrected same journey passes.

Exceptions result: local type, severity, status, owner, Provider-state and overdue filters
use only existing authorized projection fields; Store remains the selected authorized
scope. The empty-state/clear path passes in the existing 500-row browser journey (1),
with fresh 390/320 no-overflow checks and inspected screenshots. Exception screen tests
pass (8); Merchant TypeScript, targeted ESLint/Prettier and production build pass with
the existing chunk-size warning. Safe-reference search remains blocked because the
current projection exposes no safe display reference. All browser responses and rows
are synthetic; no business command or external service was invoked.

Fresh continuation (2026-09-23): reran the focused production-preview Pickup paging,
scope/permission-recovery journey and 500-row Exception workbench journey against the
current worktree; both passed (2/2). Pickup again exercised search/no-match/Clear,
state/Claim/Exception filters, proof Unknown same-operation retry, handoff confirmation
and retry, pagination, permission recovery and Store mismatch. Exceptions again rendered
all 500 rows, kept the public-reference fallback and UUID absent, then exercised empty
filter recovery/Clear. Regenerated 390px/320px screenshots for both routes were inspected;
document width remained within each viewport and controls/cards reflowed without horizontal
overflow. Playwright used synthetic intercepted API responses; this is not Store evidence.
The configured production build completed with its existing >500 kB chunk warning. No
application or business state was changed by these read-only browser journeys.

### Exception reference privacy correction

The current `merchant_order_exception_v1` contract contains an opaque UUIDv7
`orderReference`, used by source-specific actions, but no public Order number/display
reference. The normal exception card previously rendered that UUID as its Order value,
contrary to Handoff Section 88.23 and Registry `OPS-ORDER-EXCEPTION` safe-reference
requirements. Keep the identifier available only to authorized action clients and render
`Linked order · public reference unavailable` until the owning projection supplies a
safe display field. This corrects the disclosure without presenting an Order number as
known or searchable. Safe-reference search and public-reference navigation remain open
until the accepted query contract supplies an owner-authorized public reference; do not
join private Ordering tables from the UI or BFF.

Verification selection: the changed Merchant unit test and existing 500-row
production-project exception browser journey assert that the public-reference fallback
renders and the UUID is absent; the browser journey also covers mobile widths and filter
clear. Run these affected tests plus Merchant typecheck, targeted lint/Prettier, build
and diff checks. No projection/API/domain contract changes, so no database or
cross-domain suite applies. E2E remains synthetic intercepted projection data.
Fresh result: OrderExceptionPage tests pass (8); direct Merchant TypeScript, targeted
ESLint and Prettier pass. The browser's initial default-sandbox run could not bind
127.0.0.1:5173 (EPERM); the same focused `@production` journey passed (1) with approved
loopback access, asserting the fallback and absence of the UUID, filter clear, and 390/320
no-overflow checks. The production-preview Vite build succeeds with its existing
large-chunk warning; both generated mobile screenshots were inspected (they capture the
post-filter empty state). `git diff --check` passes. No API/source contract changed and
no real exception or command was used.

### Exception action-route source reconciliation

Exception permission mapping reconciliation selection (2026-09-23): the Screen
Registry entry declares `ordering.operate`, while the current Merchant workspace route,
BFF policy and Exception owner readers/commands use
`operations.order-exception.manage`. The latter is not declared in the Registry's
permission catalog. Compare Section 88.10 role wording, the accepted Registry, current
route/API policy and the recorded Store-scoped permission proposal; do not broaden the
live route or rewrite the canonical permission from implementation alone. Record the
exact mismatch and gate the effective permission/Registry correction on the authorized
owner decision. Verification is source-reference and Markdown-format/diff review only;
no runtime permission, grant, or command changes are authorized by this reconciliation.

Verification selection: trace Handoff Section 88.10/WP-1809 action ownership against
the Merchant UI, BFF route list, Task inbox reader and Task Domain command entrypoints;
update this gap register only. Check the cited routes/owner functions, Markdown format
and `git diff --check`; no business test applies to this source-only reconciliation.

`OrderExceptionPage` currently keeps general Acknowledge, Assign, compensation/retry and
Resolve controls disabled. The BFF has a read-only `GET /tasks`, a read-only
`GET /order-exceptions`, and Payment-specific follow-up assignee/evidence/query/command
routes. `createMerchantTaskInboxRead` composes authorized Task queue reads; it is not a
Task mutation transport. Task Domain `assignTask` exists, but the inspected Merchant BFF
has no generic Order Exception Task acknowledge/assign/resolve command composition.
The Task lifecycle currently exports Create, Assign, Claim, Complete, Fail, Cancel and
Escalate; there is no Acknowledge operation. `claimTask` is a specific Assigned→Claimed
transition requiring assignment and current eligibility evidence, so it is not silently
equivalent to the Screen's acknowledgement action. Task assign/claim/complete use the
versioned, idempotent, audited Domain command boundary, but no generic mutation endpoint
is mounted in this Merchant BFF. Therefore the remaining gap is owner-action mapping and
authorized API composition, plus an explicit acknowledgement contract if the Screen
action remains distinct—not absence of every Task mutation capability.
This distinction is required by the accepted Task contract: WP-0125 defines no Acknowledge
operation, says Complete stores only an opaque completion reference/result code, and
explicitly states that Task completion is not source-Domain business completion. The
Order Exception Projection's `AcknowledgeExceptionTask` mapping is an action intent; under
WP-1809, acknowledge/assign/resolve route to Task but remain intent routing only. That
contract does not implement a Task command or API adapter. Do not reinterpret Claim as
Acknowledge or Complete as Resolve; the owner contract and authorized command composition
must be scoped before enabling these actions.
The existing Payment follow-up command is source-specific and cannot stand in for Task
acknowledgement or Ordering write-off. Handoff/WP-1809 require these actions to route to
their owning Domains with Actor permission, source version and idempotency; Resolve also
requires final owner evidence. Keep unavailable actions disabled. Make's synthetic EXC
acknowledgement/assignment confirms only its in-memory presentation and is not evidence
for these routes. The next executable action requires an explicitly scoped owning WP
for the Task/Ordering command adapters, API contract and authorized actor flow; it is
outside this UI-only slice. No Domain/API behavior or external service was changed.

Recipe source-map follow-up: traced the accepted Screen/Handoff read requirements against
the current Recipe, Catalog, Inventory and Supplier sources. The normal Recipe list/editor
still resolves to the unavailable client; no public admin query/API or generation builder
is wired. The internal reader and synthetic isolated PostgreSQL fixture prove only the
Brand/generation-bound row read. Current facts do not provide a complete source contract:
cost has no currency/valuation/source version, Recipe validation has no external feed
versions, Catalog allergen review persistence is a Catalog-owned review adapter rather
than a Recipe public contract, and the numeric checkpoint sequence is not a complete
source coverage/watermark contract. The new source map records available and missing
facts without asserting external evidence does not exist. No sequence reinterpretation,
inferred watermark, cross-owner private query, production API or runtime activation is
introduced. Source map: `docs/spec/design/recipe-admin-projection-ordering.md`; project
readiness implications: `docs/runbooks/project-completion-review.md`.

Verification selection for this documentation update: inspect the traced source references,
resolve local links, format the three changed Markdown files, and run `git diff --check`.
No application, business or database suite is repeated for text-only changes. Fresh Recipe
component checks during this turn: package tests 9 files/98 tests; ownership validation
1087 tests plus live validator; Recipe lint, typecheck and build all pass. The full
`CI=true pnpm recipe-management:acceptance` composite was attempted but stopped at its
isolated database stage because Docker socket access was unavailable in the sandbox;
Recipe package and contracts-event stages had passed before that failure. The same
existing database config was then run separately with approved Docker socket access and
passed 1 isolated PostgreSQL composite scenario (11.00 seconds). This verifies the
synthetic reader-generation/RLS cases only; it does not make the composite script itself
a pass or establish a merchant route, source coverage, builder, authorization or runtime
acceptance. Project completion and all external evidence/launch gates remain open.

Current-state reconciliation: refreshed the workspace before continuation. Branch is
`codex/wp-2402-pilot-submission`, local HEAD is
`03ad510c9b694a4bf994efb6703e11afa53e2fb7`, and prior implementation remains uncommitted
in the working tree. The specification index had still identified `a0f35440...` as the
current local HEAD; update that current-state pointer to the actual checkout. References
to `a0f35440...` inside earlier batch evidence are historical and intentionally retained.
Verification selection: compare `git branch --show-current` and `git rev-parse HEAD` to
the index pointer, then format/check the two changed Markdown files and inspect diff.
This documentation-only correction does not require application or database suites.

Initial Figma Make preview inventory: opened the exact linked project read-only in Chrome.
The editor identifies Version29 but presents “Sign up to use Figma Make”; its prompt and
send controls are disabled, so no edit was possible. Preview navigation exposes all five
operations paths without TBD labels. Read-only views showed Orders' eight page-local rows
and unavailable server pagination; station-grouped Kitchen tickets; area-grouped Dining
tables and a selected Session with an unpaid Order blocker; Pickup's selected item list
and verification-required handoff gate; and an Exception detail that separates simulated
acknowledgement/assignment from disabled resolution pending source finality/evidence.
The scenario panel lists normal, loading, empty/no-results, partial, permission/session,
not-found/disabled, stale/offline, pending/failed/rate-limited/conflict/unknown states and
separate Pickup verification outcomes. It explicitly labels all transactions fictional,
in-memory and unpersisted. No simulated business command was invoked; selecting a list
item only opened its in-memory detail. This is route/detail inventory, not full prototype
acceptance: Orders/Kitchen commands, Pickup outcome journey, complete Exception actions,
and responsive/keyboard coverage remain unchecked. No project version or sharing state
was changed. Keep the Make acceptance open and continue repository work while editing
access is unavailable.

Verification selection: re-read the current linked preview and inspect each accessible
workspace plus the scenario panel; record only visible UI facts. No repository test suite
applies to this remote read-only observation. Recheck the two changed Markdown files with
Prettier and Git whitespace validation; current checkout branch/HEAD match the corrected
index pointer. This browser evidence is separate from synthetic repository browser tests
and from all production/external evidence gates.

Orders Unknown scenario follow-up: selected the Global `Acceptance outcome unknown`
scenario, opened the eligible synthetic DEMO-1001 initial batch and clicked Accept. The
preview first showed `Submitting… Duplicate submission blocked`, then the explicit
`Acceptance could not be confirmed` not-failure state with `Refresh order facts first`
and `Retry acceptance (simulated recovery)`. The documented synthetic retry resolved to
Accepted; the batch became Accepted and displayed simulated confirmation, and projection
version advanced from1 to2. The History tab showed this as a point-in-time snapshot, not
a live subscription. No API/server/persistence evidence, identical operation identity,
or real confirmation is established. This is one fresh prototype scenario journey only;
it does not close remaining Orders conflict/permission/stale/other acceptance cases,
responsive/keyboard checks, other workspace journeys, or the Make acceptance gate.

Orders failure-state preview checks: the `Stale / Offline — read-only` scenario kept the
last reconciliation timestamp/snapshot visible, labelled data stale and offline, and
rendered `Accept batch` disabled. The `Permission denied` scenario showed zero queue rows
and an Access denied explanation for missing `ordering.operate`; opening the prior demo
order route also showed not-found rather than leaking its details. Under `Conflict`, an
Accept attempt did not change the batch to Accepted; it showed `Version conflict` with a
refresh instruction/button. These are visible fail-closed prototype outcomes, not actual
scope enforcement, authenticated authorization or server conflict evidence. Preview data
remain fictional/in-memory and the Figma editor remains unavailable for corrections.
This browser pass checked three additional Orders branches only; Session expired, Not
found/Feature disabled, Partial, Pending, Failed, Rate limited, all remaining scenarios,
viewport and keyboard journeys still need review.

Make Customer shell follow-up (2026-09-23): the same Version29 preview exposes a
fictional QR entry at `/` and menu at `/menu`; the editor still requires sign-up and
its prompt is disabled. Opening the file-edit menu displayed a Figma sign-up modal;
no account or credentials were entered. In the in-memory `QR Invalid` scenario, the entry initially
showed the synthetic Open T-07 context; attempting View menu then produced “QR code
invalid or expired” and a Try again control. `QR Denied` produced an explicit Access
denied/staff-assistance message. `Menu Empty` rendered “No items available right now”;
`Menu Error` rendered “Menu unavailable” with retry/staff guidance. In `Session Expired`,
the entry continued to show Open T-07 and View menu; two attempts returned to the same
entry without a visible explanation. Record this as unresolved, not as passed expiry
recovery or a confirmed code defect. No item, cart, checkout or payment command was
invoked. These observations are fictional preview evidence only. Verification selection:
read each visible scenario outcome and editor availability; no repository suite applies.
The `Feature Off` scenario behaved similarly: View menu briefly showed Verifying, then
returned to the same Open T-07 entry without a visible feature-unavailable explanation.
Record this outcome as unresolved until the customer-facing Feature Disabled contract is
confirmed; do not call it a production defect or accepted state. The Make editing gate
remains, and customer payment/checkout behavior, responsive and keyboard coverage, and
all remaining scenario outcomes stay open. A separate source trace found the live
Catalog/API/PWA menu contracts have no distinct FeatureDisabled result; see the
[project completion review](../../runbooks/project-completion-review.md#customer-menu-feature-disabled-contract).
Resolve the owner capability signal and customer-safe message before treating this
prototype scenario as a design requirement for production. Verification selection for
the source cross-check: compare the Registry, Catalog result, API error mapping and PWA
client/render branch, then format the changed Markdown and run `git diff --check` only.

QR Entry source reconciliation (2026-09-23): checked accepted WP-1004 and WP-1700 against
the current `/bff/customer/entry` port/handler and PWA parser. Expired, revoked, copied,
mismatched and other unusable QR credentials intentionally collapse to `entry_unavailable`
with `RescanOrAskStaff`; malformed framing is `entry_request_invalid`. The port and client
have no SessionExpired or FeatureDisabled result. Preserve this uniform non-oracular
contract: the Make `Session Expired` branch's silent return is synthetic preview behavior,
not evidence of actual Guest-session expiry or authority to add a cause-specific message.
The menu Feature Disabled gap remains separate and still requires its Catalog/API owner to
identify the authoritative capability signal and customer-safe versioned result. No
production behavior or external service was changed. Verification selection: source-text
cross-check against WP-1004/WP-1700 and the current entry contracts, format the two changed
Markdown files and run `git diff --check`; application/database suites do not apply.

Make Menu Empty/Error and local PWA comparison (2026-09-23): reopened the current Preview,
selected `Menu Empty`, then `Menu Error`, and inspected accessibility state and screenshot.
Empty shows “No items available right now” while the menu header, search, category tabs and
filters remain visible; no item/cart action was used. Error shows “Menu unavailable” and
“We couldn't load the menu right now. Please try again or ask a staff member.” Neither the
accessibility tree nor screenshot exposes an actionable Retry or staff-contact control, so
the instruction is not an implemented recovery affordance. Local `MenuPage.tsx` instead
renders an explicit `Try again` button for `Unavailable`, `Offline` and `Stale`; its empty
state says the current published menu has no matching items. This is a Make/local-UI parity
gap, not a production defect or Store fact. AI editing remains gated in the current Chrome
session; no source was edited. Verification selection: compare live Preview display/AX state
with the existing PWA branch and render tests; application tests do not apply to this
observation-only reconciliation.

Make Pickup verification follow-up (2026-09-23): selected PU-007 to inspect its unknown
ready quantity; the prototype identified the missing Kitchen count and blocked handoff.
For a fully counted fictional PU-001, the Failed outcome rendered `Verification failed`
and kept handoff blocked. The Unknown outcome rendered an uncertain/not-permitted state
and offered `Retry verification (simulated recovery)`; retry changed it to Verification
passed and exposed the separate item/recipient confirmation. After selecting the
fictional Customer recipient and confirming listed quantities, the explicitly simulated
handoff completed two items and moved PU-001 to `Completed — read-only`; the active count
dropped from6 to5. These are one fresh in-memory prototype journey, not a real proof,
recipient, operation-identity or Store handoff. No production action or record resulted.
Failed retry, Expired verification, zero-ready, delegate, viewport and keyboard branches
remain unchecked. At the time, editing access appeared unavailable, so Make acceptance
stayed open; the later direct Code-view work below supersedes that access observation.

Fresh branch follow-up (2026-09-23): Expired on PU-001 displayed `Verification expired`,
said handoff was not permitted, and offered `Restart verification`. PU-006 displayed two
confirmed-zero item lines; after simulated proof passed, its handoff panel showed `None
ready` / `No items currently ready for handoff` and kept completion disabled. Selecting
Delegate on fully-ready PU-001 displayed only a masked recipient label and left the
separate order/recipient/quantity confirmation unchecked; no handoff was submitted.
These are three additional fictional preview observations, not proof timing, delegate
identity/authority or server-enforced zero-ready behavior. Verification selection: read
these exact Version29 outcomes without completing Delegate; no repository suite applies
to this in-memory inspection. Make editing remains unavailable and acceptance remains
open.

Make Exceptions follow-up (2026-09-23): selected synthetic EXC-001, an Open payment
reconciliation difference whose financial source is unresolved, not finalised and has
no evidence summary. Simulated acknowledgement appended an `Acknowledged` timeline item
but left the status Open and Resolve unavailable. Simulated self-assignment changed the
display to Assigned / You and appended `Assigned to self`; it did not resolve the source
or enable Resolve. This confirms visible action separation for this one in-memory case,
not Store-scoped permission, durable audit, financial reconciliation, refund authority
or closure. Other Exception action types/states, failure/retry, filters, responsive and
keyboard coverage remain open; no real command or service was used.

Make Exceptions branch follow-up (2026-09-23): EXC-003, `Paid Without Fulfillable Order`,
showed an unlinked fictional `UNMATCHED-1`, Unreconciled, no compensation, Source finalised
No, and no evidence summary. Acknowledge and Assign to me were offered as simulated
follow-up actions; Resolve remained unavailable and explicitly required both source
finality and an evidence summary. The current route's accessibility snapshot exposed no
search/filter controls alongside its four demo rows; reconcile this against the Registry
and resolved Make design when editing access returns, without treating the demo reference
as a production-safe public Order identifier. This is an additional preview observation,
not a financial or source-finality fact. No simulated action was invoked.

Make Kitchen follow-up (2026-09-23): the current Version29 preview groups work by
station and shows an explicit empty state for a station with no tickets. Selected
completed and cancelled tickets were read-only, with the cancelled detail stating no
further action; another In Progress ticket was locked to another synthetic operator.
On one fictional queued KT-001, the visible sequence `Accept ticket` → `Start
preparation` → `Mark complete` produced Accepted, In Progress and Completed states in
order, each with a timeline timestamp. Completion recorded 1/1 item done, made the ticket
read-only and removed it from the active queue. This is a fresh, single-ticket, in-memory
prototype journey; it does not prove Kitchen command authority, persistence, server
idempotency, Store truth or downstream service/handoff/payment. Conflict/unknown/denial,
other command outcomes, viewport, keyboard and full Screen Registry coverage remain
open. The Make editor remains disabled, so overall Make acceptance is not complete.

### Reporting normal-route source reconciliation

Verification selection: resolve the authoritative Handoff definition, Reporting screen
and query-ownership entries against the current UI types/client composition and search
the repository for query implementations. This is documentation/source-tracing only;
check the affected Markdown formatting, links and diff. No business suite or application
build applies because no code or contract is changed.

The Handoff sections 38.20–38.24 require versioned Report Definitions, fixed Metric
Version references, scoped permissions, append-only Report Runs and separately governed
exports/delivery. Section 88.15 assigns the Catalog and Builder to WP-2161, while 88.22
places reporting reads in the named `reporting_*_v1` / warehouse projection family and
requires scope, freshness and source references. The current merchant `report-pages.ts`
defines parsers and the expected `reporting_report_catalog_v1` and
`reporting_report_builder_v1` payload shapes; `ReportPages.tsx` renders them. Repository
search found no implementation of either named query outside those UI types/tests and
the Screen Registry, and WP-2161's permitted unavailable-client boundary remains in
force. Persisted definitions and the internal definition service do not supply the
field-trimmed normal-route query or a Report Run execution path. Keep those routes
unavailable; do not fabricate query responses, infer report certification or execute a
run. Resolve the owning projection/query contract and its authorized normal-App
transport before any implementation. Report Run/artifact work remains WP-2162 and
Metric/Dataset certification and external evidence remain separate gates. No external
service was touched.

Make Customer Pay Unknown follow-up (2026-09-23): on the read-only Version29 preview,
selected the explicit `Pay Unknown` scenario, added the fictional Caesar Salad to the
in-memory cart, reviewed its simulated CAD14.00 quote, and entered the payment screen.
The preview stated no real charge/provider connection and requested no card details.
After `Confirm simulated payment`, it showed `Payment status unknown`, warned not to
submit again, and offered `Check payment status`. That check resolved the prototype to
`Order confirmed`; the confirmation and order detail both explicitly said no real
payment or Kitchen order was processed. The order detail showed fictional reference
ORD-DKPWBC, Payment Confirmed, Kitchen Received and unavailable ETA, with a separate
warning that Kitchen status is simulated. This is one in-memory prototype recovery path;
it does not prove payment idempotency, authoritative status reconciliation, durable
ordering, receipt integrity, Kitchen acceptance or production Customer PWA behavior.
No repeated payment submission or real transaction occurred. Verification selection:
read the visible quote, payment Unknown/recovery and order-detail states in the named
preview; no repository test applies to this synthetic-only inspection. Checkout edge
scenarios, session expiry and normal-route implementation remain open; Make acceptance
is not complete.

Make Customer checkout branches (2026-09-23): in a fresh fictional cart, `Pay Timeout`
showed `Payment could not be completed` / `Payment timed out. (simulated)` and offered
Back to checkout; no payment retry control was visible. `Price Increased` announced a
change from CAD14.00 to CAD16.00 and offered `Confirm updated price`, while the item and
subtotal still displayed CAD14.00; the reason for the CAD2.00 difference was not shown,
so confirmation was not clicked. `Quote Expired` showed `Order summary has expired` and
offered `Recalculate`; recalculation returned a fresh quote and CAD14.00 total for the
same in-memory item. No payment was retried or confirmed. These are Version29 preview
observations only, not payment, quote expiry, price-authority or persistence evidence.
Verification selection: inspect the visible Pay Timeout, Price Increased and Quote
Expired/recalculate states without confirming the changed total; no repository suite
applies to this synthetic-only check. Checkout outcome coverage and Make acceptance
remain open.

### Pickup action-route source reconciliation

Verification selection: compare Screen Registry `FUL-PICKUP-QUEUE` actions and
WP-1805's exact UI-only allowlist with the Pickup UI/client, Merchant BFF routes and
Fulfillment lifecycle WPs. Update the project gap register and verify Markdown links,
formatting and `git diff --check`; no business suite applies to this source-only trace.

`PickupPages.tsx` keeps Claim and Report exception unavailable; the client/BFF currently
compose queue query, proof verification and explicit handoff only. Fulfillment WPs
1600–1605 define aggregate creation, Ready, proof, handoff and completion, but do not
provide a Pickup Claim or general exception Task route. The Task Domain does provide
`claimTask` for an Assigned Task, with actor, assignment, current eligibility, expected
version, idempotency and Audit requirements; the current Pickup projection has no Task
reference/source binding or BFF mutation route to invoke it. First resolve whether the
Screen's Pickup Claim means claiming a source-bound Task or a Fulfillment-owned action;
do not create a second, unbound claim model. WP-1805 explicitly excludes Fulfillment
Domain/API/database changes and records its HTTP projection/client as a later composition.
Do not enable either control with local state or substitute proof/handoff for Claim. An
authorized follow-on WP must close the Task/source mapping, generic acknowledgement
semantics, exception Task creation/assignment, authenticated transport and current
authorization before the UI can enable them. Preserve the current proof and exact-target
handoff path.
The production browser journey proves only the existing query/proof/handoff behavior with
synthetic intercepted data; no Claim or exception command is claimed. No Domain/API code,
database, real Store or external service changed. Source evidence is registered in the
[project completion review](../../runbooks/project-completion-review.md#pickup-and-exception-command-composition).

Make Version29 route reconciliation (2026-09-23): reopened the actual private preview
read-only. The five Operations links resolve to Orders, Kitchen, Dining, Pickup and
Exceptions; shell and route views label the Store/date and data as fictional/demo. The
Make prompt still requires sign-up and is disabled, so no edit was attempted. Current
preview details repeat known evidence: Kitchen KT-002 is locked to another fictional
operator and its freshness SLA is explicitly unavailable; Dining T-02 links a fictional
Order with a pending unpaid close blocker; Pickup PU-007 blocks handoff on an unknown
ready quantity; Exceptions EXC-003 lacks source finality and evidence and exposes only
simulated Acknowledge/Assign. Pickup has no visible search/Claim/Exception filters and
the four-row Exceptions list has no visible search/filter controls, contrary to Registry
requirements. The local Merchant Pickup/Exception filters are separate code evidence and
do not change Make. These observations are not server authority, real business data or
Make completion evidence. Verification selection: inspect current preview navigation,
selected detail and editor gate; no repository suite applies to this external read-only
inspection. Responsive/keyboard completion, Orders recovery matrix and editing access
remain open.

Earlier Make access recheck (2026-09-23): the linked file opened at Version29. Its editor
shows “Sign up to use Figma Make”; the prompt, context control, model selector and Send
are disabled. The embedded preview currently opens the fictional Customer entry for The
Elm / Table T-07 and states that no real orders are placed. The Figma Plugin API connector
returns “This tool is not supported for Make files” (it supports Design, FigJam and
Slides); opening the embedded preview's observed `preview.site` URL directly in Chrome
is blocked by the browser client. No edit or action was made. This confirms the existing
editing gate; the current Customer entry is synthetic preview content, not application
or Store evidence. Verification selection: fresh browser accessibility snapshot and
read-only connector capability response; no repository suite applies. Make editing,
remaining route/viewport/keyboard scenarios and acceptance remain open.

Fresh Version29 Operations route recheck (2026-09-23): from the preview entry, opened
the Operations view and inspected all five routes without invoking any simulated command.
The shell labels The Elm, Business Date 2025-11-14 and its data fictional/demo. Orders
shows eight rows with page-only Order-number search and type/channel/phase filters, and
explicitly says it is not a full-database query. Kitchen displays GRILL/COLD/PASTRY/BAR
lanes plus an empty FRYER lane; its selected KT-002 detail is locked to a named fictional
operator and says freshness SLA is unavailable. Dining displays Main/PATIO/BAR areas and
the selected T-02 session's fictional unpaid DEMO-1008 close blocker. Pickup shows seven
cards and no search/claim/exception filters in the accessibility tree; PU-007 explicitly
blocks handoff while one ready quantity is unknown and verification is unresolved.
Exceptions shows four rows with no search/filter controls; selected EXC-003 is Open,
unreconciled, unfinalised and has no evidence summary, while Resolve remains disabled and
Acknowledge/Assign are explicitly simulated. These are current Make preview observations
only. They neither establish Store/Provider/Payment facts nor replace current Merchant
browser evidence. The local Pickup and Exceptions filters are implemented separately;
Make still needs editing access, responsive/keyboard acceptance and full Registry
reconciliation. No preview command or external business operation was invoked.

Kitchen local filter continuation (2026-09-23): added loaded-projection filters for
station, work state, allergen cue and exception status, Clear behavior and a distinct
no-match recovery state. No Order/ticket search, course, priority or overdue filter is
claimed: the authorized projection lacks safe public references, course and priority,
and no accepted overdue/SLA threshold was invented. The synthetic Kitchen component
tests pass (5); Merchant TypeScript passes. The focused production-preview Kitchen
journeys pass (2/2), including no-match/Clear, allergen and exception filtering, raw
UUID non-rendering, keyboard commands and projection-version intent. A first browser
attempt timed out on the test's `getByLabel` locator despite the accessible combobox
being present; switching to `getByRole("combobox", { name })` fixed the test, and the
same journey then passed. Targeted ESLint and Prettier are recorded after the final
format pass. The browser's fresh production build retains the existing >500 kB chunk
warning. Inspected 1440/390/320 production-preview screenshots show the desktop filters
in a bounded grid and mobile filters stacked without horizontal overflow. These browser
rows and screenshots are synthetic fixtures, not Store evidence; no server contract,
Domain, command, persistence, permission or external operation changed. Registry safe
reference search, course, priority and overdue criteria remain open pending owner fields
and an accepted SLA threshold.

## Assembled candidate verification (2026-09-23)

Current verification selection: since the earlier
575–585 candidate gates, this worktree adds Customer PWA session/receipt lifecycle
changes, Orders/Kitchen/Dining/Pickup/Exceptions/Recipe Merchant UI changes, the Recipe
admin persistence reader and its isolated acceptance helper, plus the narrow Recipe
database-ownership admission. These cross-package inputs invalidate reuse of the prior
assembled static, workspace-test and browser candidate results. Reuse the valid frozen
install only if manifests, lockfile and pinned toolchain remain unchanged. Run the
existing root typecheck, lint, format-check, workspace test graph (concurrency 2), build,
Merchant and Customer production-demo browser acceptances, Customer isolated PostgreSQL
lab acceptance, and the Recipe isolated PostgreSQL acceptance. Re-run the Recipe reader's
ownership validator after the narrow admission change. Do not run unrelated broad domain
acceptance or wipe caches; retain exact failures and stop to diagnose affected inputs.
All demo browser records remain synthetic. This local gate cannot provide real
Store/Provider evidence, approve release, or complete the blocked Make draft.

Assembled candidate static/build/unit result (2026-09-23): `CI=true pnpm typecheck`,
`CI=true pnpm lint`, `CI=true pnpm format:check` and `CI=true pnpm build` all pass;
each covered all41 workspaces. Normal Turbo caching was retained. The assembled build
reports the existing Merchant >500 kB chunk warning and missing declared Turbo outputs
for TypeScript-only package builds; no maintained build task failed. The first
`CI=true pnpm exec turbo run test --concurrency=2` run passed40/41 workspace tasks; its
API workspace failed because restricted sandbox execution raised `listen EPERM` for
127.0.0.1 across existing HTTP tests. Re-running only that workspace with approved
loopback access passed all183 files/1844 tests. Combined evidence therefore covers all
41 workspace unit tasks on the current uncommitted source; no test failure is being
silently counted as a pass. Merchant/Customer full browser acceptances and isolated
Customer/Recipe PostgreSQL acceptances remain in this verification selection.

Assembled browser result (2026-09-23): the first complete browser run had Customer
91/91 pass and Merchant 65/67 pass. Merchant's two failures were assertion defects:
the stale-data recovery test used a text locator matching both the Type filter option
and the exception heading, while a linked-order assertion expected a raw internal UUID
to be rendered despite this Screen's safe-reference requirement. Updated the E2E to
target the accessible heading and assert the safe unavailable-public-reference text
without exposing the UUID. Both targeted production-preview cases pass (2/2), then the
complete Merchant browser acceptance passes 67/67. The fresh Customer result remains
91/91. These fixtures establish UI recovery and privacy display behavior only; they do
not establish live Store, Provider or release evidence.

Assembled isolated acceptance and ownership result (2026-09-23): the first Recipe
acceptance attempt passed its Recipe (9 files/98 tests), Contracts (2/31) and Merchant
(106/757) suites, then Docker could not start the isolated database in the restricted
sandbox. Re-running the existing `CI=true pnpm recipe-management:acceptance` with local
Docker access passed all four stages, including the isolated PostgreSQL acceptance
(1 test). `CI=true pnpm customer-lab:acceptance` passed its isolated PostgreSQL lab
(2 tests). `CI=true pnpm database-ownership:check` passed all 1,087 validator tests
and the database ownership validator. The sandbox-only Docker startup failure was
resolved by the approved local rerun; no business database or external service was
used.

After adding these E2E and evidence records, `CI=true pnpm format:check` passes for
the repository root and all41 workspace format targets; `git diff --check` is clean.
The current Dining 1440/390/320 production-preview screenshots were reopened: desktop
table tiles stay compact alongside the selected-table detail, while both mobile widths
stack filters, area tiles and detail without horizontal overflow. All three are synthetic
fixture captures, not Store evidence.

Make-to-repository TBD reconciliation selection (2026-09-23): reopen the exact linked
Version29 file read-only; compare same-day recorded preview routes/scenarios with the
current Orders, Kitchen, Dining, Pickup and Exceptions components and their Screen
Registry fields/actions; update the Make brief and completion review with per-screen
parity plus unresolved owner-data/action gates. Check changed Markdown, links and
`git diff --check`; no business tests or app build apply to this documentation/source
reconciliation. Do not edit, share or publish the Make draft while the editor gate is
active.

At the time of this earlier Chrome accessibility check, Version29 showed a
“Sign up to use Figma Make” editor and disabled Prompt/Send, alongside the fictional
The Elm / T-07 entry stating no real orders are placed. A later same-day check records
the authenticated editor and AI credit reset date below. The four former TBD operations routes have been observed in the same-day
Version29 route/command inventory; status text that implied they were still unbuilt is
corrected. The new [Make-to-repository crosswalk](../../runbooks/project-completion-review.md#make-to-repository-acceptance-crosswalk-2026-09-23)
compares all five routes with local code and enumerates residual Registry/Make gaps.
This resolves TBD only as route presence and demo-workspace generation. It does not
resolve all required Screen fields/actions or demonstrate route parity, authorization,
durability, actual Store/Provider behavior or full Make acceptance. The preview remains
synthetic; editing access, responsive/keyboard coverage and the recorded branch matrix
remain open. No external state changed.

Crosswalk verification result: `CI=true pnpm format:check` passes at repository root
and all41 workspace format targets; `git diff --check` is clean. Checked the new relative
source targets and heading anchors in the Make brief/crosswalk against the current files.
This is documentation/source validation only; the earlier assembled runtime/browser
results are unchanged and are not new evidence for Make acceptance.

Pilot runbook candidate separation (2026-09-23): updated the Current local candidate
acceptance row to reference this assembled development-worktree evidence, then stated
explicitly that it does not replace Windows/WSL candidate616, its active runtime or
manifest, operator handover, a signed release identity or any external gate. No local
runtime was started or mutated. The same repository-wide format gate passes after this
runbook update.

Recipe checkpoint source evidence update (2026-09-23): checked Handoff Section50.18
and the actual shared outbox migration `migrations/0000-platform/0000_010_create_outbox_event.sql`
against the Eventing envelope and Recipe event contract. Outbox persists event identity,
per-aggregate version, `occurred_at` and statement-time `recorded_at`, with a publisher
availability index; it exposes no committed, Brand-wide monotonic source position.
Section50.18 says the event log is not the sole source for every Aggregate and rebuilds
prefer owner business tables plus an Event checkpoint. Added these exact source limits to
the Recipe projection-ordering proposal. This confirms the builder must stay paused until
its checkpoint/source-coverage protocol is resolved; no timestamp, UUID order, invented
counter or aggregate maximum is substituted. No schema or runtime change. Verification
selection is this read-only authority/schema comparison plus formatting and whitespace
checks; no business test applies.

Dining desktop-tile verification rerun (2026-09-23): the repository's focused selection
is the existing production-fail-closed Playwright journey for staff table selection and
lost one-time-code recovery. It covers the 216px maximum desktop tile assertion, Area and
state filters, empty-filter recovery, keyboard selection, one initial read plus explicit
refresh, exact same-operation retry, one-time-code replacement/hiding, and 1440/390/320px
no-overflow assertions with screenshots. The initial sandbox attempt failed before test
execution because it could not bind 127.0.0.1:5173 (EPERM); the exact command rerun with
approved local loopback access passed 1/1. Inspected all three regenerated screenshots:
the desktop tile is bounded beside the selected-table panel, and 390/320px layouts stack
filters, area groups and details without horizontal overflow. The preview build retains
its existing >500 kB chunk warning. Fixtures are synthetic and do not establish Store
facts. No Session authority, Domain, API, persistence or external operation changed.

Pickup Registry filter continuation selection (2026-09-23): source comparison found the
Registry requires ready/waiting/overdue filters while the current page offered Ready,
InProgress, Completed and Overdue; its cards label non-completed rows using a 15-minute
cutoff. Before implementation, checked Screen Registry, accepted Handoff Sections 80.6
and 88.10, WP-1805 and the queue DTO/source. None defines that numeric Pickup SLA; the
cutoff exists only as a UI constant and the DTO supplies `readyAt` but no `dueAt`/SLA.
Keep this discrepancy explicit: adding Waiting reuses the existing display predicate for
local consistency, but neither the code nor its synthetic row test accepts 15 minutes as
business policy. An owner-approved threshold/source remains required before a production
Overdue claim. Run the affected Pickup production browser journey, targeted component
test, direct Merchant TypeScript, changed-file lint/Prettier and `git diff --check`. No
query/API/Domain behavior or action authority changes; Claim and Report Exception remain
disabled.

Pickup Registry filter continuation result (2026-09-23): added `Waiting` as a local
current-page filter that uses the same non-completed/<15-minute UI predicate as the existing
card label; no server query or cutoff changed. That 15-minute cutoff is not an accepted
Fulfillment SLA: the current DTO has no due/SLA field and the source trace found no
numeric Pickup threshold in the Registry, Handoff or WP-1805. The production Pickup paging,
scope and permission journey passes (1/1), including a synthetic 5-minute Ready row under
Waiting and no-match under Overdue. The Merchant package suite passes (106 files/757
tests), direct Merchant TypeScript and scoped ESLint pass. Prettier initially flagged the
new nested conditional; the source was formatted, and the final targeted formatting check
and `git diff --check` pass. Its production preview build completed with the existing
chunk-size warning above 500 kB. The E2E exercises synthetic intercepted responses only;
no Claim, exception, Store, Domain, API, persistence or external action was performed.
The simulated row outcomes verify the UI predicate only; production overdue policy and
its authorized source remain open.

Exception mandatory-field follow-up selection (2026-09-23): Screen Registry
`OPS-ORDER-EXCEPTION` requires created/SLA context; the accepted DTO already supplies
validated `createdAt` and `dueAt`, but cards displayed only the due timestamp. Render the
existing Created timestamp alongside the current due/SLA label, with a browser assertion
on the 500-row synthetic journey. Run all production journeys in the affected Exception
spec, Merchant TypeScript, changed-file lint/Prettier and `git diff --check`. No DTO/API,
source contract, action route or data authority changes; do not display UUID references.

Exception mandatory-field follow-up result (2026-09-23): Exception cards now show the
validated Created timestamp already present in the DTO alongside the due/SLA eyebrow; no
internal reference is exposed. Direct Merchant TypeScript and scoped ESLint pass. The
browser journey explicitly observes both createdAt and dueAt. A filtering mistake invoked
the configured `@production` project for the whole Merchant browser suite rather than
only this spec; all 39 production-project tests passed, including all six Exception
spec cases, with the expected local Vite preview chunk-size warning. Reopened 390px and
320px screenshots show the filtered empty state and controls without horizontal overflow;
they do not show populated exception cards. The journeys use intercepted synthetic data;
no external, Payment, source-finality or acknowledgement operation was performed. Final
Prettier and `git diff --check` are selection evidence; no database suite applies.

Latest Make editor/route recheck (2026-09-23): the earlier same-day sign-up gate has been
superseded; the linked Version29 project now opens an authenticated editor. A visible
notice says team AI credits reset on 2026-09-30. Re-read `/operations/pickup` and
`/operations/order-exceptions` through the Preview route field: Pickup shows six fictional
active records across seven cards including one Completed row and still lacks visible
Order search, Claim and Exception filters; Exceptions shows four fictional rows (4 open /
4 total) without search/filter controls. Shell and rows remain labelled fictional/demo.
The Code view also exposes the project source tree and editable source pane while the
AI prompt/Send controls remain disabled by the credit limit. A bounded Pickup source edit
attempt was restored from its pre-edit source capture; a complete clipboard comparison
confirmed the file is byte-for-byte back to that captured content. No Make source change
persisted. No prompt, simulated command, publish or share action occurred. Verification
selection is the current browser text/accessibility and preview state; no repository suite
applies. The earlier signup statement remains historical and must not be used as the
current access gate. AI-generated changes remain unavailable until credits reset, while
direct code editing is available and still requires preview, responsive and keyboard
acceptance. Full Screen reconciliation remains open.

Make editor capability reconciliation verification selection (2026-09-23): reconcile
the current authenticated Code/Preview surfaces with the WP and project crosswalk; verify
the transient Pickup edit was fully restored against its pre-edit source capture; format
and link-check the two changed Markdown files and run `git diff --check`. This is an
external-state/documentation update only; do not rerun application or database suites.

Result: authenticated Code view shows editable project files while AI Prompt/Send are
disabled through the displayed September 30 credit reset. After the bounded edit trial,
the full Pickup file copied back identically to the pre-edit capture; there is no
persistent Make change to validate or report. Preview content remains fictional. The WP
and project review now distinguish manual editing from AI generation and keep all route,
screen, responsive and keyboard acceptance open. Prettier and `git diff --check` pass for
the two changed documents; application/build/database checks are not applicable.

Make Pickup and Exceptions filter implementation (2026-09-23): after reopening the
authenticated Version29 Code view, captured each complete source file before editing and
compared the editor contents to that capture before replacement. Persisted direct code
edits in `PickupWorkspace.tsx` and `ExceptionsWorkspace.tsx`; AI prompt/Send remain
credit-disabled through the displayed September 30 reset. Pickup now filters the fictional
page-local Order number and shows active/shown counts, an empty state and Clear search.
Its copy explicitly limits search to demo records and says Claim/exception fields are
unavailable in this source. Preview verification: seven cards/six active, PU-007 yields
one row, a no-match query yields zero plus the empty state, and Clear restores seven
shown. No business action was invoked.

Exceptions now filters the actual fictional type, severity, status and owner fields, with
counts, Clear filters and an empty state. It explicitly says Provider state, overdue SLA
and safe public references are unavailable in this source, and labels the fields
fictional. Preview verification: Payment reconciliation yields EXC-001; combining Paid
without fulfillment with Assigned owner yields zero and the empty state; Clear filters
restores all four open rows. No acknowledge/assign/resolve action was invoked. Each pasted
file was compared against its staged full-file text after editing. These checks establish
only the Make draft's local synthetic UI and do not prove a backend, authorization,
persistence or business outcome.

Verification selection for the repository record: inspect the updated WP, Make brief and
project crosswalk for evidence scope, source links and stale “no persistent edit” claims;
run the existing repository format check for those Markdown changes and `git diff --check`.
Do not rerun business suites because only the remote Make draft and documentation changed
in this continuation. The viewport capability had not yet been located at this point; see
the responsive follow-up below. Required next evidence includes other Make screen
journeys, remaining WP scope (Pickup, Exceptions, Make TBD and pre-launch gaps), and all
external evidence/approval gates.

Keyboard follow-up: Pickup search accepted typed `PU-007`, rendered one row, and its Clear
search button restored seven shown records through keyboard activation. Exceptions type
selection accepted keyboard text `Paid without fulfillment`, rendered one matching row,
and keyboard activation of Clear filters restored four rows. This covers only those
controls. The repository `git diff --check` attempt did not start: the shell exited 69 at
the machine's unaccepted Xcode license notice. No terms were accepted; this was
subsequently resolved by sourcing `.local/activate.sh` and completing format/diff checks.

Make Pickup/Exceptions responsive follow-up (2026-09-23): located the actual viewport
controls under Preview options → Viewport → Custom. At 1440×956, both pages render their
desktop shell with full-width work areas. At 390×844 and 320×720, Pickup renders a
single-column search and stacked order cards; measured document/client widths were 391/391
and 320/320 respectively. At the same dimensions, Exceptions wraps its four fictional
filters into two columns and stacks exception cards; screenshots show no horizontal
clipping. The mobile shell uses its compact navigation control. Exceptions browser
automation could not read inner-frame scroll metrics after its route transition, so its
responsive evidence is the configured 390/320 iframe viewport plus visual inspection,
not a DOM overflow assertion. The floating Prototype spec affordance overlapped the
lower-right edge of Pickup's last card at 320px; the correction is recorded below.
Earlier keyboard checks cover
only Pickup search/clear and Exceptions type/clear, not complete page keyboard coverage.
Preview remained fictional and no business action was invoked.

Repository documentation verification result: `CI=true pnpm format:check` passes with
41/41 workspace format tasks; the final `git diff --check` is clean. An initial format
attempt flagged `project-completion-review.md`; it was formatted with the repository's
Prettier command and the complete check was rerun successfully. An initial formatter
invocation without `CI=true` hit pnpm's no-TTY installation guard; it was rerun with the
repository-required CI setting. No application or database suite was selected because
this continuation changed only documentation in the repository and the separate Make
prototype.

Bounded Pickup/Exceptions diff review (2026-09-23): reviewed the current UI and E2E edits
against the accepted route reconciliation. Pickup search reads the page projection's
public Order reference; Waiting reuses the existing 15-minute card predicate; Claim and
exception fields are local filters only and no new action route is introduced. Exception
filters use current DTO kind/severity/status/owner/Provider/due facts; creation time uses
the validated DTO, and linked internal UUIDs remain masked when no safe display reference
exists. Current E2E assertions exercise clear/empty/recovery and assert no UUID disclosure.
This review found no scope or authority change requiring a new business check. It is not a
review of every unrelated modified file in the broader worktree, and the broader project
remains in progress.

Make mobile SpecBadge correction (2026-09-23): the 320px screenshot and preview DOM showed
that the fixed `SpecBadge` is rendered from the prototype's `App.tsx` and covers Pickup's
last-card status. Verification selection: source-diff the global badge and loaded Pickup
scroll region, edit only the prototype-owned mobile affordance, verify at the existing
320/390 and 1440 viewports, and inspect the final-card state without invoking its business
actions. No repository business suite applies to this remote-only edit. Captured the full
current `App.tsx` and `PickupWorkspace.tsx`, verified
each against the editor before pasting, and compared the complete post-edit clipboard back
to the staged source. Reverted an earlier unverified list-padding attempt; the Pickup list
spacing is unchanged. The badge now hides at widths up to 640px while remaining available
on desktop. Its spec text now says acknowledge/assign are simulated, source resolution is
gated, and responsive acceptance is in progress. Make HMR rendered Pickup at 320×720 and
390×844 with no SpecBadge in the AX tree; at 320 the PU-007 Ready badge is visible, and at
390 all seven cards and status labels fit. At 1440×956 the desktop Spec entry remains
visible and its expanded copy matches those boundaries. Preview compilation/rendering
showed no error. No business command, publish or share action occurred; all records remain
fictional. This addresses the specific mobile overlay only; complete route keyboard and
scenario coverage remain open.

Dining single-tile width follow-up selection (2026-09-23): address the reported desktop
single-item grid expansion by fixing each Dining table track at a 13rem maximum and
aligning the grid to the start; the `min(13rem, 100%)` bound preserves narrow layouts. Run
the existing `@production` Dining session-start/recovery Playwright case only; it asserts
tile width, filters, keyboard selection, initial/refresh reads, same-operation retry,
one-time-code replacement/hiding and 1440/390/320 no-overflow screenshots. Reopen all three
screenshots and inspect the resulting diff. No Domain/API/session semantics change. No
database or full Merchant suite applies to this CSS-only fix; project regression remains a
named later milestone.

Dining single-tile width follow-up result (2026-09-23): changed the table grid to tracks
bounded at 13rem (208px) with start alignment. Fresh command
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test
e2e/dining-session-start.spec.ts --project=production-fail-closed` passed 1/1 after the
default sandbox denied local Vite loopback binding with EPERM; the identical command was
rerun with approved local loopback access. The journey exercised filter/empty recovery,
keyboard selection, one read plus refresh, same-operation retry, one-time-code replacement
and hiding, the ≤216px desktop assertion, and 1440/390/320 no-overflow assertions. Reopened
all regenerated screenshots in `apps/merchant-web/test-results/dining-board-{1440,390,320}.png`:
the single desktop tile remains compact beside the detail panel; mobile areas/cards/details
stack without horizontal overflow. Prettier check for changed source/docs and `git diff
--check` pass. Build emitted the existing >500kB chunk warning. Synthetic fixtures only;
no real Store/session evidence or external action. No database/domain suite was applicable.

Dining width continuation recheck (2026-09-23): with the repository-pinned Node
24.18.0/pnpm 11.13.0 toolchain, the same focused `production-fail-closed` session-start
journey passed 1/1 again. The regenerated 1440/390/320 screenshots were reopened: the
single desktop tile is compact beside the selected-table detail; both mobile widths stack
the board and detail without horizontal overflow. The existing journey also re-exercised
area/state/text filters, empty recovery, keyboard selection, one table refresh, same-request
retry, and explicit entry-code replacement/hiding. Its intercepted fixtures are synthetic;
no live Store facts or Dining commands are established. The initial restricted run could
not bind local Vite (EPERM); the approved local-loopback rerun passed. The project build
completed with its existing >500kB chunk warning.

Make Exceptions detail and keyboard-reset follow-up (2026-09-23): refreshed the current
Version29 `/operations/order-exceptions` preview. A local Payment Reconciliation type
filter produced only fictional EXC-001; with keyboard focus on Clear filters, Enter restored
all four rows. Selecting EXC-001 exposed a fictional detail with unreconciled Payment,
no finalised source/evidence summary, and a financial-boundary explanation. Acknowledge
and Assign to me remain explicitly labelled simulated; Resolve is unavailable until source
finality and evidence summary exist. No simulated action was invoked. These observations
are preview-only and do not establish real reconciliation, finality or evidence. Keyboard
coverage remains limited to specific Pickup/Exceptions controls; full-page accessibility
and all Registry fields/actions remain open.

Make Orders recovery scenario follow-up selection (2026-09-23): use the Scenario Browser's
Acceptance outcome unknown and Command failed scenarios on fictional Submitted Pickup rows;
verify the visible order action and recovery/refresh states, then restore Normal mixed queue.
Also select Stale/Offline and confirm a pending order is read-only. Do not interpret any
prototype status as server idempotency, source authority or a production Order.

Make Orders recovery scenario follow-up result (2026-09-23): on synthetic DEMO-1007,
Accept displayed the explicit unknown-outcome message (not a failure) with Refresh order
facts first and Retry acceptance (simulated recovery). Activating the latter showed
Submitting / duplicate submission blocked, then Accepted / Simulated confirmation received.
The displayed row moved from Submitted/pending to Accepted/confirmed. Stale/Offline showed
its stale snapshot, explicit read-only copy and a disabled Accept button. Command failed
showed a non-retriable rejection with unchanged order and required Refresh order; the
simulated refresh returned version 2 with the batch still Not accepted and Accept available.
Switching back to Normal restored the original eight-row fictional queue and DEMO-1007's
Submitted/pending state. A separate Unknown → Refresh observation also returned a fresh
version with Not accepted; the UI re-exposed Accept. This flow does not prove the old
operation's finality or safe server idempotency and remains a Make reconciliation question.
These are in-memory scenario states only; no source command/backend, real Order or Payment
was involved. AI generation is still credit-disabled; no publish/share action occurred.

Make Orders rate-limit repair selection (2026-09-23): Section 88.24 requires a visible
Retry-After/progressive delay and prohibits automatically creating a new logical operation.
The Version29 Rate limited preview only said to wait and retry; it showed neither a delay
nor a manual retry control. In the private Make Code view, update only `OrderDetail.tsx` to
display an explicit five-second simulated Retry-After countdown, keep retry disabled until
the delay ends, and require a manual retry click. Capture and compare the full source before
and after the editor paste. In Preview, select Rate limited on fictional DEMO-1007, verify
the blocked countdown and its manual action after expiry, confirm no automatic retry, then
restore Normal and all eight original rows. Do not publish/share or infer a production
cooldown from this synthetic value.

Make Orders rate-limit repair result (2026-09-23): the complete `OrderDetail.tsx` editor
source was captured before editing and the post-edit clipboard matched the staged source
exactly. The rate-limited detail now labels `Retry-After: 5 seconds` as a simulated demo
response, says no retry is automatic, and exposes a disabled countdown followed by a manual
retry button. Preview of fictional DEMO-1007 showed the 429 message and a disabled button
with four seconds remaining after initial render; after the full delay the button became
enabled as `Retry acceptance after rate limit`. No retry was clicked, so no retry request was
sent. The global Scenario Browser was restored to Normal; the original eight demo rows and
DEMO-1007 Submitted/Not accepted state returned. This verifies only the private in-memory
prototype presentation. The five-second value is synthetic and is not a Store/Provider
header or production policy. No publish/share action occurred.

Make Orders pending-timeout repair selection (2026-09-23): the earlier preview showed
`Command pending` moving to `Accepted`, although the Scenario Browser says the outcome is
unconfirmed and the next step is an Unknown path. In private Code view, add only the
`command_pending` acceptance result mapping to `unknown`, retaining the existing pending
interval, duplicate block, Unknown explanation and explicit recovery controls. Capture and
compare complete `App.tsx` source around the replacement. Verify DEMO-1007 visibly enters
Submitting/duplicate blocked, then reaches Unknown (not success), with Refresh and explicit
same-operation retry choices; restore Normal and the original eight fictional rows. No
retry is clicked, no server semantics are inferred, and no publish/share occurs.

Make Orders pending-timeout repair result (2026-09-23): the complete `App.tsx` source was
captured and the full post-edit editor clipboard matched the staged source exactly. With
fictional DEMO-1007 and `Command pending`, Preview first showed Submitting / duplicate
submission blocked, then after the existing simulated response delay showed `Acceptance
could not be confirmed`, explicitly labelled not a failure, with Refresh order facts and
Retry acceptance controls. The success state did not occur. Neither recovery control was
clicked. Restoring Normal returned all eight original rows and DEMO-1007 Submitted/Not
accepted. This is synthetic in-memory Make presentation evidence only; it proves no real
command, timeout, idempotency or Order outcome. No publish/share action occurred.

Pickup and Exceptions browser continuation (2026-09-23): with the repository-pinned Node
24.18.0/pnpm 11.13.0 toolchain, `pickup-queue.spec.ts --project=production-fail-closed`
passed 1/1 and `order-exception.spec.ts --project=production-fail-closed` passed 10/10.
Pickup re-exercised current-page reference/state/claim/exception filters, clear behavior,
unknown proof and handoff same-operation retries, pagination, permission recovery and Store
mismatch. Exceptions re-exercised 500-row paging, stale refresh, selected-Store scope,
compensation confirmation/retry and Unknown/Conflict/Self/Denied recovery identity. New
390px/320px screenshots for both queues were inspected; all four views reflowed without
horizontal overflow. The Exceptions screenshots show the documented empty filtered state.
Both browser suites used intercepted synthetic responses; no live Store, Order, Payment or
exception result is established. Initial restricted local-server attempts failed to bind
127.0.0.1:5173 with EPERM; approved local-loopback reruns passed. Production-preview builds
completed with the existing >500kB chunk warning. No source behavior changed during these
verification-only reruns.

Make Dining TBD reinspection (2026-09-23): Version29 route navigation opens
`/operations/dining` and its selected T-02 detail at
`/operations/dining/sessions/SES-002`; the floor groups fictional cards into
Main/PATIO/BAR. The selected detail includes synthetic 39-minute elapsed time, one guest,
DEMO-1008/Ready, a CAD19.00 accepted batch and a pending-payment close blocker, with copy
separating Order closure from Session closure. No floor filter or detail action control
appeared in the current accessibility tree. These prototype facts are not produced by
Merchant `/operations/dining`, whose current source is `StaffDiningTable`; the repository
route instead supports table-label/area/state filters and retains Session start/recovery/
Host Transfer. Only table selection was exercised; no business demo action, publish or
share occurred. Make Registry coverage and responsive/keyboard/failure journeys remain
open; no production Order, guest count, amount or payment status is inferred.

Make Dining filter follow-up selection (2026-09-23): the private Version29 floor lacked
filters despite the production route's table/area/state filtering. In Code view, edit only
`DiningWorkspace.tsx` to add page-local table/Session search, Area, table-state and
attention-only filters, a demo-row count, empty state and Clear filters. Preserve the
existing selected-table detail and Session actions; do not invent owner/source fields or
invoke business actions. Capture the full source and compare exact post-paste contents.
Verify text and Session searches, each filter combination, no results and clear; check
keyboard operation and 320/390 widths. Record as synthetic Make presentation only; keep
Registry gaps and production source authority open.

Make Dining filter follow-up result (2026-09-23): the complete formatted
`DiningWorkspace.tsx` source was staged and the full post-paste clipboard matched it
exactly. The private floor now searches table labels and active Session references,
filters Main/Patio/Bar, Available/Occupied/Blocked, and attention-required rows, shows
the number of demo tables, and provides an empty state and Clear filters. Preview checks
returned T-02 and SES-002 individually (1/11 each), Patio (2/11), Patio+Blocked (P-02,
1/11), attention-only (5/11), a no-match message (0/11), and Clear filters (11/11).
At 320×720, controls wrap and cards use two columns without visible horizontal overflow;
controls are at least 44px high. Keyboard navigation selected Available and attention-only,
then Enter on Clear filters restored All/11 tables. Existing detail and business actions
were not invoked. All rows and statuses remain fictional in-memory demo data; no Make
publish/share or backend action occurred. Full Screen Registry field/action, broader
responsive and failure journeys, and Make acceptance remain open.

Make Pickup state-filter follow-up selection (2026-09-23): `PickupWorkspace.tsx` exposes
safe Order-number search but no state filter, although each fictional row already has an
explicit status. Add only a local state filter for the existing Ready/InProgress/Completed/
Cancelled values and combine it with the current search. Use 44px controls, a clear-all
path and filter-specific empty copy. Keep Claim and exception filters unavailable and say
why; do not synthesize those fields or change pickup actions. Capture and compare the full
source after paste. Preview each filter, combined no-match/clear, and the configured mobile
layout; this remains private fictional presentation evidence.

Make Pickup state-filter follow-up result (2026-09-23): the complete formatted
`PickupWorkspace.tsx` source was captured before editing and the full editor clipboard
matched the staged source exactly. The preview adds a 44px Order-number search and a 44px
state select backed only by each demo row's existing status; Claim and exception fields
remain explicitly unavailable. InProgress returned PU-004 (1 active/1 shown); combining
that state with `PU-002` returned the explicit no-match state (0/0). Tab navigation reached
Clear filters and Enter restored All states, empty search and the original 6 active/7 shown.
At the 390px custom viewport the filters and single-column cards were visually inspected
without horizontal clipping. Language server showed Ready; this is not a complete remote
TypeScript/build report. No handoff/proof command, publication or sharing occurred. All
records are fictional. Claim/exception mappings, additional Registry journeys and complete
Make acceptance remain open.

Make Exceptions keyboard follow-up (2026-09-23): on the private Version29 preview, setting
Severity=Critical and Status=Assigned produced `0 open · 0 shown` and the explicit no-match
state. From the Status control, Tab navigation reached Clear filters; Enter restored All
severities/All statuses and the original four fictional rows. The inspected 390px custom
preview showed the filters in two columns and stacked cards without visible horizontal
clipping. Provider state, overdue SLA and safe public references remain explicitly
unavailable; no exception action was invoked. This extends only the preview keyboard and
responsive evidence, not a production command or reconciliation fact.

Make Kitchen state-filter follow-up selection (2026-09-23): the current private
`KitchenWorkspace.tsx` groups by station but has no queue-state filter, while each demo
`KitchenTicket` already exposes the five-state enum `Queued/Held/InProgress/Completed/
Cancelled`. Add one page-local state selector backed only by this enum, retain the existing
station lanes/tabs and selected-ticket actions, and use the same filter on mobile and
wide layouts. Do not infer course/priority/overdue policy, allergen facts or a safe Order /
ticket search contract. Replace the full source from the captured baseline, verify exact
full-file readback, test a matching row and restore All, and inspect 320/1440 previews.

Make Kitchen state-filter follow-up result (2026-09-23): only the private prototype
`KitchenWorkspace.tsx` changed. Full-file post-paste clipboard matched the staged source
exactly (26,463 characters); the language server reported Ready, and Preview compiled
without an error. State selection In Progress displayed KT-002 on the Grill station;
Completed displayed the existing completed ticket(s) across desktop lanes; All states
restored the full queue. The 320×720 preview retains horizontally scrollable station tabs,
a 44px state control and readable ticket cards. At 1440×956 the state control appears above
all five lanes and the lane layout remains intact. No kitchen action was invoked, and all
records remain fictional. Course/priority/overdue, allergen, safe-reference search, full
state/failure, and complete Make acceptance remain open. No Make publish/share occurred.

Fresh Dining browser rerun (2026-09-23): after confirming the single-tile grid cap is
13rem and the existing E2E bound is 216px, ran
`source .local/activate.sh && CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/dining-session-start.spec.ts --project=production-fail-closed --grep 'staff starts a table and recovers a lost entry code without duplicate start'`;
an initial default-sandbox launch was blocked by EPERM binding Vite to 127.0.0.1:5173;
the same command with approved local-loopback access passed 1/1. It
covered table/Area/state filters and empty recovery, keyboard selection, exact same-operation
Session retry, one-time-code recovery/hide, one initial table read plus one explicit-refresh
read, the desktop ≤216px tile assertion and 390/320 no-overflow assertions. Newly generated
1440/390/320 screenshots were reopened; the desktop tile remains compact beside selected
details and the mobile layouts stack the board/detail without horizontal overflow. The
preview build reports only the existing >500kB chunk warning. All responses are intercepted
synthetic fixtures; this does not establish live Store behavior. No Dining source changed
for this rerun. Pickup, Exceptions, Make crosswalk/TBDs and whole-project launch gaps remain
open; no publish/share/deploy occurred.

Make Pickup/Exceptions 320px follow-up (2026-09-23): on the authenticated private Version29
Preview, configured the Custom viewport to 320×720 and rechecked the current Pickup and
Exceptions filters against their existing fictional rows. Pickup In Progress showed PU-004;
adding the PU-002 search produced 0 shown and the explicit no-match state; keyboard Enter on
Clear filters restored All and 6 active/7 shown. Exceptions Critical + Assigned produced
0 open/0 shown and the no-match state; keyboard Enter on Clear filters restored All and the
original four rows. Newly inspected 320px screenshots show stacked Pickup cards and a
two-column Exceptions filter grid with a single-column case list; no horizontal clipping was
visible. The 1440px Exceptions screenshot also shows the complete filter grid and rows. This
is demo-only Preview evidence, not Registry action/source acceptance. Claim/exception fields
for Pickup and Provider state, overdue SLA, safe public Case reference and generic commands
for Exceptions remain unavailable. No business command, source edit, publish or share
occurred; Make AI credits remain unavailable until Sep 30.

Make QR-origin customer route follow-up (2026-09-23): freshly reopened the private Preview
Customer route at `/` and followed its explicit `View menu` transition to `/menu`. The entry
shows The Elm, fictional T-07 Dine-in context, Open hours and “Simulated QR session —
fictional demo, no real orders placed”; the resulting menu retains that table/channel context,
an empty cart and fictional CAD menu items. The 1440 screenshot shows the wide grid; inspected
390×844 and 320×720 screenshots show two-column item cards within the mobile frame; the
category row extends past the visible edge, and its scroll/keyboard behavior remains
unverified. No item was selected and
no Cart, Quote, Checkout, Payment or session command was invoked. This confirms only the
synthetic route/context and visual layout. The Customer `Feature Disabled` contract, invalid/
expired QR authority, source freshness, continuity and full Registry/keyboard/error coverage
remain unresolved. The five Make Operations routes remain separate evidence; Communication
History has no current Make route and must wait for its owning activation/source decisions.

Exception filtered-empty clarification (2026-09-23): final diff review found the local
Exception workbench used its source-empty message even when loaded rows existed but active
filters excluded every row. It now distinguishes an actually empty Store result from “No
exceptions match these filters” and tells staff to Clear filters. The existing full-backlog
browser journey asserts the filter-specific heading and help text. Fresh post-format
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/order-exception.spec.ts --project=production-fail-closed --grep '@production workbench displays the full 500-row backlog'`
passed 1/1; Merchant typecheck, targeted ESLint, Prettier and `git diff --check` passed.
Fresh 390/320 screenshots were inspected; the filter-specific empty copy wraps without
horizontal overflow. Browser rows remain intercepted synthetic data; no owner action or
financial write occurred.
This copy correction does not close the unresolved Exception public-reference/command and
Provider evidence gates.

Make current-access and Customer-denial recheck (2026-09-23): reopened the linked Version29
file in the current Chrome session. The left pane now shows “Sign up to use Figma Make” and
the AI prompt/Send controls are disabled; the Preview remains readable, but this session
does not expose editable Code view. This supersedes neither the prior authenticated-session
edit evidence nor proves account-wide loss of access. In the Preview, selected the synthetic
Customer `Permission Denied` scenario and activated `View menu`; after the transient
`Verifying…` label, the preview returned to the ordinary fictional T-07 entry without a
visible permission explanation or recovery instruction. This is distinct from the earlier
`QR Denied` scenario, which showed access-denied/staff-assistance copy. No real permission,
Guest Session, Order or command was exercised. Record the Session scenario as unresolved
Make presentation behavior; do not infer a production authorization result or change the
accepted uniform QR-entry error contract. Verification selection: record current visible
editor/Preview access and the synthetic route result only; no repository suite applies.

Make Customer category keyboard follow-up (2026-09-23): on the currently readable private
Version29 `/menu` Preview, selecting Mains showed only the Mains section. From the focused
Mains tab, Tab moved focus to Sides; Enter selected Sides and showed only its three existing
fictional items. The focus remained on the selected tab, and the screenshot shows the
horizontal category row clipped at this narrow Preview width while Sides remained visibly
focused. ArrowRight from Mains produced no selected-tab change; this Preview supports
sequential Tab/Enter through Sides but does not demonstrate roving-arrow navigation or
automatic horizontal scrolling. All category states and full CUST-MENU acceptance remain
open. The editor/AI prompt remains sign-up gated, so no Make source edit was possible.
No item, Cart, Quote, Checkout, Payment or Session command was invoked. Reconcile scroll and
focus visibility when editable Code view is available; no repository suite applies.

Exception filter operation-retention selection (2026-09-23): active Payment follow-up controls
retain their exact operation reference and `Unknown` recovery state in component state. The
new Exception filters currently remove nonmatching cards from the React tree, so filtering
away a card during/after an uncertain action can unmount that state and lose same-operation
retry. Keep all current-source card components mounted and apply the local filter with native
`hidden`, which also excludes nonmatching cards from visual and assistive-technology results.
Extend the existing production Exception follow-up recovery journey: after a synthetic
unknown response, filter the card out, verify its action is hidden but attached, clear filters,
and confirm Retry reuses the identical request body. This is UI-only; no API, Domain, financial
or authority changes. Run the focused Exception recovery browser case, affected component test,
Merchant typecheck, scoped lint/format and diff checks; no database or full-suite rerun applies.

Exception filter operation-retention result (2026-09-23): `OrderExceptionPage` now keeps all
current source cards mounted and toggles the native `hidden` attribute for nonmatching rows.
This removes filtered rows from visual/accessibility results while preserving each card's
same-operation/Unknown component state. The existing Unknown follow-up browser journey now
filters the row out, confirms the Retry control remains attached but hidden, clears filters,
then retries and asserts the request bodies are byte-identical. The focused synthetic browser
case passes 1/1 and the complete Exception spec passes 10/10. The Merchant unit command passed
106 files/757 tests; Merchant TypeScript, targeted ESLint and Prettier pass. Playwright's
default sandbox attempt was blocked by loopback EPERM; the exact tests passed with authorized
local loopback. The configured browser run rebuilt Vite with only the existing >500 kB chunk
warning. Fixtures/intercepted responses remain synthetic; no Payment, Store, Task, exception
resolution, API, Domain or persistence behavior changed. No database or full repository suite
applies; worktree remains uncommitted.

Pickup filter operation-retention selection (2026-09-23): `PickupProofForm` keeps the exact
verification intent in a component ref through Outcome Unknown, but the Order search/state
filters currently unmount nonmatching `PickupCard` components and dispose that intent. Keep
all current projection cards mounted and apply the local filter with native `hidden`, while
retaining the existing no-match state and assistive-technology exclusion. Extend the existing
production Pickup journey to filter out a row after a synthetic unknown proof result, confirm
the same Retry control remains attached but hidden, restore the row, and verify the same
request body is retried. The locked native handoff dialog prevents user interaction with the
background filters while its result is unknown; this selection targets proof recovery only.
No proof, handoff, authorization or source semantics change. Run the focused Pickup production
journey, affected component tests, Merchant typecheck, scoped lint/format and diff checks; no
database or full-repository suite applies.

Pickup filter operation-retention result (2026-09-23): `PickupQueueScreen` now keeps every
current-page `PickupCard` mounted and uses its native `hidden` attribute when local search or
filters exclude it; the no-match recovery state remains visible. The production browser
journey now receives a synthetic unknown proof response, searches away the card, confirms its
Retry control is still attached but hidden, restores the public Order reference and retries
the exact request body. The full focused Pickup journey passes 1/1, including proof recovery,
explicit Handoff, cursor paging, permission denial/recovery and mobile no-overflow checks.
The Merchant unit run passes 106 files/757 tests; Merchant TypeScript, targeted ESLint and
Prettier pass. Default Playwright startup was blocked by loopback EPERM; the same command
passed with approved local loopback. Vite build reports only the existing >500 kB chunk
warning. This proves synthetic UI recovery only; no live Pickup operation or source fact.
The locked native Handoff dialog is modal while its result is unknown, so the user cannot
change the background filter in that state; this does not test a filter-driven Handoff
unmount. No API, Domain, permission or persistence behavior changed; no database/full-repo
suite applies, and the worktree remains uncommitted.

Fresh Make access check (2026-09-23): reopened the linked Version29 project in a new
Chrome tab and waited for the editor/Preview to load. The Preview remains readable and
shows the fictional The Elm/T-07 entry, while the editor pane shows “Sign up to use
Figma Make”; Prompt, Add context, model selection and Send are disabled. This current
session therefore supports read-only Preview inspection only. The earlier authenticated
Code-view edits remain valid historical evidence for the private draft, but are not
evidence of present editing access. No scenario, business action, source edit, publish or
share occurred. Verification selection is the visible browser accessibility state; no
repository application suite applies. Revisit the remaining Make screen/keyboard/failure
coverage when editing access is available; preserve synthetic-data and Registry gaps.

Exception Store-scope reconciliation (2026-09-23): Screen Registry
`OPS-ORDER-EXCEPTION` lists Store among its filters. Source inspection confirmed the
normal Merchant workspace has an authenticated global Store selector limited to
`authorizedStores`; a successful switch replaces the selected scope and CSRF context.
`App.tsx` keys `OrderExceptionPage` by that Store reference and CSRF context, so it
unmounts prior Store data/filters and reloads `/merchant/order-exceptions` under the new
selected Store. The route and BFF accept no caller-supplied Store query; this is a
single-selected-Store view, not an all-Store search. Updated the completion review to
count the global selector as the Store scope/filter path and keep safe public-reference
search and generic action composition open. Verification selection: inspect the Screen
Registry entry, `MerchantShell` authorized selector, `App.tsx` scope switch/remount and
the closed BFF read route; format/link/diff checks only because no code changed. This is
source reconciliation. The existing `@production exception view follows the selected
Store after an authorized switch` E2E asserts that a switch to its synthetic Store 2 loads
that Store's exception view; it is included in the recorded 10/10 Exception spec run.
This is intercepted-fixture UI evidence, not a real Store-switch or authorization
acceptance.

## Kitchen exact-reference keyboard path (2026-09-26)

The Ticket reference field now submits its exact lookup on Enter in the existing
`apps/merchant-web/e2e/kitchen-queue.spec.ts` journey. The fresh
`production-fail-closed` run passes 3/3, including the existing exact filter/null-parameter,
no-URL/no-rendered-UUID, no-match and recovery assertions. Prettier, ESLint and `git diff --check`
pass for the changed E2E file.

Inspected the newly generated `apps/merchant-web/test-results/kitchen-board-1440.png`,
`kitchen-board-390.png` and `kitchen-board-320.png`: desktop retains three lanes; both mobile sizes
stack lanes with visible search controls, cards and read-only/KDS explanation and no horizontal
overflow. At 320 the source Refresh button is full width and Search is on its own row. Playwright's
preview build retains the existing large-chunk advisory and color-environment warnings. This is
synthetic browser evidence; no application source, live Store or Kitchen command behavior changed.

Exception Registry field reconciliation (2026-09-23): compared the exact
`OPS-ORDER-EXCEPTION` mandatory field groups and search/filter requirements with the
closed `OrderExceptionView` parser and current screen. The parser carries an opaque
exception UUIDv7, opaque Order UUIDv7 or null, kind/severity/status, Provider and
compensation states, `sourceOwner`, `ownerStatus`, created/due instants, Store label,
Business Date and freshness. It does not carry a permission-trimmed public Case/Order
reference, Payment or Dining reference fields, assigned-owner identity or a general
case timeline. The selected Store is supplied by the authorized global scope-switch
path documented above; this is not an all-Store query. The Payment-specific follow-up
panels do not establish a generic timeline or cover Dining cases. Updated the completion
review's residual gap list; no code or contracts changed. Verification selection: compare
the Registry entry against the parser/view and scoped route; check Markdown format and
diff only. These are source findings, not evidence of the corresponding owning-source
facts or browser/Store behavior. Leave missing references, owner identity, timeline and
generic actions unimplemented until their owning projection/command contracts are
composed; never expose UUIDs as user-facing references.

Exception filter keyboard acceptance selection (2026-09-23): the existing browser
journeys exercise filters with Playwright selection/click helpers but do not prove a
keyboard-only filter path. Verify that the native Type select accepts keyboard navigation,
that focus proceeds through the remaining filters to Clear filters, that Space toggles the
Overdue only checkbox, that the filter hides a synthetic future-due row while retaining an
overdue row, and that Enter clears the checkbox and restores both rows. Scope is only the
existing `OrderExceptionPage` and `order-exception.spec.ts`; the smallest existing check is the
production Exception spec filtered to the new keyboard case. Fixture responses are
synthetic. No API, authorization, projection, action or source facts change; no database
acceptance applies. Record full-page accessibility coverage as still open.

Exception filter keyboard acceptance result (2026-09-23): the focused production
Playwright case passes 1/1. It selects the first Dining type using the native select's
`D` keyboard key, tabs through the remaining filters to Clear filters, presses Enter, and
confirms the Type returns to All and the original synthetic exception row is visible.
Earlier ArrowDown/Enter did not change the native select, and the earlier `p` key matched
the preceding Payment option; the test now uses `D` for the Dining option. Prettier and
`git diff --check` pass. The preview build emits the existing >500 kB chunk warning.
This proves only the synthetic filter-and-clear journey, not full-page accessibility or
live exception behavior.

Exception overdue keyboard extension result (2026-09-23): the focused production
Playwright case still passes 1/1 with a second synthetic future-due row added. The keyboard
Type selection and Clear path pass; Space checks Overdue only, hides the future-due
`CaptureDeadlineExceeded` row while retaining the overdue open row, then Tab/Enter on Clear
restores both rows and unchecks the filter. Prettier and `git diff --check` pass. The Vite
preview build emits the existing >500 kB chunk warning. This is local fixture behavior only;
full-page accessibility, authorized due-time provenance and live exception behavior remain
open.

Exception source-action keyboard acceptance selection (2026-09-23): the existing synthetic
compensation-reconciliation journey proves current confirmed-refund review, explicit operator
confirmation, Offline lock, unknown outcome and identical-intent retry using pointer actions.
Exercise the same existing route with keyboard focus, Enter for Review and submission, Space
for the review checkbox, then Enter for retry after Unknown. Verify focus stays on the retry
control and both submitted request bodies remain identical. Scope is the existing compensation
E2E and source-specific UI; fixtures intercept every route, so no financial write occurs. If
focus is lost only because the submitting button became disabled, return it to Retry, but do not
steal focus after the operator moved elsewhere. No dedicated component test exists; run the
filtered production browser case, Merchant typecheck, ESLint on the changed component/spec,
changed-file Prettier and `git diff --check`. No database, Domain or full-repository suite applies.

Exception source-action keyboard acceptance result (2026-09-23): the first focused run exposed
focus loss after the in-flight action button became disabled; the Retry control appeared without
keyboard focus. `CompensationReconciliationAction` now remembers whether its action button owned
focus before submission and restores focus to Retry only if the browser dropped focus to the page
body. If the operator moved focus to another control during the request, it is left there. The
review/confirm/submit/Unknown/retry journey and the moved-focus boundary both pass in the two
filtered production E2Es (2/2); both assert identical request bodies through the synthetic route.
Merchant typecheck and scoped ESLint pass; changed-file Prettier and `git diff --check` pass.
Vite emits the existing >500 kB chunk warning. No live financial action, API, Domain or database
behavior changed; full-page accessibility and live authority evidence remain open.

Pickup proof keyboard recovery selection (2026-09-23): the existing production Pickup journey
proves unknown proof verification and identical retry, but the proof form unmounts during Pending
and does not yet assert keyboard focus on Retry. Extend that journey to open verification, submit
from the focused credential field, and retry with Enter after Unknown; focus should return to
Retry only when form removal left focus on the document body. Preserve focus if the operator has
moved to the page search while the request is pending. Verify the same request body on retry.
Scope is `PickupProofForm` and the existing intercepted-response Pickup E2E; no real proof or
handoff action. Run the focused production Pickup case, Merchant typecheck, ESLint on changed
source/spec, changed-file Prettier and `git diff --check`. No database or full-repository suite.

Pickup proof keyboard recovery result (2026-09-23): the first focused browser assertion showed
that after proof Unknown the retry button had no keyboard focus. `PickupProofForm` now records
whether submission originated within its form and, when it receives Outcome Unknown, focuses
Retry only if form removal left focus on the document body. A keyboard E2E also moves focus to
Order search while the first response is pending and confirms it remains there; it then retries
the same proof twice with Enter, with the second Unknown restoring focus to Retry and all three
request bodies identical. The complete focused synthetic Pickup paging/scope/proof/handoff
journey passes 1/1. An initial hidden-row assertion used an accessible-role locator, which
correctly excluded its hidden ancestor; changing that assertion to a DOM locator made the
retention check accurate. Merchant typecheck passes; scoped ESLint, changed-file Prettier and
`git diff --check` pass. Vite reports the existing >500 kB chunk warning. The page routes are
intercepted fixtures; no proof, handoff, Store or external operation occurred.

Kitchen command keyboard recovery selection (2026-09-23): the production Kitchen journey already
asserts Unknown and exact-command retry but drives both with clicks and does not assert focus.
Exercise Accept and Retry with Enter; focus should move to Retry only when disabling the original
action dropped focus to the document body. Keep a moved operator focus elsewhere. Scope is the
existing `KitchenBoardPage` command-status panel and its intercepted production E2E. No dedicated
command-UI test exists; run that focused production case, Merchant typecheck, ESLint on changed
source/spec, changed-file Prettier and `git diff --check`. No database or full-repository suite.

Kitchen command keyboard recovery result (2026-09-23): Accept submitted with Enter. While its
request was held, focus moved to Refresh; after the request became Unknown, focus remained on
Refresh. Retrying with Enter produced a second Unknown and restored focus to Retry; the next
Enter reused the exact original command and advanced to the existing refreshed-projection flow.
The focused production Playwright case passes 1/1; Merchant typecheck, scoped ESLint, Prettier
and `git diff --check` pass. The first run exposed an incorrect new assertion about distinct
idempotency keys; corrected to the existing four distinct operation intents and reran. Vite
reports the existing >500 kB chunk warning. All network routes are intercepted fixtures; no
Kitchen write, live Store fact, database suite or full-repository regression is claimed.

Pickup filter keyboard selection (2026-09-23): the existing production browser journey uses
Playwright select helpers for the current-page Waiting filter, pointer activation for Clear,
and a direct checkbox helper for Include completed. Exercise native-select typeahead and Tab
order through Claim, Exception and Clear; activate Clear with Enter; toggle Include completed
with Space and verify the refreshed queue retains focus on Refresh. Use the existing intercepted
Pickup response only. This proves the rendered control path, not an SLA, Claim command or
live Fulfillment behavior. Run the focused production Pickup case, changed-file Prettier and
`git diff --check`; no application/domain/database change or full suite is expected.

Pickup filter keyboard result (2026-09-23): the focused production case passes 1/1. Native
select typeahead with `W` selects Waiting; Tab advances through Claim and Exception to Clear,
and Enter resets the filter and restores the synthetic row. Space toggles Include completed;
the reloaded projection displays its Completed fixture and the existing accessibility behavior
moves focus to Refresh. Prettier and `git diff --check` pass. Vite reports the existing
large-chunk warning. This covers those current-page controls with intercepted data only;
full-page accessibility and the unapproved 15-minute Overdue threshold remain unresolved.

Pickup overdue source-gap correction selection (2026-09-23): WP-1805 and the accepted
`FUL-PICKUP-QUEUE` Registry require wait/overdue presentation, but the current DTO provides
`readyAt` only and no due time or SLA. The current UI invents a 15-minute Overdue cutoff and
classifies older active orders as Overdue. Remove that unsupported classification while
retaining measured wait duration and actual Fulfillment phase filters; keep the Overdue
control visibly unavailable with the missing due-time source explained. Extend focused
Pickup component and production E2E assertions for an active item older than 15 minutes,
Waiting/Clear behavior, disabled Overdue and honest card status. Scope is the existing
`PickupPages`, its focused component tests and the intercepted Pickup E2E. Run those directly
affected checks, Merchant typecheck, scoped ESLint, Prettier and `git diff --check`; no Domain,
API, database or full-repository suite because the required authoritative due-time producer
does not exist in scope.

Pickup overdue source-gap correction result (2026-09-23): removed the hardcoded 15-minute
threshold. Active cards retain elapsed minutes and say Waiting; the Waiting filter now means
any active Fulfillment phase. The Overdue option remains visible but disabled, with adjacent
copy explaining that no authorized due time is present. The existing screen test now covers a
20-minute-old Ready fixture without an Overdue label; the production E2E verifies the disabled
option, honest card state and responsive 390/320 widths. Pickup component tests pass 3/3,
typecheck and scoped ESLint pass, and the focused production browser case passes 1/1. Prettier
and `git diff --check` pass; Vite reports its existing large-chunk warning. One initial browser
run caught the long disabled-option label causing mobile horizontal overflow; shortening the
option to “Overdue” while retaining the explanation beside the filters fixed it and the rerun
passed. This does not satisfy the Registry's Overdue behavior: an accepted Fulfillment due-time
producer and projection field are still required. No API, Domain or database code changed.

Exception filter keyboard continuation selection (2026-09-23): `OPS-ORDER-EXCEPTION` requires
type, severity, status, owner, Provider and overdue filters. The existing synthetic keyboard
case asserts Type and the final Clear position but reaches the latter by a fixed Tab count.
Extend it to move sequentially through Severity, Status, Owner, Provider and Overdue, use
native keyboard typeahead/check actions on each, and then clear with Enter. Assert accessible
control names, selected values, result/empty transitions and reset. Scope remains the existing
Exception filter screen and intercepted production E2E; source contracts and query behavior do
not change. Run the focused production case, Prettier and `git diff --check`; no API, database,
or full-page accessibility claim is intended.

Exception filter keyboard continuation result (2026-09-23): the focused production case passes
1/1. Starting from Type, keyboard typeahead selected DiningUnpaidBatch, High, Acknowledged,
Assigned and Unknown in sequence; Tab reached the Overdue only checkbox, Space checked it, and
Tab reached Clear filters. Enter reset all five selects and the checkbox and restored both
synthetic rows. The focused route and callbacks remain intercepted fixtures; no Case action,
Store or Provider behavior is implied. Prettier and `git diff --check` pass. Vite reports its
existing large-chunk warning; full-page accessibility and missing owner command composition
remain open.

Make Exceptions detail continuation (2026-09-23): reopened the current private Version29
Preview and navigated the visible Exceptions list read-only. Inspected the previously
unreviewed fictional EXC-004 Dining unpaid-batch detail and EXC-002 capture-deadline detail.
Both show a DEMO Order link, assigned owner label, age, reconciliation/compensation/source
finality and a per-case timeline; EXC-002 also shows a synthetic evidence summary and
offers simulated Assign/Resolve, explicitly separating Resolve from approved/paid
compensation. EXC-004 offers simulated Assign and keeps Resolve unavailable because its
fictional source is not final and its evidence summary is absent. No simulated action was
invoked. This completes read-only detail inspection of the four current demo exception
types, not their action/failure matrix or any Registry/production contract. In comparison,
the authorized Merchant view still has no public Order/Payment/Dining references, assigned
owner identity or general timeline fields; preserve those as owning projection gaps. Update
the Make crosswalk with these exact demo-only observations. Verification selection is the
visible Preview/accessibility state; no repository suite applies to a read-only remote
prototype inspection. Demo references, owner names, finality and evidence are fictional,
not Store or Provider evidence.

Make Exceptions scenario-browser follow-up (2026-09-23): while on the Exceptions detail,
opened the read-only Scenario Browser. It exposes global Order queue states and Pickup
proof-verification outcomes, but no Exception-specific acknowledgement/assignment/
resolution outcome selector or Exception unknown/failure retry scenario. Do not treat the
global Order `Command failed`, `Conflict` or `Outcome unknown` presets as Exception action
coverage. Updated the crosswalk to leave those Make action branches open. No scenario was
changed and no simulated action, publish or share occurred. This is current prototype
control inventory only; no repository suite applies, and it does not alter the established
source-owned exception command/finality gaps.

Make Kitchen stale/permission branch follow-up (2026-09-23): in the Preview Scenario
Browser, selected the fictional `Stale / Offline — read-only` global state. The Kitchen
queue displayed `Stale — read-only` and a snapshot banner stating that writes remain
disabled until reconnection and revalidation. Opening KT-002 retained the fictional lock,
age and unavailable freshness SLA detail; no mutation control appeared. Selecting the
fictional `Permission denied` state for that Kitchen route showed `Access denied` and
`kitchen.operate permission is required to view this workspace`, matching both
`KIT-KITCHEN-QUEUE` and `KIT-WORK-ITEM` Screen Registry permission refs. With the same
global denial selected, the Dining route displays `dining.operate` and Pickup displays
`fulfillment.operate`; these also match their respective Registry entries. Exceptions
displays `ordering.operate + authorised support permission required`, which matches its
Registry permission. Yet the shared Scenario Browser description says the current actor
lacks only `ordering.operate` and applies the denial across all five Operations routes.
That scenario premise does not explain denied access to the other four workspaces. Reconcile
the prototype as route-specific permission scenarios or generic “required workspace
permission” copy; do not infer cross-domain permission denial from one missing permission.
No action was invoked. Updated the Make crosswalk; no local code or remote source was
edited. These are read-only synthetic states, not real authorization, connection or Store
evidence; no repository suite applies. Leave conflict/unknown command behavior and complete
Make error-state coverage open.

Make current access and Exceptions recheck (2026-09-23): opened the user-authorized private
Version29 project in a fresh Chrome tab. The Preview loaded while the editor displayed “Sign up
to use Figma Make”; Prompt, Add context, model selection and Send were disabled. Read-only
Operations navigation still exposes Orders, Kitchen, Dining, Pickup and Exceptions. The current
Exceptions Preview shows four fictional rows and Type, Severity, Status and Owner filters; its
own copy says Provider state, overdue SLA and safe public references are unavailable. The
Scenario Browser exposes Pickup proof outcomes and global Order queue states, but no
Exception-specific action failure, conflict or unknown/retry scenario. No exception row was
mutated, no action was invoked, and no remote edit/share/publish occurred. This observation is
superseded by the newer access check below.

Make Customer transition follow-up and source check (2026-09-23): reopened the private Version29
project. Preview and Code view are accessible; the Code view shows the project source pane,
while the AI Prompt/Send controls report that team credits are exhausted until 2026-09-30. The
visible `src/customer/CustomerApp.tsx` imports `applyCartChange`, `applyRequote`,
`applyTipChange`, `applyContinueOrdering`, `applyContextConfirmed` and `applyPaymentResult` from
`./transitions`, confirming those handlers now depend on the production transition module.
The Make chat reports 170 tests passing and says its former copied transitions were replaced.
The visible editor fragments of `src/logic.test.mjs` show the existing `commandCore.ts` import,
the Customer-transition test section and direct calls to the transition functions. A read-only
scroll across the full editor buffer confirms a separate import from `./customer/transitions.ts`
for all six functions used by both `CustomerApp.tsx` and the transition tests. The tests include
pending/unknown mutation guards, duplicate-result protection, current-context expiry, scope
mismatch/recovery, committed item snapshot, command failure and terminal-history preservation.
The Make chat's 170-test/build report was not independently executed.

Pure-clock follow-up (2026-09-23): the Make source still gives `canWrite` a `Date.now()` default.
`applyCartChange`, `applyTipChange`, `applyContinueOrdering` and `applyContextConfirmed` call it
without an explicit clock; their `CustomerApp.tsx` handlers invoke those transitions from React
state updaters. `applyRequote` receives a captured clock, but its `canWrite` call omits it. Pass
explicit `nowMs` through every transition and capture it before each updater, then update the
direct-import tests with deterministic clocks. No Make source was edited and no Make test/build
command was run in this inspection; the pure-clock correction remains open. No share/publish
occurred; all UI content is fictional.

Make Customer explicit-clock source recheck (2026-09-23): opened Code view in the current
private Version29 project and inspected `src/customer/transitions.ts`. The loaded source
shows `applyRequote(state, nowMs = Date.now())`; its call to `canWrite` omits `nowMs`.
The visible `applyCartChange`, `applyTipChange` and `applyContinueOrdering` implementations
also call `canWrite` without a supplied clock. This contradicts the earlier Make chat's
claim that the transition module was fully pure. The AI prompt is disabled until team
credits reset on 2026-09-30, so this pass did not edit source or run Make checks. Keep the
clock extraction and handler-call updates open; this is Code-view source evidence only,
not Customer PWA or production behavior. Verification selection: inspect the edited
documentation, run its Prettier check and `git diff --check`; no repository application
suite applies to this documentation-only entry.

Downloaded Make source verification continuation (2026-09-23): downloaded the current
private Version29 source ZIP to a local isolated review copy. The copied `CustomerApp.tsx`,
`transitions.ts` and `logic.test.mjs` contain the production transition extraction and
captured-clock changes described above, including an exact-expiry test across all five
guarded transitions. Full `tsc --noEmit` initially exposed two unrelated malformed type
annotations in `src/components/DiningWorkspace.tsx`; correcting only the missing separators
in the local review copy made the full TypeScript check pass. The pinned `oxfmt --check`
passes for the five reviewed Customer/Dining files. `tsx --test src/logic.test.mjs` passes
189/189, including the exact-expiry case, and `vite build` succeeds with the existing
525.91 kB bundle warning. An initial restricted TSX run could not create its IPC pipe;
the same test and build commands passed with approved local execution access. These checks
apply only to the extracted local copy: no ZIP files were uploaded and no remote Make source
was changed. Current browser UI continues to report AI credits unavailable until Sep 30.
The syntax corrections and the source correction remain pending remote write-back and fresh
Preview verification; no publish/share was performed. No repository business checks apply
to this downloaded prototype source.

Source artifact identity: `High-Fidelity Restaurant Order Prototype.zip` SHA256 `68932276586297bacd261f06b82b60447007bfead53226dfd1d700b568a810c0`. The corrected local review-copy Customer transition and test files are `src/customer/transitions.ts` SHA256 `f35574808c40766d58c911233f07fec564942ebd9db1beb1edd04f94c9d53e76` and `src/logic.test.mjs` SHA256 `0d67dbd57e0f27dd019e44af27e5b3cd068758e0f73a85fbfb2a3ecd830a04c4`; hashes identify only the isolated review artifacts, not a remote Make revision.

Customer PWA lifecycle review follow-up (2026-09-23): reviewed the current uncommitted
Order-status context-subscription/offline lifecycle and Receipt offline/reconnect changes
against their pages and clients. The state transitions retain only stale receipt history
offline, clear live financial/delivery/eligibility fields, clear Order/Receipt display on
session-context replacement, and reject stale in-flight/realtime work; reconnect keeps
explicit refresh as the revalidation step. Acceptance question: verify these four directly
affected client/controller test files against the package Vitest configuration. The first
attempt invoked the repository-root Vitest config, which does not include workspace app
tests and reported no test files; rerunning from `apps/customer-pwa` with the same pinned
Vitest passed 4 files/86 tests. This is fresh focused evidence only; no Customer PWA full
suite/type/lint/build or broader release check was run in this follow-up. No source changed
during this review.

Customer Order Status state-overlap review (2026-09-23): Screen Registry `CUST-ORDER-STATUS`
lists both Permission Denied and Offline Read-only but does not specify priority when the
session context changes while connectivity is lost. Current behavior invalidates the
in-flight request and publishes Permission Denied on context replacement; a later browser
offline event changes the screen to Offline Read-only with `view: null`, and the copy says
the order cannot be loaded until connectivity returns. No prior Order data is restored or
shown. Retain this fail-closed behavior; an access denial for the replacement context cannot
be independently confirmed offline. This source review does not prove live Guest access or
full Screen accessibility and does not change code.

Pickup and Exception keyboard browser continuation (2026-09-23): current-page filters and
their reset paths changed in the uncommitted UI/E2E work, so use the smallest production-
fail-closed journeys that exercise these controls, synthetic read responses, scope/denial
recovery and existing Pickup proof retry. Ran `CI=true ./node_modules/.bin/playwright test
e2e/pickup-queue.spec.ts e2e/order-exception.spec.ts --project=production-fail-closed
--grep 'Pickup paging, current scope and permission recovery|exception filters and clear
remain keyboard operable'` from `apps/merchant-web`; both tests passed (2/2). The first
restricted run stopped before tests because local Vite binding to `127.0.0.1:5173` returned
EPERM; the same command passed with approved local-loopback execution. The existing Pickup
E2E regenerated 390/320 screenshots; both were reopened and visually checked for wrapping
and horizontal overflow. It exercises filters, scope/denial recovery and synthetic proof
retry; intercepted data is not Store or Fulfillment evidence. The Exception filter journey
proved keyboard typeahead/Space/Enter and reset but did not regenerate screenshots in this
run; its earlier 390/320 inspection remains separately recorded. Vite build retains its
existing >500 kB chunk warning. No business command was sent and no API, Domain, database
or authorization code changed.

Recipe admin-generation reader verification selection (2026-09-23): acceptance question: does
the internal Recipe reader return only the selected Brand's active generation/checkpoint and
matching recipe row, preserve large numeric money/event sequence exactly, and fail closed on
malformed or cross-scope data? Affected inputs are the new admin query store, its contract tests,
and the existing Recipe PostgreSQL acceptance fixture. Run only
`pnpm --filter @rms/recipe exec vitest run --config vitest.config.ts src/tests/recipe-admin-query-store.test.ts`
for decoder/transaction behavior, then
`CI=true ./node_modules/.bin/vitest run --config packages/database/vitest.recipe-management.config.ts`
for actual PostgreSQL role/RLS behavior. Run the Recipe package typecheck, lint and formatting
checks for the changed TypeScript reader and tests. Evidence is fresh; no implementation changed
during verification. This internal reader does not establish a projection builder, Merchant API,
permission trimming, freshness policy or normal-route composition.

Recipe admin-generation reader verification result (2026-09-23): the focused query-store suite
passes 34/34; Recipe package typecheck and lint pass; Prettier passes for the changed reader,
tests, fixture, package README and this WP. The first PostgreSQL acceptance attempt failed before
test execution because the restricted process could not access the local Docker socket. The same
command with approved local execution passed 1/1 against the isolated PostgreSQL fixture, including
the restricted role's Brand boundary and exact large-integer readback. `git diff --check` passes.
No implementation changed during these checks. This verifies the internal reader only; no normal
Merchant route, public query adapter, projection builder or freshness/permission policy was added.

Pickup and Exception full focused journey selection (2026-09-23): acceptance question: do the
latest Pickup/Exception filter, hidden-row retention, keyboard reset, denial/scope recovery, and
existing proof/follow-up retry paths still work across each complete affected production-project
spec and page component test? Affected inputs are the two pages, proof form, their component tests
and intercepted browser journeys. Run the unit cases through the existing workspace package from
the repository root:
`CI=true pnpm --filter @bop-rms/merchant-web exec vitest run src/PickupPages.test.tsx src/OrderExceptionPage.test.tsx`;
run the browser cases from `apps/merchant-web` with
`CI=true ./node_modules/.bin/playwright test e2e/pickup-queue.spec.ts e2e/order-exception.spec.ts --project=production-fail-closed`.
Then inspect newly generated mobile screenshots when the run produces them. Fixtures remain
synthetic; no API, Task, Store or Provider behavior is claimed. This is fresh post-filter evidence.

Pickup and Exception full focused journey result (2026-09-23): component tests pass 11/11; the
complete focused production-project browser specs pass 13/13. The restricted browser attempt
failed before tests because Vite could not bind `127.0.0.1:5173` (EPERM); the identical command
passed with approved local loopback. Both specs regenerated 390px and 320px screenshots. Visual
inspection shows filters and copy wrap into one column, Pickup actions wrap inside the card, and
the Exception no-match recovery stays readable, with no visible horizontal overflow. The test
fixtures/intercepts remain synthetic; live Fulfillment/Task/Payment facts, full-page accessibility
and authorized Overdue/SLA source remain unresolved. Vite retains its existing >500 kB chunk
warning. No API, Domain, permission, external service or live business command changed.

Pickup/Exception static-check selection (2026-09-23): acceptance question: do the changed
Merchant page, proof form and browser-spec TypeScript inputs still typecheck, lint and format
after the current filter/keyboard/retry work? Run `pnpm --filter @bop-rms/merchant-web typecheck`,
`pnpm --filter @bop-rms/merchant-web lint`, and targeted Prettier on those five files plus this
WP. Vite build was already executed by the production browser project; no API/Domain contracts
changed, so no broader build or business/database suite is selected here.

Pickup/Exception static-check result (2026-09-23): Merchant package typecheck and full package
lint pass. Targeted Prettier for both pages, Pickup proof form, both E2E specs and this WP passes;
`git diff --check` passes. The focused component/browser results above and the browser project's
successful Vite build cover this UI slice only. Screenshots and intercepted responses remain
synthetic, and the full-project launch gates remain open.

Operations route regression selection (2026-09-23): acceptance question: do the current Orders,
Kitchen, Dining start/serve/close, Pickup and Exception page journeys compose under the shared
Merchant shell and styling without breaking source-state, retry or navigation boundaries? Inputs
are the eight changed route E2E specs and shared Merchant CSS; run the existing production-fail-closed
Playwright project across exactly `current-order-queue.spec.ts`, `kitchen-queue.spec.ts`,
`dining-session-start.spec.ts`, `dining-serving.spec.ts`, `dining-order-close.spec.ts`,
`dining-session-close.spec.ts`, `pickup-queue.spec.ts` and `order-exception.spec.ts`. This is fresh
browser evidence with intercepted fixtures; it does not replace live Store/Payment/Task evidence.

Operations route regression result (2026-09-23): all eight selected production-fail-closed specs
pass 22/22, covering Orders lost-response acceptance and current-version refresh; Dining start,
serving, order close and session close recovery; Kitchen read/command recovery; and the full Pickup
and Exception cases above. The configured Vite production build succeeds with the existing
greater-than-500 kB chunk warning. The checks use intercepted synthetic Store responses, so they
do not establish a live Store/Provider journey or full Screen Registry acceptance. No API, Domain,
permission, persistence or external service changed. Prettier and `git diff --check` are rerun for
this WP record.

Customer PWA lifecycle integration verification selection (2026-09-23): acceptance question: do
the Order context replacement and Receipt offline/reconnect state changes compile, satisfy app
lint and produce the normal production PWA bundle? Affected inputs are the six changed Order-status
and Receipt client/controller files and their tests. The four-file/86-test focused Vitest result
is fresh in the preceding record; run only the existing Customer PWA `typecheck`, `lint` and
`build` scripts, plus targeted Prettier for these files and this WP. No service-worker, route,
dependency or manifest input changed, so no install, unrelated PWA security suite or database gate
is selected.

Customer PWA lifecycle integration verification result (2026-09-23): Customer PWA typecheck,
full package lint and production `build` pass. The build also emits its InjectManifest service
worker and an 18-entry precache; Vite reports the existing `inlineDynamicImports` deprecation.
Targeted Prettier for the six changed files and this WP passes. The existing fresh focused
controller/client run remains 4 files/86 tests. This still does not cover a full PWA acceptance,
live Guest session, device/browser offline journey or live receipt rendering.

Customer PWA rendered-route verification selection (2026-09-23): acceptance question: do the
changed Order-status and Receipt controllers remain correctly composed through the normal App,
entry context and rendered production pages, including stale callback/revoked-access recovery?
Affected app routes are exercised by the existing synthetic HTTP E2Es
`e2e/order-status-http.spec.ts` and `e2e/receipt-http.spec.ts` under the
`production-exclusion` project. Run these two cases through the existing Customer PWA Playwright
configuration. Requests are intercepted; this verifies app wiring only, not session replacement
against a live Guest, true offline browser behavior, or live receipt facts.

Customer PWA rendered-route verification result (2026-09-23): both selected production-exclusion
browser E2Es pass (2/2): Order status clears data after revoked access, and receipt navigation
removes inaccessible history. The test server built the normal production PWA bundle with its
existing Vite deprecation warning. Requests are intercepted; this confirms app wiring only, not a
live Guest replacement, true offline device behavior or live receipt facts.

Dining area-board follow-up verification selection (2026-09-23): acceptance question: does each
table tile remain compact when an Area lane contains a single visible table, while filter/detail,
Session creation, one-time code recovery and Host Transfer semantics continue through the normal
Dining route? The grid caps tracks at 13rem and aligns them to the start; run the existing
`dining-session-start.spec.ts` production-fail-closed journey, which asserts the tile width at
1440px and records 1440/390/320 screenshots. Inspect all three outputs. Fixtures remain
intercepted and do not establish live Store behavior.

Dining area-board follow-up verification result (2026-09-23): the selected production-fail-closed
Dining session-start route passes 1/1. Its width assertion confirms a single-area table tile
stays at or below 216px on the 1440px viewport; the 1440/390/320 screenshots were regenerated
and inspected. The 208px tile width remains compact on desktop and both mobile widths, with no
visible horizontal overflow. Existing filter, selected-table details, confirmed start, lost
response recovery and one-time code replacement remain covered. Synthetic intercepted fixtures do
not establish live Store behavior. The CSS grid cap was already present in the preserved working
tree, so this follow-up confirmed it rather than adding a new CSS change.

Dining area-board fresh rerun (2026-09-23): reran
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/dining-session-start.spec.ts --project=production-fail-closed`
with approved local loopback; 1/1 passed. Reopened the newly generated 1440/390/320 PNGs. The
single-table tile remains compact at desktop width; both mobile layouts stack the lanes and keep
the selected-table panel within the viewport. No visible horizontal overflow. The production
preview build emitted its existing large-chunk warning. The controlled route still uses
intercepted synthetic data and does not establish live Store behavior.

Dining host-transfer follow-up verification result (2026-09-23): the dedicated
production-fail-closed Host Transfer browser journey passes 1/1 after the area-board layout
change. It covers guest identification, confirmation, unknown-outcome same-intent retry and denial
recovery against intercepted fixtures. This does not establish live Guest authority or Store
state.

Make Customer editor recheck (2026-09-23): reopened the linked Version29 project in a fresh
in-app browser tab. The authenticated Code view is readable and `CustomerApp.tsx` imports the six
functions from `./transitions`; the selected `transitions.ts` source still omits `nowMs` in the
`canWrite` calls for cart change, requote, tip change and continue ordering, and `applyRequote`
still defaults its clock to `Date.now()`. The prompt/build agent reports AI credits exhausted until
2026-09-30. No Make source was edited in this check, and no Make test/build was run. This confirms
the explicit-clock source gap only; repository Customer PWA tests are independent evidence.

Make explicit-clock call-chain recheck (2026-09-23): the current Code-view `CustomerApp.tsx`
confirms that entry confirmation, cart change, tip change and continue ordering call their shared
transition functions without a captured clock; checkout/requote and payment-result handlers do
capture `nowMs` before their state updaters. The corresponding transition signatures also lack
required clocks for the first group and omit `nowMs` when checking write authority. The correction
must update the module, all four callers and direct production-transition tests together; changing
the module alone would leave the UI without exact-time authority checks. A trial edit was fully
undone after discovering this cross-file dependency; the displayed source is back to its prior
state. No Figma source/test/build was changed or run. The editor remains readable while its AI
prompt is credit-disabled through 2026-09-30.

Make explicit-clock continuation (2026-09-23): resumed the private Version29 Code view and
confirmed `CustomerApp.tsx` already imports the transition functions used by the Customer flow.
The Code view now reflects the required `nowMs` signatures and `canWrite(..., nowMs)` checks in
`transitions.ts`; the entry/cart/tip/continue/requote callers pass captured clocks. Follow-up edits
also add an optional explicit clock to `canSubmitPayment` and pass captured clocks from payment
submission, Unknown status retry and Kitchen refresh through their state updaters. Direct-import
tests include exact-expiry rejection. The editor language service reports ready after these edits,
but the current remote project was not downloaded again and its Make tests/build/Preview were not
run, so this source observation is not independent saved-artifact or runtime evidence. In the
isolated previously downloaded review copy, `tsc --noEmit`, `oxfmt --check`, all 189 production
logic tests, and `vite build` pass; the test/build rerun needed approved local IPC access and Vite
retains its 525.97 kB chunk warning. This local ZIP predates the latest editor edits and cannot
stand in for checks of the exact remote source. DiningWorkspace's two malformed annotations also
remain only corrected in that local review copy. AI prompt access remains disabled until
2026-09-30; no publish/share action was taken. Continue with an exact current-source export,
repair the two annotations in the private source, then run source-matched checks and Preview
journeys when available. Treat every Make fixture as fictional.

Make current source artifact verification (2026-09-23): reloaded the private Version29 project,
switched to Code view and downloaded the current source ZIP after the editor changes. Artifact
`High-Fidelity Restaurant Order Prototype (3).zip` SHA256 is
`03a41d0818cea3c37774bf5fd954ee596fe0c6cf52e8245b92f54a59022d7008`. The exported
`CustomerApp.tsx` imports the six production transitions; `nowMs` is passed for context, cart,
tip, continue, requote, payment result, status retry and Kitchen refresh. `pureLogic.ts` accepts
`nowMs` for `canSubmitPayment`, and direct-import tests include exact-expiry rejection. The ZIP
confirms the earlier edits were present after reload. In that same private Code view, replaced the
malformed Dining status return annotation and Dining permission prop annotation with named
`DiningTableDisplayStatus` and `DiningPermissionProps` types; downloaded the ZIP again after those
edits and confirmed both declarations. Source-matched `tsc --noEmit` passes,
`tsx --test src/logic.test.mjs` passes 189/189, and Vite production build succeeds with its
existing 525.98 kB chunk warning. `oxfmt --check` still fails on CustomerApp.tsx, pureLogic.ts and
logic.test.mjs; DiningWorkspace.tsx and transitions.ts pass that check. Attempts to invoke the
Make editor's Format code button produced no observable source change, so formatting remains
open. The ZIP was extracted to an isolated review directory; tests/build ran against that source,
not against a deployment. This export hash identifies the artifact at that point only; no ZIP was
uploaded and no tests/build were claimed from Figma itself.

Make refreshed Preview readback (2026-09-23): after reloading the source export, opened current
Operations Kitchen, Dining, Pickup and Exceptions routes. Kitchen detail displays a demo ticket
and “Freshness SLA: Unavailable in this projection.” Dining board groups Main/Patio/Bar tables and
exposes demo area/state/attention filters; the selected session detail keeps unaccepted
supplemental work and unconfirmed ready items as separate close blockers and says payment must be
reconciled in Orders. Pickup shows public Order search/state filtering and explicitly states Claim
and exception fields are unavailable in this source; its detail requires simulated verification
and blocks handoff before that verification. Exceptions exposes fictional type, severity, status
and owner filters and says Provider state, overdue SLA and safe public references are unavailable;
its payment detail distinguishes Acknowledge from financial resolution and keeps Resolve
unavailable until source finality/evidence exist. All values are synthetic Make fixtures, not
Store/Provider facts or production acceptance. No simulated command was invoked and no
publish/share action was taken. Production source/permission contracts and the Make formatting
check remain unresolved.

Make latest-export audit (2026-09-23): downloaded the subsequently formatted private Version29
source as `High-Fidelity Restaurant Order Prototype (4).zip`, SHA256
`defe70d6371244636ef21a668e2d840d5dbd52118e7e734730ca1d0345e70080`. This is newer than (3)
above; its customer production transitions and named Dining types remain present, and TypeScript
`tsc --noEmit` passes against this extracted source. `oxfmt --check` now reports only
`src/customer/pureLogic.ts` and `src/logic.test.mjs`; `CustomerApp.tsx`, `transitions.ts`, and
`DiningWorkspace.tsx` pass. This is a format-only improvement over the prior artifact, not a clean
format result. The extracted source still calls `canSubmitPayment(snap, Date.now())` and then
captures a separate `const nowMs = Date.now()` in `handlePaymentSubmit`, so the guard and intent
can observe different clock values. The attempted editor selection did not find the block, then
an accidental UI search keystroke briefly inserted text into the import declaration and raised a
Vite parse overlay; Meta+Z restored the source and a fresh accessibility read confirmed the
original import block exactly. No additional source change was made. The `tsx --test
src/logic.test.mjs` run against this exact extracted ZIP (4) passes 189/189, and `vite build`
succeeds with the existing 525.98 kB chunk warning. Typecheck, focused logic suite and build are
therefore current-export evidence; clean formatting and consistent submission clock remain open.
No publish/share action was taken; all Make data remains fictional.

Make explicit submission-clock and formatter follow-up (2026-09-23): corrected the private
`CustomerApp.tsx` submission path so one captured `nowMs` is used for both `canSubmitPayment`
and `buildPaymentIntent`; a fresh Code-view read showed the guard and intent call share that
variable. Formatted `CustomerApp.tsx` and `pureLogic.ts` in the Make editor. The formatter changed
`(keyof CustomerScope)[]` to a precedence-ambiguous annotation, so corrected it to
`ReadonlyArray<keyof CustomerScope>` and confirmed that exact type in a newly downloaded export.
Current export SHA256 is `233128ee046f10ab5ae655ba218ecdb28b61f451c7eafbda7e4523fed9deacc7`.
Against this exact extracted source, `tsc --noEmit`, `tsx --test src/logic.test.mjs` (189/189) and
`vite build` pass; the Vite build retains the 525.97 kB chunk warning. `oxfmt --check` now fails
only `src/logic.test.mjs`; the other four reviewed files pass. The `.mjs` editor exposes no
Format code action, so test-file formatting remains open. Preview remains fictional and no
publish/share action was taken.

Make private-editor access and Scenario Browser recheck (2026-09-23): reopened the current
private Version29 project in Chrome. The Exceptions Preview and Scenario Browser load, and
the global Permission denied entry still says the actor lacks `ordering.operate`, while
Registry-aligned route-specific denial copy was previously observed for Kitchen, Dining,
Pickup and Exceptions. The editor now displays “Sign up to use Figma Make”; its prompt,
context, mode, model and send controls are disabled, so the code editor is not available in
this current session. This supersedes the earlier access observation that Code view remained
readable with only AI credits exhausted. No sign-up information was entered, no scenario
action was invoked, and no remote source, share or publish action occurred. Treat all Preview
values as fictional. The required generic or route-specific permission-copy reconciliation
remains open until authorized editable access returns. No repository suite applies to this
read-only recheck.

Pickup handoff keyboard acceptance selection (2026-09-23): Screen Registry
`FUL-PICKUP-QUEUE` and its contextual `FUL-PICKUP-HANDOFF` require a complete keyboard
alternative for verification and explicit handoff. The existing production-project E2E
covers masked recipient entry, exact-target confirmation, Unknown and same-intent retry,
but activates the review/confirm/retry controls by mouse. Extend that synthetic journey
to open the native dialog and complete its recipient, confirmation and retry path with
keyboard input, asserting focus placement and preserved exact request body. The first
run showed that after a successful handoff the intentional disabled opener cannot receive
the native dialog's restored focus, which leaves focus on the document body. Correct this
by focusing the persistent result status on close after a terminal success or rejection;
do not enable repeat handoff from the stale queue. Affected inputs are
`PickupHandoffForm.tsx` and `e2e/pickup-queue.spec.ts`. Run that single production-project
Pickup test with its configured build, Merchant typecheck, targeted ESLint, changed-file
Prettier and `git diff --check`; inspect the resulting E2E output. Extend the same journey
to verify rejection also focuses a result status, retains the disabled stale-queue opener,
and prohibits an unproven retry. Intercepted records remain synthetic; no
live handoff or Fulfillment evidence is involved. Claim/report-exception contracts,
Overdue source and other full-page Screen acceptance remain open.

Pickup handoff keyboard acceptance result (2026-09-23): updated
`PickupHandoffForm` so closing a terminal success or rejection focuses its persistent
status announcement when the stale-queue Review control remains disabled. The existing
native modal and its server/idempotency behavior are unchanged. The focused production-
fail-closed Pickup journey passes 1/1 with keyboard selection/input/confirmation and
same-intent Unknown retry; it asserts the identical request body and focus on the recorded
handoff status after close. A second authorized synthetic card returns a terminal 422;
after close, focus moves to its rejection status and the stale-queue opener stays disabled
without offering a retry. The configured production Vite build succeeds with the existing
large-chunk warning.
An initial E2E attempt exposed a native-select keyboard mismatch (`ArrowDown` did not
select); the test now uses native typeahead. The next run exposed the real focus loss on
the intentionally disabled opener, which the result-status focus change corrects; the
final run passes. Targeted Prettier and `git diff --check` pass. All responses remain
intercepted synthetic fixtures; this is not Fulfillment/Store evidence. Claim, exception
reporting, overdue source and complete Screen acceptance remain open.

Exception acknowledgment terminal-focus verification selection (2026-09-23): the
Screen's source-specific payment reconciliation journey already uses keyboard review,
confirmation and exact-intent retry, but its successful retry removes the focused command
button. Verify focus moves to the persistent recorded-result status when the browser drops
focus to the document body, while preserving focus if the operator moved elsewhere during
the request. Affected inputs are `CompensationReconciliationAction.tsx` and the existing
`e2e/order-exception.spec.ts` keyboard journeys. Add the narrow result-status focus behavior
and assertions for both same-intent recovery and focus moved during a pending command. Run
those two existing production-project E2Es with their configured build, Merchant typecheck,
targeted ESLint, changed-file Prettier and `git diff --check`. Synthetic confirmed refund
data and intercepted responses establish UI behavior only; they do not authorize or prove
refund, Payment, Provider, Task, Store or case-closure facts. Generic Task commands,
financial finality and whole-Screen accessibility remain open.

Exception acknowledgment terminal-focus verification result (2026-09-23): after a
successful operator acknowledgment, the removed command control no longer strands keyboard
focus on the document body; the persistent result status receives focus when that was the
browser's fallback. If focus moved to Refresh during an Unknown request, it remains there;
the later explicit retry then moves focus to the recorded-result status. Both selected
production-fail-closed journeys pass (2/2), including the same frozen acknowledgment body
on retry. The configured production Vite build succeeds with its existing large-chunk
warning. Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass. The
intercepted confirmed refund and acknowledgments are
synthetic UI fixtures, not actual Payment/Provider reconciliation, authority or case
closure. Generic Task actions, owner fields, financial finality and full Screen acceptance
remain open.

Dining area-board continuation rerun (2026-09-23): the pinned-toolchain
`dining-session-start.spec.ts --project=production-fail-closed` journey passes 1/1 on the
current worktree. Reopened the newly generated 1440/390/320 screenshots: the single-table
tile remains capped at 13rem on desktop, both mobile views reflow the filters and selected
table detail without visible horizontal overflow. Keyboard selection, one initial table
read plus explicit refresh, confirmed Session start, same-operation recovery and one-time
code replacement remain covered. No CSS change was needed because the preserved grid
already caps and start-aligns its tracks. The first invocation selected global pnpm 11.25
and was rejected by the repository engine pin before running; the successful rerun used
pinned Node 24.18.0/pnpm 11.13.0. Playwright's configured Vite production preview built
successfully with the existing large-chunk warning. Screenshots and intercepted responses
are synthetic UI evidence only and do not establish live Store behavior.

Dining screenshot artifact refresh selection (2026-09-23): the existing 1440/390/320
files referenced by that result are no longer present under Merchant `test-results`, so
the visual claim cannot be re-inspected from retained artifacts. Re-run only the existing
`dining-session-start.spec.ts --project=production-fail-closed` journey with pinned Node /
pnpm; it already asserts a single-table desktop tile no wider than216px and no mobile
document overflow. Recreate its three screenshots and inspect each. CSS, route, and
journey inputs are unchanged since the recorded pass; this is an artifact/evidence refresh,
not a reason to change styles or broaden business suites. Browser fixtures remain synthetic.

Dining screenshot artifact refresh result (2026-09-23): using pinned Node24.18.0/pnpm11.13.0,
the selected production-fail-closed journey passes1/1 and regenerates
`apps/merchant-web/test-results/dining-board-{1440,390,320}.png`. Direct image inspection
shows the desktop single-table tile at approximately207px, left-aligned within its capped
track; both mobile layouts stack the filters, Area lanes, and selected-table panel with no
visible horizontal overflow. The screenshot calls the environment Synthetic Store and shows
intercepted T1/T2 records; this is responsive/accessibility UI evidence, not Store or Session
production evidence. No CSS edit was warranted. The initial sandbox run failed before tests
on loopback EPERM; the same command with approved local-loopback access passed. The configured
Vite build completed with the existing large-chunk warning.

Exception Business Date parser verification selection (2026-09-23): the OPS-ORDER-EXCEPTION
view parser checks only the `YYYY-MM-DD` shape for `businessDate`, so impossible calendar
dates can pass into the visible Store-day label. Require an exact UTC calendar round-trip
and add invalid-day/month plus leap-day cases to `OrderExceptionPage.test.tsx`. Run that
existing component/parser suite, Merchant typecheck, targeted ESLint and Prettier on the
two changed source files and this WP, then `git diff --check`. This fail-closed input
validation does not change the owner projection, permission, SLA calculation or external
facts; no API, Domain, database or browser journey input changes.

Exception Business Date parser verification result (2026-09-23): the parser now rejects
calendar-normalized invalid dates as well as malformed date strings, and accepts a genuine
leap day. The focused `OrderExceptionPage.test.tsx` suite passes 13/13; Merchant typecheck,
targeted ESLint and Prettier pass. `git diff --check` is clean. This closes only the client
parser's calendar-validity gap; it does not prove the server's Store Business Date source,
timezone configuration, projection freshness, case ownership or production Exception
behavior.

Make Customer category keyboard comparison (2026-09-23): local `CUST-MENU` implements its
category controls as labelled in-page anchor navigation in `MenuPage.tsx`, not as a tablist;
native Tab/Enter behavior is therefore the local source contract, while roving-arrow behavior
seen in Make does not apply. The wrapping `.menu-sections` links have a 44px minimum height.
This source-only comparison does not close the Make preview's clipped category row or local
rendered focus, zoom and narrow-screen acceptance. No application source changed. For this
documentation update, the acceptance question is whether WP-2402 records the distinction
without treating Make data as local behavior; the affected inputs are this record and the
project-completion review. No application suite applies; run scoped Prettier and `git diff
--check`.

Pickup unavailable-command clarity verification selection (2026-09-23): Claim and Report
exception must remain unavailable until an authorized source-bound Task or Fulfillment
command is defined, but the current queue only exposed unlabeled disabled buttons. Add one
page-level explanation and associate both disabled buttons with it through `aria-describedby`;
do not enable either action or invent source mapping. Affected inputs are `PickupPages.tsx`,
its rendering test and the existing production Pickup E2E. Run the focused component suite,
the E2E, Merchant typecheck, changed-file ESLint/Prettier and `git diff --check`. The E2E uses
intercepted synthetic fixtures and local Vite only; no Fulfillment command or Store evidence
is in scope.

Pickup unavailable-command clarity verification result (2026-09-23): the page now explains
that Claim and Report exception await an authorized source-bound Task or Fulfillment command,
and each disabled button references that description. Claim/report behavior and source
mapping remain unavailable. `PickupPages.test.tsx` passes 3/3; the existing production-
fail-closed `pickup-queue.spec.ts` passes 1/1 and confirms both buttons remain disabled and
reference the explanation; Merchant TypeScript, targeted ESLint, Prettier and `git diff
--check` pass. The first E2E launch was blocked by sandbox loopback EPERM; the approved local
loopback rerun passed. Its intercepted records and local preview remain synthetic UI evidence,
not a command, Store or Fulfillment acceptance.

Exception unavailable-action accessibility verification selection (2026-09-23): the workbench
already explains that generic acknowledgment, assignment, compensation requests and closure
are unavailable, while source-specific actions remain separate; however, that prose was only
positioned before each card and was not programmatically tied to the disabled controls. Move
the explanation to one page-level description and associate each generic disabled action with
it through `aria-describedby`, without enabling any route or changing Payment follow-up. Run
the focused `OrderExceptionPage.test.tsx`, the existing selected-Store production E2E,
Merchant typecheck, targeted ESLint/Prettier and `git diff --check`. Intercepted cases remain
synthetic.

Exception unavailable-action accessibility verification result (2026-09-23): the shared
page-level explanation now has one stable ID and all four disabled generic action buttons
reference it. The focused `OrderExceptionPage.test.tsx` passes 13/13; the selected-Store
production-fail-closed journey passes 1/1 and verifies the explanation and disabled button
descriptions; Merchant TypeScript, targeted ESLint, Prettier and `git diff --check` pass. The
configured browser build retains its existing large-chunk warning. No command availability,
source mapping, Payment follow-up or permission changed; fixtures and responses are synthetic.

Make linked-project read-only availability recheck (2026-09-23): opening the current private
Version29 link in Chrome yields an accessibility tree with the project title, Help/zoom toolbar
and privacy opt-out link, but no route navigation, Preview controls, generated screen content or
Code/editor controls. This tree-limited observation cannot confirm current route behavior,
fictional data or edit access; no scenario action or remote mutation was attempted. Fresh Make
Screen reconciliation remains open until the linked app exposes inspectable content.

Pickup Overdue filter reason association verification selection (2026-09-23): the native
Current page filter correctly disables Overdue and a visible note explains that the source has
no authorized due time, but the explanation is not programmatically associated with the
control. Add `aria-describedby` to the filter and a stable ID to the existing reason text while
keeping Overdue disabled. Affected inputs are `PickupPages.tsx`, its component test and the
existing production Pickup browser journey. Run that focused test, journey, Merchant typecheck,
targeted ESLint/Prettier and `git diff --check`; intercepted rows remain synthetic.

Pickup Overdue filter reason association verification result (2026-09-23): the `Current page
filter` now references its visible no-authorized-due-time explanation through
`aria-describedby`; the Overdue option remains disabled. `PickupPages.test.tsx` passes 3/3, the
production-fail-closed `pickup-queue.spec.ts` journey passes 1/1, Merchant TypeScript, targeted
ESLint, Prettier and `git diff --check` pass. The configured production-preview build retains
its existing large-chunk warning. This verifies UI/accessibility behavior on intercepted
synthetic responses only; no due-time source or Fulfillment policy was created.

Pickup completed-only Overdue description correction (2026-09-23): a review initially proposed
hiding the Overdue explanation when the current read contains only completed pickups. The
Overdue option remains present and disabled in that state, so hiding its `aria-describedby`
target would leave the filter without its reason. Preserve the visible reason and its association
for every queue state, including completed-only results. The completed-card unit case and
production journey's Include completed path assert that the disabled option still has its
description. Run the focused component suite, Pickup E2E, Merchant typecheck, targeted
ESLint/Prettier and `git diff --check`.

Pickup completed-only Overdue description correction result (2026-09-23): the explanation and
stable target remain visible and associated even when every returned Pickup is completed. The
focused component suite passes 3/3; the production-fail-closed Pickup journey passes 1/1 and
checks Include completed behavior; Merchant TypeScript, targeted ESLint, Prettier and
`git diff --check` pass. The configured preview build retains its existing large-chunk warning.
Fixtures are synthetic and no source policy changed.

Exception Screen route-mode reconciliation selection (2026-09-23): compare Handoff Section
88.10, Sections 88.4/88.19, Registry `OPS-ORDER-EXCEPTION`, WP-1809 and current App/BFF route
composition. The Handoff/WP-1809 and implementation name `/operations/order-exceptions` as a
workbench route; the Registry marks it `kind: contextual`, `route_mode: contextual`, with
`OPS-ORDER-DETAIL` as parent and navigation target. Section 88.19 says contextual utilities
inherit their parent Route and are not standalone pages. Record this semantic mismatch without
changing the Registry, route or navigation before an authorized design/Owner decision. This is
source/document review only; format the runbook and this WP and run `git diff --check`.

Exception Screen route-mode reconciliation result (2026-09-23): the four sources do conflict
on whether this is a contextual Order Detail utility or an independent workbench route; the
App mounts the route, and both Merchant `merchantNavigation` and API `merchantNavigation` map
`OPS-ORDER-EXCEPTION` to an independently navigable `/operations/order-exceptions` entry.
No registry or application change was made because it would select one of the competing Screen
semantics. Owner/Screen authority must resolve the route and navigation contract before
implementation can claim alignment.

Dining table-read denial recovery selection (2026-09-23): acceptance question: after a
previously successful table read, can a denied refresh leave stale table cards selectable for
a new Session command? Clear the current table collection and paging cursor when an active
read fails; retain the visible error and allow an explicit successful refresh to recover.
The affected inputs are `DiningSessionWorkspace.tsx` and its existing production-fail-closed
Dining browser journey. Run that focused journey, Merchant typecheck, changed-file lint and
format checks, and `git diff --check`. The journey uses intercepted synthetic responses;
it does not prove live Store permissions or Session authority.

Dining table-read denial recovery result (2026-09-23): the active read failure now clears
table cards and the paging cursor. The focused production-fail-closed journey passes 1/1:
after a 403 refresh it finds no selectable stale table, displays the permission error, then
reloads tables on explicit refresh and completes the original Session recovery path. Its
1440/390/320 screenshots were regenerated during the same journey; the existing area grid
width and overflow assertions passed. Merchant TypeScript, targeted ESLint/Prettier and
`git diff --check` pass. The initial check attempts were blocked by sandbox writes to the
checkout; approved runs passed. Browser responses remain intercepted and synthetic.

Figma Make Dining visual migration (2026-09-23): reopened private project
`u5gjkcwfARvEqaiUKnCJnp` in Chrome. Version29 Preview is readable and its current
`/operations/dining` shows an area-grouped floor, table/Session search, area/state/attention
filters and status-tinted table cards; these rows and their Session, elapsed-time and
attention values are fictional. Figma `get_design_context` returned the source-file manifest,
including `DiningWorkspace.tsx` and `index.css`, but reading the returned `file://figma/make`
resource failed with `Unknown resource`. The Make editor says “Sign up to use Figma Make”;
its prompt, context, mode, model and send controls are disabled. `use_figma` only supports
Design, FigJam and Slides files, so no supported Make write path is available in this session.
The visible hierarchy was therefore applied to Merchant as a reviewable draft: white/near-black
shell, compact uppercase area labels, selected-table emphasis, subtle state/session tints and a
quiet bordered detail panel. The route still renders only `StaffDiningTable` fields and keeps
all Session controls/authority unchanged; no attention cue or elapsed/Order/Payment/party data
was copied. Source-level Make access and Make editing remain blocked; no signup, sharing or
publish action was taken. Verification selection: rerun the existing production-fail-closed
`dining-session-start.spec.ts` journey, which generates and checks 1440/390/320 layouts and
exercises denial refresh plus Session retry/recovery; inspect the three fresh screenshots.
Also run Merchant TypeScript, targeted lint/format and `git diff --check`. The browser data is
synthetic and is not Store evidence.

Dining visual migration result (2026-09-23): the focused
command `source .local/activate.sh && CI=true pnpm --filter @bop-rms/merchant-web exec
playwright test e2e/dining-session-start.spec.ts --project=production-fail-closed` passes 1/1
after the style change. The 1440/390/320 screenshots were regenerated and inspected: the
desktop board keeps compact area cards beside selected-table detail; 390px and 320px stack
filters, area lanes and details with no horizontal overflow. Keyboard focus remains visible.
Merchant TypeScript, targeted ESLint, Prettier and `git diff --check` pass. The browser build
retains the existing >500 kB chunk warning. The captured tables and responses are synthetic.
Make's source-file body remains unreadable through the returned resource URI and its current
editor still requires sign-up; visual review is based on the live Version29 Preview, not source
parity.

Dining Figma shell alignment verification selection (2026-09-23): a fresh requested journey
passes but its screenshots still show the former two-tier AppFrame header and omit the
permission-scoped workspace navigation shown by the accessible Operations Queues Figma
direction (`7JHWMW9AVlAkI4ZCRGNiXw`, node `4:2`). Align the Dining shell with the shared
black/white header, responsive authorized navigation, compact `Dining` title and nested floor
content. `DIN-FLOOR-BOARD` stays phase-gated under `dining.operate`; render only the current
session's navigation, never add a client-side grant. Keep table/area/capacity/lifecycle/state/
Session fields and existing start/regenerate/Unknown flows unchanged. Handoff Section 88.11 and
Registry `DIN-FLOOR-BOARD` remain authoritative; the Figma frame is visual direction only.
Acceptance question: does the actual route use the shared shell at 1440/390/320 while preserving
permission-trimmed navigation and the existing Session journey? Affected inputs are
`App.tsx`, `DiningSessionWorkspace.tsx`, their existing `dining-session-start.spec.ts` fixture,
Dining-scoped styles and this brief. Run that production-fail-closed browser journey and inspect
all three screenshots; run Merchant TypeScript, changed-file ESLint/Prettier and `git diff
--check`. Responses remain synthetic.

Dining Figma shell alignment result (2026-09-23): the route now uses the compact black/white
shared header, current-session navigation, desktop sidebar and mobile horizontal navigation; the
main title and table/session workspace hierarchy follow the Operations Queues review direction.
Registry data and Session commands are unchanged. The session navigation type has no
`DIN-FLOOR-BOARD` member, so the view renders only the supplied `Orders` item in the focused
fixture; neither the route nor a client-side permission was added to navigation. The fresh
production-fail-closed `dining-session-start.spec.ts` journey passes 1/1, including keyboard
selection, denied-refresh clearing/recovery, same-intent retry and screenshots at 1440/390/320.
All screenshots were inspected: desktop sidebar/details are side-by-side; mobile nav, filters,
area lanes and detail stack without page overflow. Merchant typecheck, targeted ESLint, Prettier
and `git diff --check` pass; the production preview build retains its existing >500 kB advisory.
Fixtures are synthetic. The frame is shared visual direction rather than an accepted Dining
frame; Make remains unreadable/uneditable, and Dining's wider Registry projection/phase gate
remain unresolved.

Dining page-specific Figma continuation verification selection (2026-09-23): extend the
Operations Queues Design review page with `DIN-FLOOR-BOARD` layouts at 1440/390/320. Preserve its
existing BOP black/white shell, neutral borders, Inter typography, and responsive layout; use only
`stableLabel`, `areaCode`, `capacity`, `lifecycle`, `operationalState`, and current-session presence.
Label all sample values as review-only and explicitly show that party, Order, payment, reservation,
waitlist, and elapsed-time details are absent. Do not show table/session identifiers. Acceptance
question: does this responsive visual direction match the implemented Dining workspace hierarchy
without implying unsupported projection data or permissions? Existing Dining browser journey and
its screenshot captures are the smallest affected checks; inspect all three after Figma creation.
Figma is a review artifact only; the private Make file and phase/Registry expansion remain gated.

Dining page-specific Figma continuation result (2026-09-23): added desktop 1440, mobile 390 and
compact 320 `DIN-FLOOR-BOARD` review frames (`24:2`, `24:60`, `24:109`) to the Operations Queues
Design page. The frames reuse its Inter/neutral BOP shell and show only sample table label, area,
capacity, operational state and session presence; sample data is explicitly marked review-only,
identifiers are hidden, unavailable party/Order/payment/reservation/waitlist/elapsed-time facts are
called out, and workspace navigation is limited to the current fixture's Orders item. The repo
Dining workspace now follows that shell and content hierarchy, surfaces the same source limits,
and keeps filters, session actions, permission-scoped navigation and phase gating unchanged.
The production-fail-closed `dining-session-start.spec.ts` journey passes 1/1 after an initial
ARIA-role assertion correction and one too-strict desktop card-width assertion adjustment; it
retains selection, denied-refresh clearing/recovery, same-intent retry and 1440/390/320 captures.
All three current screenshots and Figma frames were inspected with no horizontal overflow.
Merchant TypeScript, targeted ESLint, Prettier and `git diff --check` pass. The configured
production preview build still emits its existing >500 kB advisory. This is review-design parity,
not Make-file parity or accepted Registry design: Make remains unreadable/uneditable, sample data
is synthetic, and phase/projection expansion remains unresolved.

Private Figma Make access recheck (2026-09-23): the private `High-Fidelity Restaurant Order
Prototype` now opens in the current account. Its Operations preview navigates to Dining and
displays table/session fixtures; Code view lists project files and opens
`src/components/DiningWorkspace.tsx` in a settable text editor. This establishes current source
visibility and an interactive manual editor surface; no text was changed, so persisted manual
write permission was not exercised. The AI prompt remains disabled with an explicit credit-reset
date of September 30. Make Dining preview data includes fictional occupied/session-age/attention
values that are absent from the authorized repository projection and were not copied. No Make
edit, publish or share action occurred. The repo's Dining design is based on the accessible
Operations visual language plus Registry-authorized fields; the Make demo remains fictional and
does not establish accepted Screen parity.

Recipe administration Figma Review verification selection (2026-09-23): create source-limited
`RECIPE-LIST` and `RECIPE-EDITOR` Review frames in the existing Figma Design file, reusing the
Operations Queues Inter/neutral shell. Preserve the Registry's `phase_2`/`phase_capability`,
`recipe.manage`, list search/status/review-issue filters, editor requirement groups and disabled
unconnected commands. Use only the version2 Recipe view contract's declared fields. Explicitly mark
visual rows as synthetic; show cost, allergen, mapping, usage, ingredient and review values as
unavailable/restricted when the authorized source does not supply them. No customer health data,
CAD inference, private object IDs or actionable command states. Acceptance question: do desktop,
390 and 320 layouts communicate the list/editor hierarchy and disabled/missing source states
without claiming the normal Recipe query is connected? Review all frames in Figma; no application
test applies to this Design-only step. If code styling is subsequently changed, add a separate
verification selection for the actual Recipe screen behavior and responsive captures.

Kitchen Figma Design migration verification selection (2026-09-23): apply the new review design
at `https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=4-2` to the repository
`KIT-KITCHEN-QUEUE` while preserving Section 88.4/88.10 and the authorized
`kitchen_work_queue_v1` fields. The design proposes a black/white shell, permission-trimmed
navigation, station lanes, status/age/quantity/safety cues and 1440/390/320 layouts. The safe
Order/ticket display references, course, priority, SLA/overdue, claim and Hold/Prioritize
commands remain unavailable where their source contracts do not provide them. Keep the
Registry queue's compact filters in a mobile sheet and retain all existing named-operator,
freshness, failure, command and child-route behavior. The Figma file is an authorized Review
design, not an accepted baseline or Make source. Acceptance questions: does the ordinary
permission-scoped route render authorized navigation and the proposed hierarchy, and do mobile
filters remain usable without horizontal overflow while queue state/action behavior is intact?
Affected inputs are `KitchenBoardPages.tsx`, `App.tsx`, Kitchen styles, their current render test
and `kitchen-queue.spec.ts`. Run the existing Kitchen render tests, the complete production-
fail-closed Kitchen browser journey at 1440/390/320 (including native mobile filter sheet and
session-trimmed navigation), Merchant TypeScript, targeted ESLint/Prettier, and `git diff
--check`. Browser rows stay synthetic; these checks do not supply Kitchen owner fields or Store
acceptance.

Kitchen Figma Design migration result (2026-09-23): `KitchenBoardScreen` now follows the proposed
black/white hierarchy, status and safety-cue tinting, compact station lanes and 44px action targets.
The app supplies only the current session's validated navigation list. The mobile queue opens the
same four authorized loaded-item filters in a native dialog sheet; the desktop keeps them inline.
Projection references remain out of cards, with a visible explanation for the unavailable safe
display/search fields. Freshness includes a readable UTC update time. Existing state panels,
command gating, idempotent Unknown recovery and child route remain in place. The reviewed Figma
file was updated to show the closed mobile filter control, 320px queue and open sheet state.
`KitchenBoardPages.test.tsx` passes 6/6 and the affected `App.test.tsx` passes 4/4; Merchant
TypeScript, changed-file ESLint and Prettier pass. The complete production-fail-closed Kitchen
journey passes 2/2, including permission-trimmed
navigation, mobile filter-sheet open/close, command recovery and fresh 1440/390/320 screenshots;
all three screenshots were inspected and show no horizontal overflow. Its production preview build
passes with the existing >500 kB advisory. Fixtures are synthetic, so this does not certify real
operator identity, Store queue facts or the missing reference/course/priority/SLA/claim/Hold/
Prioritize sources. This local repository migration does not make the Figma Make editor writable,
accept the new Figma Design as the project baseline, or close whole-project and production gates.

Pickup Figma Design visual migration verification selection (2026-09-23): extend the
Operations Queues review page `https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=16-2` with
1440/390/320 frames, then apply its neutral queue hierarchy to the existing
`FUL-PICKUP-QUEUE` page. The projection remains authoritative for Store, freshness, ready time,
public Order reference, phase, proof readiness, staging, claim/exception, package count and
allergen cue. Static Figma fixtures must be labeled synthetic. Preserve current-page filters,
server pagination, stale read-only behavior, proof verification, explicit server-confirmed
handoff and unavailable Claim/Report Exception/Overdue actions. Acceptance questions: are the
search/filter controls and card hierarchy legible at 1440/390/320, with no horizontal overflow,
while existing actions and safe-source limitations remain unchanged? Affected inputs are
`PickupPages.tsx`, Merchant styles, existing Pickup screen/browser tests and this WP record.
Run focused Pickup component tests, the production-fail-closed Pickup queue journey with all
three widths and inspected screenshots, Merchant TypeScript, targeted ESLint/Prettier and
`git diff --check`. Browser fixtures remain synthetic and do not establish live Store evidence,
Task command ownership, an Overdue due-time source or Figma Make acceptance.

Pickup Figma Design visual migration result (2026-09-23): the shared Operations Queues page at
`https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=16-2` retains the Kitchen frames and
has Pickup Queue frames at 1440/390/320; static content is labeled synthetic. A fresh Kitchen
desktop screenshot confirms its original queue content remains visible. `PickupQueueScreen` now
uses the black/white shell header and neutral filter/card
hierarchy, with compact single-column controls/cards below 768px and long safe Order references
wrapping inside cards. Existing projection values, source refresh, filters, pagination, stale
read-only lock, proof verification, explicit confirmed handoff and disabled Claim/Report
exception/Overdue states are unchanged. The focused Pickup component tests pass 3/3 and the
production-fail-closed browser journey passes 1/1; it now captures 1440/390/320 screenshots and
retains paging, proof/retry/handoff and permission recovery. Inspected screenshots show no
horizontal overflow; the 320px long-reference fixture wraps within its card. Merchant TypeScript,
targeted ESLint/Prettier and `git diff --check` pass. The journey's configured preview build passes
with the existing >500 kB chunk warning. Fixtures remain synthetic. Make editor/write access,
source-bound Claim/Report exception command composition, authorized due time for Overdue, live
Store evidence, and full project/production acceptance remain open.

Orders Figma Design continuation verification selection (2026-09-23): add 1440/390/320
source-limited frames to the existing persistent Operations Queues Figma page
(`https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=16-90`) and align the real
`OPS-ORDER-QUEUE` shell header with the black/white hierarchy. Keep compact native Order rows,
exact Order-number search, loaded-page-only type/channel/phase filters, matching count, batch
acceptance summary and UTC submission time. Static examples are synthetic; do not add payment,
Kitchen, SLA, exception or claim fields absent from the current DTO. Existing disclosure state,
acceptance intent/retry, payment links, Dining progress lock, server cursor and denial recovery
must remain unchanged. Inspect the refreshed desktop/390/320 screenshots and run the current
Order row component tests, existing production-fail-closed browser journey with all three widths,
Merchant type/lint/format, and `git diff --check`. No Domain/API/database changes; browser rows
are intercepted fixtures, not Store evidence.

Orders Figma Design continuation result (2026-09-23): the persistent Operations Queues page
contains synthetic, source-limited `OPS-ORDER-QUEUE` layouts at 1440/390/320. The local real
queue now uses the same black/white header while retaining its compact disclosure rows, exact
public Order-number search, page-only type/channel/phase controls, accepted/not-accepted batch
counts and UTC submission time. No unavailable Payment, Kitchen, SLA, exception or claim values
were added. CurrentOrderQueuePage render tests pass 5/5 and the production-fail-closed browser
journey passes 3/3, including keyboard disclosure, preserved Unknown acceptance intent, rejected
acceptance refresh and fresh 1440/390/320 screenshots. Screenshot inspection shows the rows and
filters reflow without horizontal overflow; long rows wrap at 320px. Merchant TypeScript, targeted
ESLint/Prettier and `git diff --check` pass. The configured production preview build passes with
the existing >500 kB warning. All browser values are intercepted synthetic fixtures. Server-side
search and Registry-required Payment/Kitchen/overdue/exception/claim facets, full Make acceptance,
live Store evidence and overall production acceptance remain open.

Exception Workbench Figma continuation verification selection (2026-09-23): add synthetic
1440/390/320 frames to the persistent Operations Queues review page
(`https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=17-2`) using only the current
`OPS-ORDER-EXCEPTION` projection fields: Store/business date/freshness, kind, severity, status,
created/due instants, Provider state, compensation status and owner status. Keep Order references
unavailable in the visual because the UI has no approved public display value. Explicitly show
that general acknowledge/assign/resolve actions remain unavailable; keep the existing separate
source-specific Payment actions gated. Apply a black/white header, neutral filters/cards and
single-column small-screen reflow to the local screen. Preserve stale read-only behavior, loaded
projection filters, overdue calculation, safe text and focus. Acceptance question: can the
authorized projection be scanned at 1440/390/320 without suggesting unavailable identities,
commands or finality? Verify the existing `OrderExceptionPage` tests and production-fail-closed
`order-exception.spec.ts` journey, Merchant typecheck, targeted ESLint/Prettier and
`git diff --check`; inspect all three browser screenshots. Browser cases are intercepted
synthetic fixtures, not real Payment/Store evidence.

Exception Workbench Figma visual migration result (2026-09-23): the persistent Operations Queues
Figma page now contains source-limited exception layouts at 1440/390/320. Its synthetic card shows
severity/status, due/created labels, unavailable Order reference, Provider/compensation/owner state
and unavailable general actions. The local workbench now uses the black header, neutral filter
panel and source-state chips; exception cards wrap long text and filters remain one column below
768px. The initial browser run found a longest-option select overflowing the 390px viewport; setting
the filter select to `width: 100%; min-width: 0` fixed it. The 500-row backlog case then passed, and
the full production-fail-closed Exceptions journey passes 12/12, covering keyboard filters, Store
switch/denial recovery, Payment-specific intent retry and 1440/390/320 screenshots. The focused
`OrderExceptionPage.test.tsx` suite passes 13/13; Merchant typecheck, targeted ESLint/Prettier and
`git diff --check` pass. Inspected Figma and browser frames have no horizontal overflow; compact
Figma text was shortened/constrained after review. The configured production preview build passes
with the existing >500 kB warning. Fixtures remain synthetic and do not establish Task command
ownership, Provider/Store evidence, first-alert timing or production acceptance. Figma Make remains
unwritable in the current account session.

Kitchen Figma current-checkout revalidation (2026-09-23): the existing review-selection command
`source .local/activate.sh && CI=true pnpm --filter @bop-rms/merchant-web exec playwright test
e2e/kitchen-queue.spec.ts --project=production-fail-closed` passes 2/2. The focused
`KitchenBoardPages.test.tsx` and `App.test.tsx` run passes 10/10. Fresh 1440/390/320 screenshots
were inspected: the desktop retains the black/white shell, authorized navigation, station lane,
status/age/quantity/safety hierarchy; mobile opens the native filter dialog and stacks actions
without page overflow. Queue values are synthetic and source-limited; the missing public
Order/ticket display refs, course, priority and SLA remain unresolved. Source review also confirms
`createMerchantKitchenQuery` sets `operatorStatus: Named` after Workforce `kitchen.operate`
authorization and `createMerchantKitchenCommand` rechecks that same permission, without composing
the WP-1808 named KDS Operator lock/visibility state. The UI E2E is not evidence of that device
continuity contract; keep KDS lock/session command enforcement and real UAT as explicit remaining
work. The preview build carries its existing >500 kB advisory.

Kitchen current-worktree journey rerun (2026-09-23): the selected command
`source .local/activate.sh && CI=true pnpm --filter @bop-rms/merchant-web exec playwright test
e2e/kitchen-queue.spec.ts --project=production-fail-closed` passes 2/2 on current HEAD plus
uncommitted edits. The first sandboxed launch stopped before test execution because loopback bind
was denied; the authorized loopback run completed normally. Fresh `kitchen-board-1440.png`,
`kitchen-board-390.png` and `kitchen-board-320.png` were inspected: desktop hierarchy and mobile
filter/card/action reflow are intact with no horizontal overflow. The Vite production preview
continues to emit the existing >500 kB advisory. Intercepted synthetic rows do not prove Store
data, and this run does not close the WP-1808 server-side KDS session/lock fence or safe-reference,
course, priority and overdue projection gaps.

Recipe administration Figma Review result (2026-09-23): the shared Operations Queues design
page now contains `RECIPE-LIST` and `RECIPE-EDITOR` review frames at 1440, 390 and 320 pixels
(node IDs `27:2`, `27:30`, `27:52`, `27:74`, `27:100`, `27:126`) at
https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=27-2. The frames follow its
Inter/neutral hierarchy and preserve the Registry's phase-2 and `recipe.manage` context. Missing
authorized source values are marked unavailable and commands remain unavailable. Screenshot
review found warning copy overlap at 320px; shorter copy and additional spacing corrected it, and
the final compact screenshots show no overlap. These are design review frames only; they do not
make the normal route, source composition or Recipe acceptance complete. No Figma Make source,
publish or sharing setting was changed.

Kitchen Figma hierarchy correction (2026-09-23): direct comparison of the persistent frame
`4:2` and mobile frames `4:86`/`4:128` against the current browser captures found the prior local
screen was not yet a faithful migration: it used `Kitchen Board`/`Active work` headings, a filled
logo tile and an extra mobile navigation row. `KitchenBoardScreen` and its scoped styles now use
the Figma `BOP / OPERATIONS` header, the `Kitchen` and `KIT-KITCHEN-QUEUE · Active work` content
hierarchy, a `Queue` section and count, compact filter controls and a soft full-width mobile filter
trigger. Store context, authorized navigation, UTC freshness, loaded-item filters, privacy limits
and command/detail behavior remain sourced from the current view and session. At mobile width,
navigation collapses only when its sole authorized link is the current page; when other authorized
destinations exist, responsive navigation remains available. Design sample facts were not added.

Fresh verification after the visual correction: focused `KitchenBoardPages.test.tsx` and
`App.test.tsx` pass 10/10; Merchant TypeScript, changed TSX/E2E ESLint, Prettier and scoped
`git diff --check` pass. The production-fail-closed Kitchen browser journey passes 2/2 and generated
new 1440/390/320 screenshots, all inspected. The 390px title/byline and status/refresh alignment
needed one follow-up CSS adjustment after screenshot review; final captures show the intended
alignment and no horizontal overflow. Vite retains the existing >500 kB warning. Data remains
intercepted synthetic fixtures; KDS server session/lock enforcement and Registry-required
Order/ticket reference, course, priority, SLA/overdue, claim and exception-source fields remain
unresolved.

Dining Figma layout refinement verification selection (2026-09-23): direct comparison of the
current Review frames (`24:2`, `24:60`, `24:109`) with a fresh browser run found the Table search
placeholder missing and desktop area lanes using narrower cards than the design's three-column
grid. Restore the design's `Search labels` cue and three equal desktop filters; size area-grid
tracks to produce three desktop columns while allowing mobile cards to fill the viewport. Preserve
actual Area grouping, source row count/status/capacity/session, selected-table detail and current
start/Unknown/recovery behavior. No table count or sample details are copied from Figma. Verify
the existing production-fail-closed `dining-session-start.spec.ts`, TypeScript, scoped ESLint,
Prettier and diff check, then inspect fresh 1440/390/320 screenshots. Browser data remains
synthetic and does not verify Store acceptance or unavailable Registry projection fields.

Dining Figma layout refinement result (2026-09-23): `DiningSessionWorkspace` now includes the
`Search labels` cue and the three equal-width desktop filters. The table grid uses wider desktop
tracks while filling mobile width; current Area groups and source row counts determine the cards
shown. No design-only tables or Occupied/session-age/attention facts were added. The focused
Dining render suite passes 4/4, Merchant TypeScript passes, changed-file ESLint and Prettier pass,
and the production-fail-closed Dining journey passes 1/1. Inspected fresh 1440/390/320 captures
show no horizontal overflow and retain the selected-table/session detail and command gates. Vite
reports its existing >500 kB advisory. Intercepted browser rows are synthetic; Dining Registry
party/order/payment/reservation/waitlist/elapsed/server/attention fields and real Store acceptance
remain unresolved.

Merchant Overview Figma migration verification selection (2026-09-23): use the existing BOP
black/white Operations visual language for the normal `/app` `HOME-OVERVIEW` page. Source fields
are limited to the authenticated workspace snapshot: selected Store and Brand labels, Store
status, Business Date, freshness, authorized Store choices, switching result and the current
permission-trimmed navigation list. Keep Today summary, open Tasks/exceptions and system/Provider
health explicitly unavailable until WP-1905 connects their projection; add no synthetic counts.
Create 1440/390/320 Figma Review frames and align the local header, selected navigation state,
scope switcher and explicit unavailable cards. Preserve Store-switch authorization, denied/failure
recovery, stale warning and sign-in/offline states. Verify `MerchantShell.test.tsx`, the existing
normal App route/browser journey, Merchant typecheck, scoped ESLint/Prettier, build and
`git diff --check`; inspect fresh 1440/390/320 screenshots. Browser data remains synthetic and
does not establish Store health or WP-1905 source acceptance.

Orders Review frame correction (2026-09-23): inspecting the persistent 1440 frame `16:90`
found that its Refresh text node `16:96` started underneath the button rectangle `16:95`,
which obscured the start of the label. The text node is now centered within the existing
button bounds; the regenerated 1440 screenshot confirms the full `Refresh` label is visible.
This is a correction to the Figma Review artifact only; no Merchant source, synthetic business
facts, Make publication or sharing state changed.

Merchant Overview Figma migration verification result (2026-09-23): loaded the repository-pinned toolchain via `.local/activate.sh` (Node24.18.0, pnpm11.13.0), then ran `CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/merchant-overview.spec.ts --project=production-fail-closed` with approved local loopback; 1/1 passed. The journey asserted the authorized Store/navigation snapshot, HOME-OVERVIEW selection, current freshness, Store status, WP-1905 unavailable cards, and no document overflow at 1440/390/320. Inspected all three generated screenshots: desktop shows the BOP/OPERATIONS shell, authorized sidebar, scope selector and status/unavailable cards; mobile stacks cards and presents current authorized nav/scope without horizontal overflow at 390 and 320. At 320 the native Store option text is visually truncated within its control, while the selected Store and Brand remain fully visible in the page heading; the control remains operable and no content escapes its bounds. This is synthetic intercepted data, not Store evidence. Production Vite build emits its existing >500kB chunk advisory. No business test, live Store state, WP-1905 projection or launch acceptance is claimed.

Merchant Overview compact Store option refinement selection (2026-09-23): the inspected 320px screenshot showed the selected native Store option truncated inside its control. Keep the complete authorized Store/Brand option readable at 320px by applying a compact font size only at the narrow breakpoint; retain the existing native accessible select and all authorization/switch behavior. Verify with the existing production-fail-closed 1440/390/320 journey, inspect the refreshed 320px screenshot, and run Merchant typecheck, targeted ESLint/Prettier and `git diff --check`. This is a presentation-only correction; the displayed page heading remains the full selected Store/Brand source.

Merchant Overview compact Store option refinement result (2026-09-23): the 320px scope select now uses a 14px font only below 340px, allowing `Training Store · Synthetic Brand` to remain readable in the control while 390px retains the default font and the native select/accessibility behavior. The production-fail-closed 1440/390/320 journey passes 1/1 after the breakpoint correction; all three refreshed screenshots were inspected, showing the unchanged desktop hierarchy, full Store/Brand option at 390 and 320, and no page overflow. Merchant typecheck and targeted ESLint pass on the final TypeScript inputs; Prettier and `git diff --check` pass on the final CSS/WP inputs. The browser run rebuilt the production preview with the existing >500kB chunk advisory. All responses remain synthetic; no authorization or Store data behavior changed.

Privacy Request action affordance verification selection (2026-09-23): `PrivacyRequestList` currently renders Intake/Verify/Collect/Fulfill/Close buttons from permission/status bits but has no authenticated command client or button handlers. Make the unsupported command state explicit, disable those action controls regardless of a synthetic current/fresh fixture, and associate each disabled control with a visible explanation. Do not change the Domain, add a fake command, or imply that owner data was changed. Run the focused `PrivacyRequestPage.test.tsx`, Merchant typecheck, targeted ESLint/Prettier, and `git diff --check`. This closes an inert active-looking UI affordance only; privacy owner coverage, persistence, normal route, command execution and legal acceptance remain open.

Privacy Request action affordance verification result (2026-09-23): `PrivacyRequestList` now disables every permissioned action and points it to visible read-only copy until an authenticated command client is composed. The new component test asserts all four actions exposed by a fresh synthetic fixture remain disabled and associated with the explanation. Focused component tests pass 5/5; Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass. This removes the inert active-looking affordance only. The normal page client still fails closed; owner coverage, authorized persistence, commands, partial/hold/export outcomes and legal acceptance remain unimplemented/unverified.

Communication and Reporting action affordance verification selection (2026-09-23): the
Communication client exposes only `load`, while Reporting catalog, builder and Run history
clients also expose reads only; the page components render permission-derived buttons without
command callbacks. Disable these unsupported controls even for fresh permission-true synthetic
views and associate them with visible read-only explanations. Preserve existing permission and
eligibility visibility, do not add simulated commands or Provider outcomes. Run the three focused
Merchant component test files, Merchant typecheck, targeted ESLint/Prettier and `git diff --check`.
This is a UI honesty correction only; owner commands, normal-route client composition and workflow
acceptance remain outside this slice.

Communication and Reporting action affordance verification result (2026-09-23): fresh
permission-true Communication history/template and Reporting catalog/builder/Run fixtures now
render action buttons disabled and associated with visible read-only explanations. Existing
permission and existing report/Run state conditions still govern which controls are shown;
no client, command, Provider outcome, report data or artifact behavior was added. Focused
Communication, Report page and Report Run history tests pass 29/29; Merchant typecheck and
targeted ESLint pass; Prettier and `git diff --check` pass. The normal routes remain unavailable
and the actions are not implemented. No Make edit or project-completion claim is implied.

Kitchen named-operator display source correction selection (2026-09-23): the fresh Figma
`KIT-KITCHEN-QUEUE` frame `4:2` shows “Named operator”, but the current API query emits
`operatorStatus: Named` solely after `kitchen.operate` permission and does not resolve the active
named Session / lock required by Handoff Section 87.11.1 and WP-1808. Change the query response to
an explicit `Unverified` state until an owner-backed source is composed; parse/render this state as
read-only with clear explanatory copy, preserving the existing command-interaction logic only for
the other explicitly supplied test states. Update focused API/parser/render tests and the existing
production Kitchen browser journey so normal read responses cannot imply a named operator. Update
the Figma Review frames to the same source-honest label, disabled action styling and read-only
explanation without changing the Make draft or accepted baseline. Run affected API and Merchant
component tests, Merchant/API typechecks and targeted lint, format, plus the full Kitchen
1440/390/320 production-fail-closed browser journey and inspect all screenshots. The Merchant BFF
command still only enforces `kitchen.operate`; this read/UI correction does not close that server-
side named-session/visibility-lock fence and cannot establish real operator identity or Store
acceptance.

Kitchen named-operator display source correction result (2026-09-23): `createMerchantKitchenQuery`
now returns `operatorStatus: Unverified` for both List and Get until an owner-backed active KDS
Session/lock source exists. The strict Merchant parser accepts that explicit state; the ordinary
route renders “KDS session unverified”, a visible explanation and disabled commands even when the
projection is Fresh. The normal production browser fixture now returns Unverified, checks the
read-only state and captures the source-read route at 1440/390/320. The separate command-interaction
journey retains a clearly commented synthetic Named state only to exercise frontend pending,
conflict and Unknown-intent recovery; its screenshots use distinct `kitchen-command-board-*` names
and are not treated as source evidence. API query tests pass 8/8; Merchant parser/render tests pass
18/18; API and Merchant typechecks, targeted ESLint, Prettier and `git diff --check` pass. The
production-fail-closed Kitchen journey passes 2/2; all three normal-route screenshots were
inspected with no horizontal overflow, and the preview build has the existing >500 kB chunk advisory.
The Figma Review frames at nodes `4:2`, `4:86`, `4:128` and filter-sheet `8:8` now use the same
unverified label, disabled action styling and source explanation; all four rendered screenshots
were inspected with no clipped label or overlapping text. This is an honest display/read-path
correction only: `createMerchantKitchenCommand` still lacks the named-Session/visibility-lock
server fence, and no live operator, Device or Store acceptance is established.

Reporting catalog Figma review design (2026-09-23): per the Owner's instruction to continue
whole-project work using the available Figma visual language, added `RPT-REPORT-CATALOG`
review frames at 1440/390/320 to the existing Operations Queues Design file
([desktop frame](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=41-2)). Reused
the existing white/neutral BOP Operations shell and its typography. The catalog shows only
Registry filter/column semantics and an unavailable-source state; no synthetic report rows,
owner names, certification, schedule, last-run, or results were invented. Catalog actions
remain visually disabled because the route client exposes no authorized commands. All three
rendered screenshots were inspected; desktop filter/table hierarchy is intact, mobile
filters/actions stack at 390 and 320, and labels/copy remain inside their frames. This is a
Figma Design Review artifact, not a Make edit, accepted Screen baseline, local code migration,
normal-route read, or report execution. `ReportCatalog` and the related builder/Run routes
still default to unavailable until authorized BI projections and authenticated commands are
composed under their owning Work Packages.

Kitchen Figma source-truth correction (2026-09-23): a fresh read of Review frame `4:2`
contradicted the earlier correction record: its visible footer still said Kitchen actions
were enabled, despite the unverified-session status and disabled-looking controls. The 390/320
frames also lacked the same prominent read-only explanation rendered by the repository route.
Updated Desktop 1440 / Mobile 390 / Compact 320 frames with a visible `Board locked — read-only`
notice and disabled-action explanation, corrected the footer to say commands are disabled, and
restored the desktop sidebar's original navigation positions after inserting the notice. Fresh
renders of all three frames were inspected: the banner, selected Kitchen navigation, queue
cards, filters and footer remain within their bounds, with no horizontal overflow. This corrects
the Figma Design Review artifact only; it does not change the Make source or enable any command.
The matching repository screenshot captures were also re-opened from the current checkout at
1440/390/320 and show the actual projection-driven route in read-only state. They remain
synthetic browser fixtures, not Store or named-operator evidence. Existing focused component and
production-fail-closed journey evidence is retained because no repository code changed in this
correction.

Dining Figma migration current-checkout recheck (2026-09-23): re-read Registry
`DIN-FLOOR-BOARD`, Handoff 88.11, current `DiningSessionWorkspace`, its existing E2E and the
Review frames `24:2`, `24:60`, `24:109`. The route displays only current table-projection
facts—label, Area, operational state, capacity, current-Session link and lifecycle—and clearly
marks party, Order/payment, reservation/waitlist and elapsed-time fields unavailable. Search
and filters remain limited to table label, Area and state; selected-table details retain the
existing session-start/code-recovery and Host Transfer actions. The Review layout's header,
source-limits callout, filter hierarchy, Area cards and selected-details panel are represented
in the local route without copying its synthetic table rows or inventing missing source fields.
The existing `dining-session-start.spec.ts` production-fail-closed journey passes 1/1 and freshly
captures `dining-board-1440.png`, `dining-board-390.png` and `dining-board-320.png`. It covers
Area/state/label filtering, no-match recovery, keyboard table selection, permission denial and
refresh recovery, plus retry after a lost one-time-code result. All three screenshots were
inspected; controls/card details reflow at mobile widths without horizontal overflow. The Vite
production preview build retains its existing >500 kB advisory. Browser responses are synthetic
fixtures, not live Store acceptance. No source code changed during this recheck; no Domain,
projection, permission, persistence, Make or production behavior was added.

Recipe Figma migration verification selection (2026-09-23): acceptance question—does the
repository Recipe route adopt the existing Review file's Commerce/Review header, phase label,
source-limit callout and vertical content hierarchy while keeping unavailable data unavailable?
Affected inputs are `RecipePages.tsx`, its component tests and scoped `styles.css`; run the
existing Recipe component suite, Merchant typecheck/lint/format, then the production-fail-closed
browser route at 1440/390/320 and inspect the generated captures. This is fresh verification
because the visual layer changed; no database, owner projection or command check is applicable.

Recipe Figma migration verification result (2026-09-23): the Recipe list/editor routes now use
the existing review hierarchy—BOP / COMMERCE / REVIEW header, Registry/Phase eyebrow, source
boundary callout and a single-column content rhythm. Unavailable routes show no sample Recipe
rows; the editor's return link remains available, while source-dependent values and write
commands remain unavailable. The focused component suite passes 30/30, Merchant typecheck,
scoped ESLint, Prettier and `git diff --check` pass. The production-fail-closed Playwright route
passes 1/1 and captures list/editor at 1440/390/320; all six screenshots were inspected with no
horizontal overflow or copy overlap. The local Vite build retains its existing >500 kB chunk
advisory. This verifies visual/responsive fallback only; Recipe list/editor remain uncomposed
with the authorized normal-route query and source projections.

Reporting Catalog Figma migration verification selection (2026-09-23): acceptance question—does
`/app/reports` use the existing `RPT-REPORT-CATALOG` Review hierarchy at 1440/390/320 while
keeping catalog rows, display names, filters and commands unavailable until authorized BI
composition exists? Reference Figma nodes `41:2`, `41:60`, `41:103`; Handoff 88.15 and the
Screen Registry remain the content/permission authority. The layout's fixed Review navigation is
not copied because this normal route has no permission-trimmed workspace navigation input. The
current report DTO also exposes an opaque owner reference rather than an authorized display name;
keep the reference out of the page. Affected inputs are `ReportPages.tsx`, its component and new
browser tests, and scoped CSS. Run the focused Report page suite, Merchant typecheck/lint/format,
then production-fail-closed browser captures and inspect all three widths. This is fresh visual
and privacy verification; database/BI-owner commands are not applicable.

Reporting Catalog Figma migration verification result (2026-09-23): the current
`/app/reports` unavailable state now follows the Operations/Review hierarchy and uses the
Registry catalog fields without adding fixed navigation that could imply ungranted access.
No sample report rows or opaque owner reference are rendered; filters and View/Run/
Duplicate/Archive/Create controls remain disabled while their authorized source/commands are
absent. The focused Report page suite passes 13/13, Merchant typecheck, scoped ESLint,
Prettier and `git diff --check` pass, and the production-fail-closed Playwright journey passes
1/1. Fresh 1440/390/320 captures were inspected; filters and empty-state actions reflow with
no horizontal overflow. The Vite production preview retains its existing >500 kB chunk
advisory. This is visual fallback evidence only; the normal BI catalog/query, owner display
projection, builder, run history and authenticated commands remain unimplemented/unavailable.

Kitchen Figma responsive hierarchy refinement verification selection (2026-09-23): a fresh
comparison of Review nodes `4:2`, `4:86` and `4:128` with the current repository screenshots
found the shared `StatePanel` minimum height/padding makes the KDS read-only notice much taller
than the design, and the mobile Filter trigger follows the notice instead of preceding it.
Constrain only the Kitchen notice, place the mobile trigger in the semantic DOM immediately
after the page header, and retain desktop inline filters, authorized data/action states and
source-limit explanation. Acceptance questions: does the local notice follow the compact
68/72/82px review-card hierarchy, and do 390/320 controls/cards appear in the Review order
without clipping/overflow while keyboard interaction remains operable? Verify existing Kitchen
component tests and the production-fail-closed Kitchen journey at 1440/390/320; inspect new
screenshots, run Merchant typecheck and targeted ESLint/Prettier, and `git diff --check`.
This is a scoped visual correction; no Kitchen API/domain source is being added.

Kitchen Figma responsive hierarchy refinement result (2026-09-23): the Kitchen-only read-only
notice now overrides the shared state card's oversized minimum height/padding and uses the
compact accent/copy hierarchy from Review frames `4:2`, `4:86`, `4:128`. A dedicated mobile
Filters trigger now occurs immediately after the page header in DOM and visual order, before the
notice; the redundant mobile Queue heading is hidden and the source-boundary note follows the
cards. Desktop retains the Queue heading and inline filters. The mobile journey now asserts
Queue is hidden and the Filters trigger precedes the read-only notice. Focused Kitchen component
tests pass 7/7, Merchant TypeScript passes, targeted ESLint/Prettier and `git diff --check` pass;
the production-fail-closed Kitchen browser journey passes 2/2 after the first run exposed the
expected stale test assertion for the now-hidden mobile Queue heading. Fresh 1440/390/320 captures
were inspected with no horizontal overflow, clipped copy or card/footer overlap. The Vite build
retains its existing >500 kB advisory. This improves local visual alignment only; intercepted
queue data is synthetic, and safe display references, course, priority, SLA/overdue, Claim/Hold/
Prioritize ownership and the server-enforced named KDS session/device lock remain unresolved.

Communication History Figma continuation verification selection (2026-09-23): under the user's
whole-project UI direction, extend the existing Operations Queues Design Review file with a
source-limited `COMMS-HISTORY` desktop/390/320 page using its existing Inter/neutral BOP hierarchy.
Registry 88.14 and WP-2145 own the fields, permission split, privacy and explicit command gates;
normal Notification persistence/API composition is not present, so frames must contain no
recipient/template/provider sample rows and must keep all filters/actions unavailable without
inventing facts. No static workspace navigation is copied because the normal route lacks a
permission-trimmed navigation input. Apply the same design hierarchy to the current unavailable
route only; no Notification persistence, send, suppression, or template mutation is in scope.
Compare fresh Design renders with browser captures. Verify Communication component tests,
Merchant typecheck, targeted lint/format and a production-fail-closed route capture at 1440/390/320;
inspect all screenshots and preserve Permission Denied, Feature Disabled, stale/offline and Provider
Unknown semantics. Synthetic examples remain excluded; Design Review is not an accepted baseline.

Communication History privacy/rendering verification selection (2026-09-23): source review of
`CommunicationHistory` found it renders DTO `sourceReference` and `templateReference` directly;
these parser-enforced UUIDv7 values are opaque identifiers, not safe display fields. Section 88.14
requires masked recipient, template version, provider state, source and time; Section 88.28 forbids
unrestricted object IDs and unnecessary PII in screenshots and UI evidence. Remove raw references
from visible/history search values while retaining safe classification, masked recipient, channel,
template version, provider state, suppression and UTC attempt time. Preserve permissions and keep
commands disabled. Acceptance: component output contains no synthetic UUID refs; normal
FeatureDisabled route adopts source-limited Figma hierarchy with all unavailable filters disabled;
1440/390/320 browser captures show no sample records and no overflow. Run Communication component
tests, Merchant typecheck, targeted lint/format and production-fail-closed route E2E. No Notification
persistence, client adapter, send/suppression command, or feature activation is implied.

Communication History visual continuation result (2026-09-23): added source-limited COMMS-HISTORY
Review frames to the existing Operations Queues Figma file `7JHWMW9AVlAkI4ZCRGNiXw` at desktop
`47:2`, mobile `47:66`, and compact `47:123`. The private Figma Make artifact remains unavailable
for this pass; these are editable Design review frames and were not published or shared. The local
history and all unavailable/loading/error route states now use the Inter/neutral BOP hierarchy,
with the Screen Registry fields and explicit source/command boundaries. Raw request/source/template
UUIDs are not rendered; recipient stays masked and template version, Provider state, suppression,
classification/channel and UTC time remain the safe fields. Focused Communication tests pass 5/5,
Merchant TypeScript passes, targeted ESLint/Prettier and `git diff --check` pass. Fresh production-
fail-closed Playwright route journey passes 1/1 and captures 1440/390/320 screenshots with no
horizontal overflow; screenshots were inspected at all three sizes. The first browser run caught
an actual mobile header overflow; the source-status pill now stacks below the title on mobile.
Review screenshots use no communication rows. Normal Notification persistence/history client,
authorized source-display mapping and resend/suppression/template commands remain unavailable;
this UI continuation does not activate them or close WP-2145.

Kitchen station-label projection gap correction verification selection (2026-09-23): the
authorized queue DTO carries an opaque Station reference but no safe Station display label. The
browser client currently substitutes one identical “Station name unavailable” string per row,
groups all such work into a lane named like an actual Station, and leaves a Station filter enabled
with no meaningful options. Preserve Registry station-lane presentation without exposing IDs or
inventing labels: represent absent labels as null, group them under an explicit unavailable-source
heading, and disable the Station filter if any loaded item lacks a safe display label. Acceptance:
strict parsing supports null; actual client mapping emits null; rendered unknown rows remain visible
in an explicitly unavailable group; Station filter is disabled while labels are absent and works
with real labels. Run focused Merchant Kitchen client/parser/render tests, Merchant typecheck,
targeted lint/format, `git diff --check`, and the production Kitchen journey at 1440/390/320; inspect
fresh captures. No Kitchen Domain, query, projection, permission or command contract changes.

Kitchen station-label projection gap correction result (2026-09-23): `KitchenBoardItem.stationLabel`
now accepts explicit `null`; the same-origin client maps the query's opaque `stationReference` to
that unavailable display state rather than synthesizing a common Station label. The queue keeps
such rows visible under “Station labels unavailable” and marks the Station selector unavailable
and disabled when any record in the loaded page lacks an authorized display label, so choosing a
known Station cannot silently hide unknown-location work. Station grouping and filtering remain
enabled when every current row has a safe label. Focused Kitchen parser/client/render tests pass
22/22; Merchant typecheck and changed-file ESLint/Prettier plus `git diff --check` pass. The
production-fail-closed Kitchen browser journey passes 2/2; fresh 1440/390/320 screenshots were
inspected for the disabled selector, unavailable group, command lock and responsive fit. Browser
responses are intercepted synthetic data. This fixes the UI's presentation of missing projection
metadata only; Station label projection, KDS named Session/visibility-lock server enforcement,
course/priority/SLA/claim/hold sources and real Store/Device acceptance remain open.

KIT-WORK-ITEM source metadata and Figma shell continuation verification selection (2026-09-23):
the Kitchen owner `Get` result carries the same `projectedAt`, freshness and projection metadata as
the queue; Merchant's current detail client drops that envelope and `KitchenWorkItemScreen` passes
`createdAt` as the observation instant, causing every detail card to say `0 min`. Preserve and
strictly parse the authorized detail projection metadata (without rendering generation/checkpoint
IDs), calculate age only as of `projectedAt`, show the selected Store/session-authorized navigation
in the existing Figma Operations shell, and keep missing recipe/handling, acknowledgement, timers,
dependencies and history fields visibly unavailable. Detail commands remain disabled because this
route has no authenticated Kitchen command client. Run focused Kitchen client/parser/render tests,
Merchant typecheck, targeted lint/format, `git diff --check`, and the production Kitchen E2E at
1440/390/320 with both queue and detail screenshots inspected. No Owner/API/Domain schema change.

KIT-WORK-ITEM source metadata and Figma shell continuation result (2026-09-23): the strict detail
view now retains projection name/version, selected Store label, `projectedAt`, freshness, and the
current session operator status without exposing generation references. Work age is calculated at
projection time rather than item creation. The detail route and its permission/error states use the
same authorized Operations shell; a duplicate fixed refresh control found during screenshot review
was removed. Missing Recipe/handling snapshots, acknowledgements, timers, dependencies and history
remain explicitly unavailable, and detail commands remain disabled. Focused Kitchen parser/client/
render tests pass 22/22; Merchant typecheck, targeted ESLint/Prettier and `git diff --check` pass.
The production-fail-closed Kitchen browser journey passes 2/2 and fresh queue/detail screenshots
were inspected at 1440/390/320 with no horizontal overflow or duplicate refresh action. Browser
responses remain synthetic. No Kitchen Owner/API/Domain schema was changed; Station display names,
KDS session/device lock enforcement and source fields required for full operational acceptance
remain outstanding.

KIT-WORK-ITEM queue-scope return verification selection (2026-09-23): Handoff 88.10 requires the
full-screen detail child route to return with its Queue scope intact. The current Details and Return
links discard in-memory Station/state/allergen/exception filters. Carry only the bounded, validated
filter values in router history state (no query-string or item/object references), restore them on
queue entry, and preserve the state on both detail success and unavailable routes. Verify a nondefault
field-supported filter survives Queue -> detail -> Queue in the production Kitchen journey at
1440/390/320; run focused page/client tests, Merchant typecheck, targeted lint/format and diff check.
No API/Domain/persistence or command behavior change.

Kitchen Registry action hierarchy verification selection (2026-09-23): Figma Review frame `4:2`
shows only the state-eligible action for each work item, while the current Merchant WorkCard renders
Accept, Start, Complete, Mark ready and Hold/Prioritize for every status. Retain only lifecycle
intents supported by the item's exact execution facts and current status, keep eligible actions
visibly disabled when the board is read-only, and omit command affordances on the detail page where
no command client exists. State explicitly when lifecycle execution metadata is unavailable; keep
Hold/Prioritize in the source-limit explanation. Verify Queued/accepted/In Progress/ready eligibility
in focused render and existing browser command journeys, plus Merchant typecheck, scoped lint/format
and `git diff --check`. This is Merchant display behavior only; no Kitchen owner/query/command or
permission contract changes.

KIT-WORK-ITEM Figma Review detail hierarchy verification selection (2026-09-23): the existing
Kitchen Review file has only queue frames, so add a source-limited `KIT-WORK-ITEM` Review design in
the same file at desktop 1440, mobile 390 and compact 320, following its Operations shell, neutral
surface, read-only lock, current-work card and scope-preserving return. Registry Section 88.10
requires Recipe/handling snapshots, allergen acknowledgements, timers, dependencies and history;
current `kitchen_work_queue_v1` detail has none of those fields. Present each as explicitly
Unavailable and keep detail commands unavailable. Apply this hierarchy locally without changing
projection, Domain, API or permission behavior. Add render assertions, run focused Kitchen tests,
Merchant typecheck, targeted ESLint/Prettier and `git diff --check`; run the existing production
Kitchen browser journey at 1440/390/320 and inspect the new screenshots for row readability and
overflow. Browser responses remain synthetic; the Review design is not an Accepted Screen baseline
and Figma Make remains quota-gated.

Kitchen card copy parity verification selection (2026-09-23): Figma Review frame `4:2` uses readable
Quantity and allergen/exception language, while the current card exposes the enum token
`ReviewRequired`. Map only the existing structured cue/status enum to concise user-facing text
(e.g. review required, acknowledged, or status unavailable) and label the existing quantities
“Quantity”; preserve the enum in data attributes for status styling and keep `None`/Unavailable
semantics truthful. Extend focused render and existing browser assertions, verify the 1440/390/320
screenshots, Merchant typecheck, scoped lint/format and diff check. No new allergen/health fact,
projection field, or Kitchen domain behavior.

KIT-WORK-ITEM queue-scope return verification result (2026-09-23): bounded Station/state/allergen/
exception filter values now travel only in validated router history state from queue to detail and
back. The detail error shell returns through the same authorized navigation and preserves scope;
after a denied detail read and recovery, the selected allergen filter remains applied. No query-string,
Store, Order or item references are added to that state. The production Kitchen journey passes 2/2 at
1440/390/320, including success and permission-denied detail returns; focused Kitchen tests pass
22/22, and Merchant typecheck, targeted ESLint/Prettier and `git diff --check` pass. All six fresh
queue/detail screenshots were inspected with no horizontal overflow.

Kitchen Registry action hierarchy result (2026-09-23): queue cards now expose only the lifecycle
intent eligible for the current state and exact execution metadata; eligible controls remain disabled
when freshness/operator gates block commands. Missing execution metadata is called unavailable, the
detail route has no queue mutation controls, and Hold/Prioritize remains an explicit projection/action
gap. Figma-aligned user-facing Quantity/allergen/exception labels replace enum copy while preserving
structured status attributes and styling. Focused Kitchen tests pass 22/22, Merchant typecheck,
targeted ESLint/Prettier and diff checks pass; production-fail-closed Kitchen browser journey passes
2/2 with the existing intent/conflict/denial cases. Fresh 1440/390/320 queue and detail captures were
inspected. Playwright's production Vite build retains the existing >500 kB chunk advisory. Browser
responses are synthetic; no additional projection fact or Kitchen owner/permission/command behavior
was introduced.

KIT-WORK-ITEM Figma Review detail hierarchy result (2026-09-23): regular Figma Design access and
write permission were confirmed by adding desktop `51:2`, mobile `51:3` and compact `51:4` Review
frames in the existing Operations Queues design file; the frames reuse its BOP/Operations shell,
Inter type, neutral surface, selected Kitchen navigation, source freshness/session status,
read-only callout, current-work summary and scope-preserving return. The local detail page now
matches that hierarchy and lists Recipe/handling snapshots, allergen acknowledgements,
timers/dependencies and work history as individually Unavailable; it also retains the explicit
detail-command boundary. No query, API, Domain, permission or persistence behavior changed. Focused
Kitchen tests pass 22/22; Merchant typecheck and scoped ESLint pass. Prettier identified the changed
browser spec on its first pass, which was formatted; final formatting and diff checks were rerun.
The production-fail-closed Kitchen browser journey passes 2/2, and fresh 1440/390/320 detail
screenshots were inspected: all rows remain readable, compact labels wrap within their cells, and no
horizontal overflow occurs. The initial loopback-denied sandbox attempt was environmental; the same
journey passed with approved local server binding. The private Figma Make artifact was not edited;
Make remains quota-gated. This Review page is not an Accepted Screen baseline, and synthetic
browser data is not Store evidence.

Kitchen detail mobile title-order verification selection (2026-09-23): the inspected 390/320
captures show `Synthetic rice` above the `KIT-WORK-ITEM` eyebrow, while the new Review frames place
the Screen ID first. This comes from queue-specific mobile grid rules applying to the detail route.
Scope those rules to the Queue screen so the full-screen child retains DOM/visual order (eyebrow,
title, freshness, actions) at all widths. Extend the existing production Kitchen journey to assert
the rendered Screen ID precedes the detail heading at 1440/390/320, then inspect new detail
captures and check no overflow. Run the existing focused Kitchen tests, typecheck, scoped ESLint,
Prettier and diff check; this is CSS/browser-test-only with no source contract or command change.

Kitchen detail mobile action-width verification selection (2026-09-23): after title order is fixed,
the new Review captures show Return and Refresh controls fill the mobile content width, while local
390/320 captures still align them right at intrinsic width. On screens below 768px, make the detail
action group a full-width column, keep Return left-aligned, and stretch Refresh to the available
content width; leave desktop behavior unchanged. Assert these geometry relationships in the same
1440/390/320 production journey and inspect refreshed screenshots. This remains scoped presentation
work over existing safe route and refresh actions.

Kitchen detail mobile hierarchy alignment result (2026-09-23): the mobile Queue-only title grid is
now scoped away from the `KIT-WORK-ITEM` detail route, restoring Screen ID then work-item title at
390/320. The detail's existing Return and Refresh actions now occupy their own full-width mobile
column; Return begins at the content edge and Refresh spans the full available content width, while
desktop controls are unchanged. The production-fail-closed journey now asserts title order at
1440/390/320 and mobile action geometry at 390/320, and passes 2/2. Its first run identified an
ambiguous heading locator because the work item is also named in the Current work card; the
assertion was narrowed to the detail page's `h2` and the full journey then passed. Focused Kitchen
tests pass 22/22, Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass. Fresh
detail captures at all three widths were inspected and show the intended hierarchy, full-width
mobile actions, readable unavailable-source rows and no horizontal overflow. Browser rows remain
synthetic; no business source or permission behavior changed.

Private Figma Make access recheck (2026-09-23): opened the existing Make project in a fresh
Chrome tab and moved its readable Preview from Operations Orders to `/operations/dining`.
Version 29 displays the area-grouped Dining floor, Table/Session search, Area/state/attention
filters and 11 demo table rows with session age/attention; the preview is accessible, but those
facts are explicitly fictional and are not eligible to migrate into the live projection-driven
page. The Make editor still displays “Sign up to use Figma Make”; prompt, context, build mode,
model and Send are disabled, so current Make edit permission is absent. `use_figma` exposes the
separate regular Design file, where the 1440/390/320 Review pages are editable; it does not write
to Make. No signup, share, publish or Make source change occurred. This resolves preview-content
readability for the current account and reconfirms the edit gate; it does not establish Make source
file readability or permission to edit the Make project.

Receipt evidence scope correction (2026-09-23): reconcile the BC-09/BC-10 row in the
project completion review against batches 571 and 619. Batch 571 already proves an actual
Dining Guest browser render of Original and Refund receipts after the ordinary refund;
batch 619 proves Pickup receipt generation and persistence only. Update the table to state
both facts and keep Pickup Guest browser rendering plus broader recovery/delivery source
mapping open. Documentation-only verification: inspect the cited batch records and changed
table wording, then run formatting/whitespace checks; no business suite or application build
applies.

Receipt evidence scope correction result (2026-09-23): the BC-09/BC-10 row now explicitly
attributes rendered Original/Refund receipts to the Dining Guest journey in batch 571, and
limits batch 619 to generated/persisted Pickup receipt evidence. Pickup Guest browser rendering
and broader recovery/delivery source mapping remain open. The cited WP-2402 records were
checked; documentation formatting and whitespace checks pass. No runtime evidence was
generated or recharacterized.

Loyalty Program Design Review continuation (2026-09-23): added editable regular Figma Design
Review frames `56:2`/`56:66`/`56:123` for `LOY-PROGRAM-LIST` at 1440/390/320 in the existing
Operations Queues file ([desktop frame](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=56-2)). The design follows the existing BOP neutral/Inter hierarchy, retains
Registry-supported program/list fields and the name/code, status, Store scope and scheduled
filters as disabled controls, and explicitly shows the
authorized Loyalty projection as unavailable without example rows or invented rules, members,
Store scope or expiry terms. The renders were visually inspected; 1440px uses a three-column
filter row, 390px uses two columns and the 320px layout stacks the fields, with copy fitting the frames. This is a Design Review
artifact, not an Accepted Screen baseline or a local code migration. No Phase 3 capability,
query, command, permission or feature gate changed; the route's source and normal-workflow gaps
remain open. Figma Make remains separately quota/edit gated.

Pickup Guest receipt responsive browser verification selection (2026-09-23): batch 619
proves the current Pickup receipt was generated and persisted, but prohibits acquiring the
original Guest credential for a browser read. Extend the existing production-exclusion receipt
browser journey with screenshot and document-width checks at 1440/390/320 using its existing
synthetic HTTP fixture. This verifies Customer PWA layout/history access handling only; it must
not be described as a live Guest receipt or Pickup-session observation. Run only this existing
browser spec, inspect all three screenshots, and check formatting/whitespace; no business,
database or receipt issuance suite applies.

Receipt action group visual/accessibility follow-up selection (2026-09-23): the new
1440/390/320 captures revealed Print and the disabled email action visually adjacent, with no
visible explanation of why email delivery is disabled. Keep Print available, keep email disabled,
associate its unavailable reason with the button, and place actions in a full-width vertical group
on 390/320 while preserving a compact desktop row. The existing browser journey will assert the
reason association, 44px minimum targets, responsive order/width, no overflow, and screenshots at
all three widths. This is a UI/accessibility correction only; no receipt query or mutation changes.

Receipt capture retention verification selection (2026-09-24): the current test passes but the
Playwright project uses `preserveOutput: failures-only`, which deletes `testInfo.outputPath` screenshots
after a passing run. Save its 1440/390/320 captures into the existing ignored `apps/customer-pwa/test-results/`
directory so the requested visual inspection is reproducible. Rerun only `e2e/receipt-http.spec.ts`
under `production-exclusion`, inspect the three retained images, and check test/WP formatting plus
`git diff --check`. This changes test evidence retention only; its HTTP data remains synthetic and
the actual Pickup Guest browser receipt remains unobserved.

Pickup Guest receipt responsive browser verification result (2026-09-23): the production-exclusion
receipt journey passes 1/1 with the existing synthetic HTTP fixture. It checks inaccessible-order
history clearing, the unavailable-email description, 44px action targets, desktop-row/mobile-column
layout and zero document overflow at 1440/390/320. The reviewed screenshots are in ignored local
`apps/customer-pwa/test-results/.../receipt-{1440,390,320}.png`; the actions are visually distinct
at all widths. Merchant typecheck is not applicable; Customer PWA TypeScript, targeted ESLint,
Prettier and whitespace checks pass. These captures show only the synthetic fixture; the actual
Pickup Guest browser receipt remains unobserved under batch619's credential boundary.

Receipt capture retention result (2026-09-24): the prior Playwright output-path approach did not
retain passing-run screenshots under the project's `preserveOutput: failures-only` policy. The test
now writes deterministic ignored local captures to `apps/customer-pwa/test-results/receipt-{1440,390,320}.png`.
The fresh production-exclusion journey passes 1/1, and all three retained screenshots were inspected:
the unavailable email reason is visible, both action targets exceed 44px, mobile actions stack in
full-width order, desktop actions remain in a row, and the document has no horizontal overflow.
The focused Receipt controller suite passes 24/24; targeted ESLint, Prettier and `git diff --check`
pass. After the demo-proof preview, `CI=true VITE_BOP_INTERNAL_SIMULATED_PAYMENT=1 pnpm --filter
@bop-rms/customer-pwa build` restores the local InternalTest artifact. Only the screenshot-retention
path changed in this follow-up; the browser data is synthetic and does not prove actual Pickup Guest
rendering, receipt delivery or live financial/support eligibility.

Kitchen mobile filter keyboard verification selection (2026-09-23): the production journey
currently opens the Figma-aligned native filter dialog by pointer and closes it with Done. Verify
that each 390/320 filter trigger opens from Enter, initial focus enters the first Work state
control, Escape closes the dialog and restores focus to the trigger, and the separate Done path
still works. Fresh comparison with Figma node `8:8` also shows the local mobile `.list-filters`
override collapsing its two-column fields to one, separating Clear/Done across rows and placing the
KDS source/lock explanation outside the sheet. Restore the two-column field/action hierarchy and
bring a truthful compact source note into the sheet. The local captures also lack the visible
per-field labels in Figma and truncate the long disabled Station option at 320px; show field labels
in mobile only and use a short `Unavailable` option while preserving the disabled state. Capture
the open sheet at both widths; run both
existing Kitchen browser scenarios (read/filter/detail and synthetic command-state journey), then
inspect captures and rerun focused render/type/lint/format/diff checks. All response/action states
remain synthetic; no Kitchen source or authorization semantics change.

Kitchen mobile filter-sheet keyboard and Figma parity result (2026-09-23): the first added
keyboard run exposed that Enter opened the native dialog without moving focus inside. The launcher
now focuses the first enabled select, and native Escape restores focus to the launcher. Fresh
comparison with Figma node `8:8` also corrected a later shared mobile-filter CSS override: four
filter fields are now two columns, Clear and Done share a row, visible field labels appear only in
the mobile sheet, and the disabled Station value is shortened to “Unavailable” at narrow widths.
A compact KDS/session-lock explanation appears inside the sheet. Focused Kitchen render tests pass
8/8; Merchant typecheck, targeted ESLint/Prettier and whitespace checks pass; the two existing
production-fail-closed Kitchen browser journeys pass 2/2. Their synthetic 1440/390/320 board
screenshots and 390/320 open-sheet screenshots were inspected. Enter focus, Escape/focus restore,
Done, 2-column geometry, field labels and source explanation are asserted. Production Vite retains
the existing >500 kB advisory. This closes a local responsive/keyboard parity gap only; intercepted
rows remain synthetic and the named KDS Session/device-lock command fence and live Store acceptance
remain unresolved.

Inventory Stock Overview Design Review selection (2026-09-23): create responsive
`INV-STOCK-OVERVIEW` Review frames at 1440/390/320 in the existing Operations Queues Design
file. Registry 88.12 requires one explicit Stock Scope, on-hand/reserved/available balances,
reorder/expiry/negative/count alerts and freshness; value is separately gated. The ordinary
Inventory route has no authorized overview client, so show these fields only as unavailable,
keep search/filters/refresh unavailable, and use no sample rows, balances, scope labels, freshness,
or active commands. Reuse the existing Inter/neutral Operations hierarchy and phase/source
boundary callout. Inspect all three Figma renders and record the node IDs. This is a Review
artifact only; do not activate phase 2, add an Inventory query, or imply an Accepted Screen.

Inventory Stock Overview Design Review result (2026-09-23): added `INV-STOCK-OVERVIEW`
frames to the editable Operations Queues Design file at desktop `64:2`, mobile `64:55`, and
compact `64:107`. They use the existing BOP black header, Inter type, neutral cards and amber
source/phase callout. On-hand, reserved, available, reorder, expiry, negative-stock and count
fields are present only as unavailable; the filters and refresh state are unavailable, no sample
items or balances appear, and the footer preserves the separate inventory-value permission gate.
Inspected current Figma screenshots at 1440/390/320; after the first render exposed a wrapped
header control, its label was shortened and all three final frames were reinspected. There are no
subscribed libraries, local variables, or local text/effect styles in this file, so this follows
the existing editable Review-frame conventions instead. The private Make project was not edited.
The frames are not an Accepted Screen baseline; Inventory query/phase capability, owner projection,
route composition, commands and live Store evidence remain unavailable.

Inventory unavailable-route Figma alignment selection (2026-09-23): the new
`INV-STOCK-OVERVIEW` Design Review frames expose a route gap: `/operations/inventory` still
renders the generic AppFrame/StatePanel for its current `Unavailable` client. Align only this
normal fail-closed state with the Review hierarchy, preserving the Inventory permission/phase gate
and keeping balances, alerts, scope, freshness, filters and refresh unavailable. Add no inventory
rows or actions. Acceptance: component markup matches the Registry source boundary; a production-
fail-closed route journey confirms all controls disabled, no sample records and no overflow at
1440/390/320, and each screenshot is inspected against frames `64:2`/`64:55`/`64:107`. Run the
focused Inventory component suite, Merchant typecheck, scoped ESLint/Prettier and `git diff
--check`. No authorized query, projection, domain command or external Store evidence is in scope.

Inventory unavailable-route Figma alignment result (2026-09-23): the ordinary
`/operations/inventory` route now renders the Figma-aligned Operations shell, Stock Overview title,
explicit phase/source boundary, unavailable on-hand/reserved/available and alert areas, and disabled
search/filters/refresh only when its normal authorized client reports `Unavailable`. Other Inventory
screens and Permission Denied/Stale/Conflict states retain their existing behavior. No sample items,
balances, freshness or scope are exposed. The focused component assertion is included in the full
Merchant Vitest run (106 files/769 tests pass); Merchant typecheck, targeted ESLint, targeted
Prettier and `git diff --check` pass. The production-fail-closed browser journey passes 1/1, checks
disabled controls/no sample data/no horizontal overflow, and regenerates 1440/390/320 screenshots.
Inspection caught a wrapped 320px filter legend; shortened it and reran the journey. All three final
screenshots now match the source-limited Review hierarchy with no clipping or overflow. The
production Vite build keeps its existing >500 kB chunk advisory. Figma Make remains quota/edit
blocked; this local state and Design Review do not implement the Inventory owner query/projection,
phase capability or commands.

Kitchen Review frame current-state comparison selection (2026-09-23): reopen current editable Figma
frames `51:2`/`51:3`/`51:4` and compare them to a fresh repository route journey. The current frame
renders show the additional-detail explanation crossing its list container at desktop/mobile widths,
and long labels competing with the Unavailable column at 320. Verify the actual repository's current
layout from `e2e/kitchen-queue.spec.ts` at 1440/390/320, inspect its fresh queue/detail captures, then
repair the Review frames only where their responsive composition is demonstrably broken. Preserve
Registry 88.10's exact work-item data hierarchy and every unavailable source/command boundary; do not
copy Design sample Store values or expose missing projection fields. Run only this existing focused
production-fail-closed route journey plus the existing Kitchen component/client tests if code changes.

Kitchen Review frame current-state comparison result (2026-09-23): the fresh existing
`production-fail-closed` Kitchen route journey passed 2/2 at 1440/390/320 and mobile-filter sizes;
all queue/detail/filter captures were inspected. The repository detail layout already fits its source-
available facts and unavailable Registry fields without clipping, so no app-code change was needed.
Regular Figma Design Review frames `51:2`/`51:3`/`51:4` were repaired instead: detail copy now has
room before its unavailable-field list, every list row remains inside its container, and current-work
status cues stack at compact width. Fresh renders at 1440/390/320 were inspected after edits and show
no overlap or clipping. This is an editable Design Review artifact, not a Figma Make edit or Accepted
Screen baseline; Make quota/access and Kitchen owner projection/session/command gaps remain open.

Loyalty Program unavailable-route visual continuation selection (2026-09-23): Screen
Registry `LOY-PROGRAM-LIST` (`/app/customers/loyalty-programs`) and Handoff 88.14 require a Phase 3,
`customer.manage`-scoped program list. Reuse regular Figma Design Review frames `56:2`/`56:66`/`56:123`
to align only the ordinary route's existing unavailable client state. Keep rows, member counts, rules,
Store scope, freshness, search and lifecycle actions unavailable; preserve Permission Denied, Feature
Disabled, Stale, Conflict and Offline states. Acceptance: route shows the Review hierarchy and explicit
source/phase boundary without invented data, retains accessible status semantics, and has no horizontal
overflow at 1440/390/320. Run the existing Loyalty Program render tests, Merchant typecheck and scoped
lint/format; add a focused production-fail-closed route journey only if an existing suitable pattern
can cover this route without introducing a fake data source. No query, capability, owner projection or
command implementation is authorized by this visual slice.

Loyalty Program unavailable-route visual continuation result (2026-09-23): the ordinary list route
now follows Review `LOY-PROGRAM-LIST` hierarchy with separate disabled name/code, status, Store-scope
and scheduled filters; catalog fields, empty state and action boundary are explicit. The existing
client's `FeatureDisabled` result remains visibly a Phase 3 capability gate; `Unavailable` retains
separate projection-not-connected copy. No program/member/points records or commands were added.
Loyalty Program component tests pass 5/5, Merchant typecheck, scoped ESLint and Prettier checks pass;
the fresh production-fail-closed journey passes 1/1 and the 1440/390/320 captures were inspected
with no overflow or clipping. A first journey exposed that the real normal client returns
`FeatureDisabled`; the implementation and assertions were corrected to preserve that state before
final passing checks. This migrates the Review visual hierarchy only; WP-2142 query, authorized
projection/commands and Phase 3 activation remain unresolved.

Dining Figma Review comparison selection (2026-09-23): the editable regular Figma Design file already
contains Dining Review frames `24:2`/`24:60`/`24:109`. Compare those current renders with a fresh
production-fail-closed `/operations/dining` journey at 1440/390/320. Reconcile each visual field to
`DIN-FLOOR-BOARD`, Handoff 88.11 and the normal `StaffDiningTable` source. Preserve current Store/
Table/Session selection, start/recovery/Host Transfer and paid-batch blockers; omit or mark unavailable
Registry owner, elapsed, Order/Payment, reservation/waitlist and attention values if no authorized
field supplies them. Repair the Design Review or route where comparison demonstrates a lower-authority
layout defect, without labelling Review as Make output or Accepted baseline. Inspect all three fresh
screenshots; run only the existing focused Dining production journey and directly affected component
checks if code changes. Store outcomes remain synthetic.

Dining Figma Review comparison result (2026-09-23): fresh `dining-session-start.spec.ts` production-
fail-closed journey passes 1/1. It rechecked the real page hierarchy and existing start/recovery,
filters and permission-denial interactions; fresh 1440/390/320 captures were inspected. The route's
current `StaffDiningTable` values and explicit projection-limit notice already match the authorized
field boundary, so no app-code change was warranted. The regular Figma Review frames `24:60` and
`24:109` had clipped below their third sample card and omitted the mobile Selected table details
empty state. Their canvases now extend through all three clearly non-live sample cards and include
the same initial empty-detail prompt as the route; final 390/320 renders were inspected without text
clipping. The desktop Review render remains the same source-limited hierarchy. This does not claim
Make access/write-back, Accepted Screen status or live Store acceptance; owner, elapsed, Order/payment,
reservation/waitlist and attention projection fields remain unresolved.

Merchant Overview Figma comparison selection (2026-09-23): compare regular Figma Design Review
frames `31:2`/`31:47`/`31:88` with the existing production-fail-closed `merchant-overview.spec.ts`
journey. Preserve the actual session's authorized Store list, selected scope, Store status, business
date/freshness, permission-trimmed navigation and the explicit WP-1905 dashboard boundary. Do not
populate today metrics, tasks or health cards from Review samples while the normal snapshot marks the
dashboard unavailable. Inspect fresh 1440/390/320 screenshots for hierarchy, selectors, nav and
overflow. Repair Review or route only when the comparison proves a source-supported difference; keep
scope selection authenticated and Store-bound. Browser fixture values remain synthetic.

Merchant Overview Figma comparison result (2026-09-23): the existing production-fail-closed
`merchant-overview.spec.ts` journey passes 1/1, verifies the selected authorized Store, session-provided
status/freshness/navigation, no Kitchen link without permission and the WP-1905 dashboard boundary;
its fresh 1440/390/320 screenshots were inspected. The local shell, scope selector and four dashboard
areas match the source-limited Review hierarchy and reflow without horizontal overflow, so no app edit
was justified. Figma Review dates and Store state remain sample values; the journey's authorized Stores
are synthetic intercepts, not actual authorization or Store evidence. Today's metrics/tasks/health stay
unavailable pending WP-1905's authorized projection.

Private Make project access and editing recheck (2026-09-23): reopened the current private Make
project in Chrome. Its Operations/Dining preview and Version 29 project history load; the UI shows
“Sign up to use Figma Make,” with the prompt, context, build mode, model and Send disabled. The
Figma design-context tool now returns source-file resource links, including DiningWorkspace, but
the linked `file://figma/make/source/...` URI fails with `Unknown resource` at the MCP resource
reader, so current component source bodies were not read through that path. This confirms readable
preview content and an unproven/unavailable editor session; it does not justify saying Make source
code was reviewed or edited. No signup, source write, publish or share occurred. The separate
regular Design file remains editable and is the source of Review frames only.

Private Make access recheck correction (2026-09-24): reopened the same private Make project in
Chrome. Its preview, Version 29 conversation and Code view load without a sign-up gate. The actual
`src/components/DiningWorkspace.tsx` TypeScript source is readable in the Make code editor; the
MCP source-resource link still returns `Unknown resource`, so source access is through the visible
editor only. The selected `index.html` source pane is explicitly settable, confirming that a manual
edit control is available; no source text was changed, so save/reload persistence remains unverified.
The AI prompt, context and Send controls are disabled, and the project states that team AI credits
reset Sep 30. This supersedes the earlier “Sign up” observation. No Make content, publish state or
share setting was changed. The Design Review file remains the verified route for current editable
visual work.

Verification selection: this is an access-status documentation correction. Recheck the current
Chrome UI evidence, ensure the paragraph distinguishes visible source read, untested manual write,
disabled AI generation and unchanged publication/sharing, then run Markdown formatting and
`git diff --check` on this WP. No application or business suite applies.

Dining Make Preview comparison verification selection (2026-09-24): a fresh Chrome session can now
read the private Make Code view and standalone `/operations/dining` preview. Compare its current
shared Operations shell, floor filters and area-grouped table-card hierarchy against
`DiningSessionWorkspace` and Review frames `24:2`/`24:60`/`24:109`. Make's 11 demo tables include
fictional Session IDs, elapsed minutes and attention markers; preserve only fields supplied by the
authorized `StaffDiningTable` projection, and do not reproduce those sample values or controls.
Re-run the existing production-fail-closed `dining-session-start.spec.ts` journey, inspect its fresh
1440/390/320 screenshots against the current Make preview, and make only source-supported visual
corrections. Browser rows remain synthetic; no Dining command, API, phase, Store, Make source,
publication or sharing behavior is authorized by this comparison. The current app already uses a
soft blue linked-Session tint and green Available tint; only the `TemporarilyBlocked` tint is gray
while the Make Preview expresses its distinct Blocked state with muted violet. Style that supported
projection value as restrained violet without changing its source-state text or action eligibility.
Re-run the same browser journey, inspect 1440/390/320, and check formatting/whitespace; no data or
command assertions need to change.

Purchase Order list Figma Review migration selection (2026-09-23): add `PROC-PO-LIST` desktop/mobile/
compact Review frames to the existing Operations Queues Design file, then align only the ordinary
list route's `Unavailable` projection state. Handoff 88.13 / WP-2134 define Brand + Buyer/Store
scope, three separate status dimensions, registered filters, permission-trimmed cost/receipt/
discrepancy fields and explicit Issue ownership; the normal route still uses
`unavailablePurchaseOrderClient`. Keep every field and filter unavailable and show no example PO,
Supplier, money, receipt or discrepancy facts. Verify the production-fail-closed route at
1440/390/320 with disabled-filter and zero-overflow assertions and inspect every fresh capture;
run Merchant typecheck, targeted ESLint/Prettier and `git diff --check`. Do not change Procurement
queries, Commands, WP-2134 gates, or accepted permission semantics.

Purchase Order list Figma Review migration result (2026-09-23): created editable regular Figma Design
frames `82:2`/`82:44`/`82:83` at 1440/390/320, reusing the existing dark Operations header, Inter
type, neutral status/filter cards and amber source-boundary notice. The normal list route now uses
that hierarchy only for `Unavailable`, with a no-records state, disabled registered filters and
independent cost/Supplier-response/receipt/discrepancy wording; other list/detail/editor result
states remain unchanged. The fresh production-fail-closed route journey passes 1/1, asserts all
four filters disabled, no sample money/order references and no document overflow, and captures all
three widths. Visual inspection found readable hierarchy and no clipping/overflow. Purchase Order
page component tests pass 4/4; Merchant typecheck, scoped ESLint, Prettier and `git diff --check`
pass. No Procurement query/Command or WP-2134 acceptance is implied; all data remains unavailable.

Kitchen Review detail spacing and fresh route verification (2026-09-23): reran
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/kitchen-queue.spec.ts
--project=production-fail-closed`; both cases passed. Inspected the resulting 1440/390/320 queue and
detail captures plus 390/320 filter sheets. The real route remains source-limited and read-only for
the synthetic intercept: station labels, claim, course/priority, SLA, allergen acknowledgement,
timers, dependencies/history and named KDS lock facts remain unavailable. Its responsive queue,
filter and item detail states show no horizontal overflow or clipping. Regular Figma Design Review
detail frames `51:3`/`51:4` had their “Sample data for design review” note frame height increased
from 20 to 28 px so the read-only notice has an 8 px separation; re-rendered both final frames and
inspected the full 390/320 canvases. This is a Review-only spacing repair, not a Make source edit,
Accepted baseline, real Store fixture or Kitchen feature acceptance. No application code changed.

Kitchen mobile brand-label Figma parity verification selection (2026-09-23): fresh Review nodes
`4:86` and `4:128` label the mobile shell `BOP / KITCHEN`, while the local queue still displayed
`BOP / OPERATIONS` at 390/320. Registry assigns the route to Operations at navigation level 1 and
`KIT-KITCHEN-QUEUE` at level 2, so preserve the Operations heading in the accessibility tree and on
desktop while matching the mobile brand label to the route. Do not change selected Store scope or
mobile work-item detail shell. Acceptance question: is the mobile brand label source-supported and
visible at both widths, with Operations still the accessible shell heading, unchanged desktop label,
and no responsive overflow? Affected inputs are `AppFrame.tsx`, Kitchen queue callsite/styles,
`KitchenBoardPages.test.tsx`, and `kitchen-queue.spec.ts`. Run focused render tests, the existing
production-fail-closed Kitchen browser journey with all three widths and screenshot inspection,
Merchant typecheck, scoped ESLint/Prettier and `git diff --check`. Existing intercepted queue data
remains synthetic; this is visual parity only.

Kitchen mobile brand-label Figma parity result (2026-09-23): `AppFrame` now accepts an optional
mobile brand label; the queue supplies `KITCHEN`, while the Operations shell title remains visually
and accessibly `OPERATIONS` on desktop and remains in the accessibility tree on mobile. The label is
decorative, so it does not replace Screen ID/navigation semantics, the Store label, or the child
Work Item shell. Focused Kitchen render tests pass 8/8 and Merchant typecheck, scoped ESLint,
Prettier and `git diff --check` pass. The existing production-fail-closed browser journey passes
2/2; it verifies the responsive label at 390/320 and Operations at 1440, captures all three widths,
and confirms no horizontal overflow. Fresh screenshots were inspected. This aligns the two mobile
Review frames `4:86`/`4:128`; it is not an Accepted baseline, Make edit or live Store acceptance.

Report Run History Figma Review verification selection (2026-09-23): the Owner's current
whole-project direction explicitly includes continued Figma design work. Add `RPT-RUN-HISTORY`
Review frames to the existing Operations Queues Figma Design file, reusing the Reporting Catalog
frames `41:2`/`41:60`/`41:103` and current repo Inter/neutral/card patterns. Handoff 88.15, Registry,
and WP-2162 govern the boundary: preserve the Run/status/date/requester/trigger filter names and
registered data-column hierarchy, but show no run rows, opaque references/digests, requester IDs,
storage URLs or permission-gated action affordances while the normal route's authorized query is
unavailable. The repo should render this source-limited visual only for its existing `Unavailable`
state; retain the other universal state panels. Acceptance question: do the Review frame and ordinary
unavailable route agree at 1440/390/320, keep all unsupported filters disabled and show a truthful
empty/unavailable state without implying a query, permission or command? Affected inputs are
`ReportRunHistoryPage.tsx`, its component tests, scoped Merchant CSS, this WP and a focused browser
journey. Run those render/route checks, Merchant typecheck, scoped lint/Prettier and `git diff
--check`; inspect all three screenshots. Figma action is limited to the editable regular Design
Review file and is authorized by this Owner request; no Make edit, publication, share change or
WP-2162 business/query/action implementation is part of this visual slice. Test response data remains
synthetic and must not be rendered in the unavailable route.

Report Run History Figma Review and repository result (2026-09-23): added `RPT-RUN-HISTORY`
Review frames to the existing editable Operations Queues Design file:
[`90:2` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=90-2),
[`90:3` mobile 390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=90-3), and
[`90:4` compact 320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=90-4). The mobile
canvases were extended to contain their complete layouts. The normal route now renders the matching
source-limited hierarchy only when its existing client returns `Unavailable`: BOP/Operations header,
six disabled filters, eight registered run fields and an explicit no-rows/unavailable message. Other
typed states and found-run rendering are unchanged; no sample run, permission, digest, requester,
artifact or action data is introduced. The component suite passes 13/13, Merchant typecheck and
scoped lint/Prettier pass, and the fresh production-fail-closed browser journey passes 1/1 with
inspected 1440/390/320 screenshots and no horizontal overflow. The Vite preview repeats the existing
greater-than-500-kB chunk advisory. The regular Design Review and local route parity do not connect
the authorized Reporting projection/commands or complete WP-2162, and do not change the private Make
access/editing gap or accepted Screen baseline.

Report Builder Design Review verification selection (2026-09-23): Screen Registry `RPT-REPORT-BUILDER`,
Handoff 88.15/88.22–88.30 and WP-2161 define a Phase 3 builder over authorized versioned
Dataset/Metric inputs, constrained dimensions/filters/sort/visualization/row limit, scope policy and
schedule/delivery. The normal route's client rejects `Unavailable`; its generic panel omits that
field hierarchy. Extend the regular Operations Queues Design Review and align only the normal
route's existing `Unavailable` state. Do not render route IDs, sample definitions, source versions,
preview counts, permission affordances, or enabled controls. Preserve the other universal states and
the existing found-view rendering. Acceptance question: do desktop and 390/320 Review/code views
name all registered inputs and clearly gate Phase 3 authoring without implying authorized values,
preview, certification or schedule? Affected inputs: `ReportPages.tsx`, its tests, Merchant styles,
focused browser journey, this WP and the project completion review. Run focused Report pages tests,
Merchant typecheck, scoped lint/Prettier, production-fail-closed journey at 1440/390/320 with
screenshot inspection, then `git diff --check`. This is explicitly authorized regular Design Review
and local visual work only; no Figma Make, WP-2161 business/API/query/command implementation,
publication, sharing, or acceptance-baseline change. Existing synthetic found-view fixtures must not
appear on the normal unavailable route.

Report Builder Review result (2026-09-23): created regular Design Review frames
[`96:90` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=96-90),
[`96:174` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=96-174), and
[`96:258` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=96-258) in the existing
Operations Queues Design file. The 320 render exposed and prompted fixes for notice-text overlap and
validation-field overflow before migration. `ReportBuilderPage` now uses the corresponding
source-limited hierarchy only for `Unavailable`; all 21 registered inputs are disabled, no report
identity/values or enabled actions are shown, and the existing Found plus other typed states remain
unchanged. Focused Report page tests pass 14/14, Merchant typecheck and scoped lint/Prettier pass,
and the fresh production-fail-closed browser journey passes 1/1 with inspected 1440/390/320
screenshots and no horizontal overflow. Preview build retains the existing >500-kB chunk advisory.
This Review does not implement WP-2161's authorized reads, validation, preview or commands, enable
Phase 3, or change the private Make access gap or Accepted Screen baseline.

Kitchen Figma operator-status consistency verification selection (2026-09-23): fresh renders of
Review frames `4:2`/`4:86`/`4:128` show desktop and 320 saying “KDS session verified” while their
read-only explanation says the active session/device lock cannot be verified; 390 already says
“KDS session unverified.” Current API queue/detail responses explicitly return `operatorStatus:
Unverified` until an owner-backed active KDS source exists, and the local page renders that status.
Correct only the contradictory regular Design Review text to `KDS session unverified`; retain
read-only actions, existing queue sample labels/data, and all Registry/source gates. Acceptance:
all three Figma frames must show the same unverified KDS state and render without clipped text;
inspect fresh Figma screenshots and retain the existing repository Kitchen journey/screenshots
because application code and browser behavior are unchanged. Do not edit Make, the Accepted
baseline, KDS Domain/command sources, or production readiness claims.

Kitchen Figma operator-status consistency result (2026-09-23): the apparent mismatch was a
low-resolution reading error, not a source defect. The current text node `4:20`, plus fresh
1440/390/320 renders of `4:2`/`4:86`/`4:128`, all read `KDS session unverified`; no Figma edit
was made. The current production-fail-closed `kitchen-queue.spec.ts` journey passes 2/2 and its
fresh queue, command, detail and mobile-filter screenshots were inspected. The ordinary route
renders `Unverified`/read-only and has no horizontal overflow at 1440/390/320. The command-board
capture labelled `Named operator` is an intercepted synthetic command test state only; current
API composition still returns `Unverified` until the owner-backed active KDS Session/device-lock
source and server command fence exist. The Vite preview retains its existing greater-than-500-kB
advisory. No application or Figma content changed; Store, named-operator and production acceptance
remain unproven.

Privacy Request Design Review verification selection (2026-09-23): Screen Registry
`PRIVACY-REQUEST`, Handoff 88.14 and WP-2146 define a Phase 3, `compliance.manage`-scoped
workflow with requester/verification, rights type, scope, due date, holds/exceptions,
owner-data collection, fulfillment/denial and audit. The normal route's default client
returns `FeatureDisabled`; the current state is a generic `StatePanel` that omits the
registered field/filter hierarchy. Adapt the existing editable Operations Queues Design
Review language to that `FeatureDisabled` state only. Show registered filters as disabled
and no case, contact, legal, hold, export or audit data; keep owner Commands disabled and
preserve the Phase 3 capability gate. Retain all other typed states and Found rendering.
Acceptance question: do Design Review and local Phase 3 disabled route present the same
source-limited hierarchy at 1440/390/320, with no private data, enabled actions or overflow?
Affected inputs are `PrivacyRequestPage.tsx`,
its tests, scoped Merchant CSS, focused browser journey, this WP and the project completion
review. Run focused render tests, Merchant typecheck, scoped lint/Prettier, the
production-fail-closed browser journey at 1440/390/320 with screenshot inspection, then
`git diff --check`. This is regular Design Review and local feature-gate parity only;
no Figma Make edit, publication, sharing, WP-2146 query/command implementation, or Accepted
Screen baseline change. Synthetic Found fixtures must not appear on the normal route.

Privacy Request Figma Review and repository result (2026-09-23): added editable regular
Design Review frames [`101:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=101-213),
[`101:277` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=101-277), and
[`101:334` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=101-334) to the existing
Operations Queues Figma page, adapting its neutral shell and Review hierarchy. A first fresh render
revealed that the ordinary route defaults to `FeatureDisabled` because the Screen is Phase 3; the
frames and migration were corrected to preserve that gate. The ordinary route now shows the
registered disabled search/filter fields, request workflow columns and explicit disabled owner
actions only for that state. Other typed states and found-view rendering remain unchanged; no case,
contact, legal/hold, export or audit fixture is shown. The Privacy Request component suite passes
5/5, Merchant typecheck, scoped ESLint/Prettier and `git diff --check` pass, and the fresh
production-fail-closed browser journey passes 1/1 with inspected 1440/390/320 screenshots and no
horizontal overflow. Production preview retains the existing greater-than-500-kB chunk advisory.
This visual migration does not connect WP-2146's authorized query or Commands, enable Phase 3, alter
Figma Make or change Accepted Screen status; screenshot fixture context is synthetic.

Dining visual journey refresh (2026-09-23): following the Owner's direction to continue the whole
project with Figma-derived design, reran the existing `dining-session-start.spec.ts` production-
fail-closed journey after rechecking that the Dining Figma Review and repository alignment was
already implemented. The journey passes 1/1 and freshly captures 1440/390/320; all three images were
inspected. The Operations shell, source-limit callout, table filters/cards and selected-table start
flow remain aligned and fit their viewports. The captured table/Store outcomes are synthetic, and
owner, elapsed, Order/Payment, reservation/waitlist and attention facts remain absent. No code or
Figma change was justified by this rerun; private Make editing and full-project gates remain open.

Kitchen Figma supported-field parity verification selection (2026-09-23): compare current Review
frames `4:2`/`4:86`/`4:128` with the current `kitchen-queue.spec.ts` production-fail-closed journey.
Verify presentation for only fields the current authenticated `kitchen_work_queue_v1` response
actually supplies (item label, state, created/projected time, quantities, lifecycle metadata and
operator status); retain explicit unavailability for station labels, allergen/exception values,
course, priority, SLA, safe public references, named KDS session/device lock and Hold/Prioritize.
Do not copy Review sample lanes/counts/items into the ordinary route. Inspect fresh 1440/390/320
screenshots and keyboard/focus states; make only supported visual-parity fixes, then run directly
affected Kitchen tests, Merchant typecheck, scoped lint/format and `git diff --check` if code changes.

Kitchen Figma supported-field parity result (2026-09-23): the current regular Design Review frames
were read through `get_design_context` with fresh screenshots. On the repository queue and detail
cards, supported fields now follow the visible hierarchy: item label, a horizontal lifecycle/status
and age row, then a separated `Quantity` label/value row before safety cues. The Quantity markup uses
`dl`/`dt`/`dd`; the browser assertion now checks its label and value separately. This does not add
sample station names, Review allergen/exception values, course, priority, SLA, references or named KDS
state; the current client continues to map unsupported fields to unavailable and the lock keeps
commands disabled. `KitchenBoardPages.test.tsx` passes 8/8, Merchant typecheck, targeted ESLint,
Prettier and `git diff --check` pass; the production-fail-closed Kitchen route journey passes 2/2.
Fresh 1440/390/320 queue and detail screenshots were inspected with no clipping or horizontal
overflow. Playwright's preview build retains the existing >500 kB chunk advisory. Review frames and
the synthetic browser journey are not Accepted Screen, live Store/KDS session or production proof.

Dining Figma visual comparison result (2026-09-23): the private Make project `High-Fidelity
Restaurant Order Prototype` is currently reachable in the browser. Its Dining preview and Version 29
conversation load, and Code view exposes readable `src/components/DiningWorkspace.tsx`; the MCP
resource URI still returns `Unknown resource`. The Make editor appears editable, but source write and
persistence were not verified; prompt/build controls are disabled until the team Education AI credit
reset on Sep 30. No Make content, publication or sharing settings were changed. The source-informed
Dining Review visual hierarchy was compared with the normal repo route. Only the supported
`TemporarilyBlocked` tile tint changed to muted violet (`#f5f2fb` with `#ddd2ec` border), matching
the existing available/session visual vocabulary without changing state names, selection or actions.
The ordinary route still omits Make-only session IDs, elapsed time, attention markers and other
unsupported facts. The production-fail-closed Dining journey passes 1/1; fresh 1440/390/320
screenshots were inspected with no horizontal overflow; Prettier and `git diff --check` pass. The
preview emits its existing greater-than-500-kB chunk advisory. Store/table values in the browser
capture are synthetic. Make write/persistence, accepted-screen review, authoritative live projection
coverage and full project/pilot acceptance remain open.

Kitchen current-Figma visual parity verification selection (2026-09-23): re-read the regular
Operations Queues Review frames `4:2`, `4:86`, and `4:128` through `get_design_context` and compare
their Queue, read-only KDS lock, station lanes, work-item field order, filter affordance, and
responsive layout with `KIT-KITCHEN-QUEUE`/`KIT-WORK-ITEM`, the current projection, and the normal
route. Keep only source-authorized values; in particular, the current `kitchen_work_queue_v1` view
has an opaque station reference but no safe station label, and reports structured allergen,
exception, course, priority and SLA assistance unavailable. Do not promote Review sample lanes or
items to app data or render opaque references. Acceptance question: does the route preserve the
Review hierarchy for fields present in its validated view at 1440/390/320, with accurate unavailable
and KDS-unverified/read-only states and no horizontal overflow? Run the existing
`kitchen-queue.spec.ts --project=production-fail-closed` journey, inspect its fresh Queue, detail,
and filter-sheet captures; run `KitchenBoardPages.test.tsx`, Merchant typecheck, scoped ESLint,
Prettier and `git diff --check`. These
captures use intercepted synthetic DTOs and are visual/UI evidence only, not projection, Store,
operator-session, Accepted Screen, or production evidence. No Make edits, business data changes,
commands, permissions, Domain or projection changes are in this visual slice.

Kitchen Figma visual parity result (2026-09-23): the refreshed Figma Review screenshots at
`4:2`/`4:86`/`4:128` confirm white workbench canvas, compact mobile header, Fresh/KDS-unverified
status, refresh and filter placement, locked-board explanation, station lane and item-field order.
The route now uses the white desktop canvas, omits the redundant visible `projectedAt` line while
retaining that exact projection time to calculate item age, shows `Refresh` at 390px and the full
`Refresh from source` label at 320px, and tightens mobile spacing to match the Review frames. The
refresh button keeps the accessible name `Refresh from source`; no freshness, scope, route or action
semantics changed. The production-fail-closed Kitchen browser journey passes 2/2, including fresh
1440/390/320 Queue and detail renders, 390/320 filter sheets, keyboard operation and responsive
label assertions; all screenshots were inspected and show no horizontal overflow. The Merchant
Vitest command passes 106 files/772 tests, TypeScript and scoped ESLint pass, and Prettier plus
`git diff --check` pass. The first sandbox browser-server bind returned EPERM; the same existing
journey passed when run with the required local loopback permission. Its Vite preview emits the
existing >500-kB chunk advisory. Browser payloads are synthetic: production projection still lacks
a safe station display label, structured allergen/exception assistance, course, priority, SLA, and
owner-backed named KDS Session/device lock. Those fields remain unavailable and actions stay
read-only. This is repository visual implementation evidence, not Accepted Screen, real Store/KDS,
external UAT, or production readiness evidence.

The fresh comparison found that the implementation displayed an extra projected-at timestamp and
long refresh label on 390px, pushing the filter and lock hierarchy below the Review layout; the
desktop workbench canvas also used gray instead of white. The scoped fix removes only the redundant
visible timestamp (projectedAt remains the source for item age), uses the Review's short Refresh label
at 390px and full label at 320px, tightens the mobile heading spacing, and sets the Kitchen canvas to
white. Verify the visual changes in that same journey; preserve the accessible refresh name and all
source, scope, state, and action behavior.

Catalog Menu list Figma Review selection (2026-09-23): extend the existing editable Operations
Queues Design Review with `CAT-MENU-LIST` at 1440/390/320, reusing the Reports/Privacy hierarchy,
Inter typography and neutral cards. Registry 88.8 and WP-1802 require Brand/Store-scoped authorized
Menu facts, status/scope/channel/version/effective period/validation and safe filters; the normal
`MenuListPage` client remains unavailable. Show disabled registered search/filters, no sample Menu
rows or identifiers, and explicit unavailable scope/channel/effective-period/sections/validation
fields. Align only the normal route's `Unavailable` state; retain its Found rendering and all other
typed states. Acceptance: Figma and normal route match at 1440/390/320 with no overflow or implied
data/actions. Affected inputs are `CatalogMenuPages.tsx`, its tests, scoped Merchant CSS, a focused
production-fail-closed browser journey, the Design Review file and this WP. Run the focused component
tests, Merchant typecheck, scoped lint/Prettier and journey, inspect all screenshots, then check
`git diff --check`. No Catalog Domain/API/query/Command, permission, WP-1802 authority, Make edit,
publication, sharing or accepted Screen change is in scope.

Private Make access recheck (2026-09-23): reopened the current private Make URL in Chrome. The
Operations/Dining preview and Version 29 history load; a fresh design-context request returns the
current Make source-file resource list, including `DiningWorkspace.tsx`, but does not return those
resource bodies in that response. Figma account lookup reports a Full seat/admin role on the
`yashirq's team` Education plan. The Make page says team AI credits are exhausted until Sep 30 and
its prompt/context/build/model/Send controls are disabled. This confirms current preview/source-list
readability and the quota gate; direct source edit permission and save persistence remain unverified.
No Make edit, publication or share-setting change occurred.

Catalog Menu list Figma Review and repository migration result (2026-09-23): added editable regular
Design Review frames [`111:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=111-213),
[`111:214` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=111-214), and
[`111:215` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=111-215). The normal
`/app/commerce/menus` route now renders the matching unavailable state with disabled Registry
filters and Create Menu, registered field hierarchy, and no sample Menu/Store/business facts. Found
rendering and every other typed state are unchanged. Focused Catalog menu component tests pass 4/4,
Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass; the production-fail-closed
browser journey passes 1/1 at 1440/390/320. Fresh Figma and browser captures were inspected; all three
widths fit without horizontal overflow. The preview build retains the existing >500 kB chunk
advisory. This is local visual parity only; WP-1802's authorized Menu query/BFF and Command envelope,
Catalog data, UAT and Accepted Screen status remain open.

Inventory Item List Figma visual continuation selection (2026-09-23): Screen Registry
`INV-ITEM-LIST` (`/app/supply/items`) and WP-2120 define a Phase 2, `inventory.manage`-scoped
master list whose identity fields belong to Inventory while quantity and reorder facts require a
single authorized Store/Site/Location scope plus freshness from Ledger. The ordinary page currently
uses a generic error panel when `unavailableInventoryClient` rejects. Add regular Design Review
frames in the existing Operations Queues file at 1440/390/320, then align only this route's
`Unavailable` state: disabled registered search/filter and list headings, no Item/Store/quantity/
supplier/usage/history sample facts, explicit phase/source boundary, and no enabled actions. Preserve
Found rendering and all other typed states. Acceptance: the Review and normal route show the same
source-limited hierarchy without clipped text or horizontal overflow. Affected inputs are
`InventoryPages.tsx`, its render tests, scoped Merchant CSS, a focused production-fail-closed browser
journey, Figma frames and this WP. Run focused component tests, Merchant typecheck, scoped ESLint /
Prettier, the journey with fresh 1440/390/320 screenshots, inspect captures, and `git diff --check`.
No WP-2120 API/projection/domain/command, phase activation, Make edit, publication or Accepted Screen
change is in scope.

Inventory Item List Figma Review and repository migration result (2026-09-23): added editable regular
Design Review frames [`118:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=118-213),
[`118:257` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=118-257), and
[`118:308` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=118-308). The first
mobile render exposed oversized filter-card whitespace; adjusted the filter heights and following
section positions, then reinspected fresh renders at all three widths. The ordinary `/app/supply/items`
route now presents the matching Phase 2/source boundary, disabled search/filters/Create Item and
unavailable Item/Store/quantity/reorder/usage/supplier/history hierarchy only when its normal client
returns `Unavailable`. Found rendering and all other typed states remain unchanged; no Item or Stock
facts were fabricated. `InventoryPages.test.tsx` passes 7/7, Merchant typecheck, targeted ESLint,
Prettier and `git diff --check` pass, and the production-fail-closed browser journey passes 1/1 with
fresh inspected 1440/390/320 captures and no horizontal overflow. The preview build retains the
existing greater-than-500-kB advisory. WP-2120's authorized Inventory query, explicit Store/Site/
Location-scoped Ledger projection/freshness, phase capability and owner commands remain unconnected;
these frames are regular Design Review, not Figma Make edits, Accepted Screen or project completion.

Kitchen current-state revalidation selection (2026-09-23): re-read current Figma Review frames
`4:2`/`4:86`/`4:128` and compare against the current API query, `kitchen_work_queue_v1` DTO mapper,
Screen Registry `KIT-KITCHEN-QUEUE`/`KIT-WORK-ITEM`, current Merchant implementation and browser
journey. The API returns projection-backed item label, lifecycle, quantities, timestamps and
operator status; the client deliberately sets station label, allergen/exception data to unavailable.
Keep course, priority, SLA, safe public references and owner-backed KDS session/device-lock unavailable.
Acceptance: these fields retain the Figma hierarchy at 1440/390/320, with no fabricated values,
read-only actions or overflow. Since the shared stylesheet and current workspace contain additional
uncommitted edits, freshly run the existing Kitchen component tests, Merchant typecheck, scoped lint /
Prettier and `kitchen-queue.spec.ts --project=production-fail-closed`; inspect all fresh route/detail/
filter captures and then `git diff --check`. Reuse no prior test result for this current run. No Make,
Domain, projection, permission or business-data change is in scope.

Kitchen current-state Figma/source revalidation result (2026-09-23): reopened Review frames
`4:2`/`4:86`/`4:128`; the current screenshots retain the Fresh and KDS-unverified header, disabled
board explanation, responsive Refresh/filter placement and item hierarchy. Re-read `createMerchantKitchenQuery`,
`createKitchenBoardClient` and `KIT-KITCHEN-QUEUE`/`KIT-WORK-ITEM`: authorized queue data supplies
item label, lifecycle, created/projected time and quantities; the client continues to omit opaque
station references and maps allergen/exception fields to Unavailable. Local route screenshots now
show the matching hierarchy and source boundary at 1440/390/320, with only source-available fields;
no display or business-code change was warranted. Fresh focused component/client tests pass 22/22,
Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass, and the current
production-fail-closed browser journey passes 2/2. Queue, detail and 390/320 filter-sheet captures
were inspected and have no horizontal overflow or clipping. The Vite preview retains the existing
large-chunk advisory. Playwright input is synthetic and does not prove a live Store, named operator,
KDS lock, real station labels, safe public references, course/priority/SLA, command authorization,
Accepted Screen or production readiness. No new Kitchen code or Figma content changed.

Cross-slice exact-worktree regression selection (2026-09-23): current uncommitted inputs span
Kitchen API/query and projection client, Customer PWA receipt/order-status lifecycle, Merchant routing
and multiple screen implementations, Recipe admin persistence read code/database acceptance, and
shared database-ownership tooling. Acceptance question: do existing repository guidance, ownership /
architecture contracts, component and integration tests, type/lint/format checks, Screen Registry and
package builds pass together against this exact worktree? Run the repository's existing `CI=true pnpm
verify` aggregation once; do not add tests or bypass individual failures. Inspect and classify any
failure as product or environmental from its exact output. This is broad local regression evidence,
not real Store/Provider/device/UAT, accepted-screen, release approval or production-readiness evidence.

Cross-slice exact-worktree regression result (2026-09-23): repository guidance, module manifest,
module generator (17/17), import boundaries (22/22), database ownership (1087/1087), database
permissions (23/23), domain boundaries (57/57), migration catalog/config (109/109), database
foundation/helpers, OpenAPI, event catalog and formatting passed. The first `CI=true pnpm verify`
stopped in tests with 114 failures/1956 passes and localhost `listen EPERM`; an elevated retry first
selected pnpm 11.25.0 (the manifest requires 11.13.0), then was rerun with `.local/activate.sh` and
finished tests with 110 failures/1960 passes. The retry removed the localhost EPERM but local pilot
installation/workload/process fixtures remained unavailable or failed, and a pilot maintenance
exclusion case timed out. Consequently the aggregate stopped before Screen Registry, and package
build did not run. This is an unresolved exact-worktree regression, not a passing full-project gate;
do not claim its unavailable local pilot prerequisites as application defects or as completed. The
focused affected-slice tests, Kitchen browser journey, Merchant typecheck/lint/format and inspected
responsive captures recorded above remain separate passing evidence.

Cross-slice remaining contract/build checks (2026-09-23): because the aggregate stopped at its
failing test stage, ran the existing `CI=true pnpm screen-registry:check && CI=true pnpm build`
against this exact worktree. Screen Registry validation passes with 210 Section 88 records; all 41
workspace builds pass (37 Turbo tasks reused valid matching cache entries, four tasks executed).
The affected API/UI/Merchant/Customer PWA build tasks executed; Merchant retains the existing
greater-than-500-kB chunk advisory. This does not turn the incomplete `pnpm verify` into a pass or
cover Store/Provider/device/UAT, Accepted Screen, release or production readiness.

Catalog Menu Builder visual continuation (2026-09-24): added regular Design Review frames
`123:213`/`123:264`/`123:310` in the Operations Queues Figma file for 1440/390/320. They use the
Commerce/Inter hierarchy and show identity/scope, section and placement workspace, validation rail,
and publish workflow while keeping authorized Menu values and commands unavailable. The normal
`CAT-MENU-BUILDER` unavailable state now follows that hierarchy and does not expose the route's Menu
reference or fabricate Sections, placements, validation or publish evidence. Merchant component
tests pass 776/776, typecheck and lint pass, and the production preview browser run passes 82/82
existing `@demo`/`@production` journeys, including this route's 1440/390/320 no-overflow checks.
Fresh screenshots were inspected. The preview retains the existing greater-than-500-kB chunk
advisory. This is regular Design Review/local UI parity only; normal authorized Catalog browser
composition, live/UAT evidence, Accepted Screen and full-project completion remain open. Private
Make source edits/persistence are still unverified and its AI generation controls remain exhausted
until the displayed September 30 reset.

Cross-slice verification continuation before the Menu Builder visual edits (2026-09-24): frozen
installation and all 41 workspace build, format, lint and typecheck tasks passed in the Linux
verification container; repository
guidance, ownership/permission/domain checks, migration catalog/config, database foundation/helpers,
OpenAPI/event catalog and Screen Registry (210 records) passed. Root Vitest ran against the
container-local Linux copy of this exact checkout with `.local` present: 110 files / 2070 tests
passed for that pre-UI snapshot. A separate full `CI=true pnpm verify` run against the macOS shared bind-mounted copy stopped
at root Vitest with 7 failures / 2063 passes in three pilot recovery files; the isolated failures
involved owner/takeover evidence checks and require continued triage on that filesystem. Since the
aggregate stopped at Vitest, its Turbo package test and acceptance stages did not run; no full
`pnpm verify` pass is claimed. Local browser/UI and build results remain separate from live Store,
Provider, device, UAT, Accepted Screen, release or production readiness.

Recovery-test failure classification follow-up (2026-09-24): reran the three owner/resume/takeover
files from the native macOS checkout after the prior aggregate failure: 38/38 failed. The owner
boundary explicitly rejects non-Linux execution (`process.platform !== "linux"`), and nested
maintenance recovery expects the supported Linux process/`/proc` environment. This confirms the
native macOS result is not a valid product-failure signal. The previously recorded container-local
Linux root Vitest run passed 110 files/2070 tests on its pre-UI snapshot, while Docker control is
currently unavailable from this task sandbox (`docker ps` permission denied). The exact-final-tree
Linux aggregate remains missing; preserve `pnpm verify` as unresolved rather than weakening Linux
recovery guards or claiming current full-suite acceptance.

Kitchen source-complete filter safety selection (2026-09-24): current `kitchen_work_queue_v1` does
not provide Station display labels, allergen cues or exception state. The Merchant client maps the
latter two to `Unavailable`; previously the enabled controls still accepted `None`/`Reported` and
could hide valid work as an empty result. Disable each projection-field filter unless every loaded
item has that field, normalize any restored unsupported filter to `All`, and label its unavailable
state. Keep Work state filtering and known-field fixture behavior intact. Verify focused Kitchen
render/client/parser tests, typecheck, scoped lint/Prettier, and the existing production-fail-closed
Kitchen queue/detail/browser journey at 1440/390/320; inspect refreshed queue, filter-sheet and detail
screenshots. This is UI source-boundary behavior only; do not expand the projection or imply Make,
Store, KDS-session, Accepted Screen or production acceptance.

Kitchen source-complete filter safety result (2026-09-24): Station, allergen and exception controls
now remain disabled when any loaded item lacks the corresponding value; unsupported restored
allergen/exception selections are normalized to `All`, while Work state filtering and fully sourced
component-fixture cues remain available. Desktop and mobile copy identifies unavailable fields. The
focused Kitchen tests pass 23/23, Merchant typecheck and scoped ESLint/Prettier pass, and the
production-fail-closed Kitchen journey passes 2/2 after the initial sandbox loopback attempt was
re-run with approved local access. Fresh 1440/390/320 queue/detail plus mobile filter-sheet captures
were inspected without horizontal overflow or clipping; the production preview retains its existing
greater-than-500-kB advisory. Test responses are synthetic. Owner projection additions, real Store /
named KDS session and device lock, remaining Registry fields, full `pnpm verify`, Accepted Screen,
live/UAT and production gates remain unresolved.

Exact-snapshot Linux verification continuation (2026-09-24): prepared the current repository
snapshot in a disposable container-local Linux filesystem, installed with the pinned lockfile using
`pnpm install --frozen-lockfile`, and ran `CI=true pnpm verify`. Repository guidance, module and
ownership/permission/domain checks, migration catalog/config, database foundation/helpers,
OpenAPI/event catalog, Screen Registry (210 records), formatting, lint and the root Vitest suite
(110 files / 2070 tests) passed. All 41 Turbo package test tasks also passed. The aggregate then
stopped at `pnpm audit-record:acceptance` because that container has no `docker` executable
(`spawn docker ENOENT`); database acceptance and the aggregate's final build stage did not run.
This is a verification-environment gap, not a database acceptance result. Keep full `pnpm verify`
unresolved. The separate earlier 41/41 build evidence predates the latest Kitchen UI change and is
not a fresh build of this exact snapshot.

Purchase Requisition list visual continuation selection (2026-09-24): Screen Registry
`PROC-REQUISITION-LIST` (`/app/supply/requisitions`) and Handoff Section 88.13 define Phase 3
requester/scope/need/line/urgency/approval/allocation facts and filters. Its normal page currently
defaults to `unavailableRequisitionClient` and renders only the generic state card. Extend the
editable Operations Queues Design Review at 1440/390/320 using its Operations header, Inter type,
neutral cards and amber source-boundary pattern; align only this default `Unavailable` state. Show
the registered list/filter hierarchy as unavailable and do not reproduce Review fixtures or any
Requisition, Store, requester, estimate, approval, Offering or PO allocation values. Keep
Permission Denied, Feature Disabled, Stale, Conflict, Offline and Found behavior unchanged. Verify
the existing Requisition component suite, Merchant typecheck, scoped lint/format, and a fresh
production-fail-closed route journey at 1440/390/320 with disabled-filter, no-sample and no-overflow
assertions; inspect captures against the new Design Review frames. No WP-2133 projection, query,
command or persistence work; no Accepted Screen, live Store or Make-source claim.

Purchase Requisition list visual continuation result (2026-09-24): created editable regular Figma
Design Review frames `128:213`/`128:256`/`128:299` for desktop 1440, mobile 390 and compact 320.
They reuse the Operations dark header, Inter typography, neutral cards and amber Phase 3 source
notice. The first screenshot review caught overlap in the desktop filter panel and an overwide last
filter; both were corrected before the final render. Final Figma frames and the fresh repository
captures show the same registered hierarchy without clipping or horizontal overflow. The normal
route now renders that hierarchy only when the default authorized client returns `Unavailable`;
filters remain disabled and no sample requester, Store, amount, approval, Requisition or allocation
facts are shown. Other typed states and the Found route are unchanged. The component suite passes
4/4, Merchant typecheck and ESLint pass, Prettier/whitespace checks pass, and the new
production-fail-closed 1440/390/320 journey passes 1/1 after its initial sandbox loopback denial
was rerun with approved local access. `CI=true pnpm build` passes all 41 package tasks (40 valid
cache hits; Merchant rebuilt); the existing Merchant chunk-size advisory remains. This is local UI
and editable Design Review evidence only. WP-2133's authorized projection/query/commands, Make
write/save, Accepted Screen, live Store/UAT and production evidence remain open.

Supplier List visual continuation selection (2026-09-24): Screen Registry `SUP-SUPPLIER-LIST`
(`/app/supply/suppliers`) and Handoff Section 88.13 define Phase 3 Brand/Store-scoped identity,
qualification, Offering/open-PO and permission-trimmed performance fields. The normal route defaults
to `unavailableSupplierClient` and currently shows only the generic state card. Add regular
Operations Design Review frames at 1440/390/320 and align only that `Unavailable` state. Show
registered filter and field groups without any Supplier, contact, qualification, Offering, PO or
performance sample; keep create, suspend/reactivate and archive unavailable. Preserve other typed
states and Found route. Verify focused Supplier component tests, Merchant typecheck, scoped
lint/format, and a production-fail-closed browser journey at 1440/390/320 with disabled-filter,
no-sample and overflow checks; inspect the fresh screenshots. No WP-2131 projection/query/command or
contact data work; no Accepted Screen, live Store or Make-source claim.

Supplier List visual continuation result (2026-09-24): created editable regular Operations Design
Review frames `130:213`/`130:256`/`130:299` at 1440/390/320 by reusing the established BOP/Inter
header, amber boundary and neutral status/filter hierarchy. The normal route now uses it only when
the default client returns `Unavailable`; the identity, qualification and performance groups and
registered filters are visible with all filters disabled, while Supplier rows, contacts, qualification
values, Offerings, open-PO counts and performance remain absent. Lifecycle actions are not exposed;
the page states the no-physical-delete rule. Other result states and Found rendering are unchanged.
The focused component suite passes 4/4, Merchant typecheck/ESLint, Prettier and whitespace checks
pass, and the new production-fail-closed responsive journey passes 1/1. Inspected fresh 1440/390/320
captures match the Figma hierarchy and have no horizontal overflow or clipping. WP-2131's source
composition/commands, live Store, Accepted Screen, Make write/save and production gates remain open.
The subsequent exact-tree `CI=true pnpm build` passes all 41 package tasks (40 unchanged cache
hits; Merchant rebuilt); the existing greater-than-500-kB Merchant chunk advisory remains.

Receiving discrepancy visual continuation selection (2026-09-24): Screen Registry
`PROC-DISCREPANCY` (`/app/supply/discrepancies`) and Handoff Section 88.13 define the source-owned
case/PO/receipt, variance/tolerance, owner/overdue and permission-trimmed contact/evidence/cost/history
fields. The normal route defaults to `unavailableDiscrepancyClient` and previously showed only a
generic state card. Add regular Operations Design Review frames at 1440/390/320 by reusing the
editable Supplier template, changing only the unavailable-state copy, and match that hierarchy in
the default `Unavailable` route branch. Preserve every other typed state and Found rendering;
disable all unavailable filters and show no case, Supplier, receipt, variance, evidence, cost or
history facts. Verify the focused Discrepancy component suite, Merchant typecheck, scoped lint/format,
and a fresh production-fail-closed route journey at 1440/390/320 with disabled-filter, no-sample and
no-overflow assertions; inspect captures against the Review frames. No WP-2134 projection/query/
command/persistence change; no Accepted Screen, live Store or Make-source claim.

Receiving discrepancy visual continuation result (2026-09-24): created editable regular Operations
Design Review frames `132:213`/`132:256`/`132:299` at 1440/390/320 by adapting the Supplier Review
hierarchy. The first Figma render exposed mobile overlap in filter availability and registered-field
headings; concise labels repaired both, and final Figma renders have no observed text collision. The
normal route now renders the registered case/variance/resolution status, three disabled filters,
empty unavailable state and owner-field boundary only when the default client returns `Unavailable`;
other result states and Found rendering are unchanged. Focused component tests pass 5/5,
typecheck/lint/Prettier and `git diff --check` pass. The production-fail-closed route journey passes
1/1 at 1440/390/320, asserts no horizontal overflow or sample facts, and fresh screenshots were
visually inspected. `CI=true pnpm build` reports the known Merchant chunk-size advisory. WP-2134
source composition/commands, persistent discrepancy handling, Store/UAT, Accepted Screen, Make
write/save and production gates remain unresolved.

Cross-slice verification follow-up (2026-09-24): after the responsive discrepancy page change,
`CI=true pnpm build` passes all 41 workspace build tasks (40 cached, Merchant rebuilt); the existing
1,213 kB Merchant JavaScript chunk advisory remains. Native-host `CI=true pnpm audit-record:acceptance`
also passes 1 file / 1 test using authorized local Docker access. This isolated database acceptance
result closes only that package's audit-record test; the exact-final-tree Linux `pnpm verify` aggregate
is still unresolved because Linux owner/takeover tests do not run validly on macOS, while the prior
container-local Linux aggregate lacked a Docker CLI for this final database stage. Do not infer the
remaining full verify, live Store/Provider, Accepted Screen, release or production gates.

Kitchen Figma work-item parity refinement selection (2026-09-24): compare fresh regular Review
frames `51:2`/`51:3`/`51:4` against the current `KIT-WORK-ITEM` route. The design places the sourced
work-item title at left with status and elapsed time aligned at right; current `WorkCard` detail
rendering places the status below the title, unlike the queue hierarchy. Restrict a grid adjustment
to the detail card (`showDetails=false`, `showActions=false`) so queue cards, source fields and
command eligibility do not change. Preserve read-only callout, scope-preserving return, disabled
detail commands and unavailable Recipe/handling/allergen acknowledgement/timer/dependency/history
fields. Add browser geometry assertions for title/status/elapsed placement and verify focused Kitchen
tests, Merchant typecheck/lint/format, Screen Registry, and the existing production-fail-closed Kitchen
journey at 1440/390/320; inspect fresh queue, detail and filter-sheet captures. No query, projection,
Domain, permission or Make change.

Kitchen Figma work-item parity refinement result (2026-09-24): `WorkCard` now marks the detail-only
variant and CSS places its status and elapsed time to the right of the title while leaving queue-card
layout unchanged. The final production-fail-closed journey passes 2/2 with geometry assertions and
1440/390/320 overflow checks; focused Kitchen render/client tests pass 23/23, Merchant typecheck,
scoped ESLint/Prettier and `git diff --check` pass, and Screen Registry validates 210 records. Fresh
detail screenshots show the intended hierarchy at all three widths; queue and mobile filter-sheet
screenshots from the same run remain clear and responsive. Initial geometry assertions measured
text-box and pill outer-box top coordinates, then center positions; those mismatches reflected
different text padding rather than a layout failure. They were replaced with a stable horizontal
placement and vertical-box overlap assertion, after which the full journey passed. The preview retains
the known >500 kB chunk advisory. Browser data remains synthetic; station names, allergen/exception
facts, safe references, course/priority/SLA, KDS session/device lock, and detail execution snapshots
remain source gaps, not Figma-derived facts. No Accepted Screen or production readiness is implied.

Post-Kitchen root build (2026-09-24): `CI=true pnpm build` passes all 41 workspace build tasks (40
cached, Merchant rebuilt) against the Kitchen detail hierarchy change. Merchant's emitted JavaScript
bundle is 1,213.38 kB and retains the existing greater-than-500-kB advisory; no chunking or dependency
change was made. The exact-final-tree Linux `pnpm verify` aggregate and external readiness gates remain
open as recorded above.

Dining Make visual migration selection (2026-09-24): re-open the private Make file and inspect its
actual `/operations/dining` preview, source-file tree and `DiningWorkspace.tsx`; do not infer visuals
from the separate regular Design Review frame. The preview uses a compact area-grouped floor grid
with small status-first cards, while the repository currently uses only three wide cards at desktop.
Apply only the compact card hierarchy to the normal route. Preserve only fields supplied by the
authorized `StaffDiningTable` source, the explicit missing-field callout, accessible select-table
actions, Store scope, session start/recovery and Host Transfer; exclude Make's fictional session IDs,
elapsed times and attention values. No business/query/command changes. Run the existing
`dining-session-start.spec.ts` production-fail-closed journey at 1440/390/320, inspect the fresh
screenshots, and run directly affected Dining render/type/lint/format checks plus `git diff --check`.
Make code-resource links currently return `Unknown resource`; the editor opens the source, but AI
credits are exhausted through Sep 30 and no Make write/persistence or publication is authorized.

Dining Make visual migration result (2026-09-24): reopened the current private Make preview at
`/operations/dining`; its live-like canvas and fictional 11-table sample were readable, as were the
source file tree and `src/components/DiningWorkspace.tsx` in Code view. The AI prompt is disabled
with the team-plan credit reset shown as Sep 30. The Code editor exposes a `contenteditable` source
surface, but no keystrokes were sent, so durable Make edit/save permission remains unverified. The
Figma MCP returned Make source resource links, but reading `DiningWorkspace.tsx` by its resource URI
still failed `Unknown resource`. No Make source, publication or sharing setting changed.

The repository Dining cards now use the Make preview's compact area-grouped card hierarchy while
retaining only authorized `StaffDiningTable` fields, the explicit projection-limit notice, and the
existing selection/start/recovery/Host Transfer flows. Make-only session IDs, elapsed time, attention
state and extra controls were excluded. At first, the 8.5rem auto-fill tracks compressed a single
table in an area into a narrow desktop card and also narrowed mobile cards. The final layout uses
10–11rem compact desktop tracks and a full-width single-column mobile layout. The existing
production-fail-closed Dining journey passes 1/1 after the authorized loopback rerun; the journey
checks 1440/390/320 overflow, filtering, keyboard selection, denied refresh, exact retry and
one-time-code handling. Fresh screenshots at all three widths were inspected with no overflow or
clipping. `DiningPages.test.tsx` passes 4/4, Merchant typecheck and scoped ESLint/Prettier pass, and
`git diff --check` passes. Browser data is synthetic; Registry-required owner/elapsed/Order/Payment,
reservation/waitlist and attention fields remain source gaps. No Accepted Screen, Make persistence,
live Store evidence, or whole-project verification is implied.

Kitchen Figma desktop parity selection (2026-09-24): fresh `get_design_context` screenshots for
Operations Design Review nodes `4:2`, `4:86` and `4:128` confirm the 1440/390/320 queue hierarchy.
The current production-preview capture showed an extra desktop divider and excess gap between Fresh /
KDS status and the read-only board notice. Remove only that queue heading separator/spacing, keep
mobile and KIT-WORK-ITEM unchanged, and add a geometry assertion for the Fresh-to-notice gap. The
current API client explicitly maps Station label, allergen and exception cues as unavailable; do not
reuse Figma's fictional station/item labels or enrich from opaque Station/Order references. Verify
the existing production-fail-closed Kitchen journey and fresh 1440/390/320 screenshots, focused
Kitchen render/client/parser tests, Merchant typecheck, scoped lint/format, Screen Registry and
whitespace. No API, Domain, projection, permission or persistence changes.

Kitchen Figma desktop parity result (2026-09-24): the queue title section now has no bottom divider
and uses a 16px margin before the read-only notice, matching the freshly read Figma hierarchy without
changing mobile or detail layout. The Fresh badge now uses the design's uppercase compact label. The
production-fail-closed Kitchen journey passes 2/2, including
the new desktop geometry/border assertion and 390/320 keyboard/filter/overflow checks; focused
Kitchen tests pass 23/23, the full Merchant workspace passes 106 files / 777 tests, Merchant
typecheck and targeted ESLint/Prettier pass, and Screen Registry validates 210 records. A fresh
`CI=true pnpm build` passes all 41 workspace tasks (40 cached; Merchant rebuilt) with the existing
1,213.38 kB bundle advisory. Fresh 1440/390/320 screenshots were inspected; the one loaded row is
synthetic, and Station/allergen/exception fields remain explicitly unavailable. The separate root
Vitest run on this macOS host is not valid Linux pilot-maintenance evidence: the current runner is
Node 24.18.0 `darwin`, while those tests require Linux `/proc` and intentionally fail closed on
other platforms. No full-repository test, Store acceptance, Accepted Screen, or production gate is
claimed.

Whole-tree Linux verification follow-up (2026-09-24): an isolated Node 24.18.0 / pnpm
11.13.0 container copy passed repository guidance, module/import/database/domain/migration
checks, OpenAPI/event catalog, format (41 workspaces), lint (41), typecheck (41), and
Screen Registry (210 records). After adding a temporary `.git` index and empty `.local`
directory, root Vitest improved from 88 failures to 7 failures / 2063 passes across 110
files. The remaining failures include Linux process-identity checks: nested Docker reports
Node's `/proc/<pid>/cmdline` as `node --no-opt -r /proc/.reset <script> <argument>`, which
does not match the implementation's direct Node argument assumption. The exact-tree secret
scan also exceeded its 5-second test timeout on the host-mounted copy; four further
recovery/resume assertions remain in the failing set and need individual diagnosis. This
container run therefore does not establish root test or full `pnpm verify` success; the
database acceptance and later stages were not reached. Separately, a fresh native-host
`CI=true pnpm build` after the Dining visual change passes all 41 package tasks (40 cache
hits); Merchant retains its existing 1,213.38 kB chunk advisory. No repository `.git`
metadata or local pilot data was changed by the isolated container setup.

Customer and API source revalidation (2026-09-24): the current Customer PWA lifecycle changes
pass the full package suite (54 files / 887 tests), lint, both TypeScript projects, and production
PWA/service-worker build. Its two existing production-exclusion HTTP browser journeys pass (2/2)
for revoked Order access and inaccessible Receipt history removal; requests are intercepted, so
this is not live Guest or true device-offline evidence. The API suite initially failed or timed out
in the default sandbox because its composition tests use loopback HTTP; after rerunning the same
suite with local loopback access, 183 files / 1844 tests pass. API lint, typecheck and build also
pass. This revalidates current Customer and API source trees only; root `pnpm verify`, Linux
maintenance/recovery acceptance, live Store/Provider/Guest evidence and release gates remain open.

Kitchen Figma exact-worktree visual revalidation (2026-09-24): freshly read current Operations
Design Review frames `4:2`/`4:86`/`4:128` and reran the current production-fail-closed Kitchen
journey after the Inventory Count List styles/build. The journey passes 2/2; new 1440/390/320
captures show the migrated desktop title/read-only hierarchy, mobile filter entry, compact card
layout and keyboard-operable field controls without horizontal overflow. Comparison confirms the
repo retains the hierarchy while excluding Figma-only sample facts; Station labels and structured
allergen/exception data remain unavailable and their filters stay fail-closed. This is synthetic UI
evidence and local Figma visual parity only, not live KDS, Accepted Screen or Store acceptance.

Inventory Count Workbench Figma visual continuation selection (2026-09-24): Screen Registry
`INV-COUNT-WORKBENCH` (`/operations/inventory/counts/:id`) and Handoff 88.12 define blind expected-
quantity policy, Item/Lot/Location lines, counted quantity/unit, variance/reason, progress/conflict,
and scan/save/recount/submit/approve/reject/post intents. The existing versioned page renderer is
source-limited, but its normal unavailable client renders a generic state card. Add regular
Operations Design Review frames at 1440/390/320 by reusing the Count List visual hierarchy. Align
only this route's default `Unavailable` state: show the registered workbench fields and disabled
line search/filters/actions, no Count/Store/Item/Lot/Location/quantity/variance/task examples, and an
explicit blind-quantity and source/command boundary. Keep Found and all other typed states unchanged.
Verify focused Inventory Count tests, Merchant typecheck, scoped ESLint/Prettier, Screen Registry,
and a production-fail-closed 1440/390/320 browser journey with disabled-control, no-sample and
overflow checks; inspect captures against Figma. No WP-2122 projection/query/command, permission,
Inventory domain or external acceptance change.

Inventory Count Workbench Figma continuation result (2026-09-24): created editable regular
Operations Design Review frames `137:213`/`137:256`/`137:299` at 1440/390/320 from the Count List
hierarchy. The initial small-frame render clipped the source notice and retained the source List ID;
shorter blind-count boundary copy and the correct Workbench ID resolved both, and all final frames
were reinspected. The normal workbench route now renders its registered Count/scope/snapshot/progress
fields, blind expected-quantity policy, disabled item/barcode and line filters, empty line state and
disabled scan/save/recount/submit/approve/reject/post controls only for default `Unavailable`.
No Count, Store, Item, Lot, Location, quantity, variance, conflict or task examples are shown; Found
and all other typed states remain unchanged. Focused Inventory Count tests pass 7/7, Merchant
typecheck, scoped ESLint/Prettier and the 210-record Screen Registry pass. The production-fail-closed
browser journey passes 1/1, asserting disabled controls, no sample facts and no horizontal overflow
at 1440/390/320; inspected fresh captures match the final Review frames. A fresh current-tree
`CI=true pnpm build` passes all 41 workspace tasks (40 cached; Merchant rebuilt); the existing
1,220.57 kB Merchant JavaScript chunk advisory remains. The Workbench projection/commands, Count
acceptance, live Store/UAT, Accepted Screen, full `pnpm verify`, release and production gates remain
open; regular Figma Review and synthetic browser data do not imply project completion.

Full Linux verification environment follow-up (2026-09-24): the pinned Linux Node 24.18.0 image
and local Docker Desktop Linux engine are available. The image lacks a Docker CLI; the isolated
container-local Linux `pnpm verify` run therefore previously stopped before database acceptance.
The proposed retry would mount the host Docker socket to let the container run that existing
acceptance suite. Automatic approval review rejected this action because the mount grants broad
host Docker control and may affect host containers/volumes. The command did not execute and no
container or database state was changed. Do not retry by indirect socket/API/CLI forwarding. Keep
the exact-tree Linux aggregate unresolved; request explicit user approval before any host-Docker
socket access, and continue independent repository work meanwhile.

Whole-project normal-entry reconciliation (2026-09-24): while continuing the Owner's explicit
whole-project goal, compare the current Merchant route/source tree against Section 88 and the
project-completion inventory. Acceptance question: are there normal-entry gaps missing from that
inventory, and which WP owns them? Inputs: `docs/product/screen-registry.yaml`, `apps/merchant-web/src/App.tsx`,
the Merchant source tree, and the current completion review. Smallest checks: targeted `rg` route/page
search and documentation formatting/whitespace; no application suite is applicable to this inventory
update. Result: `CAT-PRODUCT-LIST` is registered at `/app/commerce/products` under WP-1020/1027/1802,
but no matching route/page source exists in Merchant. Added it to the project-completion review as a
separate confirmed cross-WP gap. No Catalog implementation was added because the root AGENTS.md limits
this checkout turn to current WP-2402. Whole-project completion remains open.

Kitchen desktop queue-card grid parity selection (2026-09-24): fresh Figma Review node `4:2` shows
the work-item cards arranged in responsive desktop columns, while the current production-preview
capture expands one unlabeled station lane's cards into a single wide vertical list. The authorized
Kitchen projection supplies no displayable station labels, so keep one explicit unlabeled lane and
do not invent station names or split by opaque references. Arrange cards within that lane in the
Figma-like responsive grid on desktop and one column on 390/320. Acceptance: multiple current queue
items occupy three columns at 1440 and one column on mobile, preserving all projection fields,
unavailable cues, read-only controls, and keyboard flows. Inputs: Kitchen queue CSS, its existing
production-fail-closed browser journey, screenshot output and this Figma frame. Run that journey to
cover 1440/390/320 geometry and inspect fresh screenshots; also run directly affected Kitchen render
tests, Merchant typecheck, targeted lint/Prettier and `git diff --check`. No Domain, projection,
permission, or source-data changes.

Kitchen desktop queue-card grid parity result (2026-09-24): `.kitchen-station-lane__items` now uses
a responsive card grid that shows three loaded cards in three columns at 1440 and one column at
390/320. Station labels remain explicitly unavailable, and cards are not split using opaque station
references. The production-fail-closed Kitchen browser journey passes 2/2 after extending its
synthetic-only queue fixture to three distinct lifecycle states and updating the filter/action
assertions to match that fixture; geometry assertions confirm the desktop/mobile columns and the
journey retains denied-refresh, keyboard-filter and command-retry coverage. Fresh 1440/390/320 queue
and 390/320 filter-sheet screenshots were inspected. Kitchen render tests pass 9/9, Merchant
typecheck, targeted ESLint/Prettier and `git diff --check` pass. The browser preview retains the
existing greater-than-500-kB chunk advisory. Synthetic cards do not add Store facts; station display
labels, structured allergen/exception values, named KDS session/device lock and remaining Registry
fields remain source gaps. This is local visual parity, not live Kitchen, Accepted Screen, full
`pnpm verify`, UAT or production acceptance.

Catalog Product List Figma Review continuation selection (2026-09-24): Screen Registry
`CAT-PRODUCT-LIST` and Handoff Sections 60.9/69.1–69.4/88.8 define the Product identity and
lifecycle fields, scoped search/filter dimensions, twelve default columns and owning Catalog
projection/commands. The normal Merchant route/page is absent and the Registry assigns business
implementation to WP-1020/1027/1802, so this current-WP slice is limited to an editable regular
Design Review artifact; it must not claim route or Catalog implementation. Reuse the Operations
Commerce Menu List Review hierarchy and the current file's typography/colors. Before mutation, inspect
Code Connect, existing screen instances, local variables/styles and team library assets; reuse only
matching available components/tokens. Acceptance: editable 1440/390/320 frames show the registered
unavailable field hierarchy and disabled controls, no Product/SKU/Store examples, and no clipped or
off-frame content. Inspect fresh screenshots and frame text/bounds, record links and limitations, and
check Markdown formatting/whitespace. No Merchant/business test applies because no application code
or route changes are in scope.

Product search/filter contract parity refinement selection (2026-09-24): compare the current Review
captions against Handoff Section 60.9's full search set (primary/alternate name, internal code, SKU
name/code, barcode and external reference) and filter set (status, type, category, active SKU,
sellability, assigned Menu, Store coverage, tax, missing image/translation, updated date and archive).
Make only Review-frame copy changes so the disabled fields explicitly cover the source contract;
preserve the no-sample boundary and do not introduce route/business behavior. Inspect the refreshed
1440/390/320 screenshots and confirm all labels/notes remain within their frames. No application test
applies because no repository code changes are in scope.

Catalog Product List Figma Review result (2026-09-24): created regular Design Review frames
[`143:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=143-213),
[`143:266` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=143-266), and
[`143:323` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=143-323). The desktop
table contains all twelve Section 60.9 default column headings; responsive frames show identity,
type/status, sellability/SKU count, Menu/coverage, tax/update and availability groups. Search labels
cover primary/alternate name, internal code, SKU, barcode and external reference; the remaining
active-SKU/Menu/tax/image/translation/date/archive filters are identified as unavailable pending
the authorized Product projection. Create is disabled. No Product,
SKU, Store, tax or lifecycle sample values are present. Fresh screenshots were inspected at all three
widths; after shortening the 320px additional-filter note, all text nodes fit within each frame and
no old Menu page title or source copy remains. The existing Menu Review frame has no component
instances/local variables/styles; targeted library searches found no matching button/input/card or
surface/spacing/color assets, so the frames reuse its native typography, neutrals, borders and amber
source notice. The team's Body text style exists remotely but is not applied in the reference frame.
This is editable regular Figma Design only: the ordinary Products route/page remains absent, and
WP-1020/1027/1802 still own its authorized query, commands and application composition. No Figma Make
edit, Accepted Screen, Catalog data, Store acceptance or project completion is implied.

Kitchen Figma exact-checkout revalidation (2026-09-24): compare the fresh Design Review screenshots
for `4:2`/`4:86`/`4:128` against the current Kitchen queue browser journey after the responsive card-grid
refinement. The acceptance question is whether the checked-out route still matches the approved
hierarchy at 1440/390/320 while rendering only current `kitchen_work_queue_v1` fields and preserving
read-only command safety. Reuse the existing production-fail-closed journey; its current run captures
all three widths, checks mobile filter keyboard recovery, and asserts desktop three-column/mobile
single-column geometry and no horizontal overflow. No component test rerun is selected because no
Kitchen source changed since the recorded 9/9 focused result.

Result: `e2e/kitchen-queue.spec.ts --project=production-fail-closed` passes 2/2 on the current
checkout. Fresh 1440/390/320 captures were inspected: the desktop cards render in three columns and
mobile cards in one; the shell, current-screen state, freshness, read-only notice, quantity/status
hierarchy and projection-boundary copy remain aligned with the Design Review. The client still
displays only projection-backed work-item name, status, quantity, age, Store/freshness and permission
state; station labels, safe Order/ticket display refs, allergen/exception cues, course, priority and
overdue remain unavailable and corresponding controls stay disabled. Synthetic browser items are
not Store facts. The journey recreated the demo-preview bundle; `CI=true pnpm --filter
@bop-rms/merchant-web build` restored the default fail-closed Merchant artifact. The existing
1,220.57 kB bundle warning remains. This fresh UI evidence does not establish live KDS identity,
device lock, Store acceptance, Accepted Screen, full `pnpm verify` or production readiness.

Customer Menu Search Figma/code continuation selection (2026-09-24): Handoff 88.6 and
`CUST-MENU-SEARCH` require query, section, dietary tag and available-now filters plus matched-term,
section and availability result fields. The current Customer Menu client sends only query and section;
its strict response model has no dietary tags and accepts only Available items. The focused slice will
implement the supported query/section UI and preserve result, Clear and open-item semantics. It will
not invent dietary tags or an availability toggle; record those projection/query gaps explicitly.
Use the regular Design Review file's Customer Menu frames and local tokens/typography as the visual
reference. Verification selection: focused Menu render/client tests for query/section/Clear and honest
unsupported-filter disclosure; production browser journey at 1440/390/320 for field behavior, accessible
controls and no horizontal overflow; Customer PWA typecheck, targeted ESLint/Prettier and
`git diff --check`. Do not run Catalog or full-repository acceptance for this screen-only change.

Customer Menu Search Figma/code continuation result (2026-09-24): added regular Design Review frames
[`163:213` desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=163-213),
[`163:258` mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=163-258), and
[`163:303` compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=163-303), reusing the
existing Customer Menu Inter/BOP palette, neutral cards, green actions, synthetic-data notice and
allergen/Quote boundaries. Final Figma captures were inspected at all three sizes; the 320px
summary wraps without overlap and its navigation stays inside the frame. `/menu/search` now queries
the authorized client by normalized term and/or exact selected section, shows matched term, source
section, available-only status and existing allergen/price/image disclosures, and Clear resets the
draft and result. Search results expose direct item links. The client preloads its scoped published
Menu to offer section names; no internal reference is rendered as visible text. The synthetic demo
client applies the same exact-section plus name filter. No dietary tags or available-now toggle were
invented: the payload has no dietary tags, and the current response only accepts Available items.

Fresh verification: focused Menu/client/demo tests pass 44/44; Customer PWA typecheck, targeted
ESLint, Prettier and `git diff --check` pass. `e2e/customer-menu-search-review.spec.ts
--project=demo-desktop` passes 1/1; the journey verifies query plus section, result fields, Clear,
console cleanliness and no horizontal overflow at 1440/390/320. Final inspected captures are
[`1440`](../../../apps/customer-pwa/test-results/customer-menu-search-1440.png),
[`390`](../../../apps/customer-pwa/test-results/customer-menu-search-390.png), and
[`320`](../../../apps/customer-pwa/test-results/customer-menu-search-320.png).
Playwright rebuilt its synthetic preview; `VITE_BOP_INTERNAL_SIMULATED_PAYMENT=1 pnpm --filter
@bop-rms/customer-pwa build` restored the local configured artifact. The existing Vite
`inlineDynamicImports` deprecation warning remains. Synthetic browser evidence does not satisfy the
missing dietary/available-now query contract, Catalog source acceptance, Figma Make quota/persistence,
Accepted Screen or whole-project release gates.

Whole-project Customer Menu Search contract reconciliation selection (2026-09-24): compare the
current Screen Registry/Handoff search-filter requirements with the integrated WP-1026 Catalog/API
input, WP-1028's allergen-filter exclusion, WP-1701's no-DTO-extension boundary and the current PWA
caller. Acceptance question: can the remaining registered filters be implemented within accepted
contracts, or do their owners need to reconcile the requirement first? This is documentation-only;
format the affected review/WP and check relevant links plus `git diff --check`. No application suite
applies unless an authorized source contract or code changes.

Result: the Registry and Handoff both require all four filter dimensions, but integrated WP-1026
implements only bounded name search and section filtering; the public response models `Available`
sellables and omits dietary tags/status choices. WP-1026 explicitly assigns dietary/allergen filters
to WP-1028, while WP-1028 excludes Customer allergen filtering and accommodations; WP-1701 prohibits
unapproved DTO/API expansion. The current PWA correctly stays within the q/section inputs, discloses
the missing fields and does not infer a filter from display-only availability. No current-WP code
change can resolve this accepted-contract conflict. The whole-project review now tracks it as a
cross-WP Catalog/Customer requirement requiring owner reconciliation and a newly authorized scope;
no Registry, Handoff, projection or DTO contract was changed. Documentation-only verification:
`project-completion-review.md` and this WP pass Prettier and `git diff --check`; referenced sources and
the WP link were checked. No application suite applies.

Kitchen Figma current-checkout revalidation (2026-09-24): freshly read Review nodes `4:2`/`4:86`/`4:128`
and compared them with the current queue/detail code and screenshot output. The implementation retains the
reference's Inter/neutral hierarchy, Fresh state, compact status-first work cards, responsive desktop grid,
mobile single-column cards and filter/read-only ordering. The current route receives its navigation links
from the authorized Merchant workspace snapshot; Figma's other sample links are not hardcoded. The
current `kitchen_work_queue_v1` fields remain the only rendered work data, and all commands stay locked
while named KDS operator/session/device authority is unverified. Current screen registry requirements
for safe Order/ticket references, course, priority and overdue filtering, structured allergen/exception
facts, and `KIT-WORK-ITEM` Recipe/handling/timer/dependency/history details remain unresolved owner/API
projection work; the Figma's fictional sample values were not copied into the runtime. The fresh
production-fail-closed Kitchen journey passes 2/2 and writes inspected 1440/390/320 queue/detail/filter
screenshots with responsive geometry and no overflow. No Kitchen source changed, so the recorded 9/9
focused component tests and Merchant type/lint/format evidence were reused; the current default Merchant
production build was restored after Playwright's demo preview. This confirms current local visual parity
and synthetic fail-closed behavior only, not live KDS identity/device lock, Store acceptance, Accepted
Screen, aggregate `pnpm verify`, release or production readiness.

Recipe Figma current-checkout revalidation (2026-09-24): re-ran the registered production-fail-closed
`e2e/recipe-review.spec.ts`; the Recipe List and Editor Figma hierarchy/source-boundary journey passes
1/1. It captures both routes at 1440/390/320, asserts their Registry IDs and source-unavailable state,
asserts no Recipe articles are fabricated and checks no horizontal overflow. Inspected screenshots show
the existing Commerce/Review header, amber source boundary, neutral unavailable card, return navigation
and responsive wrapping. No Recipe source changed, so this run verifies current visual fallback only;
it does not establish the admin query, generation builder, authorized source coverage or normal data
read. Restored the default Merchant production build after Playwright's demo preview; it passes with the
existing 1,220.57 kB chunk advisory. Repository source recheck confirms the internal Recipe aggregate
reader, Inventory's pinned Recipe item/configuration source, and Catalog's selected allergen-review
facts reader serve narrower owner workflows; they do not together expose a complete versioned Recipe
admin view or a Brand-wide source watermark. Keep the normal Recipe route fail-closed until owner query,
source-coverage and publication-ordering contracts can be satisfied. Synthetic browser evidence is not
real Supplier/Inventory/Allergen evidence, Store acceptance, Accepted Screen, or production readiness.

Kitchen read-only-to-queue spacing parity selection (2026-09-24): fresh Figma `KIT-KITCHEN-QUEUE`
`4:2` shows the Queue heading 32px below the read-only notice; the current 1440 screenshot shows an
18px separation. Align this one desktop hierarchy gap while keeping mobile filter/lock/lane order,
current workspace navigation and all projection/command boundaries unchanged. Inputs: the queue heading
margin in `styles.css`, its existing production-fail-closed E2E geometry section and Figma node `4:2`.
Smallest checks: add a desktop lock-bottom-to-Queue-top assertion, run `e2e/kitchen-queue.spec.ts
--project=production-fail-closed`, inspect refreshed 1440/390/320 screenshots, run affected Kitchen
component tests and Merchant typecheck/targeted lint/Prettier plus `git diff --check`. No API, projection,
Domain, permissions, feature flags or data fixtures change.

Kitchen read-only-to-queue spacing parity result (2026-09-24): the desktop Queue heading now has a
28px CSS top margin after the lock notice, moving its rendered top to the Figma frame's 320px hierarchy
position from the prior 18px gap. A Playwright assertion bounds the actual lock-bottom-to-Queue-top
geometry to 28–36px. The production-fail-closed Kitchen journey passes 2/2; fresh 1440/390/320 captures
were inspected, confirming the desktop alignment and unchanged mobile filter/lock/lane order with no
horizontal overflow. Focused `KitchenBoardPages.test.tsx` passes 9/9; Merchant typecheck, scoped ESLint,
Prettier and `git diff --check` pass. The default Merchant production build was restored after the demo
preview and passes with the existing 1,220.57 kB JavaScript chunk advisory. Only local CSS and browser
geometry verification changed; no source, command, permission or projection fields were invented.

Dining Make compact-card parity correction selection (2026-09-24): re-opened the current private
Make `/operations/dining` preview and `DiningWorkspace.tsx`; preview and code are readable, the
source editor exposes a settable text surface, but no source edit/save was attempted. The current
Merchant screenshot still shows a 175px-wide, 160px-tall tile with vertically stacked state/capacity/
session and a large blank area when an Area has one authorized table, unlike Make's compact horizontal
status-first table cards. Fix this actual mismatch while preserving `StaffDiningTable` facts, Store
scope, table selection/start/recovery/Host Transfer, keyboard and 44px action target; keep the actual
state/capacity/session-presence fields, and exclude Make-only Attention/session ID/elapsed values.
Keep full-width single-column cards on 390/320. Inputs: Dining tile markup/CSS and the existing
`dining-session-start.spec.ts` geometry/screenshot journey. Acceptance: desktop card width reduces to
112–144px, its label/state share the top row, card content remains readable, mobile reflows, and all
existing selection/filter/permission/recovery assertions still pass. Inspect new 1440/390/320 captures;
run the same production-fail-closed journey and `git diff --check`. No Dining projection/query/Domain/
permission change; Make save persistence remains out of scope.

Recipe List/Editor source-unavailable Figma hierarchy migration selection (2026-09-24): Screen
Registry `RECIPE-LIST`/`RECIPE-EDITOR`, Handoff Section 88.8, and existing Review frames `27:2`/
`27:30`/`27:52` and `27:74`/`27:100`/`27:126` define the responsive Commerce/Review hierarchy and
the source-backed fields. The normal pages currently render only a generic `Recipe data unavailable`
card after the source notice. Update only the `Unavailable` branch to show the registered search/
filter and identity/yield, ingredient, preparation/substitution, allergen/cost, and usage/version
groups in the Figma hierarchy. Use unavailable-state explanations and disabled controls; do not render
placeholder Recipe rows, sample names/codes/amounts, enable actions, or change the Found/stale/permission/
error route behavior. Inputs: `RecipePages.tsx`, scoped Recipe styles, focused component tests and the
existing `recipe-review.spec.ts`. Acceptance: 1440/390/320 frames reflow without overflow, all Registry
groups are visible, no Recipe article/sample values render, disabled controls remain inert, and return
navigation is preserved. Run focused Recipe tests, Merchant typecheck/targeted ESLint/Prettier, the
existing production-fail-closed journey with fresh screenshot review and `git diff --check`. No
projection/API/Domain/permission or private Make changes.

Recipe List/Editor source-unavailable Figma hierarchy migration result (2026-09-24): the two normal
routes now retain the Figma Commerce/Review title, amber source boundary and bordered field-group
hierarchy while rendering no placeholder Recipe records. List search/status/review filters and Create
are disabled; Editor shows identity/yield, Ingredients, preparation/substitution, allergen/cost and
Product usage/version groups, retains All Recipes navigation, and leaves editing/publish unavailable.
Found, stale, permission and other typed states were not changed. The production-fail-closed
`recipe-review.spec.ts` journey passes 1/1; it asserts all groups, no sample rows, disabled controls,
return navigation and no horizontal overflow at 1440/390/320. Fresh captures were inspected:
list 1440,
list 390,
list 320,
editor 1440,
editor 390, and
editor 320. `RecipePages.test.tsx` passes
30/30; Merchant typecheck, targeted ESLint/Prettier pass. These remain unavailable source states: the
Recipe generation builder, complete authorized owner-source versions, Brand-wide ordering and normal
query/API composition remain unresolved. No data-source, permission or private Make changes.

Dining Make compact-card parity correction result (2026-09-24): the floor board now uses 112–144px
desktop tiles with table label/state aligned in one row and capacity/session-presence sharing a compact
line; the existing selection button and 390/320 single-column reflow remain. The fresh
`dining-session-start.spec.ts --project=production-fail-closed` journey passes 1/1, including card
geometry, keyboard selection, filtering, denied refresh, exact retry/recovery, session start and
1440/390/320 overflow checks. Final captures were inspected: 1440,
390, and 320. `DiningPages.test.tsx` passes 4/4;
Merchant typecheck, targeted ESLint/Prettier, default Merchant build and `git diff --check` pass. The
build retains the existing 1,220.62 kB JavaScript chunk advisory. Current Make preview and code editor
are readable and its source editor is settable; no Make write/save was attempted, so persistence is
unverified. No Make-only data was copied. This is local visual parity only, not Dining projection
coverage, Store/UAT, Accepted Screen or whole-project completion.

## Catalog Product Detail Figma Review continuation (2026-09-24)

The Owner clarified that whole-project completion should continue, including use of the existing
Figma design. Chose `CAT-PRODUCT-DETAIL` as the next visual artifact because its registered
Product List already has matching Operations Commerce Review frames, while the normal Product Detail
route remains absent and is owned by WP-1020/1021/1022/1023/1024/1802. This turn is limited to the
regular Design Review file; it does not implement that cross-WP route or Catalog query/commands.

Source: Screen Registry `CAT-PRODUCT-DETAIL`; Handoff Sections 60.10, 67.1–67.4 and 69.6; existing
`CAT-PRODUCT-LIST` Design Review frames `143:213`/`143:266`/`143:323`. Section 67 separates the
read-only Detail from the explicit Draft Editor. Detail hierarchy covers stable identity, lifecycle,
effective/published version and scope/period/source, draft presence, sellable summary, localized
content, media, variants/SKUs, options/categories, Menu/availability/tax/Store overrides, versions,
pending approval/task, update and audit summary. Review shows every field as unavailable and keeps
Draft action disabled; it contains no Product, price, SKU, Menu, Store, approval or audit sample facts.

Created editable frames in the existing Operations Queues — UI direction file:
[1440 desktop](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=180-213),
[390 mobile](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=180-394), and
[320 compact](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=180-579). Reused the existing
Commerce Review Inter/neutral/amber hierarchy. The file has no subscribed libraries, local variable
collections, text styles or instances in the Product List reference; no local Code Connect source was
found, and Code Connect lookup is unavailable to the current Figma seat. The mobile first render
exposed cards outside the viewport and missing unavailable values; both were corrected before final
screenshots. Final render inspection confirms the 1440 two-column detail groups and single-column
390/320 groups, visible unavailable values, disabled action, and no off-frame right column. Desktop
vertical spacing was tightened after inspection.

This is an editable regular Figma Design Review artifact, not Figma Make content, an Accepted Screen,
Catalog route/query implementation, live Catalog data, or cross-WP completion. The Registry's
`catalog.manage` permission reference and Section 67's `catalog.product.read` Detail persona should
be reconciled by the owning Catalog WP before any runtime action is enabled. Documentation-only
closeout: verify the new links resolve to the three frames, Markdown formatting and whitespace; no
application/business checks apply.

Catalog Product Create/Edit Figma continuation (2026-09-24): Handoff Sections 67.5–67.6 distinguish
the initial segmented create from explicit Draft editing. Added editable `CAT-PRODUCT-CREATE` frames
at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-283), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-360), plus `CAT-PRODUCT-EDIT`
frames at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-437),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-560), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=184-692). Both use the Product Detail
Review Commerce style. Create shows only required initial fields plus optional category and Brand
default tax classification, disables submission, and states that creation makes an unpublished Draft
without auto-creating price/Menu/Recipe/Inventory records. Edit shows Draft/base version, aggregate
version, unsaved, validation and impact fields; its Draft actions remain disabled pending source,
permission and policy. Initial 320px rendering clipped wrapped source notices; their cards were expanded
and all six final renders were inspected. No sample Product values were added. The route and command
composition remain owned by WP-1020/1021/1022/1023/1024/1802; these Review frames do not implement or
accept either workflow.

Kitchen work-item Figma surface parity verification selection (2026-09-24): the current Review frame
`51:2`/`51:3`/`51:4` uses a `#f5f5f5` detail canvas with white information cards, while the current
production preview renders a white canvas. Align only the detail-route main surface; leave the Queue
white as shown by `4:2`. Acceptance: exact main-surface colors are asserted on Queue and Detail, and
the existing production-fail-closed Kitchen journey passes with fresh 1440/390/320 Queue and Detail
captures inspected for card contrast and overflow. Inputs are the scoped Merchant CSS, the existing
Kitchen browser journey and current Figma frames. Verification selection: run the focused
`KitchenBoardPages.test.tsx` component suite, Merchant typecheck, ESLint/Prettier on the two changed
files, the `e2e/kitchen-queue.spec.ts --project=production-fail-closed` journey with fresh screenshot
inspection, restore the normal Merchant production build after Playwright, and run `git diff --check`.
No projection/API/Domain/permission/command change; browser fixtures remain synthetic, and no live
Store/KDS claim follows.

Kitchen work-item Figma surface parity result (2026-09-24): scoped the main content background to
`#f5f5f5` only when `KIT-WORK-ITEM` is rendered. `KIT-KITCHEN-QUEUE` still inherits the white shell;
the production browser journey asserts both computed values. Its first post-change run exposed the
test's incorrect expectation that the Queue main element had an explicit white fill (it is transparent
over a white shell); the assertion was corrected to the observed shell contract. The fresh
`e2e/kitchen-queue.spec.ts --project=production-fail-closed` run then passes 2/2. Inspected 1440/390/320
detail screenshots show white cards over the Figma-matched gray detail surface with no overflow; the
same journey freshly captures the queue and filter sheet at all widths. `KitchenBoardPages.test.tsx`
passes 9/9, Merchant typecheck and scoped ESLint/Prettier pass, and the default Merchant production
build was restored successfully (existing 1,223.08 kB chunk warning). Scoped `git diff --check` passes.
Browser fixtures remain synthetic; this surface parity does not supply station display
labels, KDS session/device lock authority or other Registry source fields, and is not Store acceptance,
Accepted Screen, aggregate `pnpm verify` or production readiness.

Customer Cart Figma design and implementation selection (2026-09-24): `CUST-CART` is the next
Customer PWA journey screen because its Screen Registry contract is explicit and the current regular
Design Review file already establishes the customer green/neutral visual language on Menu and Search.
Create editable `CUST-CART` frames at 1440/390/320 from Handoff 88.6 and the current CartPage fields:
configuration, quantity, line estimate, warning, Quote summary/expiry, service mode and safe disabled
clear-cart boundary. Keep all displayed business values fictional and explicitly synthetic; do not
add item photos, identity, payment or Store facts. Then migrate only the approved visual hierarchy to
the normal Cart page, preserving its versioned mutations and stale/expired/offline/foreign-participant
states. Acceptance: Figma frames resolve and inspected renders fit their viewports; the production
Cart local-synthetic browser journey at 1440/390/320 shows the mapped hierarchy with no horizontal
overflow and keeps unavailable actions disabled. Verification selection: inspect current Cart and
CSS/API behavior first; use the existing Cart component tests, Customer PWA typecheck and scoped
lint/format; extend the existing local-only `customer-demo.spec.ts` Cart review to capture the three
viewports and run it with fresh screenshot inspection; run the normal Customer PWA build after
Playwright and `git diff --check`. No Cart query/command/data-source change.

Customer Cart Figma migration result (2026-09-24): created editable regular Design Review frames for
`CUST-CART` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=189-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=189-254), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=189-295). The designs reuse the
Customer green/neutral hierarchy and mark all shown Cart/Quote amounts as synthetic. The first render
review found a wrapped subtitle collision; its text was shortened before final renders. The normal
Cart page now uses the same green header, canvas, white cards, journey links, and checkout emphasis
while retaining server-derived Cart/Quote state and read-only/error boundaries. Browser review found
and corrected missing Cart-local design token aliases, Quote warning spacing, and an over-specific
navigation label selector. The final
`e2e/customer-demo.spec.ts --project=demo-desktop --grep CUST-CART` local-synthetic journey passes 1/1;
it checks 1440/390/320 two-column/stacked layouts, no horizontal overflow, one-row navigation, Quote
spacing, palette, offline read-only messaging, and disabled actions. Inspected captures are
`apps/customer-pwa/test-results/cust-cart-1440.png`, `cust-cart-390.png`, and `cust-cart-320.png`.
`CartPage.test.tsx` passes 29/29; Customer PWA typecheck, scoped ESLint/Prettier, `git diff --check`
and normal Customer PWA build pass. The build retains the existing Vite `inlineDynamicImports`
deprecation advisory. These are local synthetic fixtures, not live Cart projection or Store evidence.
The ordinary Figma Review file is editable; Figma Make remains quota-gated through Sep 30 and Make
source edit/save persistence remains unverified. This work does not establish Make completion,
Accepted Screen, aggregate `pnpm verify`, Store/UAT, or whole-project completion.

Customer Checkout Figma design and implementation selection (2026-09-24): continue from `CUST-CART`
to the Registry's `/checkout` step, using the Customer Design Review green/neutral frame family and
Handoff 80.10.3/88.6. Create editable frames at 1440/390/320 for the Details → Review → Pay → Result
progress, current synthetic Cart/Quote, contact minimum, receipt choice, policy acknowledgement and
safe payment handoff. The current Checkout runtime has no customer-safe Capacity Hold field; show that
value as unavailable and record the Projection gap rather than inventing a hold. Preserve versioned
Quote, explicit price-change acknowledgement, detail-save policy gates, offline/error states and the
disabled Continue to payment state. Acceptance: inspected frames fit their viewports; the existing
local-synthetic Customer browser route covers the Checkout hierarchy at 1440/390/320 without
overflow, shows Capacity Hold unavailable, and never enables payment while details/policy aren't
ready. Verification selection: inspect the page/form data contract and source first; use focused
Checkout component tests, Customer PWA typecheck and scoped lint/format; extend the existing local
synthetic Customer E2E to capture the three widths; inspect screenshots; restore normal Customer PWA
build and run `git diff --check`. No query, command, payment or capacity-source change.

Customer Checkout Figma migration result (2026-09-24): the editable regular Design Review frames are
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=191-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=191-271), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=191-329). Final Figma screenshot
inspection confirmed the compact action card now contains its disabled payment button and the closing
note fits below it. The regular Customer page now carries the green header, canvas, journey navigation,
Details → Review → Pay → Result progress, summary cards, and an explicit unavailable Capacity Hold
source boundary. Quote/version, policy, contact-save, offline and payment gating behavior remain on
their existing sources and controllers. The local-synthetic `customer-demo.spec.ts --project=demo-desktop
--grep 'CUST-(CART|CHECKOUT)'` adjacent regression passes 2/2; both screens capture 1440/390/320 and
verify no horizontal overflow, and Checkout verifies single-row navigation, visible source-gap copy
and disabled payment. Final Checkout screenshots are
`apps/customer-pwa/test-results/cust-checkout-1440.png`, `cust-checkout-390.png`, and
`cust-checkout-320.png`; visual inspection found no clipping or overlapping page content. `CheckoutPage.test.tsx`
passes 14/14, Customer PWA typecheck, scoped ESLint and Prettier checks pass, and the normal Customer
PWA build passes with the existing Vite `inlineDynamicImports` deprecation advisory. The demo's
Checkout-details endpoint is unavailable, so the screenshots correctly show its reload/error state;
no contact or policy data is fabricated. Capacity Hold remains absent from the current customer-safe
Checkout projection. Figma Make quota/source-edit persistence, accepted-screen review, live owner
projection, Store/UAT, aggregate `pnpm verify`, and whole-project completion remain unresolved.

Customer Receipt Figma visual continuation verification selection (2026-09-24): `CUST-RECEIPT-SUPPORT`
is the next normal Customer lifecycle page after Order Status. Section 88.6 and its Screen Registry
contract require immutable receipt/correction/refund history, the issued entity/Store/Order snapshot,
current payment/refund and delivery/support eligibility, and accessible print/email boundary. Create
editable regular Design Review frames at 1440/390/320 from the current stale synthetic fixture. Apply
only the Customer green/neutral header, card hierarchy, responsive history/summary layout and action
grouping to the existing renderer. Keep current financial amounts separate from immutable receipt
snapshots; preserve stale/offline/permission/not-found states, route-scoped authorization, disabled
email, print and refresh behavior. No receipt, payment, email, support or cancellation Command/source
change. Verification selection: `ReceiptPage.test.tsx`, Customer PWA typecheck, scoped ESLint/Prettier,
`receipt-http.spec.ts --project=production-exclusion` at 1440/390/320 with screenshot review, normal
Customer PWA build after the browser run, and scoped `git diff --check`.

Customer Receipt Figma migration result (2026-09-24): editable regular Design Review frames are
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=197-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=197-259), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=197-305). The Receipt page now
uses the Customer green header, neutral canvas, merchant/order and stale-state cards, responsive
immutable-history/financial hierarchy, and grouped print/email actions. Existing refresh/back behavior,
disabled email, print, authorization and unavailable live-state boundaries remain intact. `ReceiptPage.test.tsx`
passes 10/10; Customer PWA typecheck and scoped ESLint pass. The local-synthetic
`receipt-http.spec.ts --project=production-exclusion` journey passes 1/1 at 1440/390/320; all three
screenshots were visually inspected with no clipping or overflow. Normal Customer PWA build and
scoped formatting/diff checks pass; build retains the existing Vite `inlineDynamicImports`
deprecation advisory. These frames and fixtures are review-only. Figma Make quota/source-save
persistence, live receipt facts, Store/UAT, Accepted Screen, aggregate verification and whole-project
completion remain unresolved.

Exact-checkout build revalidation (2026-09-24): acceptance question—do all workspace packages,
including the current Kitchen, Dining, and Customer visual continuations, build from this exact
checkout? Inputs are the current 41-package Turbo graph and repository source. Ran
`source .local/activate.sh && CI=true pnpm build`; all 41/41 tasks succeeded (39 cached, two
re-executed). Merchant retains the existing 1,223.08 kB chunk advisory and Customer PWA retains the
existing Vite `inlineDynamicImports` deprecation advisory. This proves the workspace build only;
the full `pnpm verify` remains unresolved because the Linux container-local run stops at audit-record
acceptance when Docker is absent, and Store/UAT/Accepted Screen gates remain separate.

Current-tree Dining responsive revalidation (2026-09-24): `source .local/activate.sh && CI=true pnpm
--filter @bop-rms/merchant-web exec playwright test e2e/dining-session-start.spec.ts
--project=production-fail-closed` passes 1/1 on the exact current worktree. Fresh captures at 1440/390/320
were inspected; compact desktop cards and full-width mobile cards have no viewport overflow. The journey
covers selection/start/recovery, filtering and denial handling with synthetic records; it does not prove
live Store data or Accepted Screen. Captures are
`apps/merchant-web/test-results/dining-board-{1440,390,320}.png`.

Native-host root test diagnostic (2026-09-24): `source .local/activate.sh && CI=true pnpm test` on this
Darwin host exits 1: 92/110 files and 1968/2070 tests pass; 18 files / 102 cases fail. Observed failure
signatures include absent Linux `/proc/self/stat`, Darwin process-identity mismatches and sandbox-denied
loopback binds (`listen EPERM`), including a QR journey timeout. This is not a valid Linux aggregate
acceptance or evidence that every failing case is environmental. The exact-snapshot Linux run recorded
above passed root Vitest before later current-tree UI changes; an exact-current-tree Linux suite remains
unverified. Do not count this diagnostic as `pnpm verify`.

Dining confirmation target verification selection (2026-09-24): current refreshed 320px screenshot
shows the selected-table confirmation checkbox adjacent to its wrapped instruction with no deliberate
spacing, and the associated label is not explicitly a 44px interaction target. Improve only the
existing confirmation label/input styling while preserving its native checkbox, accessible name,
confirmation gating and command payload. Acceptance: the label remains keyboard/native-control
operable, has at least a 44px hit area at 1440/390/320, and keeps visible separation when the copy
wraps; no Dining data or command semantics change. Add geometry assertions to the current
`dining-session-start.spec.ts`; run that production-fail-closed journey at all widths and inspect the
fresh screenshots, then run Merchant lint/typecheck, normal build, formatting and `git diff --check`.

Dining confirmation target correction result (2026-09-24): the selected-table confirmation label now
uses an explicit 44px minimum hit area, 8px checkbox/copy separation and nonshrinking native checkbox;
its accessible name, native keyboard operation and existing command gating are unchanged. The updated
`dining-session-start.spec.ts --project=production-fail-closed` journey passes 1/1 and asserts these
bounds at 1440/390/320. Fresh captures were inspected; the two-line 320px label remains aligned and
readable without overflow. Merchant typecheck, targeted ESLint, Prettier, normal Merchant build and
scoped `git diff --check` pass. The build retains its existing 1,223.08 kB chunk advisory. This is local
interaction accessibility evidence with synthetic Dining data, not Store/UAT/Accepted Screen or
production acceptance.

Current-tree Linux test verification selection (2026-09-24): the native-host root test suite is not
valid for Linux `/proc` process-identity requirements. Acceptance question: do root Vitest and all 41
workspace test tasks pass on the exact current checkout in supported Linux process semantics? Use the
locally cached pinned Node 24.18 image, mount the checkout read-only only for a snapshot copy, exclude
host `node_modules`, `.local` installation secrets/data and generated artifacts, install the locked
workspace inside disposable container-local storage with `pnpm install --frozen-lockfile`, then run
`CI=true pnpm test`. This tests current source and lockfile without reading or mutating the active
`.local/pilot-v14` installation. The existing script includes Docker database acceptances after root and
workspace tests; if Docker CLI is absent in the container, record that stage as unresolved, not passed.

Linux snapshot test preparation correction (2026-09-24): the first disposable-container attempt froze
and installed all 42 workspace projects successfully, but deliberately excluded generated `dist` files
and invoked `pnpm test` before rebuilding. Root Vitest then ran only 69/110 files (1856 tests passed)
and 41 suites failed to import workspace build outputs; this is an incomplete test run, not a code or test
acceptance result. Correct sequence for the fresh isolated snapshot is frozen install, `CI=true pnpm
build`, then `CI=true pnpm test`. Active `.local` remains excluded.

Customer Order Status route assertion correction selection (2026-09-24): the current fresh
`@bop-rms/customer-pwa` suite fails its canonical `/orders/:orderReference` shell test because
`App.test.tsx` expects the previous Pickup-specific subtitle, while the rendered `OrderStatusPage` now
uses the channel-neutral current copy. Preserve the page copy and update only the stale test assertion.
Re-run the focused Customer PWA suite, then typecheck/lint/format and normal Customer PWA build; this is
a test alignment repair and changes no route, projection or business behavior.

Current-tree Linux root/workspace test result (2026-09-24): after the snapshot build, the exact current
checkout passes root Vitest (110 files / 2070 tests) and all 41/41 Turbo workspace test tasks. The full
`CI=true pnpm test` script reaches `audit-record:acceptance`, whose isolated PostgreSQL startup fails
because the disposable Linux container has no `docker` executable (`spawn docker ENOENT`). This is a
Docker-stage environment gap; it does not invalidate the completed root/workspace unit tests and does
not constitute full `pnpm test`/`pnpm verify` success. Customer PWA independently passes 54 files /
890 tests after correcting the stale Order Status shell assertion in `src/App.test.tsx`.

Isolated audit-record acceptance continuation selection (2026-09-24): the Linux test stages pass, while
the one-time container lacks Docker CLI and the local host daemon is now confirmed reachable only with
approved escalation. Run the existing `pnpm audit-record:acceptance` from the repository root on the
host, using its WP-0024 isolated database harness. Verify it creates only its namespaced temporary
PostgreSQL resources and cleans them up; do not touch `.local/pilot-v14`. This closes this one acceptance
case only and cannot convert the earlier `pnpm test` or full `pnpm verify` invocation into a pass.

Isolated audit-record acceptance result (2026-09-24): `source .local/activate.sh && CI=true pnpm
audit-record:acceptance` passes 1 file / 1 test against a WP-0024 namespaced temporary PostgreSQL
instance through the existing cleanup harness. It did not connect to or mutate `.local/pilot-v14`.
This is the one acceptance step that the disposable Linux `pnpm test` could not start because Docker CLI
was absent there. Other database acceptance commands after audit-record were not run; full `pnpm test`
and `pnpm verify` remain unresolved.

Customer Order Status route assertion correction result (2026-09-24): changed only the stale expected
subtitle in `apps/customer-pwa/src/App.test.tsx` to match the current channel-neutral route copy. The
Customer PWA suite passes 54 files / 890 tests; typecheck, targeted ESLint and Prettier pass. No page
copy, route, projection or business behavior changed.

Current-tree root static gate selection (2026-09-24): acceptance question—do the 41-workspace source,
tests, styles and current Registry mappings satisfy the repository's existing lint, TypeScript,
formatting and Screen Registry checks after the accumulated WP-2402 changes? Run existing root
`pnpm lint`, `pnpm typecheck`, `pnpm format:check` and `pnpm screen-registry:check`; reuse no older
evidence for changed frontend, API, tooling or Registry inputs. These checks do not replace Linux
runtime/DB acceptance, the full `pnpm verify`, or Store/UAT gates.

Current-tree root static gate result (2026-09-24): `CI=true pnpm lint` passes root ESLint and all
41/41 workspace tasks; `CI=true pnpm typecheck` passes root `tsc` and all 41/41 workspace tasks;
`CI=true pnpm format:check` passes repository Prettier and all 41/41 workspace tasks; and
`CI=true pnpm screen-registry:check` validates all 210 Section 88 records. `git diff --check` passes.
The full `pnpm verify` remains unresolved: its Linux snapshot run stops at Docker-backed acceptance
because the container has no Docker CLI, and a prior attempt to forward the host Docker socket was
rejected by automatic approval review for broad host control/side-effect risk. No socket forwarding
or database acceptance beyond the isolated audit-record case was attempted here.

Kitchen Figma visual revalidation selection (2026-09-24): current Kitchen source and Review frames
`4:2`/`4:86`/`4:128` are unchanged since their recorded parity migration, but generated Playwright
captures are no longer present in the current checkout. Re-run the existing production-fail-closed
`e2e/kitchen-queue.spec.ts` journey to refresh 1440/390/320 queue, detail and mobile filter captures,
then inspect the images for the Figma hierarchy, available-source-only content, clipping and overflow.
No new projection field is in scope for this visual check; synthetic intercepted records cannot
establish Store/KDS acceptance.

Kitchen Figma visual revalidation result (2026-09-24): refreshed Figma context/screenshots for Queue
`4:2`/`4:86`/`4:128` and Work Item `51:2`/`51:3`/`51:4`, then ran
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/kitchen-queue.spec.ts
--project=production-fail-closed`; both browser scenarios pass. Inspected fresh queue, detail and filter
captures at 1440/390/320; heading spacing, read-only notice, neutral/gray detail canvas, white detail
cards, disabled missing-source controls and mobile filter layout follow the existing Figma hierarchy
without clipping or horizontal overflow. Evidence: `apps/merchant-web/test-results/kitchen-{board,
detail}-{1440,390,320}.png` and `kitchen-filter-sheet-{390,320}.png`. The default Merchant production
build was restored and passes (existing 1,223.08 kB chunk advisory). No code/data change was warranted;
Figma's sample item, station, allergen and exception facts remain review-only. Browser responses remain
synthetic and do not establish Store/KDS acceptance, Accepted Screen or project completion.

Dining Make/current-checkout visual revalidation selection (2026-09-24): the exact private Make
`/operations/dining` preview and `DiningWorkspace.tsx` source are readable; current Make shows fictional
11-table data, while the production route must retain only `StaffDiningTable` facts. Re-run the existing
production-fail-closed `e2e/dining-session-start.spec.ts` journey to refresh 1440/390/320 captures and
inspect the compact area-grouped desktop cards, mobile reflow, confirmation and retry hierarchy against
Make. Do not alter Make or infer missing owner/elapsed/Order/Payment/reservation/attention fields. Restore
the normal Merchant build afterward; this is visual evidence only, not Store/UAT or Accepted Screen.

Dining Make/current-checkout visual revalidation result (2026-09-24): reopened the linked Make project
in Chrome. The exact `/operations/dining` preview and Code view are readable; the `src/components/
DiningWorkspace.tsx` editor is exposed as a settable text area. The preview labels its 11-table dataset
fictional. Make AI prompt/model/Send controls remain disabled with the displayed team-credit reset on
September 30. No source edit, save, publication or sharing change was made; settable editor access does
not prove cloud save persistence. Re-ran
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/dining-session-start.spec.ts
--project=production-fail-closed`; 1/1 passed. Inspected fresh 1440/390/320 captures: compact desktop
area-grouped tiles retain table/state/capacity/session-presence; mobile remains single column; selection,
44px confirmation target and no-overflow behavior remain. Screenshots:
`apps/merchant-web/test-results/dining-board-{1440,390,320}.png`. Restored the default Merchant build;
it passes with the existing 1,223.08 kB chunk advisory. No application or Make source change was needed.
Owner/elapsed/Order/Payment/reservation/waitlist/attention facts remain unsupported by
`StaffDiningTable`; synthetic browser evidence is not Store/UAT, Accepted Screen or project completion.

Kitchen Work Item modifier projection selection (2026-09-24): Registry `KIT-WORK-ITEM` and Handoff
88.10 require exact item/modifier/quantity. The current `kitchen_work_queue_v1` owner DTO contains
`selectedOptions` with validated option UUID, integer quantity and localized snapshot names; the BFF
already returns this projection-owned field, but Merchant drops it before rendering the detail route.
Carry only the validated localized option name and quantity into the Work Item UI; validate then omit
opaque option references. Render modifiers on detail only, distinguish a present empty array (no
selected modifiers) from an absent/malformed field (projection unavailable), and do not populate Recipe,
handling, allergen, timer, dependency or history fields. Update the regular Design Review Work Item
frames with this contract-backed group. Verification: focused Kitchen model/client/component tests,
production-fail-closed Kitchen browser journey at 1440/390/320 with detail assertions and screenshot
inspection, Merchant typecheck/lint/format/build and `git diff --check`; no Domain/API/database changes.

Kitchen Work Item modifier result (2026-09-24): the client now strictly validates the owner-projected
option reference, localized name and quantity, then passes only display name/quantity into the closed
screen model. Missing or malformed options fail closed; the queue remains unchanged and the detail
shows a Modifiers section, including the present-empty state. Updated editable Review frames `51:2`,
`51:3`, `51:4` with the neutral empty state and checked fresh Figma screenshots. Focused Merchant tests
pass 35/35; typecheck, targeted ESLint/Prettier and whitespace checks pass. The production-fail-closed
Kitchen journey passes 2/2, and its 1440/390/320 detail screenshots were inspected; the normal Merchant
production build passes with the existing 1,225.12 kB chunk-size advisory. Browser values are
synthetic; projection/Store acceptance, other missing Registry groups, and full-project gates remain
open.

Modifier projection transport regression selection (2026-09-24): acceptance question—does the Merchant
Kitchen BFF preserve the Kitchen owner DTO's selected option reference, localized name and quantity
through both List and Get without changing mapping? Inputs are the `itemView` spread mapper and its
List/Get handlers; smallest check is `CI=true pnpm --filter @bop-rms/api exec vitest run
src/merchant-kitchen-query.test.ts`, followed by scoped ESLint, Prettier and `git diff --check`. The
fixture is synthetic; no API/domain/persistence behavior changes.

Modifier projection transport regression result (2026-09-24): the Merchant Kitchen BFF test now asserts the
owner's selected option reference, localized name and quantity survive both List and Get mapping. The
focused API file passes 9/9; scoped ESLint, Prettier and `git diff --check` pass. This verifies the BFF
transport contract with a synthetic fixture; it is not a live projection or Store acceptance result.

Kitchen detail keyboard-route verification selection (2026-09-24): acceptance question—can keyboard
users open `KIT-WORK-ITEM` from the filtered queue and return to the same authorized Queue scope without
changing projection semantics? Inputs are the existing production-fail-closed Kitchen Playwright
journey and its browser route state; smallest check is the single journey, then inspect the existing
1440/390/320 captures and run `git diff --check`. This adds interaction assertions only; response data
remains synthetic and permissions/commands stay unchanged.

Kitchen detail keyboard-route verification result (2026-09-24): the production-fail-closed journey now
opens Details with focus plus Enter, returns with focus plus Enter, and confirms the prior `Queued`
filter is restored. Both production Kitchen scenarios pass 2/2. Refreshed detail screenshots at
1440/390/320 were inspected; no visual/layout change or overflow was found. Targeted ESLint/Prettier,
normal Merchant production build and `git diff --check` pass; the build keeps the existing 1,225.12 kB
chunk advisory. Synthetic route responses are not Store/KDS or Accepted Screen evidence.

Dining exact-checkout visual revalidation selection (2026-09-24): the recorded Dining screenshots are
absent from the current checkout, so inspect cannot be reused. Acceptance question—does the exact current
`/operations/dining` build retain the documented Figma-derived compact area grouping, bounded desktop
tile widths, selected-session hierarchy and single-column 390/320 layout? Inputs are the normal Dining
renderer/styles and existing production-fail-closed journey. Run the single `dining-session-start.spec.ts`
journey, inspect fresh 1440/390/320 captures and run Merchant typecheck, scoped ESLint/Prettier and
`git diff --check`; no Dining source or Make edits unless a concrete in-scope mismatch appears.

Dining exact-checkout visual revalidation result (2026-09-24): the current production-fail-closed Dining
journey passes 1/1; its captures were recreated and inspected at 1440/390/320. Desktop table tiles remain
112–144px despite only two synthetic tables; mobile layouts are single-column, the selected-table detail
and 44px confirmation target remain visible, and there is no horizontal overflow. Fresh normal Design
Review frames `24:60`/`24:109` retain the area/table/filter/selected-detail information order at 390/320;
the repository adds state-semantic coloring, so this records hierarchy/responsive alignment, not
pixel-identical styling. Dining tests pass 4/4; Merchant typecheck, scoped ESLint/Prettier, default
production build and `git diff --check` pass. The build retains its existing 1,225.12 kB advisory.
Fixtures remain synthetic; current Make save/edit, Store/UAT and broader Dining source requirements are
not established here.

Customer Delivery Status visual continuation selection (2026-09-24): Screen Registry `CUST-DELIVERY-STATUS`
and Handoff 88.6 constrain the page to authorized coarse delivery status, bounded ETA, safe proof/handoff
summary and support action; the ordinary route has no HTTP client and its fail-closed client returns
`FeatureDisabled`. Reuse the editable Customer Order Status Figma hierarchy (green header, journey
navigation, neutral canvas and state card) for that existing state. Preserve Guest-session copy, no
courier/location/proof claims and the existing Back to order link; do not add retry, sample tracking
facts, projection, endpoint or command. Verification: focused Delivery Status render tests, Customer PWA
typecheck and scoped ESLint/Prettier, production-exclusion route journey with fresh 1440/390/320 screenshots
and no-overflow assertions, then normal Customer PWA build and `git diff --check`.

Customer Delivery Status visual continuation result (2026-09-24): added editable Review frames for
`CUST-DELIVERY-STATUS` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=205-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=205-245), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=205-276), adapted from the existing
Customer Order Status Review hierarchy. The ordinary route now carries its green Customer header,
responsive journey navigation, neutral canvas and state card. Its actual fail-closed `FeatureDisabled`
copy, Guest Session boundary and Back to order status action are preserved; the retry control from the
template was removed, and no delivery facts or API were added. Focused page tests pass 4/4, Customer PWA
typecheck, targeted ESLint/Prettier and `git diff --check` pass. The production-exclusion browser journey
passes 1/1 and fresh 1440/390/320 screenshots were inspected; page overflow is absent and the compact
navigation scrolls within its own viewport. The normal Customer PWA build passes with its existing Vite
`inlineDynamicImports` deprecation advisory. Screenshots:
`apps/customer-pwa/test-results/delivery-status-{1440,390,320}.png`. The disabled tracking capability and
owner projection/HTTP source remain unresolved; Review frames and the intercepted local browser build do
not establish live Delivery or Store acceptance, Accepted Screen or project completion.

Kitchen current-tree Figma screenshot revalidation selection (2026-09-24): the exact current checkout
no longer has the previously recorded `kitchen-board-*`/`kitchen-detail-*` image artifacts, so prior
visual inspection cannot be reused. Re-run `e2e/kitchen-queue.spec.ts --project=production-fail-closed`
against the current Merchant source, capture fresh Queue/Work Item/Filter renders at 1440/390/320, and
compare the Queue with Figma `4:2` and Work Item with `51:2`/`51:3`/`51:4`. The known projection-derived
values are work-item name/state/quantity/age/modifiers; station display, safe Order/ticket refs,
structured allergen/exception facts and KDS lock authority stay unavailable. Acceptance is fresh
geometry/no-overflow evidence and confirmation that the sample Figma facts remain absent. After the
browser run, restore the normal Merchant build and run `git diff --check`; no API, projection, command or
permission change is selected unless evidence exposes an actually supported unmapped source field.

Kitchen current-tree Figma screenshot revalidation result (2026-09-24): production-fail-closed Kitchen
journey passes 2/2. Fresh Queue and Work Item screenshots were inspected at 1440/390/320, with Filter
screens at 390/320; layouts remain responsive and no horizontal overflow was found. The existing renderer
shows the available name/state/quantity/age/modifier facts and explicit unavailable station/capability
states; synthetic Figma sample facts remain absent. Queue hierarchy aligns with Figma `4:2`, and Work
Item neutral canvas/card hierarchy aligns with `51:2`/`51:4`; this confirms responsive hierarchy, not
pixel parity or live projection acceptance. The normal Merchant production build passes with its existing
1,225.12 kB chunk advisory and `git diff --check` passes. Targeted Prettier and `git diff --check` pass; no source change was required. Screenshots:
`apps/merchant-web/test-results/kitchen-board-{1440,390,320}.png`,
`apps/merchant-web/test-results/kitchen-detail-{1440,390,320}.png`, and
`apps/merchant-web/test-results/kitchen-filter-sheet-{390,320}.png`. Missing owner-backed fields and KDS
authority remain unresolved; these synthetic browser captures do not establish Store acceptance or project
completion.

Cross-surface exact-tree regression result (2026-09-24): after the Kitchen screenshot revalidation and
Customer PWA/Merchant visual continuations, full Customer PWA tests pass 54 files/890 tests, Customer
PWA TypeScript and ESLint pass; full Merchant tests pass 106 files/781 tests, Merchant TypeScript and
ESLint pass. These are fresh local unit/component results for the current source tree and synthetic
fixtures. They do not cover Playwright journeys beyond their separately recorded scoped runs, DB-backed
acceptance, external Store/Provider/UAT, Accepted Screen or production release gates. The earlier
current-checkout `CI=true pnpm build` result covers all 41 workspace build tasks with unchanged source
inputs; it remains reusable, with the recorded chunk/deprecation advisories. Exact-snapshot Linux
`pnpm verify` remains unresolved at Docker-backed acceptance.

Recipe admin reader current-tree recheck selection (2026-09-24): acceptance question—does the internal
Brand-bound active-generation reader remain compatible with the entire current Recipe package, and does
the ownership verifier still admit only this precise owner/schema/table/path? Affected inputs are
`recipe-admin-query-store.ts`, its Recipe tests/export/README, the isolated helper, acceptance integration,
and `tooling/database-ownership` rule/tests. Run the complete Recipe package test/typecheck/lint/format
commands and `database-ownership:check`. Reuse the 2026-09-23 isolated PostgreSQL run recorded above:
the exact acceptance helper, test integration and reader inputs are unchanged since that run; this
recheck has no Recipe persistence edits. Do not access the Docker socket, whose mount was rejected by
automatic approval review. This reader remains internal and does not supply the version2 public query,
builder, permission trimming, freshness, API or normal route.

Recipe admin reader current-tree recheck result (2026-09-24): complete Recipe package tests pass 9
files/98 tests; Recipe typecheck, ESLint and Prettier pass. `database-ownership:check` passes its 1087
rule tests and live validator. `git diff --check` passes. The isolated Recipe PostgreSQL acceptance is
reused from 2026-09-23 (1/1) because the reader, SQL, test-support helper and acceptance integration
inputs are unchanged; no host Docker access was attempted. The internal reader remains separate from
the public version2 Merchant view, builder, authorized API, freshness/source coverage and normal-page
composition. No Recipe implementation changed in this recheck.

Customer Menu permission-refusal state selection (2026-09-24): Screen Registry `CUST-MENU` includes
Permission Denied, while the normal public-menu GET has no application authorization middleware and
Catalog/API expose no denial result. The PWA can still honor a transport-level HTTP 403 without
inventing a Domain state: map status 403 only, do not parse/render its body, present generic refusal
copy plus return-to-entry recovery, and do not offer a same-context retry. Preserve 401/404/503 and all
existing parsing. This is client handling for an explicit HTTP denial only; it does not add or claim a
server permission gate. Verification: focused Menu client/page tests, Customer PWA typecheck, lint,
format and production build; `git diff --check`. No Catalog/API/domain/query/permission/route changes.

Customer Menu permission-refusal state result (2026-09-24): the PWA returns a distinct
`PermissionDenied` state for HTTP 403 before parsing the response body, then renders generic Store-session
copy and a Return to entry link without a retry. HTTP 401, existing versioned 404/503 mappings and safe
body parsing remain unchanged. Menu page/client tests pass 35/35; Customer PWA typecheck, lint, format,
normal production build and `git diff --check` pass. Build reports the existing Vite
`inlineDynamicImports` deprecation advisory. The current Express menu route has no application
permission middleware or 403 outcome, so this implements customer recovery for an explicit transport
refusal only. It does not establish a live permission-denial path, Feature Disabled or Conflict
contract, Store acceptance, Accepted Screen or overall completion.

Customer Menu Permission Denied browser verification selection (2026-09-24): verify the real
production-exclusion `/menu` route using an intercepted valid server session bootstrap followed by an
explicit HTTP 403 with non-JSON body. Acceptance: generic refusal heading/copy, no server-body leak or
same-context retry, Return to entry link, and card/no-horizontal-overflow screenshots at 1440/390/320.
Run the single new `customer-menu-permission-denied.spec.ts --project=production-exclusion`, focused
Menu tests, Customer PWA typecheck/lint/format/build and `git diff --check`. Only the client transport
mapping and Menu presentation change; no permission/API/Domain decision or backend path is introduced.

Customer Menu Permission Denied browser verification result (2026-09-24): production-exclusion
journey passes 1/1 using an intercepted valid bootstrap and explicit HTTP 403 with a non-JSON response.
It confirms the generic state, no body leakage or same-context retry, return-to-entry link, and no
horizontal overflow at 1440/390/320. Screenshots were inspected at all widths and are saved under
`apps/customer-pwa/test-results/customer-menu-permission-denied-{1440,390,320}.png`. Focused Menu tests
pass 35/35; Customer PWA typecheck, ESLint, Prettier, normal production build and `git diff --check`
pass. The 403 is synthetic and intercepted: the current public-menu route has no authorization
middleware/outcome, so server-side permission denial, live Store acceptance, and the full project gates
remain unresolved. Editable Figma Review frames `212:213`, `212:281`, and `212:349` now represent the
same generic recovery at desktop/mobile/compact widths using the existing Customer menu visual language;
the frame CTA corner radii match the 8px repository control style.

Exact-current-tree aggregate verification selection (2026-09-24): acceptance question—does the
repository's existing `pnpm verify` gate still pass after the latest Customer Menu transport/state,
the new source-limited `CUST-DINE-IN-SESSION` route, browser journey and WP evidence changes, and what
is its first unresolved failure on this exact checkout? Run the existing root `CI=true pnpm verify`
command once; its ordered static, contract, test/acceptance and build stages provide the smallest
named repository-wide gate for the whole-project status. Prior evidence is not reusable because
source, tests and docs changed. Record the exact stage and environment outcome; do not represent
external Store/UAT or release approval as covered by this command.

## Customer Dine-in Session Figma and route continuation (2026-09-24)

Screen Registry `CUST-DINE-IN-SESSION` and Handoff Section 88.6 define the Customer route
`/dine-in/session`, Guest Session plus exact Store scope, four source groups (Table / Dining Session,
active Order batches, shared payable summary, service / allergen notices), and mutation actions that
must wait for current authorized owner sources. The route is absent from the Customer router, and no
customer-safe current-session projection is composed there. Continue from the existing Customer
Inter/green/neutral Review family; create only a source-limited unavailable state, retain an Entry →
Dine-in → Menu → Cart → Checkout journey, and do not add sample participants, table/order references,
money, notices, refresh, payment, Batch submission or Staff request actions. Add the route only as an
explicit unavailable display with four unavailable field groups and Return to entry. Verification
selection: focused page test, Customer PWA typecheck, ESLint/Prettier, production-exclusion browser
journey at 1440/390/320 with no overflow, four field groups and no action assertion, then normal
Customer PWA build and `git diff --check`. This is UI route coverage only; Dining owner projection,
authorized actions, live Guest/Store/UAT, Accepted Screen and aggregate project acceptance remain
separate.

Customer Dine-in Session Figma and route result (2026-09-24): editable regular Figma Review frames
`216:213`/`216:243`/`216:272` now show the Customer source boundary at 1440/390/320. Final renders
were inspected: the Dine-in step is active, navigation follows the route sequence, and the four
unavailable field groups fit without overlap. The Customer router now recognizes `/dine-in/session`
and renders only the matching fail-closed hierarchy with no data client, sample business facts,
mutation controls or inferred permission result. The focused page test passes 1/1; Customer PWA
typecheck, ESLint and Prettier pass. The production-exclusion browser journey passes 1/1, asserts all
four field groups and no actions, and captured inspected 1440/390/320 screens without horizontal
overflow. The Customer PWA production build and `git diff --check` pass; the build retains its existing
Vite `inlineDynamicImports` deprecation advisory. This does not implement the missing query/commands
or close the owning Dining WPs.

Exact-current-tree aggregate verification result (2026-09-24): `source .local/activate.sh && CI=true
pnpm verify` passes repository guidance, module/import/domain/database ownership and permission,
migration catalog, foundation/helpers, OpenAPI/event catalog, root and all 41 workspace formatting,
root and all 41 workspace lint/typecheck, and the 210-record Screen Registry check. It stops at root
Vitest: 92/110 files pass, 1,968/2,070 tests pass, 102 fail, and 3 unhandled errors occur. The failures
include Linux-only `/proc/self/stat` and process identity assumptions, sandbox `EPERM` on loopback
binds, and environment-sensitive pilot supervisor/maintenance tests. Workspace tests, database
acceptance and the aggregate's final build are not reached. This exact root gate is not passing; the
focused Customer PWA build and browser evidence above do not replace it. Store/UAT, Accepted Screen,
Dining owner projection/commands and release acceptance remain unresolved.

## Customer Payment visual continuation selection (2026-09-24)

Screen Registry `CUST-PAYMENT` / `/checkout/payment`, Handoff Section 88.6 and WP-1704
own the exact Guest/Store scope, selected tip, amount returned by the authorized session query,
idempotent same-intent retry, secure Provider handoff, processing/unknown recovery, offline
read-only behavior and payment result boundary. Preserve the existing payment client and every
state/action contract. The current default build has no authorized Stripe or explicit local
simulation configuration and therefore renders `Online payment is currently unavailable.`
Continue from regular editable Figma Customer Review primitives (Inter, deep green, neutral
surfaces); add only the configured-unavailable screen at 1440/390/320, without amounts, tip
values, method names, card fields, intent references, or payment actions. In code, improve the
visual hierarchy of this existing unavailable state while preserving the existing checkout
payment journey and responsive behavior. Verification: focused SessionPaymentPage tests,
existing payment continuity E2E, Customer PWA type/lint/format/build, and browser screenshots at
1440/390/320 for the unavailable state; no root regression rerun because the exact-tree `pnpm
verify` result above already identifies the active aggregate blocker and no shared contract is
changed. No payment-provider/UAT, Store acceptance, Accepted Screen or overall completion claim.

Customer Payment Figma and route result (2026-09-24): editable regular Figma Review frames
`223:213`/`223:248`/`223:282` now cover 1440/390/320. The existing Customer Inter/green/neutral
language carries a Payment header, exact Guest/Store context, checkout journey navigation, unavailable
amount/tip/method/card/processing rows, and Back to checkout. Repository Payment now renders the same
source-limited unavailable hierarchy only when configuration is absent; existing create/retry, Provider
handoff, simulation gating, offline and outcome behavior remain intact. Focused page test passes 4/4,
Customer PWA typecheck, ESLint, Prettier, normal build, and `git diff --check` pass. The scoped
production-exclusion Checkout continuity browser journeys pass 8/8; the configured-unavailable route
journey passes 2/2 and inspects fresh 1440/390/320 screenshots saved under
`apps/customer-pwa/test-results/customer-payment-unavailable-{1440,390,320}.png`, with no horizontal
overflow or fabricated payment facts. Vite retains the existing `inlineDynamicImports` deprecation
advisory. The Figma work is an editable Review direction, not an Accepted Screen or Make save. This does
not establish real Provider, Store/UAT, complete Screen states, root/workspace test gate, release
approval or overall project completion.

Exact-current-tree escalated root test diagnostic (2026-09-24): re-ran the existing
`source .local/activate.sh && CI=true pnpm test` with loopback execution authorized, because the earlier
sandbox run included denied local binds and Payment code changed afterward. Root Vitest now passes
95/110 files and 1,972/2,070 cases; 15 files have 98 failing cases and one unhandled error. The failures
remain concentrated in pilot process/maintenance/recovery tooling on this Darwin host: spawned
platform-specific children exit nonzero, process identity relies on Linux `/proc/self/stat`, maintenance
ownership failures cascade, and the maintenance suite has a timeout. The escalation did not make these
Linux-specific process semantics available. Root Vitest stops before Turbo workspace tests, database
acceptance and aggregate build; it remains a failed exact-tree gate. Do not weaken the production Linux
process-identity checks to obtain a Mac pass. A designated Linux/WSL exact-tree run is still required.
This diagnostic does not change Kitchen source conclusions or establish Store/UAT, Accepted Screen,
release approval or project completion.

## Customer Menu Empty/Unavailable Figma continuation (2026-09-24)

Continue the Customer Menu Review beyond its Found state: Section 88.6 / `CUST-MENU` includes Empty,
and the current Menu page already supports an explicit Unavailable service outcome. Reuse the editable
regular Design Review file's existing Customer Inter/green/neutral shell; create separate Empty and
Unavailable frames at 1440/390/320. Empty shows only the current published-menu explanation and no
item/order action. Unavailable keeps the existing no-submission copy and Try again action. Preserve
the Menu route, active Browse navigation, allergen-help boundary and exact controller behavior. No
Catalog projection, Store, item or menu facts are to be added. The existing Figma Review file has no
linked design library, file variables, text/effect styles, Code Connect instances or matching code
components; existing editable Review frames are the visual source.

Result: added six editable regular Design Review frames `228:213`/`228:278`/`228:343` (Empty) and
`228:408`/`228:476`/`228:544` (Unavailable). Each preserves the existing title/navigation shell,
uses responsive message cards, shows only the Empty copy or existing Unavailable recovery action,
and includes no sample Menu rows. In the repository, Empty now has an explicit styling hook; Empty and
Unavailable use the same padded, centered card hierarchy, with the error state retaining its red
leading edge and primary retry. A targeted screenshot review found `.menu-help` used the undefined
`--bop-space-5`, invalidating its padding declaration; the CSS now uses the existing 16px spacing
token so its accessibility/allergen explanation stays inside the card at all widths. No query,
projection, action, permission or fixture behavior changed.

Verification selection/result: `MenuPage.test.tsx` passes 22/22; Customer PWA typecheck, changed-file
ESLint/Prettier, `git diff --check`, and the normal Customer PWA production build pass. The new
production-exclusion browser journey passes 1/1, injects only synthetic session/menu responses,
checks Empty has no action and Unavailable retry reissues the same read, and captures 1440/390/320
screenshots for both states with no document overflow. All six final captures were inspected; mobile
copy wraps inside both cards and all actions remain within the viewport. The E2E preview build retains
the existing Vite `inlineDynamicImports` deprecation advisory. Screenshots are saved as
`apps/customer-pwa/test-results/customer-menu-{empty,unavailable}-{1440,390,320}.png`. The Review
frames are editable design direction, not Accepted Screens or a private Make save. Synthetic HTTP
interception is not Catalog or Store acceptance.

Isolated platform diagnostic (2026-09-24): `source .local/activate.sh && CI=true pnpm exec vitest run
tooling/environment/pilot-recovery-resume.test.mjs` fails all 12/12 cases at
`pilot-maintenance.mjs:53` because the production guard requires `process.platform === "linux"` and
valid Linux process/maintenance ownership. This reproduces the broader root-test cluster on the
current Darwin checkout; the failures are not evidence that the guarded Linux flow should be weakened.
Use the designated Linux/WSL exact-tree run for that acceptance question.

## Shared spacing token correction - 2026-09-24

Verification selection: the CSS token audit found --bop-space-5 consumed by both Customer PWA and Merchant Web without a definition, invalidating every declaration that uses it. It also found two Merchant report headings using an undefined --bop-color-text-primary; replace those with the canonical default-text token. Define spacing step 5 as 1.25rem between the existing 1rem and 1.5rem scale steps, and restore the Menu help card's intended 16px/20px padding. No Screen 88 semantics, projection, routes, permissions or business actions change.

Acceptance question: do both applications resolve the shared token consistently and keep affected responsive pages legible after the spacing declarations become active? Affected inputs are the shared UI token and test, Customer and Merchant stylesheets, and Menu state browser assertion. Smallest checks are the UI token tests and Customer Menu state browser journey; because this is a shared style token used across both applications, broaden to the full Customer and Merchant component suites, typecheck/lint/format, all-workspace build and existing affected Menu, Pickup/Exceptions/Dining responsive journeys at 1440/390/320. Run browser journeys with their existing project/configuration and inspect fresh captures. This does not close unrelated root Vitest/Linux acceptance or external pilot gates.

Result: `packages/ui/src/tokens.css` now defines spacing step 5 as 1.25rem; the token test covers that declaration. Both Merchant report text references use `--bop-color-text-default`. Customer Menu help uses 16px vertical / 20px horizontal padding; the previous Menu Empty/Unavailable result's 16px-only measurement is superseded. The full Customer 55-file / 895-test suite, Merchant 106-file / 781-test suite, and UI token suite (4/4) pass. UI, Customer and Merchant typechecks, lint and formatting pass; root Prettier plus all 41 workspace format checks pass. `CI=true pnpm build` passes all 41 packages (38 cache hits; shared UI, Customer PWA and Merchant Web rebuilt), retaining the existing Customer `inlineDynamicImports` deprecation and Merchant 1,225.12 kB chunk advisory.

Fresh responsive journeys pass: Merchant Dining 1/1 at 1440/390/320 (filtering, selection, retry and confirmation), Customer local demo 30/30 (including Cart and Checkout at desktop/mobile, with the Cart flow internally setting 320px), and Customer Menu Empty/Unavailable 1/1 at 1440/390/320. Inspected captures: `apps/merchant-web/test-results/dining-board-{1440,390,320}.png` and `apps/customer-pwa/test-results/customer-menu-{empty,unavailable}-{1440,390,320}.png`. Dining area grouping and compact cards follow Make's visual direction while only using StaffDiningTable fields. Current Make visibly adds demo-only search by Session reference, Attention filter, Session references and elapsed minutes; those fields remain excluded from production UI because the authorized table source does not provide them. A current Make read confirms project/preview and source-tree access and a settable editor, but no code was edited, so save persistence remains unverified; the prompt/model/Send controls report team credits unavailable until 2026-09-30. Share and Publish settings were untouched. The regular Review frames and synthetic browser responses do not establish Accepted Screen or live Store acceptance.

The full root `pnpm verify` gate remains unresolved: previous exact-tree evidence stops in root Vitest because the Linux maintenance/process checks cannot pass on this Darwin host; Linux exact-tree verification, database acceptance, Store/UAT, release and production gates remain open. No full-project completion claim is made.

Cart screenshot follow-up: the focused `CUST-CART` local-synthetic browser journey
(`customer-demo.spec.ts --project=demo-desktop --grep CUST-CART`) passes 1/1 and captures
`apps/customer-pwa/test-results/cust-cart-{1440,390,320}.png`. All three captures were inspected.
The desktop item/summary columns and mobile stacked hierarchy remain legible; at 320px the menu
label shortens to `Menu`, text wraps within cards, and no horizontal document overflow is visible.
Captured item, amount, tax and Quote timestamp are synthetic review data, not live business facts.

Kitchen current-worktree visual revalidation selection (2026-09-24): the just-added shared
`--bop-space-5` token is consumed by Kitchen styles, so earlier captures predate this effective CSS
change. Compare the exact current `KIT-KITCHEN-QUEUE` and `KIT-WORK-ITEM` render against editable
Design Review nodes `4:2` and `51:2`, using only fields available in `kitchen_work_queue_v1`. Run the
existing `e2e/kitchen-queue.spec.ts --project=production-fail-closed` journey, inspect fresh
1440/390/320 Queue and Work Item screenshots, and retain its no-overflow, desktop grid, mobile filter,
read-only command and keyboard return assertions. No station-name joins, Store data or command/source
changes are selected because the only station value in this projection is an opaque reference.

Result: the current production-fail-closed Kitchen journey passes 2/2. Inspected fresh
`apps/merchant-web/test-results/kitchen-board-{1440,390,320}.png` and
`kitchen-detail-{1440,390,320}.png`: the Queue retains the three-column desktop/single-column mobile
layout; the Work Item keeps status/age, quantity, unavailable safety cues, and projection-backed
modifier name/quantity in responsive cards. The read-only lock, unavailable station label, and
unavailable owner groups remain visible; opaque station/ticket/order references and fictional Figma
sample facts remain absent. 320px header/focus/return layout and all six pages show no horizontal
overflow. This confirms local visual alignment with the current Figma hierarchy under the authorized
projection, not named station parity, live KDS/device lock, Store acceptance, Accepted Screen, or
production readiness. No Kitchen source changed, so previously recorded focused Kitchen tests and
type/lint checks remain applicable; the demo browser journey emits the existing >500 kB warning.

Kitchen desktop column-gutter Figma parity selection (2026-09-24): the inspected current 1440px
Queue capture has an 8px card-column gap, while Design Review node `4:2` specifies 24px between its
three cards. Set only `.kitchen-station-lane__items` desktop grid gap to the existing 24px token and
assert that computed gap in the current production-fail-closed browser journey. Keep the responsive
three-column desktop/one-column mobile layout, projection-limited unlabeled lane, all state cues and
disabled actions unchanged. Re-run the Kitchen journey, inspect fresh Queue/Work Item captures at
1440/390/320, run affected Kitchen component tests and Merchant typecheck/scoped lint/format, restore
the normal Merchant build and check `git diff --check`; no owner projection or command changes.

Result: the desktop Kitchen Queue card grid now uses the existing 24px spacing token, matching Figma `4:2`;
the Kitchen E2E asserts the rendered `column-gap` is 24px and continues to assert three desktop
columns and one mobile column. The production-fail-closed journey passes 2/2; fresh Queue and Work
Item captures at 1440/390/320 were inspected after the change. The larger desktop gutters now match
the Review frame, mobile vertical card separation stays usable, and the projection-limited labels,
modifier details, disabled commands and no-overflow behavior remain correct. `KitchenBoardPages.test.tsx`
passes 10/10, Merchant typecheck and targeted ESLint/Prettier pass, and the normal Merchant build
passes with the existing 1,225.12 kB chunk advisory. `git diff --check` passes. No Kitchen API,
projection, command, permission or fixture contract changed. Browser items remain synthetic; missing
station, allergen/exception, course/priority/SLA sources, live KDS authority, Store acceptance,
Accepted Screen, full verification and production readiness remain open.

Kitchen default-filter toolbar Figma parity selection (2026-09-24): Figma `KIT-KITCHEN-QUEUE`
node `4:2` shows four filter controls at the unfiltered desktop state, while the current page also
shows a disabled `Clear filters` button. Keep the clear action available after any loaded-field filter
is active, but omit it from the desktop toolbar until then; retain the always discoverable Clear
control in the mobile filter sheet. Extend the existing production-fail-closed journey to assert this
initial/active behavior and confirm the toolbar matches the four-control Figma hierarchy. Run the
Kitchen journey, inspect fresh 1440/390/320 Queue and Work Item screenshots, affected component tests,
Merchant typecheck/scoped lint/format, normal build and `git diff --check`. No source or filter
semantics change.

Result: the default desktop toolbar now shows only the four Figma filter controls; `Clear filters`
appears after a filter is active. The mobile filter sheet retains its always-present disabled/active
Clear control and Done action. The production-fail-closed journey passes 2/2, asserting Clear is absent
on the unfiltered desktop toolbar and available after filtering; focused Kitchen tests pass 10/10,
Merchant typecheck and targeted ESLint/Prettier pass, and the normal Merchant build passes with the
existing 1,225.13 kB chunk advisory. Fresh Queue and Work Item captures at 1440/390/320 were inspected;
the default desktop row now has four controls, mobile recovery is preserved, and there is no overflow.
`git diff --check` passes. Synthetic data, unverified Kitchen projection fields, live KDS authority,
Store acceptance, Accepted Screen and project/release completion remain separate and unresolved.

Kitchen desktop filter/count alignment Figma parity selection (2026-09-24): after removing the
unfiltered Clear action, the four desktop filters still stretch across the available row, unlike
Figma `KIT-KITCHEN-QUEUE` node `4:2`, which uses compact 142px controls with 12px gaps and places the
loaded work-item count at the right end of that row. Keep the current Queue heading/helper above;
move only the existing filtered item count beside the desktop filters, set the four supported filter
tracks to the Figma dimensions, and keep mobile count presentation on the existing station group.
Preserve two-column filter wrapping for 768–1199px and active Clear behavior. Assert desktop control
width/gap and count alignment in the fail-closed journey; inspect fresh Queue/Work Item screenshots at
1440/390/320. Run the existing Kitchen journey, affected component tests, Merchant typecheck/scoped
lint/format, normal build and `git diff --check`. No filter values, query, source or command changes.

Kitchen compact disabled-filter label selection (2026-09-24): the current source-supported desktop
control width is 142px to match Figma `4:2`, but the disabled Station/Allergen/Exception options show
long availability explanations that are visibly clipped. Use the concise selected value `Unavailable`
for those three disabled controls at desktop, retaining the accessible `Station`/`Allergen`/`Exception`
labels and the existing page/filter-sheet explanation that specifies which projection fields are
missing. Keep Work state selectable and do not imply the unavailable options are supported. Assert the
selected values remain understandable at 1440/390/320, run the Kitchen journey and focused component
tests, Merchant typecheck/scoped lint/format, normal build and `git diff --check`; no query behavior.

Kitchen desktop filter/count alignment and compact disabled-filter result (2026-09-24): the latest
production-fail-closed Kitchen browser journey passes 2/2 after moving the loaded item count to the
right of the 4 × 142px desktop controls with 12px gaps, and shortening the three unsupported selected
values to `Unavailable`. It checks control dimensions and vertical count alignment, asserts the
unsupported filters stay disabled, keeps Work state selectable, checks Clear's initial/active behavior,
and exercises 1440/390/320 layouts. Inspected latest 1440 and 320 Queue captures: compact filters and
count are readable at desktop; mobile keeps the count by its lane heading, one-column cards, and no
horizontal overflow. `KitchenBoardPages.test.tsx` passes 10/10, Merchant typecheck and scoped ESLint
pass, Prettier check passes, and the normal Merchant build for this app revision passed with its
existing large-chunk advisory. `git diff --check` is recorded at closeout. This is repository UI parity
only: source-backed station/allergen/exception data, real KDS authority, Store/UAT, Accepted Screen,
Linux exact-tree regression and overall project/release acceptance remain unresolved.

<a id="customer-checkout-result-unknown-state-figma-migration-selection-2026-09-24"></a>

Customer Checkout Result Unknown-state Figma migration selection (2026-09-24): the current result route
renders its correct Pending/Unknown/Failed/Succeeded source states but lacks the Customer header,
journey hierarchy and recovery card used by `CUST-CART`, Checkout and Payment. Continue from the existing
editable Operations Queues — UI direction Customer Payment Review frames; create an Unknown-state
`CUST-CHECKOUT-RESULT` trio at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=234-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=234-248), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=234-282). Match that hierarchy in the
existing `SessionPaymentResultPage` without changing the HTTP/controller contract: preserve explicit
Unknown/Pending/Failed/Succeeded meanings, same-operation refresh only, authoritative total and Order
link only on success, and no new payment/Order claims. Extend the current reload-recovery browser journey
to inspect Unknown at 1440/390/320 and assert no overflow, duplicate payment action, browser storage or
invented identifiers. Run focused Customer Payment tests, Customer typecheck/scoped lint/format/build,
the recovery journey and screenshot inspection, plus `git diff --check`; no API/Domain/permission changes.

Customer Checkout Result Unknown-state Figma migration result (2026-09-24): created editable regular
Design Review frames in the existing Operations Queues — UI direction file at `234:213`/`234:248`/
`234:282` for 1440/390/320. They reuse the Customer Payment Inter/green/neutral visual language, add an
amber unconfirmed-status cue, state “Neither success nor failure is confirmed,” and make the explicit
same-payment status check the primary action. Final Figma renders were inspected at all three sizes;
the top review note fits at 320px, desktop carries the canonical CUST-CHECKOUT-RESULT ID, and the
mobile compositions stay single-column. No payment intent, Order reference, amount or success sample was
added.

The ordinary `/checkout/result` now uses the matching full-width Customer header, one-row journey bar,
bounded status card, explicit recovery button and checkout return link. It preserves current-session
reads; the only refresh remains the existing explicit reconciliation path. The UI keeps Pending,
Unknown, Failed and Succeeded distinct, exposes authoritative total/Order navigation only on success,
and never displays synthetic intent/Order identifiers or totals while Unknown. The responsive geometry
asserts full-width header, one navigation row, 126/132px header, 60/56px navigation, 28/36px section
spacing and no document overflow at 1440/390/320. After correcting discovered grid spacing and touch
target stretch issues, the full production-exclusion reload/recovery journey passes 6/6; Unknown
screenshots were inspected at all three widths and are saved as
`apps/customer-pwa/test-results/customer-payment-result-unknown-{1440,390,320}.png`. Focused Customer
Payment tests pass 16/16; Customer typecheck, scoped ESLint, Prettier and `git diff --check` pass. The
journey's preview build passes with the existing Vite `inlineDynamicImports` advisory. No API, Domain,
permission or provider contract changed. These Unknown-state Review frames do not complete every
`CUST-CHECKOUT-RESULT` state or represent an Accepted Screen. Figma Make AI remains quota-gated until
Sep 30; no Make source, save, publication or sharing setting changed. Store/UAT, real Provider,
Accepted Screen, exact-tree Linux verification and full project/release completion remain unresolved.

<a id="customer-checkout-result-remaining-state-figma-selection-2026-09-24"></a>

Customer Checkout Result remaining-state Figma selection (2026-09-24): complete the same
`CUST-CHECKOUT-RESULT` Review coverage for `Pending`, `Failed`, and `Succeeded` at 1440/390/320,
reusing the Unknown-state hierarchy and existing Customer palette. Follow Section 88.6 and
`SessionPaymentResultPage`: Pending is not a second-payment prompt and may only offer explicit
same-payment status checking; Failed is terminal guidance/contact support with no pay-again action;
Succeeded alone may display the authoritative total and Order navigation supplied by the current
session projection. Review examples must be labeled synthetic and must not add a new real-payment
fact. Update only status presentation and visual evidence; keep reads, reconciliation, session
authority and Commands unchanged.

Verification selection: extend the existing production-exclusion `payment-reload-recovery.spec.ts`
to capture and assert the three remaining states at 1440/390/320, including correct state copy,
success-only total/Order link and absence of a new-payment mutation; rerun the focused payment-result
unit suite because the UI presentation changes. Run Customer PWA typecheck, affected ESLint/Prettier,
and `git diff --check`; build through the existing browser journey. This is synthetic browser
evidence, not Store/Provider acceptance or an Accepted Screen. No full repository regression applies
to this presentation-only change.

Customer Checkout Result remaining-state Figma/code result (2026-09-24): added editable regular
Design Review frames for `Pending` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-245), [320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-276);
`Failed` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-307),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-339), [320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-370);
and `Succeeded` at [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-401),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-433), [320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=240-464).
All nine final frames were visually inspected after tightening card spacing and aligning state-label
colors to the BOP semantic palette. The existing ordinary page now gives Pending, Failed and Succeeded
distinct token-backed status colors and a terminal Failed introduction; no state, session authority,
result query, reconciliation behavior, mutation or Payment/Order identity changed. Pending has only
the same-payment status check; Failed has no pay-again action; the total and Order link are still
rendered only when the current-session result is `Succeeded`. Figma's success amount is visibly marked
illustrative and no Order reference is printed.

Fresh `payment-reload-recovery.spec.ts --project=production-exclusion` passes 6/6 and captures all five
read states across 1440/390/320. Assertions cover no payment-creation controls or mutations, empty
browser storage, hidden synthetic Payment/Order references, success-only fixture total and Order link,
Pending same-payment checking, and no horizontal overflow. Refreshed screenshots for Pending, Failed
and Succeeded were inspected at all three sizes in
`apps/customer-pwa/test-results/customer-payment-result-{pending,failed,succeeded}-{1440,390,320}.png`.
The focused Customer Payment suite passes 16/16; Customer PWA typecheck and targeted ESLint pass;
Prettier and `git diff --check` pass. The browser journey builds the application and emits the existing
Vite `inlineDynamicImports` deprecation advisory. These are local synthetic UI checks; the Review file
is not an Accepted Screen and this result does not establish Provider/Store acceptance, Make save
persistence, Linux exact-tree verification or whole-project/release completion.

Dining Make Figma migration result (2026-09-24): fresh Make preview/code inspection confirms the
private Dining route and `DiningWorkspace.tsx` are readable, and the source editor is settable. The
Make Dining visual hierarchy shows its dark BOP Operations header, compact filter bar, area-grouped
table tiles and status key. Build prompt, model and Send remain disabled until the displayed
2026-09-30 credit reset; no Make source was changed and editor save persistence remains unverified.
Migrated the supported dark Operations header and the compact area-board/selected-table split into
the ordinary `/operations/dining` route. The detail/action panel sits beside the area board at
1024px+; 390px and 320px stay stacked. Preserved only fields supported by `StaffDiningTable` and
Handoff 88.11, keeping fictional Store/date, Occupied/attention flags, Session age/reference, and
Make-only navigation out of the runtime. Search, Table selection, explicit confirmation, start or
same-operation retry, one-time code recovery and Host Transfer are unchanged. The `DIN-FLOOR-BOARD`
Screen Registry authority/data gaps remain visible. Final `dining-session-start.spec.ts
--project=production-fail-closed` passes 1/1; its layout assertions cover the dark header, desktop
side panel, 390/320 vertical order and no horizontal overflow. Final inspected screenshots are
`apps/merchant-web/test-results/dining-board-{1440,390,320}.png`. `DiningPages.test.tsx` passes 4/4,
Merchant typecheck, targeted ESLint/Prettier and normal build pass, and `git diff --check` follows.
The build retains the existing 1,225 kB chunk advisory. The journey uses synthetic Local Demo data;
it does not provide full-floor, live Store, Dining projection, Accepted Screen or production
acceptance. Verification selection: inspect changed CSS/E2E plus this evidence entry and the

Kitchen projection-boundary footer Figma parity selection (2026-09-24): freshly rendered current
Queue/Work Item screenshots show the footer's long projection-limit sentence wraps into two desktop
lines and six lines at 320px, while Review `4:2`/`4:86`/`4:128` uses a compact single source-limit
note. Shorten only the Queue footer to name every unavailable reference/filter/action group in the
Review wording; retain the more detailed mobile filter-sheet explanation and the prominent KDS lock
notice. Do not add fields or change filter/command behavior. Run the existing production-fail-closed
Kitchen journey, inspect Queue/detail/filter screenshots at 1440/390/320, Kitchen page tests,
Merchant typecheck/scoped lint/format, normal build and `git diff --check`. This is visual copy
polish; no projection, permission or command verification applies.

Final screenshot review selection above: inspect changed CSS/E2E plus this evidence entry and the
project completion review for format/whitespace; no API, command, Domain or query verification applies.

Kitchen projection-boundary footer Figma parity result (2026-09-24): updated the component-test
assertions for the shorter note after its first run exposed two stale copy expectations; the
`KitchenBoardPages.test.tsx` suite then passed 10/10. The production-fail-closed queue/detail journey
passed 2/2 after the UI copy change. Final Queue screenshots at 1440/390/320 and Filter sheet at
390px were inspected; final Work Item screenshots at 1440/320 were inspected. The 1440 footer is one
line; 390/320 wrap naturally, with no horizontal overflow. Merchant typecheck, scoped ESLint,
Prettier and normal Vite build passed. The scoped Prettier check was first invoked from the package
directory with a repository-root evidence path and could not locate that Markdown file; the corrected
repository-root check passed. `git diff --check` passed. Build retains the existing approximately
1,225 kB chunk advisory. These checks do not close the KDS session/device authority, missing projection
fields, Accepted Screen, live Store/UAT, Make editing/persistence, or project/release acceptance gates.

Kitchen Figma/Make live access recheck (2026-09-24): private Make opens and its current
`/operations/kitchen` preview is readable. The preview labels its Store/date and `KT-*` ticket/order
values as fictional Demo data. Code view exposes the current `src/App.tsx` in a settable text entry
area, so editor input is enabled; no source edit, save or publish was performed, so durable save
permission/persistence remains unverified. The AI prompt/Build/Send controls are disabled by the
visible Sep 30 credit reset. Regular Design Review `7JHWMW9AVlAkI4ZCRGNiXw` context calls freshly
resolve `4:2`, `4:86` and `4:128` to Kitchen 1440/390/320 (the current `4:2` context explicitly names
`KIT-KITCHEN-QUEUE`). Fresh renders preserve the implemented shell, lock, filter, lane/card and
responsive hierarchy. Values absent from the current authorized projection remain unavailable in code;
Figma sample records are not promoted to live facts. Existing final production-fail-closed Kitchen
journey 2/2 and inspected local screenshots remain valid because no runtime source changed. This
recheck establishes Make preview/source visibility and an enabled editor field, not saved Make changes,
Accepted Screen, KDS authority, live Store/UAT or project completion.

Exact-current Docker CLI/socket recheck (2026-09-24): `.local/activate.sh` resolves Docker CLI 29.7.2
in `desktop-linux` context, but read-only `docker version` exits 1 with permission denied for
`/Users/ryanzhao/.docker/run/docker.sock`. No socket escalation or container command was attempted;
the earlier automatic approval rejection remains in force. Docker-backed `pnpm verify` acceptance
cannot be rerun from this checkout under current access. Continue repository work that does not need
the host socket, and keep whole-project verification unresolved.

Merchant Overview Figma current-tree recheck selection (2026-09-24): validate the already-migrated
`HOME-OVERVIEW` route against Review frames `31:2`/`31:47`/`31:88` after the broad current UI branch
changes. The authorized workspace provides a Store label and `Current|Stale` freshness; Figma separates
Store from a compact desktop freshness badge and hides the badge on mobile. Move only those existing
values into that responsive header hierarchy and preserve stale warning, permission-trimmed navigation,
four-card dashboard-unavailable state and Store selection behavior. Run focused shell tests and the
existing production-fail-closed `merchant-overview.spec.ts`, inspect all three screenshots, and check
the shared AppFrame and Merchant type/lint/format plus whitespace. Do not add WP-1905 dashboard source,
workspace contract fields or Store facts.

Merchant Overview Figma current-tree parity result (2026-09-24): the Review frames `31:2`/`31:47`/
`31:88` separate the authorized Store label from its freshness state on desktop and hide the freshness
badge on mobile. `MerchantShell` now renders the existing `Current|Stale` value as a neutral desktop
badge and keeps the Store description separate; existing stale warning and workspace behavior remain.
Fresh `merchant-overview.spec.ts --project=production-fail-closed` passes 1/1; its 1440/390/320
captures were inspected and show the desktop badge, hidden mobile badge, and no horizontal overflow.
Focused Merchant shell tests pass 4/4; Merchant and UI typechecks, targeted ESLint, Prettier, Merchant
Vite build, UI package build and `git diff --check` pass. Merchant build retains the existing 1,225 kB
chunk advisory. This uses only the already-projected Store/freshness values; no dashboard projection,
registry, permission or Store data changed. Review frames are not an Accepted Screen or live Store/UAT
acceptance.

Kitchen Work Item unavailable-detail card parity selection (2026-09-24): fresh regular Review renders
of `KIT-WORK-ITEM` `51:2`/`51:3`/`51:4` show its four Registry-required but currently unavailable
execution-detail fields as separate bordered cards inside a padded group. The repository currently
flattens those fields into one card with row dividers. Match the source grouping and responsive row
orientation, and use the Review's “Additional detail unavailable” heading and current Kitchen detail
projection explanation. Preserve every field as Unavailable and all current work-item facts/commands.
Run `KitchenBoardPages.test.tsx`, Merchant typecheck, scoped ESLint/Prettier and the existing
`kitchen-queue.spec.ts --project=production-fail-closed` journey; inspect fresh 1440/390/320 detail
screenshots and `git diff --check`. No query, projection, permission, command, Domain or owner-data
change applies. Browser payloads remain synthetic UI evidence only.

Kitchen Work Item unavailable-detail card parity result (2026-09-24): the detail route now matches
Review `51:2`/`51:3`/`51:4` by placing the four authorized-but-unavailable detail groups in separate
bordered rows inside a padded container. Mobile rows stack each field label and `Unavailable`; the
heading and explanation now identify the missing current Kitchen detail projection. No projected work
facts, command states or source behavior changed. The focused `KitchenBoardPages.test.tsx` suite passes
10/10; Merchant typecheck and targeted ESLint pass. The production-fail-closed Kitchen journey passes
2/2 after correcting its newly added CSS assertion to target one row; screenshots for Queue, Work Item
and Filter at 1440/390/320 (Filter at 390/320) were freshly generated and inspected. The new rows fit at
all sizes and no horizontal overflow appears. Prettier, normal Merchant build and `git diff --check`
pass; build retains the existing 1,225.09 kB chunk advisory. Sample data remains synthetic, and Registry
field coverage, real KDS operator/device authority, Accepted Screen, Store/UAT, Docker-backed full
verification and production gates remain unresolved.

Procurement Purchase Order Detail Figma Review continuation (2026-09-24): added `PROC-PO-DETAIL`
1440/390/320 Review frames in the regular editable file using the current Operations Inter/neutral
hierarchy. Source selection: Screen Registry `PROC-PO-DETAIL` plus Handoff 88.12 require issued
snapshots, separated workflow/fulfilment/closure states, acknowledgement, revisions, receipt and
discrepancy history, line completion, supplier performance timeline and registered action intents.
The three new frames are [1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=251-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=251-302), and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=251-389). A final screenshot pass
identified and corrected an initially clipped performance section; final renders show it in all
three layouts with no clipping or horizontal overflow. All PO, supplier, receipt, discrepancy and
performance facts remain Unavailable; registered actions remain disabled. This is design-only under
WP-2402 continuation: the normal Purchase Order client, authenticated projection/command composition
and WP-2134 implementation/acceptance remain outstanding. No runtime code changed and no app tests
apply to this Figma-only addition.

PO Detail Figma-to-repository selection (2026-09-24): the regular route `/app/supply/purchase-orders/:id`
currently falls back to a generic error panel when its default client reports `Unavailable`, although
Registry/Handoff fields and editable Review frames now define a source-limited detail state. Acceptance
question: does that ordinary detail route render those required groups without business facts, keep all
registered mutations disabled, and fit at 1440/390/320? Affected inputs are `PurchaseOrderPages.tsx`,
its styles and the existing `purchase-order-list-review.spec.ts`. Run that exact production-fail-closed
Playwright file, Merchant typecheck, targeted ESLint/Prettier and whitespace checks; no Procurement
Domain, query, persistence, permission, command or source projection input changes. No full WP-2134
suite applies to this WP-2402 visual/source-boundary continuation.

PO Detail Figma-to-repository result (2026-09-24): the default `/app/supply/purchase-orders/:id`
route now renders the matching source-unavailable detail hierarchy, including separate Workflow,
Fulfillment and Closure states; six issued-snapshot fields; ordered/received/open completion; supplier
response, revision and receipt/discrepancy history; Supplier performance timeline; disabled registered
actions; and the closure invariant. All business fields remain Unavailable and the route does not echo
its path reference. Browser journey `purchase-order-list-review.spec.ts --project=production-fail-closed`
passes 2/2 (List and Detail); the detail route is captured and inspected at 1440/390/320 with no
horizontal overflow. Final section order follows the Review: registered actions, closure invariant,
then Supplier performance timeline. Initial sandbox startup failed with loopback `EPERM`; the same
explicitly requested local journey then passed after reviewed escalation. Merchant Vitest passes all
781 tests across 106 files from the initial implementation; the focused `PurchaseOrderPages.test.tsx`
rerun after the final section-order adjustment passes 4/4. Merchant typecheck, scoped ESLint, Prettier
and `git diff --check` pass. The production-preview build inside Playwright succeeds with the existing
large-chunk advisory. The
ordinary authorized Procurement query/client, role-filtered data, commands, persistence and WP-2134
business acceptance remain open; this is UI migration only, not a Purchase Order workflow completion.

PO Editor unavailable-route continuation selection (2026-09-24): Screen Registry `PROC-PO-EDITOR`
requires Supplier/Buyer/Ship-To/currency, Offering-based lines, quantity/unit/price resolution,
terms/tolerance, totals/source allocations and registered authoring actions. Its normal edit route
currently falls back to a generic `Unavailable` panel instead of exposing those fields. Acceptance
question: does the default `/app/supply/purchase-orders/:id/edit` route show this source boundary,
keep all registered commands disabled, avoid PO facts/path-reference echo, and fit 1440/390/320?
Affected inputs are `PurchaseOrderPages.tsx`, its existing shared unavailable-state styling and
`purchase-order-list-review.spec.ts`. Run that existing production-fail-closed journey, the focused
Purchase Order component test, Merchant typecheck, scoped ESLint/Prettier and whitespace checks. No
Procurement query, persistence, authorization, command or pricing implementation changes; current
owner facts remain unavailable and WP-2134 workflow acceptance stays open.

PO Editor unavailable-route continuation result (2026-09-24): the regular `/app/supply/purchase-orders/:id/edit` route now presents the Registry field groups in the migrated Figma Review visual hierarchy. Missing Supplier/Buyer/Ship-To/currency, revision, Offering/quantity/unit/price/allocation, terms/tolerance and totals/validation facts all remain explicitly Unavailable. Save Draft/Revision, Validate, Submit, Approve and Issue stay disabled; approval remains distinct from explicit Supplier commitment by Issue. No opaque route reference or synthetic business fact is rendered. Production-fail-closed journey `purchase-order-list-review.spec.ts --project=production-fail-closed` passes 3/3 (List, Detail, Editor); final Editor captures at 1440/390/320 were inspected, with no horizontal overflow. Focused `PurchaseOrderPages.test.tsx` passes 4/4; Merchant typecheck, scoped ESLint, Prettier and `git diff --check` pass. Production preview emits the existing >500 kB chunk advisory. The ordinary authorized Procurement projection/client, authenticated command composition and WP-2134 business acceptance remain unresolved; this is visual/source-boundary work only.

PO List Review-to-repository refinement selection (2026-09-24): current ordinary `/app/supply/purchase-orders` screenshots were compared with Figma Review `PROC-PO-LIST` nodes `82:2`, `82:44` and `82:83` and Screen Registry `PROC-PO-LIST` / Handoff 88.12. The route already keeps projection facts unavailable, but its disabled filter controls render as native select boxes and its source/empty/field summaries do not follow the Review hierarchy. Acceptance question: does the default route preserve all four registered disabled filter dimensions on desktop, group them into the two Review mobile controls without losing accessible names, preserve mandatory list fields, and match the Review status/summary density without horizontal overflow at 1440/390/320? Affected inputs are `PurchaseOrderPages.tsx`, its page-scoped rules in `styles.css`, and `purchase-order-list-review.spec.ts`. Run the existing production-fail-closed PO journey, focused Purchase Order component test, Merchant typecheck, scoped ESLint, Prettier and whitespace check. The Playwright production preview rebuild covers the changed Merchant app. No query, source mapping, persistence, authorization, command, totals or Procurement behavior changes; WP-2134 data/action acceptance stays open.

PO List Review-to-repository refinement result (2026-09-24): the unavailable List screen now uses disabled neutral text fields in the Review layout, with four independently named registered filter dimensions on desktop and two grouped, accessible disabled controls on mobile. The source boundary, three status cards, empty result and registered-fields summary follow the desktop/mobile Review density; the summary explicitly includes ordered/received/open amounts and expected delivery. No PO, Supplier, cost, receipt or discrepancy records were introduced. Production-fail-closed journey `purchase-order-list-review.spec.ts --project=production-fail-closed` passes 3/3 for List/Detail/Editor; final List screenshots at 1440/390/320 were inspected, and the journey checks responsive grouping, card heights, required field summary and no horizontal overflow. Focused `PurchaseOrderPages.test.tsx` passes 4/4; Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass. Production preview succeeds with the existing >500 kB chunk advisory. The normal Procurement projection/client, field-level authorization and commands remain absent; WP-2134 data/action acceptance is open.

Kitchen Queue Figma density refinement selection (2026-09-24): fresh current-tree production captures were compared with Review `KIT-KITCHEN-QUEUE` nodes `4:2`, `4:86` and `4:128`. With every real queue item currently missing both structured allergen and exception facts, the card repeated two separate unavailable cue pills, making it about 30px taller than the Review card; the separate Details action also displaced the registered disabled work action from the Figma card footer, and the mobile read-only explanation wraps to three lines at 320px. Acceptance: keep both cue facts explicitly unavailable in one accessible queue cue, use the item title as the keyboard-accessible detail link so the registered action remains in the Figma footer position, and shorten the read-only explanation without implying operator authority. Affected inputs are `KitchenBoardPages.tsx`, Kitchen-scoped CSS, `KitchenBoardPages.test.tsx` and `kitchen-queue.spec.ts`. Run the existing production-fail-closed Kitchen journey, focused page tests, Merchant typecheck, scoped ESLint/Prettier and whitespace checks; inspect refreshed queue/detail/filter captures at 1440/390/320. This is queue visual and accessible-navigation refinement only; projection fields, unavailable values, command authority, server checks and persistence remain unchanged.

Kitchen Queue Figma density refinement result (2026-09-24): the queue now renders one accessible cue whose visible label states that allergen and exception cues are unavailable, the item title is the keyboard-accessible detail link, and the registered action remains in the card footer. Queue lock copy is shorter while explicitly keeping commands disabled; the detail view retains separate unavailable allergen and exception facts. Focused `KitchenBoardPages.test.tsx` passes 10/10 and `kitchen-queue.spec.ts --project=production-fail-closed` passes 2/2, including current 1440/390/320 queue journeys and card-height checks. Fresh queue and detail captures at 1440/390/320 were inspected; responsive queue cards remain compact and detail facts remain explicit. Merchant typecheck, scoped ESLint, Prettier and `git diff --check` pass. The production preview build reports its existing >500 kB chunk advisory. The first browser attempt exposed a strict-mode assertion matching all three cards; the locator was narrowed to the first cue and the rerun passed. No projection fields, unavailable source values, command authority, server checks or persistence changed.

Kitchen Make status-color parity selection (2026-09-24): the authenticated Make Code view exposes the current `KitchenWorkspace.tsx` source even though MCP `read_mcp_resource` returns `Unknown resource` for its generated resource link. Its status palette maps Queued to blue, Held to amber, In Progress to green, Completed to neutral gray, and Cancelled to red. The repository currently uses neutral Queued, blue In Progress, green Completed, and neutral Cancelled, unlike the Make design. Apply only this presentation mapping to the same existing source-projected status labels on queue and detail. Add computed-color assertions to the existing Kitchen browser journey; rerun it and inspect queue/detail screenshots at 1440/390/320, then run the directly affected Kitchen tests, Merchant typecheck, scoped lint/format and whitespace check. No status or command semantics, projection values, KDS authority, or sample records may change.

Kitchen Make status-color parity result (2026-09-24): read-only Make Code view exposed `src/components/KitchenWorkspace.tsx`; its Queued/Held/In Progress/Completed/Cancelled colors now match the repository's respective labels and remain identical on the Queue and Work Item routes. The current Make preview provides only fictional ticket references, ages, stations and sample item records, so none were imported. Production-fail-closed `kitchen-queue.spec.ts` passes 2/2 with computed background-color assertions for Queued, In Progress and Completed and fresh Queue/Detail capture paths at 1440/390/320. All six captures were inspected; card hierarchy remains responsive, unavailable facts remain explicit, and all Kitchen commands remain disabled because operator/device authority is unverified. `KitchenBoardPages.test.tsx` passes 10/10; Merchant typecheck, targeted ESLint, Prettier and `git diff --check` pass. Preview build retains the >500 kB bundle advisory. Figma Make's Code view is readable/settable, but its MCP source resource still returns `Unknown resource`; no Make text was edited and save persistence is unverified. Build/Send remain disabled until the Sep 30 credit reset. Publish/Share were untouched. This is visual parity only; Screen Registry owner fields, actual KDS session/device lock and live Store acceptance remain open.

Audit Record isolated PostgreSQL acceptance selection (2026-09-24): previous exact-snapshot Linux `pnpm verify` stopped before database acceptance because its container had no Docker executable. The current host has Docker Server 29.7.2 reachable after approved read-only daemon inspection. `packages/database/test/audit-record-acceptance.test.mjs` calls `withIsolatedDatabase` with fixed test case `audit_record`; the helper enforces the `bop_rms_test_<run>_<case>` namespace, test-only loopback profile, owner-checked private port lease and per-run Compose project/database/user/password, then cleans its isolated resources. Run only the existing root `CI=true pnpm audit-record:acceptance` to obtain fresh WP-0042/WP-0046 audit chain, RLS/ACL, append/correction, rollback and concurrency evidence. No production/pilot database profile or business records are inputs. This direct gate will not convert prior Darwin root-Vitest failures into a full `pnpm verify` pass.

Audit Record isolated PostgreSQL acceptance result (2026-09-24): `source .local/activate.sh && CI=true pnpm audit-record:acceptance` passes 1/1 on the current checkout using the isolated test Compose/database path. The acceptance test proves the WP-0042 append-only and WP-0046 chain/head/RLS/ACL/rollback/concurrency scenario for the test schema and role. It is a fresh database acceptance result, not a rerun or pass of root `pnpm verify`, workspace acceptance inventory, Store/UAT, release or production readiness.

## Customer Dine-in Session Figma parity follow-up (2026-09-24)

Figma Review nodes `216:213`, `216:243`, and `216:272` show a full-width Customer header and
journey navigation with a centered 880px content column. The current normal route instead inherits
the 55rem Order Status shell, constraining the header/navigation, and places each unavailable value
at the far side of a split row. The acceptance question is whether the normal `/dine-in/session`
route matches the Review's responsive outer hierarchy and compact four-line unavailable summary
without leaking the Design Review notice or adding Guest/Store/order/payment facts or commands.
Affected inputs are `DiningSessionPage.tsx`, `DiningSessionPage.test.tsx`, and Customer PWA CSS.
Run the focused Customer test, Customer typecheck, scoped lint/format, and the existing
`customer-dining-session-review.spec.ts --project=production-exclusion`; inspect refreshed 1440/390/320
captures and `git diff --check`. Its Playwright preview build covers the page bundle. No API, Domain,
Guest authority, Dining projection or command changes apply; Store/UAT and owning Dining workflows
remain outside this visual continuation.

Customer Dine-in Session Figma parity result (2026-09-24): the `/dine-in/session` page now uses
the Review's full-width BOP header and journey navigation, centered 880px content column, 38px
navigation pills, and compact `field · unavailable` rows. Typography and unavailable-card minimum
heights match the 1440/390/320 Review frames; the Review-only notice remains absent from the real
route. The route still renders only its four source-limited fields and Return to entry; no Guest or
Store facts, Order/payment data, or mutations were added. Focused `DiningSessionPage.test.tsx` passes
1/1, Customer PWA typecheck and scoped ESLint pass, targeted Prettier and `git diff --check` pass.
The production-exclusion `customer-dining-session-review.spec.ts` passes 1/1 after adding assertions
for full-width header/navigation, content width, responsive card heights, no Review notice and no
actions; refreshed screenshots at 1440/390/320 were inspected and show no horizontal overflow. The
browser journey rebuilds the Customer production preview and reports the existing Vite
`inlineDynamicImports` deprecation advisory. Dining owner projection/commands, accepted Store/UAT,
and overall project/release acceptance remain open.

## Kitchen filter control Figma parity follow-up (2026-09-24)

Figma `KIT-KITCHEN-QUEUE` node `4:2` shows the four desktop filter controls at 142 × 44px with
12px text and 7px corner radius. The current controls already use the supported four dimensions,
but inherit 13px text and a 6px radius from the shared form style. Acceptance asks whether their
rendered dimensions, label readability, spacing, and keyboard/selection behavior remain correct after
matching the Review typography and radius. Affected inputs are Kitchen desktop-filter CSS and the
existing `kitchen-queue.spec.ts` geometry section. Run that production-fail-closed journey, inspect
fresh 1440/390/320 Queue and Work Item captures, then focused Kitchen tests, Merchant typecheck,
scoped ESLint/Prettier and `git diff --check`. No filter options, unsupported fields, owner data,
permissions or commands change; synthetic browser records remain synthetic.

Kitchen filter control Figma parity result (2026-09-24): the four desktop filter controls now render
at 142 × 44px with the Review's 12px text and 7px radius while retaining native labeled selects,
the same available/Unavailable options, and keyboard behavior. The first browser run caught a later
shared-form rule overriding the new properties; the Kitchen-specific selector was made more specific,
then the production-fail-closed `kitchen-queue.spec.ts` passed 2/2. Its computed-style and geometry
assertions cover desktop size/radius/type, four-control spacing, and the queue-count alignment; all
1440/390/320 Queue and Work Item captures were inspected with no horizontal overflow. `KitchenBoardPages.test.tsx`
passes 10/10; Merchant typecheck, targeted ESLint/Prettier and `git diff --check` pass. The preview
build retains its >500 kB advisory. This is local visual parity only; the browser items are synthetic,
source-missing station/safety/search/SLA fields remain unavailable, KDS operator/device authority is
unverified, and Store/UAT, Accepted Screen, aggregate verification and production readiness remain open.

## Kitchen status badge Figma parity follow-up (2026-09-24)

Figma `KIT-KITCHEN-QUEUE` node `4:86` renders its queue-card status badge at 112 × 26px; Figma
`KIT-WORK-ITEM` node `51:4` renders the detail-card status badge at 78 × 28px. Both current routes
size their badges to text. Implement these distinct per-route badge dimensions without changing
status labels/colors, card actions, item facts, or mobile navigation. The three-column desktop Queue,
320px Queue status/time row, and Work Item title/status/age layout must remain non-overlapping and
within the existing detail-card height target. Affected inputs are Kitchen-scoped badge CSS and
`kitchen-queue.spec.ts` geometry assertions. Run the existing production-fail-closed Kitchen journey,
inspect Queue and Work Item captures at 1440/390/320, then focused Kitchen tests, Merchant typecheck,
scoped ESLint/Prettier and `git diff --check`. No status source, API, permission, command, or projection
field changes; browser records remain synthetic.

Kitchen status badge Figma parity result (2026-09-24): Queue status badges now match Review `4:86`
at 112 × 26px; Work Item detail badges use the distinct 78 × 28px geometry from Review `51:4`.
The first shared-size attempt made the 320px detail card exceed its existing 230px height target; the
route-specific override restores the Review title/status/age arrangement and keeps the target. The
production-fail-closed `kitchen-queue.spec.ts` passes 2/2 with exact geometry assertions at 1440/390/320;
all six refreshed Queue/Work Item captures were inspected, including the compact 320px detail card.
`KitchenBoardPages.test.tsx` passes 10/10; Merchant typecheck, targeted ESLint/Prettier and
`git diff --check` pass. The Playwright preview build retains its existing >500 kB advisory.

Exact projection recheck (2026-09-24): `KitchenQueueItemView` supplies opaque Order/Ticket/Work Item
references, source status, quantities, localized item names, selected options, station reference,
created/accepted/ready times, and version metadata. Future course/priority/SLA/hold/exception/claim/ETA/
structured-allergen capabilities are explicitly `NotAvailable`. The Merchant client deliberately maps
station label to null and allergen/exception cues to `Unavailable`; API returns `operatorStatus:
Unverified` because no active named KDS Session/device-lock source is composed. The UI already exposes
all returned display-safe facts and withholds opaque references/actions. No additional Registry field
can be populated from the current authorized projection without new owner contracts; this source map
is a boundary, not a live-Store acceptance or production-readiness result.

# Inventory Item Detail Figma Review migration selection (2026-09-24)

Screen Registry `INV-ITEM-DETAIL`, Handoff Sections 72.4 and 88.12, and WP-2120 require Item identity,
units, tracking / lot / expiry, scoped stock, reorder policy, supplier / usage summaries and history.
The existing regular Figma file had Review frames for `INV-ITEM-LIST`, but no standalone Item Detail
Review. Added editable source-limited frames for 1440/390/320 at [`260:213`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=260-213),
[`260:214`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=260-214), and
[`260:215`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=260-215). Migrate the design hierarchy only to
the normal route's `Unavailable` state. Preserve Found and every other error state. Keep Item, Store,
quantity, Ledger, Supplier, Recipe and history values unavailable; do not expose quantities without an
authorized single Stock Scope and Ledger freshness; keep all actions disabled. Affected inputs are
`InventoryPages.tsx`, its component tests, Inventory-scoped styles and a new production-fail-closed
browser journey. Run the focused component suite, Merchant typecheck, scoped ESLint / Prettier, the
1440/390/320 journey and screenshot inspection, plus `git diff --check`. No WP-2120 owner query,
projection, phase activation, permission, command, persistence, Make source or Accepted Screen status
change is in scope.

Inventory Item Detail Figma Review migration result (2026-09-24): the Review uses the existing
Operations/Inventory shell, explicit Phase 2 source boundary, selected Overview tab, disabled
section navigation/actions, identity summary, and owner-separated descriptive, unit, tracking,
scope-gated stock, reorder, Supplier, Recipe/SKU, Movement/Count and History groups. The 320px
heading was reduced after the first render overlapped its Screen ID; the duplicate identity card was
replaced with descriptive fields, and the stock group now states its scope requirement without
showing quantity fields. Fresh Figma renders at 1440/390/320 were inspected. The ordinary Item Detail
route now renders that hierarchy only when the default client returns `Unavailable`; Found and other
typed states remain unchanged. All displayed facts and actions remain unavailable, and no path ID is
echoed. `InventoryPages.test.tsx` passes 8/8; Merchant typecheck, scoped ESLint, Prettier check and
`git diff --check` pass. The new production-fail-closed
`inventory-item-detail-review.spec.ts` passes 1/1, verifies the source/action boundary and captures
1440/390/320; all three screenshots were inspected with no horizontal overflow. Its production preview
build succeeds with the existing >500 kB chunk advisory. WP-2120's authorized Inventory Item query,
single-scope Ledger projection, Supplier/Recipe feeds and commands remain unconnected; the Figma frames
are editable Design Review, not an Accepted Screen or project completion.

# Inventory Item Create/Edit Figma Review continuation selection (2026-09-24)

Screen Registry rows and Handoff Sections 72.4/72.13/88.12 cover `INV-ITEM-CREATE` and
`INV-ITEM-EDIT`: identity, units, tracking / lot / expiry, Store-scoped reorder policy, and
high-risk unit/tracking impact review. WP-2120 confirms the normal source query and commands are not
connected. Extend the regular editable Figma Review with Create/Edit frames at 1440/390/320 and
migrate only the ordinary routes' `Unavailable` state; keep Found and typed error states intact.
Keep all unavailable values and actions disabled, show the source boundary, and never add quantity or
opening-balance fields to the Item form. Affected inputs are `InventoryPages.tsx`, its component test,
Inventory-scoped styles, and a production-fail-closed route journey. Run the focused component suite,
Merchant typecheck, scoped ESLint/Prettier, both routes at 1440/390/320, inspect all screenshots, and
run `git diff --check`. No WP-2120 query, projection, permission, command, persistence, Make source,
or Accepted Screen change is in scope.

Inventory Item Create/Edit Figma Review continuation result (2026-09-24): added editable, responsive
Design Review frames for `INV-ITEM-CREATE` at [`264:213`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=264-213),
[`264:256`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=264-256), and
[`264:299`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=264-299), and `INV-ITEM-EDIT` at
[`264:342`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=264-342),
[`264:387`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=264-387), and
[`264:432`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=264-432). The first visual pass
found 320px wordmark wrapping and mobile field/action overlap; both were corrected in the Review
frames before migration. The ordinary routes now use the same source-unavailable hierarchy, owner
fields, Store-scoped reorder boundary, disabled registered actions, and explicit quantity/opening
balance invariant only when their default client returns `Unavailable`; Found and typed error states
are unchanged. Fresh production-fail-closed browser journey passes both routes at 1440/390/320 (1/1)
with no horizontal overflow, no editable controls, no fabricated records, and six inspected captures
at `apps/merchant-web/test-results/inventory-item-{create,edit}-{1440,390,320}.png`. Component tests
pass 9/9; Merchant typecheck, scoped ESLint, Prettier check and `git diff --check` pass. Its preview
build retains the existing >500 kB chunk advisory. The regular Figma frames remain Design Review,
not Accepted Screens; WP-2120 source/API/command composition, Make save persistence, and overall
project/release acceptance remain open.

## Supplier Detail Figma-to-repository selection (2026-09-24)

Acceptance question: does the default `/app/supply/suppliers/:id` `Unavailable` branch present the
reviewed `SUP-SUPPLIER-DETAIL` field hierarchy at 1440/390/320 while preserving Found and typed error
states? The source is the three Figma frames `284:213`, `284:256`, `284:299`; canonical fields/actions
come from Screen Registry and Handoff 88.12/88.13. Affected inputs are `SupplierPages.tsx`, its
component test, scoped styles and a production-fail-closed browser journey. Reuse current AppFrame and
unavailable-state styling. Do not render the route reference or synthetic/test Supplier facts; expose
only registered labels with unavailable/restricted values and the no-physical-delete / issued-PO
boundary. Do not change Procurement owner query, permissions, commands, persistence or Found rendering.
Run focused Supplier tests, Merchant typecheck/scoped lint/format, and a fresh 1440/390/320 route
journey with screenshot review plus `git diff --check`; this directly tests the new source-boundary
visual branch and fresh screenshots are required because the structure is new.

## Procurement Purchase Order Editor Figma Review design selection (2026-09-24)

The regular Review canvas has dedicated `PROC-PO-LIST` and `PROC-PO-DETAIL` frames but no
`PROC-PO-EDITOR` frame. The normal editor route already renders the Screen Registry field groups in
the source-unavailable state documented above; add a distinct editable Design Review at 1440/390/320
that follows the existing Purchase Order detail visual language. Preserve Supplier/Buyer/Ship-To/
currency, revision, Offering lines and allocations, terms/tolerance, totals, validation impact and
the approval-versus-Issue invariant; keep every value unavailable and authoring action disabled.
Acceptance is design completeness/responsive fit and source-boundary fidelity. Inputs are the new
Review nodes, the existing route/styles, and this evidence file; compare with the current route using
the existing production-fail-closed Purchase Order journey and inspect its 1440/390/320 captures.
Then check evidence Markdown formatting and whitespace. No code behavior or WP-2134
source/API/command scope changes.

PROC-PO-EDITOR Figma Review design result (2026-09-24): created dedicated editable Review frames at
[`269:213`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-213),
[`269:306`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-306), and
[`269:398`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-398). The first mobile
render exposed a column-pattern mismatch with the existing PO List/Detail and normal Editor route;
the final 390/320 frames use the established single-column reading pattern. Final Figma renders show
the full source boundary, all eight field groups, seven authorized Offering-line fields, five disabled
commands, the Inventory Goods Receipt boundary, validation placeholder and Approval-versus-Issue
invariant without clipping. The existing `purchase-order-list-review.spec.ts
--project=production-fail-closed` journey passes 3/3; fresh Editor screenshots at 1440/390/320 were
inspected and retain the same source-limited values, disabled commands, and no horizontal overflow.
The production preview reports the existing >500 kB chunk advisory. No repository code changed for
this Figma-only addition. These Review frames are not Accepted Screens; authorized Procurement reads,
authenticated commands, WP-2134 workflow acceptance, and overall project/release acceptance remain
open.

## Purchase Order Editor Figma-to-repository hierarchy refinement (2026-09-24)

Implement the existing `PROC-PO-EDITOR` Design Review hierarchy in the ordinary route's
source-unavailable state, using frames [`269:213`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-213),
[`269:306`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-306) and
[`269:398`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=269-398). Preserve Registry/Handoff
field and action semantics and WP-2134 ownership; do not connect the Procurement projection or
commands.

Result: the normal Editor route now matches the Review's compact amber source boundary, four-column
party group, two-column revision group, compact three-column Offering field rows, three-column terms
and totals, disabled three-column desktop actions and gray approval-versus-Issue boundary; mobile
groups reflow to one column. Added the Inventory Goods Receipt ownership notice. Found/data-backed
Editor states and API/command behavior are unchanged; the unavailable route has no editable controls,
route-reference echo or fabricated values. `PurchaseOrderPages.test.tsx` passes 4/4; Merchant
typecheck, scoped ESLint and Prettier pass. The existing production-fail-closed PO List/Detail/Editor
journey passes 3/3; inspected captures at `apps/merchant-web/test-results/purchase-order-editor-`
`{1440,390,320}.png` show no horizontal overflow or source/action boundary violations. The preview
build retains the existing >500 kB chunk advisory. Documentation formatting and `git diff --check`
remain for this refinement. Authorized Procurement reads/commands, WP-2134 business acceptance,
Accepted Screen, and full project/release acceptance remain open.

## Customer Dine-in Session Figma parity recheck selection (2026-09-24)

Acceptance question: does the current source-unavailable `/dine-in/session` route still follow
the existing regular Figma Review frames `216:213`, `216:243`, and `216:272` after the latest
repository changes, while keeping the four Registry groups visibly unavailable and avoiding
horizontal overflow at 1440/390/320? The existing production-exclusion browser journey already
contains those dimensions and captures; run it against a fresh synthetic production build, then
inspect all three captures. No new route behavior or source data is being introduced. The
`CUST-DINE-IN-SESSION` Design Review already exists in Figma, so no duplicate design frame is needed.

Result: the existing `customer-dining-session-review.spec.ts` passes 1/1 against a fresh Customer
PWA production preview; it checked all three widths and captured
`apps/customer-pwa/test-results/customer-dining-session-{1440,390,320}.png`. All captures were
inspected: wide content stays centered, mobile text wraps at 320px, and no horizontal overflow,
Review-only notice, editable action or fabricated Dining/Order/Payment value appears. The current
implementation already follows the Figma hierarchy, so no visual code change was needed. This is
local visual parity only; live Guest Session / Store / Dining owner sources and full project / pilot
acceptance remain open.

Database acceptance repair selection (2026-09-24): the first Linux exact-tree `pnpm verify` reached
the database stage but emitted three isolated acceptance failures. Re-run the existing
`vitest.identity-session-store.config.ts` acceptance serially in the isolated Docker/Linux harness
to remove temporary secret-file concurrency as a factor. Reconcile only evidence-confirmed stale
fixtures: the Identity inventory with its current migrations and the Customer Entry handler's
explicit request-admission dependency. Re-run these same five database acceptance files serially;
do not interpret temporary adapter failures as product defects or claim full `pnpm verify` until
the ordered root gate finishes. The original `pnpm verify` result remains recorded as failed.

## Customer Menu original Make visual alignment selection (2026-09-24)

Acceptance question: can the existing `/menu` renderer adopt the currently readable private Make
customer menu's white Store header, compact search/category navigation, and four-column desktop
cards without claiming prototype-only image, price, dietary or cart facts? The affected inputs are
`MenuPage.tsx`, the App shell render assertion, its scoped stylesheet, and the local demo notice
stylesheet. Preserve the Catalog
projection, Guest/Store authority,
allergen disclosures, and unavailable-image/final-Quote wording. Run the focused Menu render tests,
Customer typecheck, targeted lint/format, and the existing synthetic browser Menu journey at
1440/390/320; inspect fresh captures for hierarchy and overflow. A current Make Preview read
supplies the visual reference; its AI prompt is disabled until September 30, but no Make edit is
needed for this local visual transfer. No full business or database suite is selected because
source contracts and writes are unchanged.

Result: the current private Make Preview's Customer `/menu` is readable. The local `CUST-MENU`
now uses a white Store header, Menu title, full-width search entry, compact category navigation,
and lighter image-first cards; the synthetic preview notice was compacted on narrow screens.
The local 390/320 layouts use one card column because source-required allergen/Quote details do
not fit legibly in the prototype's narrower cards. The current Catalog Menu view lacks image,
display-price and dietary-tag fields, so their Make examples were not copied into the renderer;
the existing unavailable-image and final-Quote wording remains visible. Menu and App shell
component tests pass 35/35 after updating the Store-header assertion; Customer
typecheck and targeted ESLint/Prettier pass. The existing local demo
Menu browser journey passes 1/1 at 1440/390/320 using a temporary configuration that reuses
the already running preview; all three fresh captures were inspected. Its checks cover current
navigation, semantic content, console errors and horizontal overflow, not pixel-perfect Make
equivalence. This local visual transfer does not establish an Accepted Screen or Catalog/Store
acceptance. The Make project was read only; its AI prompt remains disabled until September 30.

## Customer Menu Search original Make visual alignment selection (2026-09-24)

The Owner's live `/menu/search` review shows that the prior regular Design Review form differs
materially from the private Make search route. The current Make Preview uses a back-to-menu
action, a single prominent search field, and a centered empty prompt. Preserve the canonical
standalone route and its approved term/section query, explicit Search/Clear actions, result
links and truth about absent dietary tags. Recompose only the search page and its scoped CSS;
update the existing browser journey to follow the current Menu navigation. Acceptance evidence:
focused Menu/App render tests and Customer typecheck; targeted lint/format; the existing
synthetic search browser journey at 1440/390/320 with screenshots, functional query/section/Clear,
console and overflow checks. This does not change Catalog/API contracts or claim Make data parity.

Result: `/menu/search` now uses the Make route's simpler back-to-menu/cart navigation, prominent
search field, and centered idle prompt while retaining the canonical Search/Clear, section filter,
result and source-limit disclosures. The focused Menu/App component run passed 35/35 tests;
Customer typecheck, targeted ESLint/Prettier, and `git diff --check` passed. The existing synthetic
search browser journey passed 1/1 with functional query/section/Clear, console and no-overflow
checks at 1440/390/320; all three resulting screenshots were inspected. Remaining visual
differences reflect required contract controls and unavailable Catalog image/price/dietary fields.

## Linux exact-tree and Catalog Product List continuation (2026-09-24)

The selected Figma page for continuation was `CAT-PRODUCT-LIST`. Its regular Design Review is already
present at `143:213`/`143:266`/`143:323`, and the 1440/390/320 artifact matches the Handoff field
groups and source-unavailable boundary. The normal Merchant route remains absent under the owning
Catalog WPs; no duplicate Figma frames or route implementation were added. The private Make project
and Dining source remain readable from the prior authenticated recheck, but its model/Build/Send
controls still show exhausted credits through 2026-09-30. A settable editor has no persistence proof;
no Make content, publish state or sharing setting changed.

The current isolated Linux `CI=true pnpm verify` rerun passes repository guidance, module/import/
domain/database ownership and permissions, migration/foundation/helper/OpenAPI/event checks, root
and all 41 workspace format/lint/type checks, Screen Registry, root tests (110 files/2,070 tests),
and all 41 workspace test tasks. Its ordered database acceptance chain passes Audit, Tenant,
Permission, Identity/Workforce, Customer Entry, and the Catalog checks through Option Set. It stops
at `availability-workbench-acceptance` because `withIsolatedDatabase` reports
`ISOLATED_DB_START_FAILED` while starting the Compose PostgreSQL service. The existing
`CI=true pnpm catalog-availability-workbench:acceptance` command passes separately (Catalog 237/237,
Contracts Events 31/31, Merchant Web 318/318 and PostgreSQL 1/1). The aggregate run therefore remains
incomplete, and its final `build` step was not reached.

During the same acceptance review, two stale Identity table inventories were reconciled to the
current migrations (`browser_session_selection`, `guest_entry_admission`, and 10 RLS tables), and
the Customer Entry HTTP fixture now supplies an explicit synthetic Allowed request admission. The
Ordering Cart test role was missing SELECT on `dining_cart_replacement`; those test roles now receive
only that table's SELECT grant. The `cart-aggregate` inventory now matches all 39 current
`rms_ordering` tables. WP-2314 specifies that only Active Carts whose idle and absolute expiry are
strictly after observation time are currently selectable. The read adapter now applies that filter
inside its scoped query; expired/terminal history remains available through the separate command
recovery reader, and absence does not authorize replacement. Unit tests pass 2,014/2,014 after
updating the current-read expectations. The Ordering Cart acceptance assertions passed across
focused isolated runs: `cart-aggregate` 1/1, Dining selection 1/1, `cart-query-store` 2/2,
configured quote 2/2, Cart items 2/2, binding 1/1, lifecycle 1/1, and quote attachment 1/1. One
broader run had a transient Compose-start failure for the first `cart-query-store` case; rerunning
that whole file passed 2/2.

The final current-tree `CI=true pnpm build` passes all 41 workspace tasks (34 cached, 7 executed).
Existing Turbo output-file advisories remain for Fulfillment, Kitchen, Ordering and Payment. These
repo checks and editable Review frames do not supply live Store/UAT, owner-composed normal routes,
Accepted Screens, release approval, or whole-project completion evidence.

## CAT-SKU-LIST Design Review (2026-09-24)

Created three editable frames in regular Figma Design file `7JHWMW9AVlAkI4ZCRGNiXw`, page `0:1`,
following the existing `CAT-PRODUCT-LIST` BOP Commerce visual direction: desktop 1440 (`273:213`),
mobile 390 (`273:263`), and compact 320 (`273:315`). Captures were inspected after layout
correction. The desktop view retains the Handoff's registered SKU columns and shows
disabled/unavailable search and filters; mobile frames group registered fields into responsive
cards. All frames are labeled Review / Not Accepted, Create/Export/bulk actions are disabled, and
the unavailable source notice suppresses SKU, Product, Barcode, price, recipe, inventory, and
status facts rather than inventing rows.

This is a visual design artifact only. CAT-SKU-LIST still needs its owning WP-1020/WP-1027
projection, permissions, query, commands and normal route before implementation or acceptance. No
Figma Make AI generation, publish or share action was performed; Make credit exhaustion remains
through 2026-09-30 and editor persistence is unverified. Whole-project verification remains
incomplete for the Compose PostgreSQL startup failure recorded above.

## Current Kitchen Make parity and browser revalidation (2026-09-24)

Reopened the authenticated private Make preview at `/operations/kitchen`. It remains readable; its
screen still identifies Demo/Fictional data and exposes Queue statuses, while Build/model/Send remain
disabled until the displayed Sep 30 credit reset. No Make source, sharing, or publish state was
changed. The repository already follows the Make status palette (`Queued` blue, `Held` amber,
`In Progress` green, `Completed` neutral, `Cancelled` red), but the editable regular Design Review
frames had an older Queue/detail palette. Reconciled nine visible Queue and Work Item status badges
across `4:2`, `4:86`, `4:128`, `51:2`, `51:3`, and `51:4` to the current Make/repository colors. New
captures of Queue at 1440/390/320 and Work Item at 1440/320 were inspected. Review frames remain
Review artifacts, not Accepted Screens; demo rows and cues remain fictional and were not transferred.

Re-ran the existing `kitchen-queue.spec.ts` production-fail-closed browser journey on alternate local
ports because an existing Merchant Vite preview already owned port 5173. A temporary config outside
the repository used ports 5175/4175; the exact command was
`source .local/activate.sh && pnpm --filter @bop-rms/merchant-web exec playwright test --config=/private/tmp/kitchen-playwright.config.ts e2e/kitchen-queue.spec.ts`.
Both scenarios passed (2/2). Fresh local queue captures at 1440/390/320 and the 320 Work Item detail
capture were inspected: no horizontal overflow; the compact controls/cards remain legible; unsafe
commands stay disabled. The captures are synthetic: [`1440`](../../../apps/merchant-web/test-results/kitchen-board-1440.png), [`390`](../../../apps/merchant-web/test-results/kitchen-board-390.png), [`320`](../../../apps/merchant-web/test-results/kitchen-board-320.png), and [Work Item 320](../../../apps/merchant-web/test-results/kitchen-detail-320.png).

Fresh affected-input checks pass: Kitchen page Prettier, ESLint and Merchant typecheck. The full
production-fail-closed browser journey builds the preview and retains the existing >500 kB chunk
advisory. Current host `docker version` reports a Docker client but cannot access the Docker Desktop
socket, so this turn did not rerun database acceptance or the aggregate `pnpm verify`; the prior
isolated-Linux aggregate still stops at Availability Workbench Compose startup as recorded above.
Registry-required safe Order/ticket search, course/priority/overdue, complete safety/detail projection,
active named KDS Session/device-lock source and server command fence, live Store/UAT, Accepted Screen,
and aggregate release gates remain unresolved. This closes visual parity evidence only.

## Current Linux exact-tree full verification rerun (2026-09-24)

Acceptance question: does the current tracked repository snapshot pass its complete local WP-2402
repository gate when the Linux environment supplies Docker Compose and isolated PostgreSQL? The
fresh check ran `CI=true pnpm build && CI=true pnpm verify` against an isolated current-tree copy,
including current tracked edits, `.git` metadata, and generated build outputs. The container used a
temporary Compose CLI plugin registration and the repository Docker wrapper; no credentials or
private `.env` files were copied into the snapshot.

Result: the standalone build passed all 41 workspaces. The full `pnpm verify` then passed the root
repository, architecture, migration, format, lint, typecheck, Screen Registry (210 records), root
tests (110 files/2,070 tests), all 41 workspace format/lint/typecheck/test tasks, and the ordered
PostgreSQL acceptance chain through `dining:acceptance`; its final all-workspace build passed all 41
workspaces. Database Compose startup passed with the temporary Linux plugin registration. This
supersedes the earlier isolated aggregate attempt that stopped at Availability Workbench; the earlier
attempt's harness/plugin failure was environmental and is not a current product failure. The same-day
Dining 1440/390/320 browser journey and inspected screenshots remain the browser evidence recorded in
the Dining section above; they were not rerun as part of this Linux full-verification invocation.

This closes the repository verification gate for the observed checkout only. It does not supply
normal owner-composed routes for every Registry screen, Accepted Screen approvals, actual Store/UAT,
live Provider/printing/KDS/staffing evidence, release approval, or production go/no-go. The private
Make Design and source are readable, while AI Build/model/Send remain disabled through the displayed
2026-09-30 reset; the source editor accepts text input but durable save permission was not proven and
no Make write/publish/share action was attempted.

## Kitchen desktop Queue width Figma correction selection (2026-09-24)

Acceptance question: does the normal `KIT-KITCHEN-QUEUE` desktop content retain the Review frame's
1120px queue width at 1440 while preserving existing 390/320 layouts and projection-limited facts?
Affected inputs are the queue-only CSS rule and existing `kitchen-queue.spec.ts` production-fail-closed
journey. Run that responsive journey and inspect fresh 1440/390/320 Queue and Work Item screenshots;
also run Merchant typecheck, targeted ESLint/Prettier and `git diff --check`. The journey is fresh
because the geometry rule and assertion are new; no Domain/API/projection behavior changed.

## Kitchen desktop Queue width Figma correction result (2026-09-24)

The existing production-fail-closed responsive journey passed 2/2 with the new 1440px geometry
assertion. The Queue workspace now matches Review `4:2` at x=260 and width=1120. Fresh Queue and
Work Item captures at 1440/390/320 were inspected; the mobile Queue layout is unchanged, and the
Work Item remains readable with unavailable projection fields explicit and commands disabled.
Captures: [`Queue 1440`](../../../apps/merchant-web/test-results/kitchen-board-1440.png),
[`Queue 390`](../../../apps/merchant-web/test-results/kitchen-board-390.png),
[`Queue 320`](../../../apps/merchant-web/test-results/kitchen-board-320.png),
[`Work Item 1440`](../../../apps/merchant-web/test-results/kitchen-detail-1440.png),
[`Work Item 390`](../../../apps/merchant-web/test-results/kitchen-detail-390.png),
[`Work Item 320`](../../../apps/merchant-web/test-results/kitchen-detail-320.png).

Fresh affected-input checks passed: `CI=true pnpm --filter @bop-rms/merchant-web typecheck`, scoped
ESLint for `KitchenBoardPages.tsx` and `kitchen-queue.spec.ts`, Prettier for the touched CSS, E2E and
evidence files, and `git diff --check`. The preview build retains its existing Vite >500 kB chunk
advisory. The change is limited to desktop Queue content width and its browser assertion; it adds no
business fields or permissions. Queue projection limitations, named KDS Session/device authority,
Accepted Screen, live Store/UAT, and project/release completion remain open.

## Supplier Detail Figma Review selection (2026-09-24)

Continue the project's regular Figma Design Review set while Make generation is quota-limited. Add
responsive `SUP-SUPPLIER-DETAIL` Review frames at 1440/390/320 to existing file
`7JHWMW9AVlAkI4ZCRGNiXw`, matching the editable Supplier List/PO Detail visual language. Follow Screen
Registry and Handoff 88.12/88.13: identity, field-masked contacts and addresses, qualifications and
evidence, authorized Offering/PO/performance summaries, and history/audit. Render each unavailable
field as unavailable, never copy supplier/contact/certificate data from synthetic test fixtures, and
mark all frames Review / Not Accepted. Registered lifecycle and relation actions remain unavailable.
This selection is Figma artifact work within WP-2402's design-continuation scope; it does not modify
WP-2131 code, projections, permissions, commands, persistence or acceptance status. Capture and
inspect the resulting three frames, then record IDs and remaining owner/runtime gates.

Supplier Detail Figma Review result (2026-09-24): created editable regular Design Review frames
[1440](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=284-213),
[390](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=284-256) and
[320](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=284-299) by adapting the existing
Supplier List Review hierarchy. The frames cover Supplier identity, masked contact name/email/phone,
business/remittance address and tax-registration restriction, qualification/evidence, authorized
Offering/open-PO/performance summaries and history/Audit. Registered edit, qualification review,
suspension and related-route actions are explicitly unavailable; suspension preserves issued POs and
physical delete remains forbidden. Fresh screenshots at all three widths were inspected after
clarifying contact fields and the disabled action contract; text stays within the frames and the 320px
footer wraps cleanly. The frames contain no supplier, contact, address or certificate samples and
remain Review / Not Accepted. No repository code or WP-2131 owner contract changed. This provides
visual design coverage only; owner-composed Supplier query/permissions/commands, Store evidence,
Accepted Screen and project/release acceptance remain open.

## Supplier Detail Figma-to-repository selection and result (2026-09-24)

The default `/app/supply/suppliers/:id` `Unavailable` state now uses the reviewed hierarchy; Found
rendering and typed load/error states are unchanged. Only Registry labels and explicit
`Unavailable`/`Restricted` markers render; the URL reference and synthetic Supplier/contact/certificate
facts are not shown. Registry actions and immutable PO / no-physical-delete rules remain visible as
unavailable. The fresh production browser journey passed 1/1 at 1440/390/320 with no horizontal
overflow, and the final screenshots were inspected at
`supplier-detail-1440.png` (historical capture; unavailable in this checkout),
`supplier-detail-390.png` (historical capture; unavailable in this checkout), and
`supplier-detail-320.png` (historical capture; unavailable in this checkout). Supplier component tests
pass 5/5 with `CI=true pnpm --filter @bop-rms/merchant-web exec vitest run src/SupplierPages.test.tsx`;
the browser command was `CI=true pnpm --filter @bop-rms/merchant-web exec playwright test
--config=/private/tmp/kitchen-playwright.config.cjs e2e/supplier-detail-review.spec.ts`. Merchant
typecheck, scoped ESLint/Prettier and `git diff --check` pass. The preview build retains the existing
Vite >500 kB chunk advisory. Figma sources remain Review / Not Accepted frames
[`1440`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=284-213),
[`390`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=284-256) and
[`320`](https://www.figma.com/design/7JHWMW9AVlAkI4ZCRGNiXw?node-id=284-299). This local unavailable-state
visual migration does not complete WP-2131 owner projection/command acceptance, Accepted Screen,
live Store/UAT or project/release gates.

## Requisition Detail Figma Review draft (2026-09-24)

`PROC-REQUISITION-DETAIL` is a canonical Phase 3 `/app/supply/requisitions/:id` screen in Screen
Registry/Handoff 88.12. WP-2133 requires need sources, requested lines/quantities, candidate
suppliers, approval, PO allocations and timeline; actions include draft edit/submit, review/approve or
reject, split allocation and reasoned remainder cancellation. Three regular Figma Design Review
frames were created at 1440/390/320 by reusing the existing Procurement review visual language
(desktop `287:213`, mobile `287:307`, compact `287:399`). They are Review / Not Accepted artifacts.

After the Owner redirected priority from additional UI work to project completion, repository migration
was deferred. No route, query, permission, command, Domain, persistence or WP-2133 acceptance changed;
the Requisition detail route still falls back to the unavailable List presentation. The frames do not
establish owner facts, a production route, business acceptance or project completion. No tests were run
for the deferred migration.

## Kitchen API named-session policy fence (2026-09-24)

Handoff Section 87.11.1 and WP-1808 require Kitchen execution to use a named KDS Operator Session;
the existing `createMerchantKitchenCommand` authenticated the current session and checked
`kitchen.operate`, but did not check the Session policy. The API now rejects any authenticated
session whose policy is not `NamedKdsOperator` before opening the business transaction. Missing or
malformed policy also maps to the existing non-reflective `KITCHEN_WORK_PERMISSION_DENIED` result.
The actor, Brand, selected Store and permission checks still run in their existing scope-bound path.

Focused verification selection: this changes the Kitchen command authorization boundary, so the
acceptance question is whether only a current named-KDS-policy session reaches the existing scoped
command path and whether unrelated API behavior remains intact. The smallest behavior test is
`merchant-kitchen-command.test.ts`; because authentication/authorization is the changed boundary,
run the complete API test suite plus API typecheck, lint, build, formatting and whitespace checks.
No persistence or Domain inputs changed, so database acceptance is not selected for this adapter-only
guard.

Result: all 183 API test files / 1,848 tests pass with local loopback permission; the earlier
sandboxed run was interrupted after unrelated HTTP tests timed out on denied loopback. API
typecheck, lint and build pass, as do Prettier and `git diff --check`. A named policy alone does not
prove the current selected Store, active device, visibility lock, or lock-before-handover state.
Those owner-backed KDS continuity facts and the complete server command fence remain unresolved under
WP-1808; no live Device/Store evidence, command-ready KDS state, or production acceptance is claimed.

Source recheck: Identity's current-session contract returns the authenticated `Session` policy and
Store selection is separately resolved by the Merchant scope. Device assignment carries only a
`namedOperatorSessionSummaryReference`; the checked-in Device persistence package has no reader that
resolves it to an active Session/lock. The Kitchen `kds_operator_handover` and
`kds_recovery_reconciliation` tables are append-only history, while Device KDS Profile tables store
configuration and UAT facts; none represents a current visibility lock. Therefore the new policy
check closes the session-kind condition only. Completing the server fence needs an owner-authorized
live lock source and transaction-bound resolution before command execution; do not reinterpret the
assignment reference or historical handover as that source.

## Task assignment transport idempotency boundary (2026-09-24)

Source tracing confirms the Task Domain exports `assignTask`, the Task owner store and
`createMerchantTaskAuthorization` supports current `task.assign` scope authorization, while the
Merchant BFF exposes only `GET /tasks`. A generic assignment endpoint is not a route-only omission:
`assignTask` validates that the loaded Task version equals the command's expected version before
calling the store. `createPostgresTaskStore` exposes current-record `load` and `commit`, but no
owner-level operation-result or historical-version reader. Its commit can distinguish an existing
same-key mutation by digest, but an HTTP retry after the first commit would load the newer Task
version and fail the service's expected-version check before reaching that replay fence. The API must
not query `bop_task.task_version` directly to work around the missing owner port.

The next Task assignment slice therefore needs an explicit owner contract for resolving a prior
idempotent Task mutation under current Task scope, binding operation, Task, expected version and
request digest, before composing `task.assign` over HTTP. Task target eligibility/directory facts and
the Exception-to-Task source mapping remain separately required for the Order Exception screen. No
Task, API or Screen behavior changed in this source audit; this is a confirmed composition gap, not a
verified assignment workflow.

Task owner-scope recheck (2026-09-24): the assigned WP-0125 brief explicitly forbids persistence
adapters and production API/routes, declares persistence and production API hard stops, and limits
its implementation to a fixed 15-file allowlist that excludes the current API and Task persistence
store. Therefore the missing operation-result reader and HTTP assignment adapter cannot be added as
a continuation of WP-0125 or smuggled into WP-2402. Before implementation, the Task owner must
authorize a follow-up persistence/API work package that defines same-key replay result semantics,
current-scope reauthorization, request-digest binding, concurrency and the Task response contract.
Until then, keep generic Task assignment and Exception actions unavailable; this is an owner-scope
gate, not a test failure. Verification selection: compare the Task service/store behavior with
WP-0125 decisions 10, 11, 19 and 21 and its exact file allowlist; check this evidence text, source
links and formatting only. No business suite or build applies to this documentation-only update.

Result: the WP-0125 hard stop and excluded-file boundary were confirmed directly against its current
brief. The continuation now distinguishes Task Domain Assign support from absent HTTP replay-safe
assignment and records the precise owner action required to start that implementation. No Task, API,
Screen, permission or persistence behavior changed; no workflow is claimed complete.

## Inventory Phase 2 capability source recheck (2026-09-24)

Acceptance question: does the current repository provide a current, authorized Brand/Store-scoped
capability source for Registry `INV-ITEM-LIST` before the persisted Inventory Item repository is
exposed through a Merchant route? Compare Registry `inventory.inv_item_list` / `phase_capability`,
WP-2120 and DEC-PILOT-INV-01 with Feature Control's public Release Flag contract, owned persistence
reader and API composition. This is source reconciliation only: no phase activation, Item API, query,
route or UI change is selected. Check the source references, this record and Markdown formatting;
business suites/builds are not applicable.

Result: `INV-ITEM-LIST` remains Phase 2. DEC-PILOT-INV-01 authorizes Inventory Item persistence but
does not activate that capability. Feature Control defines generic Release Flags and persists
`control_version` / dependencies, but the only current PostgreSQL query adapter is the Kill Switch
reader; no Release Flag query or Merchant capability composition is present. Inventory's owner
`load` is a single-item internal repository method and does not authorize a Phase 2 list or prove a
Merchant capability. The API must not read Feature Control private tables directly. The Item route
therefore remains source-unavailable until an owner-scoped capability reader and authorized query
composition are implemented; no Item route, permission, data or Phase activation is claimed.

Owner scope: WP-2193 assigns Release Flag and Store Capability ownership to `@bop/feature-control`,
but its exact tracked-file allowlist excludes `apps/api`. Its local completion status does not supply
an API route or normal Merchant composition. A follow-up must extend the Feature Control owner read
contract and add API composition through that public source before enabling any Inventory query; do
not place the adapter in Inventory or query `control_version` from the API.

## Persisted Customer Dine-in Cart current-selection recheck (2026-09-24)

Acceptance question: after Ordering's current Dining Cart reader began excluding superseded,
terminal, idle-expired and absolute-expired Carts, does the existing Customer lab still complete
authenticated Dine-in admission and persisted Cart edit/shared-table flows while Pickup Quote
repricing remains intact? Affected inputs are the `dining-cart-read-store.ts` filter, its focused
tests and the existing local Customer lab runtime path. Run the existing
`CI=true pnpm customer-lab:acceptance` isolated PostgreSQL/browser journey. Do not include Ordering
lifecycle paths unless the Customer lab exposes a regression; do not reuse the earlier Batch 581 lab
evidence because the current eligibility read predicate changed. No live pilot Store/database, UI
visual change or new behavior is selected.

Result: the first sandboxed `CI=true pnpm customer-lab:acceptance` attempt failed both cases before
business execution because Docker Desktop socket access was denied (`ISOLATED_DB_START_FAILED`).
`docker version` confirmed a local Docker client but the default sandbox could not access
`~/.docker/run/docker.sock`. The same existing command was then run with approved elevated local
Docker access; the isolated database/browser lab passed 2/2 (Dine-in admission and persisted Cart;
Pickup persisted Cart and Quote repricing). The harness uses fresh isolated test databases and
cleanup, not `.local/pilot-v14`; this is current local synthetic acceptance and not Store/UAT evidence.

## Current-tree workspace tests (2026-09-24)

Selection: the exact-tree root `pnpm verify` stops at root Vitest on this Darwin host, before the 41 Turbo
workspace test tasks; accepted Linux evidence predates later WP-2402 app/API/persistence changes.
Acceptance question: do all existing workspace test tasks pass against the current checkout? Run
`source .local/activate.sh && CI=true pnpm exec turbo run test`, reusing the repository task graph and
normal cache. This answers only the workspace test stage; it does not replace root Vitest, database
acceptance, aggregate `pnpm test`/`pnpm verify`, or Store/UAT/release gates. No production/pilot
installation is an input.

Result: the fresh elevated run completed with Turbo reporting 41/41 workspace test tasks successful
(40 normal-cache hits; API suite executed). API passed 183 files / 1,848 tests; Merchant Web 106 files /
784 tests; Ordering 116 files / 2,014 tests; database base/catalog/config/foundation/helper tests
4 files / 119 tests; UI 2 files / 4 tests. The initial restricted run was interrupted after API loopback
tests timed out and is not counted as a pass. This fresh workspace run does not cover root Vitest or
ordered database acceptance after Audit, so aggregate `pnpm test`/`pnpm verify` remain unresolved.

## Current-checkout Linux root tests (2026-09-24)

Selection: current root Vitest remains unverified on Linux after accumulated application/API edits; native Darwin failures include required Linux `/proc` process semantics. Acceptance question: does root Vitest pass against this exact current checkout under pinned Linux Node 24.18.0? Use the cached `node:24.18.0-bookworm` image with the current source and `.git` snapshot archive mounted read-only, excluding `.local`, host `node_modules`, and generated outputs; extract into container-local storage, create only an empty `.local` parent for test fixtures, mark that temporary checkout safe to Git inside the disposable container, run the pinned frozen install and normal build, then invoke the repo-installed Vitest root suite. Do not mount the Docker socket or include the pilot installation. Workspace tests and Audit DB acceptance are separately freshly covered above; this check answers only root Vitest and does not establish full `pnpm test`/`pnpm verify` or release readiness.

Current-checkout Linux root test result (2026-09-24): after the snapshot setup corrections, the pinned `node:24.18.0-bookworm` run completes frozen install, all 41 workspace builds, and root Vitest with 110/110 files and 2,070/2,070 tests passing. The disposable container held the source plus `.git` snapshot, an empty `.local` fixture parent, and an ephemeral Git safe-directory setting; it had no Docker socket and no pilot data. Two preliminary container runs were not counted: one copied macOS AppleDouble metadata; the next lacked the expected empty `.local` parent; the third lacked the container-local Git safe-directory setting. This closes the Linux root test question for the current source snapshot only. It does not run the database acceptance chain or full `pnpm verify`.

## Current-checkout database acceptance after Audit (2026-09-24)

Selection: root Vitest and all 41 workspace tasks now pass for the current snapshot; Audit Record acceptance passes separately, while the existing `pnpm test` sequence stops on Darwin before subsequent database acceptance. Acceptance question: do the remaining repository-owned Tenant, Permission, Identity/Workforce, Catalog, Pricing, Recipe, Ordering, Kitchen, Reporting, Dining and related isolated PostgreSQL acceptance scripts pass on the current checkout? Resume the existing root `test` script order immediately after `audit-record:acceptance`, running each named existing acceptance script with its established isolated-database harness on the host. Reuse normal task output; each harness must clean its unique test namespace. Do not use `.local/pilot-v14`, production DB profiles, or real Store data. This advances database acceptance only; it does not constitute the full aggregate command, Store/UAT, release or production readiness.

Current-checkout database acceptance after Audit result (2026-09-24): all 41 remaining commands in the existing root `pnpm test` order pass on the current checkout, including Tenant/Permission/Identity/Workforce, Catalog and Customer Menu, Pricing, Recipe, Ordering Cart and amendment, Production Batch, device/KDS/provider and API client, operating/brand/platform/support/store administration, Reporting, and the complete Dining acceptance chain. Each command exited 0; database integrations used the existing isolated PostgreSQL namespaces and cleanup helpers. The previously passing Audit Record isolated acceptance is separate and remains 1/1. Together with current Linux root Vitest (110 files / 2,070 tests), all 41 current workspace test tasks, and the pinned Linux build (41/41 workspace tasks), this covers the component stages of the repository test and build gates. The root `pnpm test` and `pnpm verify` shell commands were not run end-to-end as one invocation; the full `pnpm verify` status is not upgraded based on assembled evidence alone. No pilot DB, Store/UAT, release approval or production readiness was tested.

## Kitchen freshness badge width Figma correction selection (2026-09-24)

Acceptance question: does the `KIT-KITCHEN-QUEUE` freshness badge match the current regular Design
Review / Figma Make frame geometry at 1440/390/320 while retaining the real projection-owned
freshness value and the explicit unverified KDS-session label? Live `get_design_context` on node
`4:86` shows a 78px-wide Fresh badge and `KDS session unverified`; the Registry requires inherited
freshness, while the current Kitchen query safely returns `Fresh` or `Stale` and does not assert a
named operator. The repository badge was content-sized. Affected inputs are the Kitchen badge CSS,
the existing `kitchen-queue.spec.ts` responsive journey, and this evidence. Set only the badge width
to 78px and assert it at 1440/390/320. Run the production-fail-closed browser journey on available
temporary ports, inspect fresh captures, and run focused Kitchen component tests, Merchant typecheck,
scoped ESLint/Prettier and `git diff --check`. No API, permission, projection or command behavior
changes; this does not close Registry source-field, KDS lock, Store/UAT or project release gaps.

Kitchen freshness badge width Figma correction result (2026-09-24): the badge now has a fixed
78px border-box width, and the existing production-fail-closed responsive journey asserts that
geometry at 1440/390/320. It passes 2/2 on temporary ports 5175/4175; occupied 5173/5174 listeners
were left untouched. Fresh Queue and Work Item captures were inspected at all three widths; the
badge now aligns with Review node `4:86`, while projection freshness and the unverified KDS-session
message remain separate. `KitchenBoardPages.test.tsx` passes 10/10, Merchant typecheck, scoped
ESLint, Prettier and `git diff --check` pass. The preview build retains the existing >500 kB chunk
advisory. This is a visual correction only; unsupported Registry fields, named KDS session/device
lock, Store/UAT, Accepted Screen and full project/release gates remain open.

## Customer Dine-in Session source recheck (2026-09-24)

Acceptance question: can an existing Dining/Identity read safely supply any of the canonical
`CUST-DINE-IN-SESSION` page groups without adding a new projection? Screen Registry requires Guest
Session plus exact Store scope and four groups: Table/Dining Session/participants, active Order
batches, shared payable summary, and service/allergen notices. Trace
`createDiningGuestBindingQuery`, its PostgreSQL reader, actual API call sites, the Customer route,
Registry row and owning WP-1006/1007 boundaries. Documentation-only because this is a source-contract
reconciliation: if the helper only serves Identity binding or checkout authorization and does not
provide the customer presentation DTO, keep the route unavailable and record the exact missing
owner-composed data/authorization contract. Do not expose opaque references, join private Domain
tables from UI/API, add mutations, or alter the accepted owner WP allowlists. Verify the changed
project review against source/Registry/WP references, Markdown formatting and `git diff --check`; no
business suite or build applies.

Result: `createDiningGuestBindingQuery` is a current binding authorization helper, not a customer
Session projection. Its evidence contains opaque Brand/Store/Session/Participant/Table references,
the Active/Closing phase, owner versions and observation time; `createPostgresDiningGuestBindingStore`
binds its read under Dining RLS, and the current API composition invokes the query only to validate
Identity's exact Dining-bound Guest Session. It does not return participant-safe display data,
active Order batches, payable totals, or service/allergen notices; no normal Customer read endpoint
is composed. Handoff Section 88.6 assigns the screen to WP-1006, WP-1007, WP-1220–1226 and WP-1703.
Those briefs cover the source Domain workflows, but the combined Customer projection/route
composition still needs an explicit owner contract. Current Ordering helpers do not fill that gap:
`createPostgresDiningSessionOrderLookup` is explicitly Identity lookup, returns only one opaque Order
reference and fails if multiple exist; `createPostgresDiningSessionOrderInventory` is a bounded
closeout reader whose parent query uses `FOR UPDATE`, so it is not a Customer read source. The
existing source-unavailable page remains accurate. Exact source evidence is
`packages/rms/dining/src/application/dining-guest-binding-query.ts`,
`packages/rms/dining/src/infrastructure/persistence/dining-guest-binding-store.ts`,
`apps/api/src/customer-dining-binding-composition.ts`,
`packages/rms/ordering/src/infrastructure/persistence/dining-session-order-lookup.ts`,
`packages/rms/ordering/src/infrastructure/persistence/dining-session-order-inventory.ts`,
`docs/product/screen-registry.yaml` row `CUST-DINE-IN-SESSION`, and the cited owning briefs. No
application/API/permission/persistence behavior changed; this is an identified owner-contract gap,
not page or Dining workflow completion.

Kitchen current-worktree screenshot regeneration selection (2026-09-24): the prior recorded Kitchen capture paths are absent from `apps/merchant-web/test-results`, so image-level review cannot be inferred from the old result. No Kitchen source or projection changed since its current-tree Figma parity journey. Acceptance question: does the existing production-fail-closed Kitchen journey still verify the supported Queue/Work Item hierarchy and no-overflow behavior, while generating reviewable current captures at 1440/390/320? Run `pnpm --filter @bop-rms/merchant-web exec playwright test e2e/kitchen-queue.spec.ts --project=production-fail-closed`; inspect the generated Queue and Work Item images and the mobile filter-sheet images. No UI, API, projection, authorization, command or persistence change is selected unless current evidence contradicts the Screen Registry/Handoff source boundary.

Kitchen current-worktree screenshot regeneration result (2026-09-24): the existing `e2e/kitchen-queue.spec.ts --project=production-fail-closed` journey passes 2/2 using the same project/test cases on temporary ports 5175/4175, because 5173 and 5174 already had listeners and were left untouched. The generated Queue and Work Item screenshots at 1440/390/320 and mobile filter-sheet screenshots at 390/320 were inspected. Layout remains responsive with no horizontal overflow; unsupported Order/ticket references, station/courses/priority/SLA, allergen/exception source facts and KDS authority remain unavailable, and commands remain disabled. Existing source/projection behavior was not changed. The temporary Playwright config was removed. Captures: `apps/merchant-web/test-results/kitchen-board-{1440,390,320}.png`, `kitchen-detail-{1440,390,320}.png`, and `kitchen-filter-sheet-{390,320}.png`.

## Current checkout high-confidence secret scan (2026-09-24)

Acceptance question: do the current changed files contain high-confidence credential/key patterns?
The existing `CI=true pnpm secret-scan:check` passes 2/2 and scans current contents of tracked files,
but does not include new untracked files. A whole-worktree `rg -l` scan for the same high-confidence
AWS, GitHub, Stripe-live-key and private-key patterns therefore checked tracked and untracked text
files while excluding `.local`, dependencies, build output and screenshots. It returned no matching
paths. This is a targeted source-text scan, not the external release scanner set or a signed-artifact
attestation; untracked binary/generated artifacts and production configuration are outside its scope.

## Exact-current-tree repository acceptance reconciliation (2026-09-25)

Selection: close the latest repository-owned acceptance questions after the Kitchen Figma CSS/E2E
slice. The acceptance inputs are the current Git-visible worktree, the root `test` command order,
and the exact Node `24.18.0` / pnpm `11.13.0` pins. Run the existing full `CI=true pnpm verify` gate
in pinned Linux after `pnpm build`; if the Docker daemon cannot resolve paths from a container-local
checkout, record that boundary and run the same remaining root-script acceptance commands through
the host's existing isolated PostgreSQL harness. Do not mount `.local/pilot-v14`, use production
profiles or records, or infer Store/UAT/release readiness. Reconcile exact commands, successful
stages, the first blocked stage and any host-specific limitation; review this entry's links/formatting
and `git diff --check` only after recording results.

Result: the Mac-host `CI=true pnpm verify` stopped in root Vitest because Darwin lacks required Linux
`/proc` process semantics and the sandbox denied loopback binds (`EPERM`); this was not treated as a
product failure. A clean current-tree copy was then frozen-installed and built with Node `24.18.0` /
pnpm `11.13.0` on the native Linux filesystem in `node:24.18.0-bookworm`: the standalone build passed
all 41 workspaces. The Linux `CI=true pnpm verify` passed repository guidance, module/import/domain/
database checks, migration/foundation/helper checks, OpenAPI/Event Catalog, root and 41-workspace
format/lint/typecheck, Screen Registry (210 records), root Vitest (110 files / 2,070 tests), and all
41 workspace test tasks. It then stopped at Audit PostgreSQL startup because Docker Compose, although
connected to the local daemon, could not resolve the container-local `/workspace` secret path on the
daemon host. No pilot or production data was mounted.

The existing host isolated-database harness then passed `pnpm audit-record:acceptance` (1/1), all four
Tenant/Permission/Identity/Workforce database stages, and all 37 remaining commands after Audit in
the root test order, including the full Dining acceptance chain. Thus every repository acceptance
component has fresh current-tree evidence across the pinned Linux and host-isolated environments;
the single monolithic `pnpm verify` invocation itself did not finish and is not reported as a pass.
The initial macOS bind-mount Linux attempt and the Linux Compose-path attempt are harness setup
failures, not counted as acceptance evidence. No Store/UAT, Accepted Screen, release approval or
production go/no-go was tested. Existing uncommitted project files were preserved; the temporary
Linux copy, Compose helper and test resources were removed.

## Private Figma Make current access recheck (2026-09-25)

Selection: recheck the existing `High-Fidelity Restaurant Order Prototype` after the prior
source-resource `Unknown resource` and Make editor quota observations. Use the authenticated
Figma identity/plan result and the exact project URL already recorded in the project brief; open
the Make project in Chrome, inspect its Preview and Code views, and request current Make design
context. Do not submit an AI prompt, change source, publish, share, or change access settings. This
is an access/readability check only; verify this Markdown addition, its source links and formatting.

Result: the current Figma identity belongs to the project's `yashirq's team` with a Full seat and
Admin role on the Education plan. The Make Preview and Code views load. `get_design_context` now
returns links for the full source tree, including Dining, Kitchen, Pickup, Exceptions and Customer
components; the visible Code editor also exposes the current `src/customer/transitions.ts` source.
The Code view has a settable source text area and the project file actions are present, so source
editing is available in the current account. Save/reload persistence was not tested because no
source was changed. The AI prompt, context selector, mode/model selectors and Send remain disabled;
the page reports credits unavailable until September 30. Thus project preview/source readability
and manual editor access are currently confirmed, while AI generation remains quota-gated. This
does not establish any repository implementation or acceptance result; no Make content, sharing,
or publish state changed.

## Make prototype and production Customer payment boundary (2026-09-25)

Selection: decide whether the now-readable Make Customer transition module is an implementation
source for the repository Customer payment path. Compare the visible Make `src/customer/transitions.ts`
and its `CustomerState` intent/cart model with the current production route and payment result
controller. No behavior change is selected; this is a source-boundary finding, so verify exact imports,
source links and Markdown formatting only.

Result: Make's transition functions operate on its own in-memory `CustomerState`, cart/quote and
prototype payment intent. The production `apps/customer-pwa` path instead captures the current
Guest CSRF context and Checkout Session, calls the persisted Checkout/Payment clients, and reads or
reconciles the server-owned payment result through `session-payment-result-controller.ts`. No Make
transition module is imported by the repository. The prototype snapshot/recovery changes therefore
cannot be copied into production as a direct implementation; any corresponding production change
must preserve the Checkout Session, current-scope authorization and persisted Payment operation
contracts. No production, API, projection, permission or persistence behavior changed, and no
production Customer acceptance is inferred from Make preview/source access.

## Current checkout pilot status read (2026-09-25)

Selection: refresh the current closed-day settlement handover using the existing read-only
`pilot-daily-settlement-status-cli.mjs` command documented by the runbook. This check must read only
`.local/pilot-v14`, never start settlement or use another installation. Acceptance question: is the
current Windows/WSL InternalTest settlement status available from this Mac checkout? Record only the
minimized status/error and check this documentation; no business suite or application build applies.

Command:

```sh
source .local/activate.sh && NODE_ENV=development node --import ./tooling/environment/register-workspace-typescript.mjs tooling/environment/pilot-daily-settlement-status-cli.mjs .local/pilot-v14
```

Result: the command exited 1 with
`DAILY_SETTLEMENT_STATUS_UNAVAILABLE`. The expected `.local/pilot-v14` directory does not exist in
this Mac checkout, so the separate Windows/WSL InternalTest installation cannot be refreshed here.
No pilot directory was created, no database read succeeded, and no settlement or business action
ran. Prior Windows/WSL handover evidence remains historical; it is not a current 2026-09-25
readback. This environment limitation does not establish a product defect or change the external
Store/UAT, handover or release gates.

## Kitchen current Figma parity and responsive recheck (2026-09-25)

Selection: revalidate `KIT-KITCHEN-QUEUE` and `KIT-WORK-ITEM` against current Design file frames
`4:2` and `51:2`, current Screen Registry fields, the actual Kitchen queue/detail views, and fresh
1440/390/320 browser captures. Acceptance asks whether supported projection fields preserve the
Figma hierarchy, missing source facts stay explicit, the KDS state is visibly unverified/read-only,
and all three widths avoid horizontal overflow. Use the existing
`kitchen-queue.spec.ts --project=production-fail-closed` journey and inspect its Queue, Work Item,
and mobile filter-sheet captures. Do not change code if the design and supported field hierarchy
match. No API, projection, permission, command, Domain, Store or Make write is selected.

Result: live Figma Design context and rendered screenshots for `4:2`/`51:2` were compared with the
current checkout. The initial visual impression that the page said "KDS session verified" was a
downscaled-text misread; the refreshed 1440/390/320 Queue and Work Item screenshots visibly say
`KDS session unverified`, and the existing journey asserts that exact text, the read-only lock and
disabled actions. The Queue preserves the neutral header, freshness badge, locked-board explanation,
filters, lane/card order and source-limited footer; unavailable station labels correctly group all
current items without inventing station names. Work Item preserves the separate gray detail canvas,
right-aligned desktop route/refresh controls, mobile stacked controls, Current work card and four
unavailable detail rows. All screenshots show no horizontal overflow. Fresh filter-sheet screenshots
at 390/320 retain the registered fields and unavailable explanations. `get_design_context` also
returned an `Updated Sep 19` sample text node for `51:2`, but the current rendered Figma screenshot
does not show that line; the implementation and E2E continue to omit it, consistent with the prior
review decision to keep projected-at as age-calculation input rather than duplicate visible status.

The first sandboxed Playwright attempt stopped before the test because local loopback binding returned
`EPERM`. The same existing journey was then run with the required local loopback permission and
passed 2/2, rebuilding the production preview. Fresh files inspected:
`apps/merchant-web/test-results/kitchen-board-{1440,390,320}.png`,
`kitchen-detail-{1440,390,320}.png`, and `kitchen-filter-sheet-{390,320}.png`. Build output retains
the existing >500 kB chunk advisory. This confirms current local synthetic visual/route behavior only;
safe Station display labels, Registry course/priority/SLA/exception fields, owner-backed KDS Session
and device-lock enforcement, Accepted Screen, Store/UAT, release and production readiness remain
unproven or owner-gated. No application source changed in this recheck.

## Current checkout full verification selection (2026-09-25)

The current dirty checkout contains changes across API, Customer and Merchant UI, RMS domains,
database acceptance, tooling, and project documentation. Existing assembled results do not constitute
a fresh aggregate run for this exact worktree. Acceptance question: do the repository's current
guidance, manifests, architecture/ownership/permission/migration/contracts, formatting, lint, types,
Screen Registry, tests, and build gates pass together? The first `CI=true pnpm verify` reached root
Vitest on macOS and failed because its test files require Linux `/proc` and local TCP listeners; the
same failure persisted with local loopback permission. That host result cannot establish Linux
acceptance. The Linux x86_64 emulation run passed all 41 builds and reached root tests, but its Node
image injected extra `NODE_OPTIONS` into child processes and the tracked-file secret scan exceeded
its default 5-second timeout; this does not prove a source defect. The first temp copy also lacked
Git metadata and an empty `.local` parent; those were restored for the native run without copying
pilot runtime data. Selected `CI=true pnpm build && CI=true pnpm verify` in a native Linux arm64
container with `NODE_OPTIONS` unset, read-only current Git metadata, and the existing Docker socket/
Compose CLI needed by acceptance fixtures. The prebuild supplies current workspace artifacts
consumed by root tests, and `verify` runs the complete remaining gate including a final build. The
current manifests, lockfile and Node pin were compared with the cached Linux install; pnpm
nevertheless reified Linux arm64 optional dependencies in the isolated temporary copy.

Result (2026-09-25): the pinned native Linux arm64 run completed the prebuild with 41/41 workspace
tasks. In the container-local source copy, repository guidance/manifests/architecture/ownership/
permission/migration/contracts checks, Prettier and all workspace format checks, lint, typecheck,
Screen Registry (210 valid), root Vitest (110 files / 2,070 tests), workspace tests, and database
unit tests (119) passed. The first bind-mounted Linux run's five root-test failures were Docker
Desktop filesystem artifacts: extracting the same source snapshot into the container-local
filesystem made the affected recovery-owner/resume tests pass 21/21. The `verify` invocation then
stopped at Audit Record PostgreSQL acceptance because Docker Desktop could not resolve the
container-local `/tmp/repo/.local/.../password` secret path on its host. The existing
`pnpm audit-record:acceptance` passed directly on the Mac host, followed by every remaining command
in the current `package.json` `test` sequence through the complete Dining acceptance chain; the
sequence exited 0. Thus each selected static/test/acceptance/build stage has passing current-tree
evidence, but the single monolithic `pnpm verify` command did not exit 0 and is not called a pass.
The 2026-09-25 pilot status read remains unavailable because `.local/pilot-v14` is absent; no
pilot data or Store/UAT evidence is inferred. No source or application behavior changed during this
verification; only this WP evidence record was updated.

## Kitchen projection-backed milestone history selection (2026-09-25)

The `KIT-WORK-ITEM` view currently labels its entire history group unavailable even though the
authorized Kitchen queue projection supplies `workItemCreatedAt`, `acceptedAt`, and
`orderItemReadyAt`. Acceptance asks whether the detail view renders only these validated source
milestones in chronological order while keeping start/progress/completion history, Recipe and
handling snapshots, allergen acknowledgements, timers, and dependencies explicitly unavailable.
Preserve the Figma detail-card hierarchy, safe read-only behavior, and current KDS lock. Affected
inputs are `KitchenBoardPages.tsx`, its focused component tests, and Kitchen detail CSS. Fresh checks:
focused Kitchen component tests; `e2e/kitchen-queue.spec.ts --project=production-fail-closed` with
fresh 1440/390/320 screenshots inspected for no overflow; Merchant typecheck, lint, Prettier on
changed sources, production build, and `git diff --check`. No API, projection, authorization,
command, persistence, Store, Make, release, or pilot-runtime behavior is selected.

Result: `KitchenBoardPages.tsx` now renders the source-backed Work item created milestone and,
when present, Accepted and Order item marked ready timestamps in chronological order, explicitly
formatted as UTC. The history copy names the exact omitted start/progress/completion timestamps;
Recipe/handling, allergen acknowledgements, timers and dependencies remain unavailable. The
existing detail-card hierarchy and locked/read-only state remain in place. A first browser run
correctly caught a stale heading assertion, which was updated to the new partial-source heading.
The subsequent existing production-fail-closed journey passed 2/2 and regenerated the 1440, 390
and 320 Queue/Work Item screenshots. Visual inspection confirms the history list uses the available
width on mobile and the journey reports no horizontal overflow. `KitchenBoardPages.test.tsx` passes
11/11; Merchant typecheck, lint, changed-source Prettier and `git diff --check` pass. The browser
journey rebuilt the production preview; its existing JavaScript chunk-size advisory remains. The
fixtures are synthetic, so these results verify rendering and responsive behavior only; no Store,
operator-session, Accepted Screen, full-history or production acceptance is implied.

## Dining owner-backed elapsed-time field selection (2026-09-25)

The `DIN-FLOOR-BOARD` registry requires elapsed time, while the authorized table query currently
returns only a current Dining Session reference. Source review found the Dining-owned Session reader
already binds Session snapshots to the current Tenant/Brand/Store, and
`PersistentMerchantBffOptions.now()` supplies the read observation time. Extend that owner adapter
with a bounded batch read, compose it inside the existing
authenticated `dining.session.manage` table-query transaction, and return only elapsed whole minutes
for a matching `Active` or `Closing` Session. Missing or non-current sessions remain unavailable;
never infer elapsed time from the reference, table version, client clock, or synthetic Make data.
Preserve current command behavior and safe field allowlist. Focused Dining owner-store and Merchant
API tests, Dining page tests, Merchant typecheck/lint/format, the existing Dining production-fail-closed
journey with inspected 1440/390/320 screenshots, API/Dining affected ownership checks, and
`git diff --check` cover the change. This does not add Registry owner/server, Order/Payment,
reservation/waitlist or attention facts, and synthetic browser evidence will not establish Store or
release acceptance.

Dining owner-backed elapsed-time field result (2026-09-25): the read-only `DiningSessionReadStore`
offers a strict, immutable, maximum-100 `loadSessions` batch using the exact Tenant/Brand/Store owner
SQL and current transaction/RLS context; `DiningSessionStartStore` delegates its existing read
methods to this adapter. It rejects duplicate requests/rows and unexpected identifiers,
and preserves requested ordering with explicit nulls for absent Sessions. `createMerchantDiningTables`
composes those reads after its authorized table page and rechecks current authority before returning
an allowlisted `elapsedMinutes` per active Session; only matching `Active`/`Closing` snapshots with a
non-future `startedAt` are accepted. `pilot-merchant.mjs` composes the read without loading Dining
credential material. Merchant parsing requires elapsed time and Session-reference presence to agree. The UI shows
whole minutes for supported sessions; a newly Issued Session shows zero until refresh, while
AlreadyApplied recovery remains explicit that elapsed time is unavailable without a fresh readback.
No raw Session ID or start timestamp is added to the display.

Fresh results: `CI=true pnpm --filter @rms/dining test` ran the Dining package suite (37 files /
1,238 tests) and passed; the Merchant dining-table API composition test passed 8/8, including
current-authority loss during the owner read; the focused Dining client plus Merchant App tests passed 10/10 after a
fixture correction. Dining, API and Merchant typechecks and all three workspace ESLint commands
passed. The first sandboxed PostgreSQL run could not start Docker; the same existing
`CI=true pnpm exec vitest run --config packages/database/vitest.dining-session-start.config.ts`
passed 1/1 with local Docker permission, including real PostgreSQL batch-read assertions for
requested ordering, missing Session references and denial across mismatched Tenant/Brand/Store
scopes. The final focused rerun after adding the cross-scope assertions also passed 1/1.
`CI=true pnpm database-ownership:check` passed (1,087 tests and validation). Prettier and
`git diff --check` passed. The production-fail-closed Dining browser journey passed 1/1 after
correcting a stale availability notice and a text locator that did not account for the capacity
prefix. Its fresh 1440/390/320 captures and focused 1440 elapsed-time tile were inspected; no
horizontal overflow or clipping was found. The preview build retains its existing >500 kB chunk
advisory. Screens use synthetic rows, so the evidence proves only local source composition, rendered
elapsed-time behavior and responsive UI—not Store operation or complete Registry acceptance.
Owner/server, Order/Payment, reservation/waitlist, attention fields/filters and the full
`query.din_floor_board` projection remain open. Current Dining and API package builds passed, as did
the import-boundary checks (22 tests) and domain-layer boundary checks (57 tests). The repository-wide
`pnpm verify` aggregate was not rerun for this slice; these are affected-path results, not a new full
repository acceptance or project-completion claim.

## Dining unavailable-table command boundary recheck (2026-09-25)

Selection: verify whether the Screen Registry `DIN-FLOOR-BOARD` “mark Table unavailable” action can be
closed inside current WP-2402 using an existing authenticated API/permission composition. Acceptance
question: any command must preserve WP-2112's Store-scoped `dining.operate` authority, current Store,
actor, expected aggregate version, idempotency, audit and event contract; do not broaden the current
`dining.session.manage` permission. Smallest checks: inspect `DiningTableService.executeTable`, its
authorization/ports and the normal Merchant API composition, then compare WP-2112 and Section 88.11.

Result: the domain/service path already supports `SetBlock` and `ClearBlock` with audited,
idempotent versioned commits. The normal Dining floor-board API only resolves
`dining.session.manage`, no table-command route currently composes this service, and WP-2112 records
live BFF wiring as a non-goal. Since no accepted permission mapping authorizes `dining.session.manage`
for `dining.operate`, wiring the button here would create a permission expansion. No business code
was changed. The actionable gap is recorded in the project completion review; resolve through the
table-command owning WP/API authority before enabling the action. This is a source reconciliation,
not a test or workflow acceptance result.

## Dining table operation composition follow-up (2026-09-25)

The preceding source-only blocker was subsequently closed for repository implementation within
WP-2402 without weakening its permission requirement. The Merchant BFF now exposes a protected
`/merchant/dining/tables/availability` command, and both `createMerchantRuntime` and
`tooling/environment/pilot-merchant.mjs` can compose it with explicit server-generated references
and audit retention. The table query reports the availability affordance only if that command is
configured and the current selected Store authorizes `dining.operate`. No role grant was added; the
existing InternalTest DEMO role's `dining.session.manage` authority does not authorize this action.

Fresh results: 19 API Dining command/query tests and 7 Merchant client tests pass; the isolated BFF
route tests pass 2/2 with loopback permission. The production-fail-closed Dining browser journey
passes 1/1, including a lost SetBlock response, byte-identical retry, AlreadyApplied recovery,
ClearBlock and the existing Session start/entry-code recovery journey. API/Merchant typecheck, API
and scoped Merchant ESLint, API/Merchant production builds, pilot-merchant ESLint/`node --check`,
focused Prettier and `git diff --check` pass. Fresh 1440/390/320 screenshots were inspected. The
first unconstrained full `merchant-bff.test.ts` run timed out on earlier loopback route cases before
the target route; it was interrupted and is not a pass. A later isolated route run passed. The
browser fixtures and composition unit doubles are synthetic; no new permission grant, actual Store
operation, external acceptance, whole-project verification or release evidence is claimed. Existing
Dining projection omissions remain open.

## Kitchen Figma journey recheck (2026-09-25)

Selection: revalidate the repository's current `KIT-KITCHEN-QUEUE` and `KIT-WORK-ITEM` implementation
against the supported Screen Registry/Handoff fields and responsive Design Review hierarchy. The
existing production-fail-closed journey covers read-only behavior, status treatment, available
work-item details, keyboard navigation and command recovery. Run it with local loopback access and
inspect fresh Queue/Work Item captures at 1440/390/320; no projection or authority change is selected.

Result: `CI=true pnpm --filter @bop-rms/merchant-web exec playwright test
e2e/kitchen-queue.spec.ts --project=production-fail-closed` passes 2/2. The first sandboxed attempt
could not bind `127.0.0.1:5173` (`EPERM`); the same command passed when rerun with local loopback
access. Fresh captures at
[`apps/merchant-web/test-results/kitchen-board-1440.png`](../../../apps/merchant-web/test-results/kitchen-board-1440.png),
390, 320, and corresponding `kitchen-detail-{1440,390,320}.png` were inspected. The supported
queue fields, selected modifier, source-backed history milestones, locked command state and compact
status colors remain visible without horizontal overflow. Fresh regular Design Review contexts
`4:2`, `4:86`, `4:128`, `51:2`, `51:3` and `51:4` confirm the same hierarchy at 1440/390/320.
Review-only sample records, lane labels and allergen/exception values are not copied because they
are absent from the current authorized projection; available modifiers and history milestones are
shown. This is synthetic browser and visual evidence only. KDS active named-operator/device-lock
composition belongs to WP-1808 and is not
available in this current WP; safe public Order/ticket references, station labels, course, priority,
SLA, structured allergen/exception details and full Work Item history remain unprojected. No actual
Store/KDS acceptance, Accepted Screen, full `pnpm verify`, release or production readiness is implied.

Result: queue status badges retain 112px at 1440/390 and use 100px at compact 320px; the detail badge
remains 78px. `CI=true pnpm --filter @bop-rms/merchant-web exec playwright test
e2e/kitchen-queue.spec.ts --project=production-fail-closed` passes 2/2, and the focused
`KitchenBoardPages.test.tsx` passes 11/11. Merchant typecheck, full Merchant ESLint, targeted Prettier
and `git diff --check` pass. The production preview rebuilt successfully with the existing >500 kB
chunk advisory. Fresh Queue and Work Item captures at 1440/390/320 were inspected; the compact badge
now matches Review `4:128`, other reviewed widths retain their previous geometry, and no horizontal
overflow appears. This is visual/UI regression evidence only; the source and business boundaries
above remain unchanged.

## Kitchen full Make status palette acceptance (2026-09-25)

Selection: the current Make `KitchenWorkspace.tsx` defines presentation colors for Queued, Held,
In Progress, Completed and Cancelled. Repository CSS contains all five mappings, but the existing
production-fail-closed journey asserts only Queued, In Progress and Completed. Preserve that journey's
filter restoration cases and add a separate fresh-route synthetic projection with all five statuses,
then assert every rendered background color and capture the resulting 1440 queue. Affected input:
`apps/merchant-web/e2e/kitchen-queue.spec.ts`; smallest verification: the existing
`CI=true pnpm --filter @bop-rms/merchant-web exec playwright test e2e/kitchen-queue.spec.ts
--project=production-fail-closed`, inspect the new 1440 palette capture and retain its 390/320 layout
assertions. No status meaning, permission, API, projection, application styling, real Store data or
Make source change is selected.

Result: the fresh normal-route palette case in `e2e/kitchen-queue.spec.ts` passes alongside the two
existing read/filter/recovery and command journeys (`3/3`). It uses five explicitly synthetic Queue
rows and confirms the Make status background colors for Queued, In Progress, Held, Completed and
Cancelled. The new 1440 capture at
[`kitchen-status-palette-1440.png`](../../../apps/merchant-web/test-results/kitchen-status-palette-1440.png)
was inspected; all five colors render, the board remains visibly locked/read-only, and no unsupported
source facts were added. The original journey continues to produce fresh 1440/390/320 queue and
1440/390/320 detail captures and its mobile geometry/overflow assertions pass. ESLint,
Prettier and `git diff --check` pass for the scoped test/document changes. The preview build retains
its existing >500 kB chunk advisory. Three attempts to replace rows within the existing filter/recovery
journey did not produce the expected rendered fixture rows; those edits were discarded, and the
accepted test uses an isolated fresh route instead. This is synthetic visual-parity evidence only; no app source,
projection, permission or business status changed, and it does not establish KDS/Store acceptance.

## Kitchen compact 320 status badge parity selection (2026-09-25)

Acceptance: current regular Design Review Queue frames `4:2`/`4:86` use the 112px status badge at
1440/390, while compact frame `4:128` uses a 100px badge at 320. Preserve the 78px Work Item detail
badge and all status colors/labels; apply the compact width only to queue cards at widths up to 340px.
Inputs: Kitchen-scoped CSS and `e2e/kitchen-queue.spec.ts`. Run the existing production-fail-closed
Kitchen journey with inspected 1440/390/320 Queue and Work Item captures, focused Kitchen page
tests, Merchant typecheck, scoped lint/Prettier and whitespace check. No projection, permission,
command, status meaning, business data or external acceptance changes are selected.

Result (2026-09-25): the existing responsive rule already matches the selected Review geometry;
no CSS change was needed. The production-fail-closed Kitchen journey passes 3/3, including exact
queue badge widths of 112px at 1440/390 and 100px at 320, plus the 78px detail badge. Fresh Queue
and Work Item captures at all three widths were inspected and show no horizontal overflow; the
read-only lock and unavailable-source explanations remain visible. Merchant unit tests pass 787/787
across 106 files, Merchant typecheck and targeted ESLint pass, and Prettier plus `git diff --check`
pass for the scoped inputs. Playwright rebuilt the production preview successfully with the existing
chunk-size advisory. This confirms local visual/UI behavior only; no projection, authority, Store,
Accepted Screen, production or release acceptance is implied.

## Dining Table List normal-route gap recheck (2026-09-25)

Selection: confirm whether the `DIN-TABLE-LIST` normal route can safely use an existing owner read in
WP-2402. The Screen Registry requires `dining.operate`, Phase 2 `dining_table_admin_v1`, and current
phase-capability gating. Inspect the normal route/default client, API query routes, Dining owner table
read, and Feature Control's current query adapter. If the only reusable query belongs to another
screen/permission or the phase capability has no current owner reader, keep the route unavailable and
add the gap to the project review. Documentation-only verification: source references, Prettier,
local links and whitespace; no business suite/build applies.

Result: `/app/operations/tables` mounts `DiningTableListPage`, whose default client rejects reads.
`createPostgresDiningTableStore.listTables` can read scoped owner snapshots, but no `dining_table_admin_v1`
Merchant query, current `dining.operate` scope composition or runtime client connects it. The existing
`/merchant/dining/tables` query serves the Staff Dining workspace under `dining.session.manage`, has a
different response and does not implement the Screen's Phase 2 gate. Feature Control's installed
query adapter reads Kill Switch definitions only; no current Store phase-capability reader was found.
No business code changed or phase gate bypassed. The project completion review now records this normal
entry gap and the required owner-backed phase capability before route wiring. This is source evidence,
not query, permission-denial, or Store acceptance.

## Project review gap-count correction (2026-09-25)

Selection: reconcile the opening gap-table count with the following Catalog Products paragraph.
The table now contains eight confirmed examples, including Dining Table List, while the additional
Catalog paragraph still says it is beyond seven surfaces. Inspect the current table rows, count,
Screen Registry entry and Merchant route source; update only the stale count. Documentation-only
verification: Prettier, source/link review and `git diff --check`; no application behavior or tests
apply.

Result: confirmed eight rows in the opening table and verified that Catalog Products is separately
listed under “Additional normal-entry route gap” with its owning WP-1020/WP-1027/WP-1802 assignment.
Corrected “seven surfaces” to “eight surfaces.” No route, phase gate or implementation status changed.

## Dining Reservation/Waitlist projection source boundary (2026-09-25)

Selection: identify whether the missing Reservation/Waitlist handoff on `DIN-FLOOR-BOARD` can be
composed in current WP-2402 from an existing owner read. Inspect the Screen Registry, normal Dining
BFF, Reservation/Waiting package contents/README and owning WP status. If only in-memory lifecycle
contracts exist and persistence is explicitly outside that package scope, document the precise owner
gate; do not expose transient aggregates or query private data. Documentation-only checks: Prettier,
source/link review and whitespace scan.

Result: Registry `DIN-FLOOR-BOARD` requires reservation/waitlist handoff and assigns this Screen to
WP-2112. The normal `/merchant/dining/tables` source composes only Dining Table snapshots and
matching active/closing Dining Sessions. `@rms/reservation-waiting` contains Domain/Application
contracts and tests, but no persistence adapter or Merchant query in this checkout; its README marks
runtime inactive and lists persistence/Provider integration as non-goals under WP-2113–WP-2115. The
project review now records that source gate. No Reservation facts were fabricated or joined, and no
business source, route or permission changed. This is an ownership/source audit, not runtime or Store
acceptance.

## Current candidate evidence separation (2026-09-25)

Selection: reconcile the runbook's “Current local candidate” language with the active macOS checkout
and the retained Windows/WSL v14 runtime. Re-read branch, HEAD, changed-path count, presence of
`.local/pilot-v14`, the current-checkout full-verification record, and the latest Dining/Kitchen
targeted results. Update only the runbook's candidate labels and evidence summary. Documentation-only
verification: Prettier, in-repository link/anchor check, source cross-reference review and whitespace.

Result: the Windows/WSL v14 candidate remains a separate runtime recorded with identity616. The
current macOS branch `codex/wp-2402-pilot-submission` remains at `03ad510c9b694a4bf994efb6703e11afa53e2fb7`
with 162 changed paths; `.local/pilot-v14` is absent. The recorded Linux/macOS verification stages
have assembled passing results but the one `pnpm verify` invocation stopped at the Audit Record
PostgreSQL acceptance path and is not a pass. Later Dining and Kitchen changes have targeted tests,
types/lint/build and responsive evidence; they do not create a current pilot runtime, signed candidate
identity, Store/UAT or release evidence. The runbook heading/link and candidate row now state those
separate facts; no installation, business data or application source changed.

## Order Queue Payment field authorization boundary (2026-09-25)

Selection: verify whether the missing OPS-ORDER-QUEUE Payment facet can safely reuse the existing
PaymentStatus source. Compare Screen Registry permission/scope, Ordering's queue query, Ordering's
status projection contract, and the actual PaymentStatus composition in Customer status. Record
whether an authorized Merchant query exists; do not pass Guest authority, broaden `ordering.operate`,
or expose Payment-private facts. Documentation-only checks: Prettier, source/link review and whitespace.

Result: `OrderStatusProjection.paymentStatus` is the literal `NotReported`, and
`createMerchantOrderQueueRead` currently composes Ordering, Dining and Kitchen owner reads without a
Payment scope. `createCustomerOrderStatusRead` can query `createPostgresPaymentStatusStore`, but only
after current Guest authorization and an explicit Brand/Store/provider/environment `paymentScope`;
that Customer binding is not Merchant authorization. Registry OPS-ORDER-QUEUE names `ordering.operate`
and requires Payment filtering plus field-level permission, but no Merchant Payment read capability or
mapping is present in the queue composition. The project review now tracks this exact boundary. No
cross-domain read, permission grant or UI filter changed. Safe composition awaits an approved
Merchant field-authorization contract; this is not Payment or Store acceptance.

## Dining table command security review (2026-09-25)

Scope: review the WP-2402 `POST /merchant/dining/tables/availability` path from browser input
through BFF, current Merchant Session/Store policy, Dining owner transaction, Event/Audit and bounded
response. Applicable contract: WP-2112 requires Store-scoped `dining.operate`, expected version,
idempotency, append-only Audit and minimal Events; WP-2402 may compose the existing owner command but
must not add a role grant. Data includes internal Table/operation references and a controlled reason
code; no contact, Payment, allergy, credential or Provider data is required by this command.

Selection: conduct a read-only security/privacy review of the changed composition, owner store, route,
client and focused existing tests. Trace current-session identity, Store/action reauthorization,
CSRF/origin, scope filters, optimistic concurrency/idempotency, Audit/Event transaction, response
allowlist and failure behavior. Reuse only the recorded fresh focused results; no application source
changed during this review, so no tests were rerun.

Result: source review found no Blocker or High issue in this path. Exact same-origin and
`Sec-Fetch-Site` middleware plus CSRF validation protect the route; query parameters are rejected and
an absent handler returns 503. The handler derives Tenant/Brand/Store/Actor from the current Workforce
Session and selected Store, requires `dining.operate`, and rechecks the same current scope and action
before the owner write and response. The Dining store applies Tenant/Brand/Store predicates and RLS
context, locks the idempotency operation then Table row, checks expected aggregate version, and commits
the state, operation record, Event and Audit together. The BFF response allowlist omits Audit,
operation digest and reason details. UI retries reuse the identical serialized intent after an unknown
result; changed intent under that operation reference is rejected. No logging or analytics path was
added.

Existing focused evidence: command/query tests 19/19; isolated HTTP route tests 2/2 for same-origin,
CSRF, query injection, unavailable handler and response allowlist; Merchant client tests 7/7; the
production-fail-closed Dining browser journey 1/1 including lost-response replay and ClearBlock.
These fixtures are synthetic; the monolithic BFF suite earlier timed out before this route and is not a
pass. No new suite was run for this source-only review. Residual limits: the local DEMO identity lacks
`dining.operate`; there is no current Mac `.local/pilot-v14` runtime for an actual authorized Store
operation. No role grant, live Store/UAT, production or release acceptance is claimed.

Adjacent Medium finding from the same route-family review: `/merchant/dining/tables` and Session Start
authorize `dining.session.manage`, while `DIN-FLOOR-BOARD` and `DIN-SESSION-START` declare
`dining.operate`; `dining.session.manage` is not in the Screen Registry permission catalog, and no
accepted mapping was found in the checked Handoff/WP sources. The Table Set/Clear command correctly
checks `dining.operate`, but this does not reconcile the read and Session Start scopes. Required owner:
Dining Screen/permission authority (WP-2112) to accept the mapping or revise the screen contract before
code changes. Disposition: open; no grant or permission expansion made. Current exposed facts are
limited to Table/Session operational references and state; this is not evidence of PII or Payment-data
exposure.

## Dining Table List phase-capability source recheck (2026-09-25)

Selection: recheck whether an existing Store Capability/Feature Control reader can supply the
Screen Registry `DIN-TABLE-LIST` Phase 2 `dining_table_admin_v1` gate in current WP-2402. Inspect the
normal Store Capability route/client, public Feature Control persistence readers and owner README.
Do not reinterpret Kill Switches or arbitrary control keys as Screen phase approvals. Documentation-
only verification: source path review, Prettier, internal links and whitespace.

Result: `/app/organization/stores/:id/capabilities` exists, but `StoreCapabilityPage` defaults to
`unavailableFeatureAdminClient`. The only exported Feature Control persistence query is
`createPostgresKillSwitchQueryStore`; it reads `kill_switch_version` and rejects any Definition whose
kind is not `KillSwitch`. It does not read a Phase capability or authorize `dining_table_admin_v1`.
WP-2193 owns Store Capability administration and lists both `FeatureControlAdminPages.tsx` and the
administration migration. However, that owner implementation does not establish that its generic
capability records represent the Section 88 `dining_table_admin_v1` phase approval; no accepted
mapping was found. The Dining Table List gap now records this specific source boundary; do not wire
the default Store Capability page or bypass the Phase 2 gate. No business code, policy, permission or
capability record changed. This is source evidence, not Phase 2, Store or screen acceptance.

## Feature Control owner README drift (2026-09-25)

Selection: resolve the apparent conflict between the Feature Control README and its later accepted
owner WP before relying on that README as a boundary for the Dining Phase 2 source review. Compare
the README, WP-0120, WP-2193's exact scope/status and the owned administration migration. This is a
documentation-only source reconciliation within current WP-2402; do not modify the WP-2193-owned
package or reinterpret its controls as Section 88 phase approval. Verification: source/authority
cross-reference, Markdown formatting and whitespace only.

Result: the README describes the original WP-0120 provider-neutral minimum contract and says the
package owns no database object, Section 88 Screen or production route. Later accepted WP-2193 assigns
Store Capability administration to Feature Control and explicitly owns the `0400_001` administration
migration and Merchant administration pages; therefore those README exclusions are stale when read
as current package-wide ownership. This corrects the prior paragraph's inference that README ownership
language was current. The current public persistence query remains Kill-Switch-only, and the Store
Capability UI still defaults to `unavailableFeatureAdminClient`; neither provides the Dining
`dining_table_admin_v1` phase approval mapping. Current WP-2402 records the owner documentation drift
for WP-2193 follow-up rather than editing another WP's file. No runtime source, control value,
permission, role or capability record changed. The Phase 2 gate remains unresolved.

## Kitchen Fresh badge 320px Figma alignment (2026-09-25)

Selection: compare the current `KIT-KITCHEN-QUEUE` Review frames `4:2`, `4:86` and `4:128` against
the Freshness badge in the repository implementation. The 1440 and 390 frames specify a 78px badge;
the compact 320 frame specifies 76px. Keep the Work Item detail badge at 78px and preserve freshness
meaning, source text, permissions, unavailable facts and locked commands. Change only the compact
queue badge width and add a viewport-specific browser assertion. Verification: the existing
production-fail-closed Kitchen journey, focused Kitchen page tests, Merchant typecheck, targeted
ESLint, Prettier, `git diff --check`, and fresh 1440/390/320 screenshot inspection. No projection,
authorization, Domain or business data change.

Result: `styles.css` now sets the Queue Fresh badge to 76px at widths up to 340px; the 78px default
continues to match frames `4:2` and `4:86`, and Work Item styling is unchanged. The E2E journey asserts
76px at 320 and 78px at 390; the existing desktop assertion retains 78px. The journey passes 3/3,
`KitchenBoardPages.test.tsx` passes 11/11, Merchant typecheck and targeted ESLint pass, and Prettier
plus `git diff --check` pass. The production preview rebuilds with the existing chunk-size advisory.
Fresh Queue and Work Item captures at 1440/390/320 were inspected with no horizontal overflow; the
320px Fresh badge now matches the current Design frame. Synthetic UI evidence only; KDS authority,
Accepted Screen, Store/UAT, production and release acceptance remain open.

## Kitchen Fresh badge color Figma alignment (2026-09-25)

Selection: compare the current Figma Review Fresh badge on nodes `4:2`, `4:86` and `4:128` with the
actual Queue CSS. All three frames specify background `#e8f7ed` and text `#14784a`; the repository
used visually similar but different values. Update only the Fresh badge palette and assert its
computed colors at 1440/390/320. Preserve stale-state colors, status colors, Freshness meaning and
the 320px width correction. Verification: production-fail-closed Kitchen journey, focused Kitchen
page tests, Merchant typecheck, targeted ESLint, Prettier, `git diff --check`, and fresh responsive
screenshots. No Screen fields, source values, commands or permissions change.

Result: the Queue Fresh badge now uses the exact Figma colors at all three widths. The journey
asserts both computed colors on desktop and mobile and passes 3/3; `KitchenBoardPages.test.tsx` passes
11/11; Merchant typecheck and targeted ESLint, Prettier, and `git diff --check` pass. The production
preview rebuilds with its existing chunk-size advisory. Fresh 1440/390/320 Queue captures were
inspected; the color now matches the Review reference while locked commands and unavailable source
facts remain unchanged. This is synthetic visual verification, not an Accepted Screen or Store,
operator, production or release acceptance.

## Kitchen Queue card Figma alignment (2026-09-25)

Selection: compare Queue card border/divider, disabled action controls and compact title/button
geometry with current Design Review frames `4:2`, `4:86` and `4:128`. Apply only the observed
visual values: `#e3e3e3` borders/dividers and `#f2f2f2` disabled fill; 145px action buttons at 1440
and 390; at 320, a 15px title and 260px full-row action. Preserve disabled command behavior and all
projection-derived/unavailable content. Verification: production-fail-closed Kitchen journey,
focused Kitchen page tests, Merchant typecheck, targeted ESLint/Prettier, and fresh Queue/Work Item
screenshots at 1440/390/320.

Result: the Queue now matches those measured border, disabled-fill and action dimensions. The 320px
card title and spacing follow its compact frame; card-specific selectors leave Work Item detail
styling unchanged. Browser journey passes 3/3, `KitchenBoardPages.test.tsx` passes 11/11, typecheck,
targeted ESLint and Prettier pass, and all six fresh Queue/Work Item captures were inspected with no
horizontal overflow. The browser run uses the installed Playwright/Vite binaries with a temporary
test-only `pnpm` shim because the host provides pnpm 11.25.0 while this repository pins 11.13.0;
no package manifest, lockfile or repository toolchain setting was changed. The production preview
build retains its existing chunk-size advisory. This remains synthetic UI verification only; the
Review frames are not Accepted Screens, and Kitchen source, operator/device, Store/UAT, production
and release gates remain open.

## Dining Screen permission composition alignment selection (2026-09-25)

Selection: align the normal Staff table-read and Session Start routes with the current Section 88
permission references. `DIN-FLOOR-BOARD`, `DIN-SESSION-START` and `DIN-TABLE-LIST` all declare
`dining.operate`; the Merchant table-list, start, join-state and join-credential regeneration
composition currently requests the unregistered `dining.session.manage`. Change those four
composition routes to the canonical Screen action. Keep current-session, Store scope, CSRF,
owner transaction, exact-intent replay and denial checks. Do not grant `dining.operate`, alter the
local DEMO role/bootstrap, change owner Domain permission grammar, or claim the local DEMO operation
remains available. Acceptance asks that every affected API composition authorizes only the registered
Screen action and that loss of it fails closed before reading/writing. Smallest fresh checks: focused
four Merchant Dining API tests, applicable BFF/route tests, Merchant Dining browser journeys, API and
Merchant typecheck/lint/build, Prettier and `git diff --check`. Review every changed auth call and
retain the local role mismatch as an explicit external authorization gate.

Result: the Merchant table-list read, Session Start, join-state and join-credential regeneration
routes now resolve the current Store scope with `dining.operate`; Start and regeneration also
recheck that action before loading the owner Table. The existing exact-scope, transaction, CSRF,
idempotency and no-plaintext-on-replay behavior is unchanged. New denial tests prove a denied action
does not load the Table. The four focused API suites pass 29/29, the three matching BFF transport
cases pass 3/3, API typecheck/build/lint pass, and the Dining production-fail-closed browser journey
passes 2/2. Fresh 1440/390/320 Dining captures were inspected; `git diff --check` and focused
Prettier pass. Browser evidence uses synthetic responses and does not authenticate a real DEMO user.
The local InternalTest configuration still names `dining.session.manage`; no role/bootstrap change
was made, and an identity with only that action will remain denied until an authorized role update.
This implements the canonical Screen action in code; it does not resolve the separate operator
grant, projection, Store/UAT, Accepted Screen, production or release gates.

## Dining InternalTest helper permission alignment selection (2026-09-25)

Selection: close the remaining WP-2402 local helper's use of unregistered `dining.session.manage`
after the Merchant Screen routes were aligned to `dining.operate`. The only affected input is
`tooling/environment/pilot-dining-session.mjs`, which resolves the current Store and constructs
staff authorization evidence for the same Dining Session Start / credential regeneration operations.
Use the same canonical action as the registered Screen and API routes. Do not modify role grants,
bootstrap data, domain permission grammar, or any `.local` installation. Acceptance: both resolver
and action recheck use `dining.operate`, and the helper source passes the repository's existing
ESLint/Node syntax checks. The `.local/pilot-v14` runtime is absent in this checkout, so no actual
identity, Store operation, or role compatibility test is selected or implied.

Result: `tooling/environment/pilot-dining-session.mjs` now resolves current Store scope and
rechecks staff evidence with `dining.operate`, matching the Merchant Screen APIs. Script ESLint,
`node --check`, focused Markdown Prettier and `git diff --check` pass. `.local/pilot-v14` is absent;
no actual identity or Store operation was run. The existing DEMO role/bootstrap was not changed and
still needs an authorized update before identities holding only `dining.session.manage` can use
these routes. No role grant, package Domain grammar, persistent data or external state changed.

## Private Figma Make access recheck (2026-09-25)

Selection: reopen the recorded private `High-Fidelity Restaurant Order Prototype` in authenticated
Chrome and determine which project surfaces are currently readable and editable. Check the Dining
Preview, Version 29 history, Code file tree and source editor, and the AI prompt state. Do not change
source, run a Make prompt, publish, or alter sharing. Record separately whether the editor is
available and whether cloud-save persistence has been proven.

Result: the private Make URL loads the Dining Preview and Version 29 conversation/history; the Preview
shows its synthetic The Elm / Table T-07 scenario. The Code view exposes the project file tree, and
`src/customer/pureLogic.ts` opens in a settable text editor, so source is readable and a manual edit
control is available. No text was entered; save/reload persistence is unverified. The AI prompt,
context and Send controls are disabled, and the project states that team AI credits reset September
30, 2026. This confirms that Make's AI generation/edit flow remains unavailable at this checkpoint,
while manual code editing appears available but was not exercised. No source, publication or sharing
state changed. This observation does not itself transfer Make code or design to the repository;
continue repository implementation from accepted Handoff/Screen sources and mark remaining Make
AI generation and save-persistence work as externally gated.

## Kitchen Work Item current-frame control alignment (2026-09-25)

Selection: directly re-read high-fidelity regular Design Review contexts and screenshots for
`KIT-WORK-ITEM` nodes `51:2`/`51:3`/`51:4` against the current Merchant JSX, CSS and browser assertions.
Desktop node `51:2` uses a 340px-wide vertical controls group; Return to Kitchen queue is left-aligned
across that group, while the 186px Refresh from source control is aligned to its right edge. Mobile
nodes `51:3`/`51:4` keep the return link left-aligned above a full-width Refresh control. The current
Merchant desktop column was only 186px wide and right-aligned both items. Change only that desktop
group width/link alignment and its browser assertion; preserve the mobile controls, return route state,
current projection data, compact Work Item card, unavailable detail groups and locked commands. The
acceptance check is the existing `kitchen-queue.spec.ts --project=production-fail-closed` journey with
fresh 1440/390/320 screenshots, focused Kitchen component tests, Merchant typecheck/lint/format/build,
and whitespace validation. No API, projection, Domain or permission changes.

Result: the detail-only desktop action group is now 340px wide; its Return link spans the group from
the left, and the 186px Refresh button remains right-aligned beneath it. The 390px and 320px layout is
unchanged: left-aligned return link and full-width Refresh control. The production-fail-closed
`kitchen-queue.spec.ts` journey passes 3/3 and now asserts the desktop group width and left/right
alignment alongside the existing mobile layout checks. `KitchenBoardPages.test.tsx` passes 11/11;
Merchant typecheck, targeted ESLint, Prettier, `git diff --check` and normal Merchant production build
pass. Fresh detail screenshots at 1440/390/320 were inspected; the controls now match the current
Review frames and there is no horizontal overflow. The production build retains the existing
1,249.92 kB chunk-size advisory. Review-frame sample work remains synthetic; this change does not
complete missing Kitchen projection fields, named operator/device authority, Accepted Screen,
Store/UAT, release or production acceptance. This current-frame evidence supersedes the prior
description that the desktop return link should also be right-aligned.

## Current-checkout Dining and Kitchen browser refresh (2026-09-25)

Selection: the existing current-worktree screenshot artifacts were absent, so rerun the existing
Dining Session Start and Kitchen Queue production-fail-closed browser journeys to obtain current
1440/390/320 screenshots. Reuse the prior Screen/Handoff source-boundary selection because no
Dining/Kitchen JSX, projection, command or permission input changed after those reviews. Verify the
known responsive layout and ensure unavailable source facts remain explicit and commands remain
fail-closed. No application change is selected. Exact existing command:
`source .local/activate.sh && CI=true pnpm --config.verify-deps-before-run=false --filter @bop-rms/merchant-web exec playwright test e2e/dining-session-start.spec.ts e2e/kitchen-queue.spec.ts --project=production-fail-closed`.

Result: the first sandboxed attempt could not bind `127.0.0.1:5173` (`listen EPERM`); the same
command then ran with reviewed local loopback permission and passed 4/4 (Dining 1/1, Kitchen 3/3).
The production-preview build emitted the existing >500 kB chunk advisory. Fresh captures were
generated and visually inspected: Dining `dining-board-{1440,390,320}.png`; Kitchen
`kitchen-board-{1440,390,320}.png`, with detail and filter-sheet captures also present. Dining keeps
the desktop floor/selected-table split and mobile single-column flow. Kitchen keeps three desktop
cards and one mobile column; unprovided detail/source facts remain unavailable, its KDS/device lock
is explicit, and command controls remain disabled. No visible horizontal overflow was found at
these viewport widths. These browser fixtures are synthetic; they do not prove live Store data,
DEMO authorization, an Accepted Screen, real operator/device authority, Store/UAT or release
readiness. The images are generated under ignored `apps/merchant-web/test-results/` and are not
committed artifacts.

## Kitchen Work Item milestone explanation accuracy (2026-09-25)

Selection: compare `KIT-WORK-ITEM` history rendering with the `kitchen_work_queue_v1` projection
and its component/browser fixtures. The detail contract carries optional `execution.acceptedAt` and
`execution.readyAt`, which the screen already renders as `Accepted` and `Order item marked ready`
when present. Its note nevertheless said all start/progress/completion timestamps were absent,
without distinguishing those available milestones. Correct only explanatory copy and assertions;
preserve the Handoff 88.10 field boundary, milestone ordering, permissions, read-only commands and
current Review hierarchy. Acceptance: response-with-execution and response-without-execution copy
must be accurate; run the existing Kitchen component and production-fail-closed browser journeys,
Merchant typecheck, scoped ESLint/Prettier, then inspect fresh detail captures at 1440/390/320.
No API, projection, Domain, permission or persistence changes.

Result: when an execution object is present, the history explains that recorded acceptance and
Order-item-ready milestones appear above when available, and that Kitchen start/progress/completion
timestamps are not supplied by this projection. When the response has no execution object, the note
states that acceptance/ready times are absent from that response as well. The existing
`KitchenBoardPages.test.tsx` passes 11/11; `e2e/kitchen-queue.spec.ts --project=production-fail-closed`
passes 3/3; Merchant typecheck, targeted ESLint and Prettier pass. The Playwright production preview
build succeeded with the existing >500 kB chunk-size advisory. Fresh Work Item screenshots at 1440,
390 and 320 were inspected; the correction is legible at all widths without horizontal overflow.
No projection/query or business behavior changed. Synthetic browser facts do not prove live KDS
authority, Store/UAT, Accepted Screen or release readiness.

## Current-candidate Merchant production browser milestone (2026-09-25)

Selection: verify the complete current Merchant `production-fail-closed` Playwright project after
the assembled WP-2402 route, command and Review-state changes. The existing project includes ordinary
Orders/Dining/Kitchen/Pickup/Exceptions browser journeys, Review routes, and production demo-exclusion
assertions. Run only the repository's existing command; no fixture or business-data change. This
checks local current-source browser behavior and builds the normal Merchant preview, not the private
pilot runtime or a live Store.

Command: `source .local/activate.sh && CI=true pnpm --config.verify-deps-before-run=false --filter @bop-rms/merchant-web exec playwright test --project=production-fail-closed`.

Result: all 65 production-fail-closed Merchant browser tests pass in the current dirty checkout. The
normal production preview build succeeds and retains the known >500 kB minified JavaScript chunk
advisory. Coverage includes Orders queue and acceptance/recovery, Dining host transfer/serving/session
close/start, Kitchen read/filter/palette/command recovery, Pickup paging/permission recovery,
Exception filtering/follow-up/compensation recovery, route-specific responsive source-boundary
reviews, and production demo exclusion/fail-closed route checks. This does not run the `@demo`
desktop/mobile projects or Customer browser suite, use `.local/pilot-v14`, establish real DEMO
authorization, or prove Store/UAT, Accepted Screens, Provider/device/staffing readiness, full
`pnpm verify`, release evidence or production approval.

## Current-candidate Merchant assisted-demo browser milestone (2026-09-25)

Selection: complement the 65/65 current Merchant production-fail-closed result with its existing
`@demo` projects at their configured desktop and mobile viewports. Check the bounded showcase routes
and accepted-workflow link at 1440px and 390px after the current Merchant code changes. Use the
existing `playwright.config.ts` projects only; no new tests/fixtures, runtime install, backend identity,
or production data. This is repository-contained synthetic demo evidence, not current Windows/WSL
InternalTest runtime acceptance.

Command: `source .local/activate.sh && CI=true pnpm --config.verify-deps-before-run=false --filter @bop-rms/merchant-web exec playwright test --project=demo-desktop --project=demo-mobile`.

Result: the existing `demo-desktop` and `demo-mobile` projects pass 28/28 combined. Each viewport
covers 13 bounded screen showcases plus the accepted-workflow accessible-link check. The configured
preview build succeeds with the known >500 kB JavaScript chunk advisory. The fixture-based run does
not use the running Windows/WSL InternalTest runtime, actual DEMO credentials, Store data or live
services; no identity or permission acceptance is inferred. This run and the 65/65 production
fail-closed run are separate projects, not one all-project invocation.

## Dining Make/Review card layout migration (2026-09-26)

Selection: the current Review frames `24:2`, `24:60`, and `24:109` and the private Make Preview
show a Dining heading followed by the Registry eyebrow, grouped table cards, and selected details
below the board. The repository still puts selected details beside a narrow desktop board. Migrate
only this supported presentation hierarchy into `DIN-FLOOR-BOARD`; preserve the owner-backed Table
and elapsed-session fields, current permission/command rules, unsupported-field warning, and
synthetic-only test boundary. Use the existing Dining production-fail-closed browser journey with
three Main-area fixture cards to assert equal desktop columns and detail placement, capture and
inspect 1440/390/320, then run changed Merchant ESLint, Prettier, and `git diff --check`. Review
frames remain not accepted; no Make edit, save, publish, or share operation is included.

Result: the heading now places `Dining` before its Registry eyebrow; each card separates state,
capacity, and current-session status with the reviewed divider/hierarchy; a 1440 viewport lays three
Main-area cards across the 1120px workspace with 12px gaps, and selected details follow the full
board. At 390/320 the cards remain one column and the details follow the board. The synthetic E2E
fixture adds two Main-area rows in the parser-required ascending table-reference order; production
fields and command behavior are unchanged. The first browser run exposed a test-fixture ordering
issue; the corrected existing `e2e/dining-session-start.spec.ts --project=production-fail-closed`
journey passes 1/1. Fresh `dining-board-{1440,390,320}.png` captures were visually inspected and
the journey confirms no horizontal document overflow. Targeted ESLint passes for the TSX and E2E
files; ESLint has no CSS configuration, while Prettier, the production preview build, browser render,
and `git diff --check` cover the stylesheet. The build retains its existing >500 kB chunk advisory.
This corrects the earlier desktop split-pane screenshot noted in the Sep 25 browser recheck. The
result is local synthetic alignment to Review/Make hierarchy only; it does not accept the Review
frames, supply the full `query.din_floor_board` source groups, prove live Store behavior, or close
pilot/release readiness.

## Kitchen Figma hierarchy and projection revalidation (2026-09-26)

Selection: freshly read Design Review nodes `4:2`, `4:86`, `4:128` and `51:2`–`51:4`, then
reconcile current 1440/390/320 renders with `KIT-KITCHEN-QUEUE`, `KIT-WORK-ITEM`, Handoff 88.10,
and the actual `kitchen_work_queue_v1` / `kitchen_*_v1` fields. Preserve projection-backed station
partition, item state, elapsed age, quantity/modifiers and recorded accepted/ready milestones;
continue to withhold station labels, safe refs, allergen/exception cues, course/priority/SLA and
other detail fields absent from the current authorized projection. Do not turn Review sample records
into live facts or unlock KDS commands without named-session/device-lock authority. The comparison
will identify any supported presentation mismatch before selecting a code change. Use only the
existing `production-fail-closed` `e2e/kitchen-queue.spec.ts` journey, inspect fresh Queue and
Work Item captures at 1440/390/320, and run changed-file checks if source changes. These local
synthetic browser outputs cannot establish Store/UAT, Accepted Screen, KDS authority or release
acceptance.

Result: all six current Queue/Work Item Review nodes were readable and their screenshots were
compared with fresh repository captures. The supported hierarchy matches at the three target widths:
the Queue workspace is 1120px wide at 1440, its three 354px lanes begin at x=260/638/1016 with
24px gutters, mobile uses one lane per row, and the Work Item route retains its responsive controls
and detail rows. The 390px Queue uses the short Refresh label; the 320px Queue uses the full-width
“Refresh from source” control. Freshness, status, elapsed age, quantity/modifiers, and the available
accepted/ready history are projection-backed; unsupported station labels, safe refs, allergen/
exception/coursing/priority/SLA and other detail fields remain unavailable, and the KDS lock keeps
commands disabled. The existing `production-fail-closed` Kitchen journey passes 3/3 and fresh
Queue/Work Item screenshots at 1440/390/320 were visually inspected with no horizontal overflow.
No application source change was indicated by this comparison. This verifies local synthetic
presentation and interaction only; Review is not Accepted, and Registry source coverage, named
operator/device authority, Store/UAT, external evidence and release/production acceptance remain
open.

## Kitchen exact-reference search continuation (2026-09-26)

Selection: Handoff Section 88.10, the `KIT-KITCHEN-QUEUE` Screen Registry, and WP-1403 §29
require/support exact Order or Ticket reference search. The page previously loaded an unfiltered
projection and described reference search as unavailable. Add an Order/Ticket selector and exact
UUIDv7 query to the existing authenticated `ListKitchenQueue` request; references stay in React
memory only for the active query and in the same-origin POST body, and never enter URLs, browser
storage, page results, or screenshots. Keep the owner query, Store authority, projection generation
guard and four-page bound unchanged. Exact references are lookup inputs only, not display numbers.

Result: the existing queue client now applies either `orderReference` or `ticketReference`, validates
UUIDv7 before transport, and leaves the other exact filter null. The page clears the visible input on
submit and distinguishes no search matches from an empty queue. A new client test covers both filter
forms and rejection before transport; the production-fail-closed browser journey covers exact Order
lookup, no URL/visible identifier leakage, clear-search recovery, and maintains the requested
1440/390/320 responsive checks. The focused Kitchen component/client tests pass 25/25, the existing
Kitchen browser journey passes 3/3, Merchant ESLint, changed-file Prettier, production preview build,
and `git diff --check` pass. Visually inspected synthetic captures are
`apps/merchant-web/test-results/kitchen-board-{1440,390,320}.png` and
`kitchen-board-search-1440.png`; all three widths remain one-column on mobile/three-lane desktop as
before, the exact-reference field is visible, and no horizontal overflow appears. Merchant
TypeScript fails on four existing errors at `e2e/dining-session-start.spec.ts:286–287`; no
Kitchen-file diagnostics remain. This closes current Registry exact-reference search locally, not
safe public-reference display, unsupported course/priority/overdue fields, Accepted Screen status,
KDS authority, Store/UAT, or pilot/release readiness.

## Kitchen Ticket reference browser coverage (2026-09-26)

Selection: the exact-reference continuation has client coverage for both Order and Ticket, but its
real page-to-query browser journey exercises only Order. Extend the existing synthetic Kitchen
`production-fail-closed` journey to select Ticket, submit a projection-backed fixture ticket
reference, assert `ticketReference` is sent with `orderReference` null, and confirm neither URL nor
rendered page exposes the lookup input. Clear the search and preserve the existing 1440/390/320
responsive journey. The smallest check is the existing focused Kitchen Playwright project plus
formatting/lint and `git diff --check`; this validates local UI-to-query wiring only and does not add
owner, Store, KDS authority or release evidence.

Result: the production-fail-closed Kitchen journey now selects Ticket and proves the exact fixture
value is sent as `ticketReference` while `orderReference` stays null; the rendered page and URL do
not expose that value. Clear-search recovery still passes. All three Kitchen production journey
cases pass. Fresh 1440/390/320 captures were inspected: the desktop lane layout and the single-column
mobile layouts remain intact, the search control wraps without horizontal overflow at 390 and 320,
and the 320px full-width refresh control remains readable. The changed E2E file passes scoped
ESLint/Prettier, and `git diff --check` passes. The preview build emits the existing >500 kB chunk
advisory. This adds browser evidence for Ticket lookup only; all live Store, KDS authority, Accepted
Screen, external readiness and release/production gates remain open.

## Kitchen exact-reference privacy and authorization review (2026-09-26)

Selection: review the exact Order/Ticket reference flow across `KitchenBoardScreen`,
`createKitchenBoardClient`, the same-origin Merchant BFF route, `createMerchantKitchenQuery`, and
the projection query. Trace collection, transport, authorization, query binding, display/storage,
and failure handling. Reuse the fresh exact Order/Ticket browser journey and the focused client/API
tests already covering this unchanged code; this is a source review, so do not rerun application or
database suites. Check only the changed evidence text's formatting and repository whitespace.

Result: Order/Ticket UUIDv7 values are internal opaque identifiers used only as lookup inputs. The
client validates before a same-origin `POST` with CSRF, same-origin credentials, `no-store`, and no
redirect; the input clears after submission, and the active query stays in React memory. The BFF
requires the current authenticated session, rejects query-string fields, resolves current selected
Store and `kitchen.operate`, and rechecks permission around the owner read. The projection parser
accepts only its closed filter shape and UUID references; SQL uses bound parameters constrained by
the resolved Brand, Store and active generation. The bounded client reads at most four pages of 50,
checks a stable projection generation, and the UI does not render the identifier. The existing
focused client tests cover both filter variants and malformed UUID rejection before transport; the
fresh production browser journey verifies both UI branches, URL/page non-disclosure and clear-search
recovery. No Blocker, High, or Medium finding was identified in this changed flow. Residual limits:
global infrastructure request-body logging/rate policies were not audited here, and synthetic browser
fixtures do not establish live Store authorization, KDS operator/device-lock authority, Store/UAT,
Accepted Screen or release readiness. No runtime, API, Domain, permission, schema or projection code
was changed by this review.

## Kitchen exact-reference page validation (2026-09-26)

Selection: the existing client test proves malformed UUID input is rejected before transport, but the
browser journey does not yet prove the rendered form's native UUIDv7 constraint prevents a request.
In the existing production-fail-closed Kitchen journey, submit a malformed value before the valid
Order and Ticket queries; assert the input is invalid and the request count is unchanged. Then clear
the field and continue both valid searches. This is browser form validation only; no production
logic changes. Run the focused Kitchen production journey, scoped E2E lint/Prettier, and
`git diff --check`; inspect the existing responsive captures only if their layout changes.

Result: the browser journey submits `not-a-reference`, confirms native form validity rejects it,
and confirms the Merchant request count is unchanged. Clearing the field allows the existing Order
and Ticket searches to continue; those branches, privacy checks, clear-search recovery, and responsive
1440/390/320 journey remain green (3/3). Scoped ESLint, Prettier and `git diff --check` pass. No
application/API/Domain behavior changed; this is local browser evidence only, not live Store, KDS or
release acceptance.

## Kitchen exact-search projection fixture fidelity (2026-09-26)

Selection: the current browser route captures exact filters but returns all three fixture rows
regardless of those filters, so it cannot prove a correct filtered result or the registered
no-match state. Give the synthetic rows distinct Order/Ticket references and make the mocked List
response apply its Order/Ticket filters, as the real projection query does. Assert each valid lookup
returns its one matching row, and a valid UUIDv7 with no row shows “No matching work”; clearing it
restores the queue. Preserve malformed-input rejection, non-disclosure and the responsive journey.
Only the existing Kitchen production Playwright journey, scoped E2E ESLint/Prettier and
`git diff --check` are selected; production code and API behavior are unchanged.

Result: the E2E route now returns only rows whose Order/Ticket reference matches the submitted
filter. The browser proves each valid exact search returns its one matching fixture row, a valid
unmatched Ticket UUID shows the registered “No matching work” explanation without rendering the
identifier, and clearing search restores all three rows. The first attempt exposed a test-flow
assumption: clearing a search remounts the screen and restores the default Order selector; the
journey now explicitly selects Ticket before the unmatched lookup. The focused production Kitchen
journey passes 3/3. Fresh 1440/390/320 queue captures were visually inspected; the desktop lane
layout and mobile single-column layouts remain intact with no horizontal overflow. Scoped ESLint,
Prettier and `git diff --check` pass. No runtime or business code changed; the results use synthetic
fixtures and do not establish Store/UAT, KDS authority or release readiness.

## Kitchen exact-filter SQL parameter coverage (2026-09-26)

Selection: the new browser/client tests prove Order/Ticket selection reaches the Merchant request,
and source inspection shows the PostgreSQL owner query binds `orderReference` and `ticketReference`
as parameters `$4`/`$5`, scoped by the authorized Brand, Store and active projection generation. The
existing `kitchen-queue-queries.test.ts` verifies the null/default values but does not assert either
non-null exact-filter binding. Add two focused adapter cases that prove the Order and Ticket UUIDs
occupy only their corresponding SQL parameters while the other remains null. Run the single existing
`@rms/kitchen` query test file, package lint/Prettier as needed, and `git diff --check`; no SQL,
projection contract or production behavior change.

Result: two parameterized adapter cases now prove Order and Ticket filters occupy only `$4` and `$5`
respectively, keep the other UUID parameter null, retain the Brand/Store/generation scope parameters,
and do not interpolate either UUID into SQL text. The focused `kitchen-queue-queries.test.ts` passes
10/10; scoped ESLint, Prettier and `git diff --check` pass. This verifies query construction and
parameter binding, not a live Store's projection contents or pilot/KDS/release acceptance.

## Kitchen exact-reference PostgreSQL projection acceptance (2026-09-26)

Selection: the current isolated Kitchen PostgreSQL acceptance seeds the canonical projection,
activates it through the owner store, and reads it using a restricted database role, but its read
assertions cover only an unfiltered page and a status-filter miss. Extend that acceptance to query the
seeded `order_id` and `kitchen_ticket_id` independently and assert each returns the exact projection
row, then query a different valid UUIDv7 and assert an empty result. During the first runs, both the
queue and adjacent Ticket acceptances exposed stale WP-1403 assumptions: global migration-history
count exactly 49 (the current catalog has 198), then the exact schema table list limited to the seven
tables present at that milestone (later accepted migrations add more Kitchen tables). Replace these
global totals with an exact check that `1500_002_create_kitchen_work_queue_projection` is applied and
a required-table subset check. The Ticket suite also hardcodes schema-wide immutable UPDATE trigger,
rule, trigger-function, foreign-target, index and prohibited-column inventories; the current schema has additional valid
append-only tables, all still owned by `rms_kitchen`. Scope immutability invariants to the original
Ticket/projection tables, and replace the exact foreign-target snapshot with required existing
targets plus a same-Kitchen-schema boundary assertion; scope composite-index checks to the original
Ticket/projection tables as well, and scope the prohibited-column scan to those same tables.
Preserve the Brand/Store/GUC, active-generation, read-only
transaction and restricted-role checks. Run only the existing
`packages/database/vitest.kitchen-queue-projection.config.ts` and `packages/database/vitest.kitchen-ticket.config.ts`
acceptances plus changed test lint/format and `git diff --check`. This is synthetic isolated
PostgreSQL coverage, not current Store data or operational acceptance.

Result: queue projection acceptance passes 2/2, including exact Order-reference, exact Ticket-reference
and valid no-match reads through the restricted owner adapter. Kitchen Ticket isolated PostgreSQL
acceptance passes 1/1 after retaining the original Ticket/projection safety checks while limiting
schema-inventory assertions to those seven owned tables. ESLint, Prettier and `git diff --check` pass.
The first restricted Docker launch failed before database startup; the same existing acceptance then
ran with approved local Docker access. A prior variant run exposed stale schema-wide fixture assumptions,
which this selection now scopes to Ticket-owned behavior. No production data or live Store was used; these
results do not establish KDS, Store/UAT, pilot, release or production acceptance.

## Private Figma Make access recheck (2026-09-26)

The exact private `High-Fidelity Restaurant Order Prototype` link reopened in the authenticated
Chrome session. Preview displayed fictional The Elm / T-07 content; Code view exposed the `src`
file tree and an `App.tsx` text editor marked settable. The authenticated Figma identity reports a
Full seat/admin role on the target team. AI prompt/model/Send controls remained disabled with the UI
stating team credits reset on 2026-09-30. No source edit, save attempt, publish, share change, or
business action was performed. Thus read access and an editable Code surface are currently observed;
durable manual-save permission remains unverified, and AI generation remains quota-gated. This is
not complete Make/Screen, responsive, keyboard, or business acceptance.

## Kitchen Make preview and repository projection comparison (2026-09-26)

Selection: inspect the existing private Make `/operations/kitchen` preview and `KitchenWorkspace.tsx`
Code view without editing the file. Reconcile its supported hierarchy against `KIT-KITCHEN-QUEUE`,
`KIT-WORK-ITEM`, Handoff 88.10 and the actual Kitchen projection. Use existing repository
1440/390/320 screenshots for the local comparison because no repository UI input changed. No Make
save/publish/share, new browser journey or synthetic-data migration is selected.

Result: Make currently shows fictional station labels (`Grill`, `Fryer`, `Cold`, `Pastry`, `Bar`),
`KT-002` / `DEMO-1002` references, fixed Business Date `2025-11-14`, and a simulated action function;
the app explicitly labels its records demo data. The AI prompt/model/Send remain disabled through
the displayed `2026-09-30` team-credit reset. Those example values and simulated command results are
not owner projection facts. The repository retains the supported station grouping, state controls,
age/status/quantity hierarchy and the read-only KDS fence, but does not render missing station labels
or unsafe internal UUIDs. It adds exact UUIDv7 search because Handoff 88.10 requires lookup, even
though the current Review footer still calls search unavailable. Existing current-tree screenshots
`apps/merchant-web/test-results/kitchen-board-1440.png`, `kitchen-board-390.png` and
`kitchen-board-320.png` show the registry-required search, scoped unavailable filters, KDS lock and
no horizontal overflow. No app or Make source changed. These synthetic screenshots and fictional
Make preview do not establish an Accepted Screen, live Store/KDS authority or complete accessibility/
business acceptance; Make save persistence also remains unverified.

## Merchant typecheck blocker cleanup (2026-09-26)

Selection: Merchant `typecheck` exposed four `noUncheckedIndexedAccess` diagnostics in the Dining
responsive geometry assertions at `apps/merchant-web/e2e/dining-session-start.spec.ts:286–287`.
The test expected three Main-area measurements but its Playwright length assertion does not narrow
the TypeScript array. Add an explicit guard for the first and second measured tiles; keep the existing
runtime count, widths, vertical alignment, and 12px gutter assertions unchanged. Verify with Merchant
typecheck, lint, file-scoped Prettier, the existing Dining `production-fail-closed` journey (which
captures 1440/390/320), and `git diff --check`. This is test type-safety cleanup only.

Result: the explicit guard now narrows both indexed values and provides a focused error if either
measurement is absent. Merchant typecheck passes across the package; ESLint, Prettier, and
`git diff --check` pass. The focused Dining `production-fail-closed` browser journey passes 1/1 and
retains its responsive assertions/captures at 1440/390/320. No runtime code, API, Domain, permission,
projection, or business behavior changed. The prior typecheck blocker is cleared; this does not
establish full Merchant browser-suite, pilot, Store/UAT, Accepted Screen, or release readiness.

## Kitchen station display source reconciliation (2026-09-26)

Selection: trace whether the Kitchen-owned station-routing contract and Queue projection contain a
safe display name that would support labeled lanes and the registered Station filter. Read the
candidate evidence contract, persistence mapping and Queue projection/SQL fields. Do not introduce
fictional Make station names, expose opaque references, or change behavior when no authorized source
exists. Source reconciliation and Markdown/whitespace checks only.

Result: `KitchenStationRoutingCandidate` has station/routing references, versions, status,
capabilities and target reference; the persisted configuration stores that evidence as `record_json`.
Neither it nor the current Queue row contract carries a safe localized station label. The UI must
continue showing station labels unavailable and keep the Station selector disabled until an
owner-approved label source/contract is available. No application, domain, projection, migration or
external state changed. This source scan is bounded to the inspected contracts and does not prove
that no other external runtime contains station metadata.

## Kitchen current-Store reload journey (2026-09-26)

Selection: whole-project review identifies cross-Store operator journey coverage as an outstanding
local acceptance question. `MerchantShell` switches only to a Store already present in the
authorized workspace snapshot, and `App` remounts Store-scoped pages with the returned Store and
CSRF. Existing Kitchen E2E coverage authorizes one Store at a time; the Exceptions scenario
already covers global selection but does not prove Kitchen reloads its owner query. Add a synthetic
end-to-end journey from `/app` through Store 1 Kitchen, switch to Store 2, and re-enter Kitchen.
Assert the request body contains no caller Store authority, Store 2 projection content appears and
Store 1 content does not. The existing `production-fail-closed` Kitchen journey, Merchant typecheck,
scoped E2E ESLint/Prettier, fresh 1440/390/320 captures and `git diff --check` are the selected
checks. This does not prove real membership, BFF authorization, RLS or live Store readiness.

Result: the new synthetic `production-fail-closed` Kitchen journey passes as part of the focused
spec (4/4). It enters Store 1 Kitchen, switches through the authorized shell selector, re-enters
Kitchen under Store 2, verifies Store 2 content is present and Store 1 content is absent, and
verifies the Kitchen query carries no caller-supplied Store reference. Fresh 1440/390/320 captures
were inspected: Store Two and its synthetic item are visible, the existing fail-closed/unavailable
states remain clear, and no horizontal overflow appears. Merchant typecheck, scoped E2E ESLint,
Prettier and `git diff --check` pass. This proves the local client/shell sequence against synthetic
responses only; it does not establish real Store membership, BFF authorization, RLS, live Store/UAT,
or release readiness.

## Current Merchant production browser suite revalidation (2026-09-26)

Selection: the previously recorded complete Merchant `production-fail-closed` project result was
65/65. The Kitchen Store-switch journey added one registered case since that run, so the prior
result does not cover the current test set. Re-run the same whole Merchant production-fail-closed
project and its existing production preview build. Keep the result bounded to local synthetic
browser behavior; no Store/UAT, DEMO runtime or release claim follows.

Result: after the sandbox initially denied Vite's loopback bind, the existing command was rerun
with local loopback permission and passes 66/66, including Kitchen's new Store 1 → Store 2 route,
all current Orders/Dining/Kitchen/Pickup/Exceptions journeys, review routes and demo-exclusion
checks. The preview build succeeds with the existing >500 kB chunk advisory. Browser responses are
local/synthetic; no actual DEMO identity, `.local/pilot-v14`, Store membership, BFF authorization,
RLS, live UAT, Accepted Screen, or production/release readiness is established.

## Persisted Dining Table HTTP composition revalidation (2026-09-26)

Selection: the WP-2402 Dining Table SetBlock/ClearBlock path already has a selected isolated
PostgreSQL acceptance in `vitest.current-permission-policy.config.ts`. Re-run that exact config
against the current checkout because its changed helper composes the Merchant runtime and actual
HTTP route with the persisted Identity, Store-selection, Membership, Permission, Dining and Audit
owners. Also lint and format the changed database helper and check whitespace. This does not touch
the local pilot database or any external service.

Result: the first sandboxed run could not start isolated PostgreSQL because Docker Compose was
denied; the same command with authorized local Docker access passes 1/1. The exercised path uses
the actual persistent Merchant login, BFF session/CSRF, selected Store and SQL permission records;
the actual HTTP router and `createMerchantRuntime`; SetBlock, same-intent replay, ClearBlock and a
state-valid SetBlock after current Store permission denial; and persisted Table/operation/event/
Audit assertions with no duplicate replay writes. ESLint and Prettier pass for
`packages/database/test-support/persistent-merchant-bff.mjs`; `git diff --check` passes. The earlier
failed bootstrap prototype remains a historical attempt; this current result comes from the later
composed acceptance path. This proves only the synthetic isolated local composition, not real Store
authority, UAT, production data or release readiness.

## Persisted Kitchen queue BFF composition (2026-09-26)

Selection: the browser journey and Merchant BFF tests use synthetic HTTP responses, while the
Kitchen PostgreSQL projection acceptance verifies its owner query separately. Close the repository
composition gap in the existing current-permission-policy isolated database fixture: grant only
synthetic `kitchen.operate`, seed one schema-valid source Ticket/Work Item and an owner-built active
generation/projection row for the selected Store, compose `createMerchantKitchenQuery` through
`createMerchantRuntime`, and issue an exact-ticket List request through the actual HTTP router.
Check invalid CSRF denial, returned item fields, opaque station reference, selected Store and
`operatorStatus: Unverified`. Run the exact isolated PostgreSQL config, ESLint and Prettier on the
changed helpers, and `git diff --check`. No live KDS, pilot or external service is involved.

Result: `vitest.current-permission-policy.config.ts` passes 1/1. Kitchen's public
`buildKitchenQueueRows` and `buildKitchenQueueGeneration` compute the synthetic row and generation
digests; schema-valid source Ticket/Work Item and projection records are seeded into the isolated
database. The actual HTTP request with wrong CSRF returns 403; the current authenticated Merchant
session with valid CSRF returns 200 through a restricted SQL role. The response identifies the
selected Store, leaves operator authority `Unverified`, reports `initializedEmpty: false`,
`partial: false`, `stale: false` and returns the matching Queued item with expected quantities,
display name and opaque station reference. The role can SELECT the Kitchen generation/projection
tables only. ESLint, Prettier and `git diff --check` pass for changed helpers and records. The first
run caught an extra field rejected by Kitchen's strict source-ticket parser; removing `proofBundle`
from the read-feed fixture produced the passing run. The earlier empty-generation check is retained
as prior evidence; the current result closes populated item readback through this local BFF
composition. KDS/device authority, live Store/UAT, Accepted Screen and release readiness remain
unverified. Sandbox Docker start was denied initially; the selected test passed with local Docker
access.

## Persisted Kitchen Work Item detail BFF composition (2026-09-26)

Selection: after adding populated List readback, verify the `KIT-WORK-ITEM` projection's actual
Merchant `Get` path through the same isolated PostgreSQL fixture, persisted session/Store and
`kitchen.operate` policy. Send wrong/current CSRF variants for `kind: Get` using the seeded opaque
Work Item reference. Assert no-store, current Store, `operatorStatus: Unverified`, complete/non-stale
metadata and the expected fields already owned by the Queue projection. No source, schema, permission
or browser UI change is included; run the same selected DB config and helper lint/format/checks.

Result: `vitest.current-permission-policy.config.ts` passes 1/1. Both populated List and Get requests
return 403 on wrong CSRF, then 200/no-store for the valid persisted session and selected Store. Get
returns the expected Work Item, queued status, quantities, localized display name and opaque station
reference with `initializedEmpty: false`, `partial: false`, `stale: false` and
`operatorStatus: Unverified`. ESLint, Prettier and `git diff --check` pass. This is local synthetic
HTTP/runtime/owner-projection evidence; detail history/preparation/safety sources, KDS/device lock,
Store/UAT, Accepted Screen and release/production acceptance remain open.

## Figma Make Kitchen source and manual editor recheck (2026-09-26)

Selection: re-open the current private Make project in the authenticated Figma account and check its
current source manifest, `KitchenWorkspace.tsx` Code view, manual source editor affordance, and AI
generation availability. Treat Make content as prototype evidence only; do not copy unsupported
station names, references, dates, records, or simulated commands into the repository. No Make source,
save, publish, or sharing mutation is selected. Compare the supported Kitchen hierarchy with the
already inspected local `KIT-KITCHEN-QUEUE`/`KIT-WORK-ITEM` journeys at 1440/390/320; no new local
browser run is needed absent repository changes.

Result: the current Figma project opens in the authenticated account. `get_design_context` returns a
source manifest including `src/components/KitchenWorkspace.tsx` and image resource links; direct
MCP resource read for that source still returns `Unknown resource`. The browser Code view opens the
current `KitchenWorkspace.tsx` and exposes its source text in a settable text-entry area, so the file
is readable and the manual editor affordance is present. No edit was made, therefore save/persistence
is not verified. The visible AI prompt, Build mode, model picker, and Send control remain disabled;
the displayed credit reset is September 30, 2026. The current Make source still contains prototype
action simulation and sample-specific fields; the fresh `/operations/kitchen` preview shows the
fictional `The Elm`/`Queen St. W.` context, fixed Business Date `2025-11-14`, named `Grill`/`Fryer`/
`Cold`/`Pastry`/`Bar` lanes, and `KT-002`/`DEMO-1002` sample references. These are not authority for
the repository projection.
The existing local 1440/390/320 Kitchen captures remain the relevant code evidence: exact-reference
search, supported filters, lane hierarchy and mobile stacking are retained, while missing station
labels/actions remain unavailable. This confirms current private project access and source visibility,
not accepted design parity, writeback persistence, Store/UAT, KDS/device authority, or release
readiness.

## Cross-Store Orders and Pickup journey coverage (2026-09-26)

Selection: the whole-project coverage review calls for multi-Store operator journeys; current
production journeys already cover Dining, Kitchen and Exceptions, but Orders and Pickup only verify
single-Store pagination/recovery. Add one existing-project browser journey to each screen: enter
Store One from `/app`, load its synthetic row through the current authenticated session, switch
through the authorized Store selector, re-enter the screen, then prove Store Two's row replaces Store
One's. Assert the switch request carries only the selected Store reference. Orders uses its existing
credentialed GET and must not put Store authority in URL/body; Pickup uses its existing POST with the
current CSRF and must not put Store authority in its body. This verifies client route/session
continuity only; fixtures are synthetic and do not prove Store membership, BFF authorization, RLS,
UAT, or production behavior. Run the two affected Playwright specs, Merchant typecheck, scoped
ESLint/Prettier, Screen Registry and `git diff --check`; no application or persistence change is
selected.

Result: the focused production-fail-closed run passes all 6 cases across the Orders and Pickup specs,
including both new Store One → Store Two journeys. Orders keeps its existing credentialed GET without
Store query/body authority; Pickup sends the current Store's CSRF and only its supported cursor/page
fields, while its response is scoped to the active Store. Both screens replace the prior Store row
after switching. Merchant typecheck, scoped ESLint/Prettier, Screen Registry (210 records), and
`git diff --check` pass. The preview build retains the existing chunk-size advisory. The first
sandboxed Playwright bind failed with loopback `EPERM`; the same run passed with approved local
loopback access. Fixtures are synthetic; actual Store membership, BFF/RLS, Store/UAT, and release
acceptance remain unverified.

## Current candidate secret scan coverage (2026-09-26)

Selection: the current development candidate includes 41 untracked non-ignored files, while the
repository's existing `secret-scan:check` deliberately enumerates only `git ls-files` entries. Run
that existing check against all tracked current contents, then apply the same four high-confidence
patterns from `tooling/security/secret-scan.test.mjs` to the exact current untracked-file inventory.
Report the two coverage counts separately and expose only file/pattern names if a finding exists;
never print matched secret contents. This covers the repository's configured high-confidence
patterns, not a full credential scanner or release-artifact scan. No source change or broad test is
selected; finish with `git diff --check`.

Result: `CI=true pnpm --config.verify-deps-before-run=false secret-scan:check` passes 1 file / 2
tests against all tracked current contents. A read-only Node scan using the same four patterns finds
no matches in the 41 untracked non-ignored candidate files. `git diff --check` is clean. This verifies
only the repository's configured high-confidence patterns in the current source candidate; it is
not a full credential scanner, ignored-file scan, release-artifact scan, or formal security review.

## Task Inbox Store-switch stale-view clearing (2026-09-26)

Selection: the existing cross-Store journey set now covers five Merchant operation pages, but the
read-only Task Inbox route has no switch/reload case. Its current general runtime accepts a fixed
server-configured queue and may report the feature unavailable for another selected Store; do not
invent a second Store queue or Task row. Add a synthetic browser journey that reads one Store's
permission-trimmed Task row, switches via the existing authorized Store selector, then makes the
second Store read return the existing unavailable response and proves the first Store's task
reference/content is cleared. Assert the Store-switch request carries only the target Store
reference, `/merchant/tasks` remains a credentialed GET without task/Store URL authority, and Task
mutations remain disabled. This is stale-view fail-closed evidence only; it does not provide
per-Store queue provisioning, membership, BFF/RLS or Manager workflow evidence. Run the focused Task
Inbox production Playwright spec, Merchant typecheck, scoped ESLint/Prettier, Screen Registry and
`git diff --check`.

Result: the focused `production-fail-closed` Task Inbox spec passes 2/2. It renders Store One's
synthetic permission-trimmed task, switches with the authorized target reference, then receives the
configured unavailable response for Store Two. The prior task content/reference disappears, and no
claim/assign/acknowledge/source action becomes available. Both reads remain same-origin GETs without
Store/task query parameters. Merchant typecheck, scoped ESLint/Prettier, Screen Registry (210
records), and `git diff --check` pass. The fresh preview retains its existing chunk-size advisory.
This verifies client-side stale-view clearing only; Store Two queue provisioning, actual
membership/BFF/RLS, Manager actions, Store/UAT and release acceptance remain unverified.

## Owner-entry to Merchant authorization composition follow-up (2026-09-26)

Selection: test whether a current Owner-generated Ready Pickup can be consumed by the existing
Merchant BFF/policy journey in the same isolated database, while preserving current Permission
authorization. The smallest acceptance is the existing `current-permission-policy` database
configuration plus the existing public Store Entry owner journey; no production auth or policy
change is selected. This is an exploratory composition check; its result must not be treated as
evidence that a cross-domain Merchant queue journey passed.

Result: the first composition attempt reached an Owner-generated Ready Pickup and passed synthetic
Identity/Tenant association checks, then failed closed in Permission policy materialization before
role loading. Owner Entry had seeded synthetic acceptance roles/permissions at the current wall
clock (2026-09-26), while this current-policy acceptance deliberately evaluates fixed
2026-07-28 `f.AT`; the future-dated rows correctly made materialization unavailable. A second
attempt aligned the Owner Entry clock to `f.AT`, but Pickup checkout returned
`checkout_session_not_found` before its validation port ran (`failures: 0`, `validations: 0`,
`observations: 0`). The Entry runtime deliberately switches to real current time when checkout
activates, so the July Guest Session is expired at checkout. No production permission or session
behavior was changed. Both experimental hooks were removed. The standalone
`current-permission-policy` acceptance passed 1/1 after the first experiment. Owner-to-Merchant
queue integration remains unverified; a new acceptance fixture must keep Guest Session expiry,
Owner records, Permission policy state, and Merchant BFF session on one consistent clock without
relaxing expiry checks. Kitchen 1440/390/320 screenshots and the focused responsive browser evidence
recorded above remain local synthetic UI checks; actual Store membership, Merchant BFF/RLS, Store/UAT
and release acceptance remain unverified.

## Owner Entry shared-clock fixture follow-up (2026-09-26)

Selection: an experimental `checkoutNow: () => at` hook pinned Pickup checkout to the Guest Session
issuance instant while retaining expiry and Permission checks. Added a temporary read-only diagnostic
that returned only authorization booleans/states, never credentials or object references. The focused
`public-store-profile` Pickup journey observed Guest Session authorization, scope/channel matching,
Cart binding and initial checkout authorization all succeed; the route nevertheless returned
`checkout_session_not_found` before validation (`validations: 0`, `observations: 0`). Source tracing
identified the next gate: the persisted allocation store evaluates PostgreSQL `clock_timestamp()`
and reauthorizes at that transaction instant. The test-pinned application clock was one second behind
the database clock, so `createCustomerCheckoutSessionAuthorization` correctly rejected a future
observation relative to its `now()` and the HTTP layer masked Permission Denied as 404. This confirms
the fixed-clock experiment was invalid; it does not close Owner→Merchant composition or explain the
separate historical Permission-policy date mismatch.

Removed the temporary diagnostic, clock seam and cross-fixture wiring. Earlier default-flow checks
remain valid: `public-store-profile` passed 3/3 and `current-permission-policy` passed 1/1 under
approved Docker access; helper ESLint/Prettier and `git diff --check` passed. The next meaningful
fixture must use a live monotonic clock consistent with PostgreSQL while aligning Permission
effective dates to the same test instant, without relaxing Session expiry or Permission checks. No
production auth or Permission behavior changed. Owner Entry → Merchant populated queue composition
remains unverified.

## Owner/Permission fixture clock-domain separation (2026-09-26)

Selection: after the failed pinned-clock experiment identified PostgreSQL's transaction-time
reauthorization check, inspect all current-policy fixture consumers before changing clock behavior.
The fixture is imported by ten test files/helpers; its timestamps feed Merchant auth/session,
Permission effective periods, Store setup and cross-domain BFF verification. The BFF helper also
contains fixed `2026-07-28` Tuesday Business Date and weekday service windows used by its availability
assertions. Shifting the shared fixture wholesale to the live date would change those tests' Store
hours semantics. Keep the existing deterministic default and introduce independently named live
Identity/Session/Permission time inputs and Store Business Date inputs for the Owner→Merchant
composition acceptance. Do not relax the transaction-bound `observedAt <= now()` check or session
expiry.

Current helper source reconciliation (2026-09-26): the current-clock public Entry acceptance sets
its owner time to `Date.now() - 1s`, while the current-policy test and `verifyPersistentMerchantBff`
retain the fixed `2026-07-28T12:30Z` timestamp. That helper's service-hours fixture is Tuesday-only
and asserts fixed July Store Business Dates. The harness therefore needs an optional, independently
named live Identity/Session/Permission clock while preserving the static default, plus explicit
current-clock Store Business Date/weekday setup for the integrated case. This is a test-fixture
separation; the production clock-order fence and Store Business Date semantics must remain intact.

Same-database failure source audit (2026-09-26): the selected callback intentionally collapses
internal failures at three layers: the Identity selection store maps validation/SQL errors to
`BROWSER_SESSION_SELECTION_DENIED`, the Merchant selection adapter maps that to
`MERCHANT_SESSION_SELECTION_DENIED`, and the BrowserSession transaction boundary maps callback
failures to `BROWSER_SESSION_DENIED`. Therefore the observed public error cannot locate the failing
stage. A renewed reproduction should keep only test-local stage markers around association
validation, selection persistence and workspace composition. It must not retain raw SQL errors,
query values, cookies, digests or opaque business references. This is a test-diagnostic plan only;
no production error contract or authorization behavior is selected for change.

Test-helper clock seam (2026-09-26): `verifyPersistentMerchantBff` accepts optional Identity/
Permission fixture timestamps, Store business dates/weekdays and per-Store service windows; the
existing static Tuesday/July values remain its default. The current-permission-policy PostgreSQL
acceptance passes 1/1 on the default path and 1/1 with the explicit optional inputs matching that
static fixture. The first optional-path attempt widened target hours and changed its expected
Closed status to Open; separate Store-window inputs restored the original assertion. Helper
ESLint/Prettier and `git diff --check` pass. A truly live-clock run and same-database
Owner-generated Ready Pickup journey remain unverified.

The current Figma Review `4:2` design-context screenshot was re-read in this turn alongside
`KitchenBoardPages.tsx`, its current styles and the Screen Registry. The supported desktop hierarchy,
read-only KDS explanation, exact-reference search, and source-limited filters remain represented;
Figma sample business rows/station labels remain excluded. No new Kitchen source edit was selected.
The latest recorded local responsive/browser evidence remains the existing 1440/390/320
`production-fail-closed` Kitchen journey; Review and external acceptance gates remain open.

## Kitchen Review search alignment (2026-09-26)

Selection: the desktop Kitchen Queue Review frame `4:2` still said Order/Ticket search was
unavailable even though the accepted Registry and repository implement exact UUIDv7 lookup on the
authorized Kitchen projection. Reconcile its toolbar and footer, mobile notes `4:86`/`4:128`, and
mobile open filter sheet `8:8` with that behavior. Keep internal UUIDs hidden, mark unsupported
source fields unavailable, preserve the KDS/device command lock, and retain synthetic sample content
unchanged. Do not edit Make, publish, or change sharing. Inspect all four screenshots after the
design edits; no application/browser rerun is selected because code did not change.

Result: desktop `4:2` now includes the exact Order/Ticket selector, UUIDv7 input and Search control;
unsupported toolbar filters say unavailable. Mobile `8:8` includes the implemented reference
search, clear controls and URL/privacy hint, with unsupported source filters labeled unavailable.
The three footer notes say exact lookup is supported while identifiers remain hidden. Unsupported
public labels, station/safety cues, course, priority/overdue and unverified KDS/device authority
remain explicit; commands/actions remain disabled. Post-edit screenshots of `4:2`, `4:86`, `4:128`
and `8:8` were inspected at 1440/390/320 and the mobile sheet fits its frame. No application source,
Make preview/source, sharing, or publish state changed. Review frames remain Not Accepted; sample
rows remain fictional, and Store/UAT and production acceptance are still unverified.

## Kitchen reference placeholder parity (2026-09-26)

Selection: the updated Kitchen Queue Review shows the supported exact UUIDv7 search input
explicitly, while fresh repository captures show a blank desktop field. Add the non-sensitive format
hint as a placeholder for desktop and the existing mobile filter-sheet search; preserve the
accessible name, in-page-only privacy boundary, validation and request behavior. Acceptance: assert
the placeholder at the existing desktop and 390/320 mobile cases in `e2e/kitchen-queue.spec.ts`,
then run that existing `production-fail-closed` journey and inspect fresh 1440/390/320 screenshots.
Run changed-file ESLint/Prettier and `git diff --check`; no query, projection, API, permission or
command changes.

Result: the desktop input shows the non-sensitive `Exact UUIDv7 reference` placeholder; mobile uses
the shorter `UUIDv7 reference` so it fits at 320px. The visible Order/Ticket field label and
accessible name, in-page-only reference handling, validation and request behavior are unchanged.
The existing Kitchen `production-fail-closed` Playwright journey passes 4/4 with desktop/mobile
placeholder assertions at 1440/390/320. Fresh Queue screenshots at all three widths and open
filter-sheet screenshots at 390/320 were inspected; no horizontal overflow or unsupported
facts/actions appear. Merchant typecheck, scoped ESLint, Prettier and `git diff --check` pass. The
Vite preview retains its existing greater-than-500-kB chunk advisory. No query, projection, API,
permission or command behavior changed. Review remains Not Accepted; Store/UAT, KDS/device authority
and release/production gates remain open.

## Current Kitchen Make/Review parity and browser revalidation (2026-09-26)

Selection: re-read the current private Make Kitchen source in its authenticated Code editor, and fetch
the current Review screenshots for Queue `4:2`, `4:86`, `4:128` and Work Item `51:2`, `51:3`, `51:4`.
Compare only supported styling/hierarchy with the Screen Registry and actual Queue/Work Item
projections. Preserve exact Order/Ticket search, opaque station grouping, hidden raw references,
projection-backed facts, disabled commands and the explicit KDS/device lock. Do not copy fictional
station names, dates, order IDs, example items or simulated actions. Run the existing focused Kitchen
`production-fail-closed` Playwright journey, save and inspect fresh Queue/Work Item screenshots at
1440/390/320, and change application source only if an in-scope difference is demonstrated.

Result: the private Make project opens in the authenticated browser and its Code view lists and opens
`src/components/KitchenWorkspace.tsx`; the source editor exposes a read/write CodeMirror surface. Its
current status palette defines background, text and border colors for Queued, Held, In Progress,
Completed and Cancelled, matching the repository's existing Make-alignment values. The same source
contains `simulateKitchenAction`, so its command behavior remains prototype-only. The Make MCP source
resource link still fails with `Unknown resource`; the browser reports AI credits disabled until
2026-09-30. No Make file was edited, saved, published or shared in this check. The visible preview
continues to use fictional The Elm / Table T-07 data.

All six Design Review frames returned screenshots and design context. The focused Kitchen
`production-fail-closed` journey passes 4/4. Fresh captures
`apps/merchant-web/test-results/kitchen-board-{1440,390,320}.png` and
`kitchen-detail-{1440,390,320}.png` were inspected. Desktop lanes, toolbar, status badges and
read-only banner remain; mobile 390/320 stacks the filters, warning, work cards and details without
horizontal overflow. Local labels and details come from synthetic authorized-projection fixtures,
not Make sample rows. Exact search remains in the request body and UUIDs are not rendered. No
additional in-scope visual mismatch or application source edit was found. This verifies local
synthetic screen behavior only; Review remains Not Accepted and screen-reader/actual-zoom, live
KDS/device authority, real Store/UAT and release/production gates remain open.

## Scoped security review — Dining table availability command (2026-09-26)

Review boundary: authenticated `POST /api/dining/tables/availability` through the Merchant BFF,
`createMerchantDiningTableCommand`, the selected-Store scope resolver, and the Dining owner's
persisted Table/operation/Audit transaction. The command accepts only SetBlock/ClearBlock, a Table
reference, expected aggregate version and operation reference; SetBlock also requires a validated
reason code. It obtains Tenant/Brand/Store/Actor from the authenticated persisted session,
Membership and current `dining.operate` authorization, derives the next Table snapshot from the
owner read, writes the immutable operation/event and Audit together, and rechecks permission before
the write and response. The HTTP response is reduced to status, Table reference, operational state
and aggregate version; route tests cover same-origin/CSRF, query-scope rejection, safe projection
and unconfigured denial. No credential or private Audit/operation record is returned by this path.

Finding: no Blocker/High issue identified in this reviewed command path. Existing current-policy
isolated PostgreSQL acceptance exercises persisted authorization, SetBlock, exact replay,
ClearBlock and denied mutation; focused route/composition, browser and owner-store results are
recorded under [WP-2402](./WP-2402.md#continuation-selection--dining-table-operation-bff-2026-09-25)
and its persisted HTTP acceptance follow-up. Those are synthetic local evidence, not live Store or
release security evidence.

Residual scope: this was a targeted source/data-flow review, not a full security audit of all 206
changed paths or release artifacts. It does not establish production role grants, live membership/RLS,
Store/UAT, KDS/device authority, external Provider behavior, formal accessibility/security artifacts
or production go/no-go. No source, database, permission grant or external service was changed.

## Owner-backed populated Pickup after Store switch (2026-09-26)

Selection: the existing browser-enabled `public-store-profile` composition creates a Ready Pickup
through Ordering, Payment, Kitchen and Fulfillment owners, then reads it through the authenticated
Merchant BFF. The current sequence rotates from Store One to an empty Store Two. Extend only this
existing HTTP acceptance to rotate back to Store One and verify that the same Owner-generated
Fulfillment reappears under the new persisted Session. Assert the intermediate cookie is revoked,
the returned workspace selects Store One, the response is `no-store`, exactly the existing
Fulfillment appears, and a caller-supplied Store body is rejected. No Pickup row may be inserted or
fabricated. Run the existing `public-store-profile` isolated PostgreSQL config with
`BOP_PICKUP_BROWSER=1`, then changed-helper/test ESLint/Prettier and `git diff --check`.

Result: a preliminary `current-permission-policy` run passed 1/1 but lacked `pickupReady`, so it did
not execute this branch and is not acceptance evidence for the change. The correct
`BOP_PICKUP_BROWSER=1 CI=true pnpm --config.verify-deps-before-run=false exec vitest run --config
packages/database/vitest.public-store-profile.config.ts` run passes 3/3. The suite creates the
Owner-generated Ready Fulfillment, reads it through the persisted Merchant session at Store One,
rotates to Store Two and confirms the queue is empty there, then rotates back to Store One. The
intermediate cookie is denied; the Store-switch, replacement Session bootstrap and authenticated
BFF responses are `no-store`. The queue response selects Store One, contains exactly the original
Owner Fulfillment, and rejects a request naming Store Two. ESLint and Prettier pass for the changed HTTP helper; WP and continuation evidence formatting plus
`git diff --check` pass. This is synthetic local Owner/HTTP/session evidence. It does not establish
live Store membership/RLS, target Store UAT, KDS/device authority, production Provider behavior or
release readiness.

## Owner-backed Kitchen projection after Store switch (2026-09-26)

Selection: extend the same current `public-store-profile` Owner composition to its persisted Kitchen
queue projection. The current authenticated Merchant rotation proves Pickup scope changes, while
Kitchen Store-switch evidence uses intercepted browser rows. Give the fixture's existing
Store-scoped `kitchen.operate` permission read use through the actual Merchant runtime. Derive
expected work-item references and statuses only from the Owner-produced Active Kitchen generation;
exclude retained retired-generation history. Query the actual current Store, rotate to the
initialized-empty target Store, then rotate back and compare the same Owner rows under the newly
persisted Session. Keep `operatorStatus` `Unverified`; do not issue Kitchen commands or seed work
items. Assert revoked intermediate credentials, no-store and body Store-scope rejection. No UI or
URL behavior changes are selected. Run only the existing isolated `public-store-profile`
acceptance with `BOP_PICKUP_BROWSER=1`, plus changed-helper ESLint/Prettier and `git diff --check`.

Result: the first acceptance draft compared against retained rows from retired projection
generations; the production query correctly returned only the Active generation, so expected rows
were tightened to join that generation. A second run exposed the legacy synthetic Get-detail check
running when this Owner case supplied a List query only; the detail assertion now runs only when
that fixture supplies a Get request. The final
`BOP_PICKUP_BROWSER=1 CI=true pnpm --config.verify-deps-before-run=false exec vitest run --config
packages/database/vitest.public-store-profile.config.ts` run passes 3/3. The actual HTTP responses
show the Owner-generated Kitchen rows at Store One, no rows in the initialized-empty Store Two
projection, and the same Active Store One rows after a second Session rotation. `operatorStatus`
stays `Unverified`; the intermediate cookie is denied, Store-switch/session/projection responses
are `no-store`, and Store scope supplied in a query body is rejected. No Kitchen mutation or
fabricated work row was used. Changed helper ESLint, Prettier and `git diff --check` pass. This is
synthetic local Owner/HTTP/session evidence, not named KDS/device authority, live Store/RLS, Store
UAT or release readiness.
