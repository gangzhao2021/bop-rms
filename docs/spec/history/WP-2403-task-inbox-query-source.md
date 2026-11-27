# WP-2403 — Task Inbox owner query filters

## Authority and readiness

- Status: scoped owner/API/browser read acceptance locally verified; integration,
  release and full Screen completion remain open.
- Owner authorization: 2026-09-27 request to complete the documented project.
- Branch: `codex/wp-2403-task-inbox-query`; managed worktree `task-inbox-query`.
- Baseline: `03ad510c9b694a4bf994efb6703e11afa53e2fb7`, initially clean.
- Sources: accepted composite Handoff 0.5.3 Sections 0–91 plus accepted 92–97;
  Sections 44.6.4, 88.7 TASK-INBOX, 88.22, 92–94; spec index precedence.
- Existing WP-0125 minimum remains closed. Its no-persistence/API/UI allowlist is
  not extended. This new WP owns an additive read contract over the already
  existing Task-owned persistence reader, not a change to Task lifecycle.
- Original WP-2402 dirty checkout is retained separately. Its uncommitted code
  and evidence are not silently imported or claimed on this branch.

## Scope and contract

Task owns task type, severity, status, assignment, claimant, due instant and safe
source references. Extend its existing queue reader with optional, closed filters:
Assigned/Claimed status, exact task type/severity code, exact Task/source reference,
claim owner (unclaimed, supplied actor, other actor), and overdue true/false.
Absent filters preserve current behavior. Overdue uses the existing strict
`observedAt > dueAt` rule. Queue scope stays fixed by the trusted caller; filters
cannot select another Brand/Store/Queue or grant authority. Actor references are
internal authorization-derived inputs, not names/email or user directory facts.

Select the latest version first, then match filters, then apply the bounded page.
Never resurrect an old matching task version. Revalidate every returned owner row,
including the lookahead, against the normalized immutable filter contract. Retain
before/after authorization fences, current-scope checks and fail-closed errors.
A caller changing filters must reset its cursor. Cursor order is not a snapshot
or guarantee of stable results while tasks change.

Non-goals: visual UI controls, terminal/history queue or other assignment kinds,
free text or PII search, cross-Store aggregation, source resolution, task mutations,
new schema/index/migration, notification scheduling, workforce identity source,
live runtime/deployment. Full TASK-INBOX completion requires later consumer work.

## Files and acceptance

Allowlist: this brief; spec index link; Task queue-filter contract/public export;
Task queue reader; focused Task unit tests; one isolated database acceptance test
and its Vitest config. Authenticated read continuation additionally owns API
Task filter parser, Inbox read/composition, existing merchant BFF route and their
focused tests. No dependency or toolchain changes.

1. Backward compatible bounded queue read and authority fences.
2. Closed immutable filter validation rejects hostile/unknown/unbounded fields
   before authority/database access; no string interpolation of filter values.
3. Latest owner facts are filtered before pagination, without history resurrection.
4. Exact scope/queue isolation and strict overdue boundary; claimant truth comes
   from currentClaim, not assignment or staff labels.
5. Returned rows are validated against all filters; malformed/foreign/nonmatching
   lookahead rows fail the read rather than creating a false continuation.
6. Authenticated HTTP accepts only bounded masked filter fields, derives current
   Actor server-side, retains source permission and rejects scope/identity injection.
7. Browser reads transport the same filters, cancel old generations, reset cursors
   and incompatible snapshots, remain offline read-only, and reject wrong-filter views.

## Verification selection (before checks)

All evidence is fresh at baseline plus this WP's named uncommitted allowlist.
A fresh worktree needs its own pinned frozen install: `CI=true TMPDIR=/private/tmp
pnpm install --frozen-lockfile` (completed, Node24.18.0/pnpm11.13.0; no lock change).

- Contract/parser/row validation: `pnpm --filter @bop/task test`; directly owned
  Task behavior including existing lifecycle consumers, no mutation changes.
- Real SQL latest-version/filter/page/RLS semantics: `pnpm exec vitest run
--config packages/database/vitest.task-queue.config.ts`; new focused test uses
  existing isolated-database harness and existing canonical migrations.
- Shared additive contract compatibility: Task/API typechecks and existing API
  Task Inbox read/composition tests; no HTTP or presentation shape changes.
- Affected format/lint/build: Task scripts, changed database/config files and brief;
  Task build because its public export changes.
- Architecture/security: existing import-boundary, domain-layer-boundary,
  database-ownership, database-permission and secret-scan checks.
- Migration behavior/schema unchanged: no migration acceptance rerun; canonical
  migration setup is exercised by the isolated test. No Screen change or browser
  journey in this WP. Database AGENTS full root/release checks are reconciled
  with the newer root affected-check policy: full `pnpm verify` belongs to the
  assembled project release/merge milestone, not a repeat of unrelated suites.
- Broaden to API integration/browser for the authenticated read continuation, and
  to full regression if a shared authorization/schema/tooling risk is discovered.

## External evidence, rollback and next action

Synthetic isolated database evidence only. No real workforce, Store, Provider,
production, delivery, exact-head CI or accepted operator evidence is supplied.
No commit/push/merge/deploy is authorized by this execution. Rollback is removal
of this isolated scoped diff; original WP-2402 remains preserved. After local owner query acceptance, the continuation below connects the
permission-trimmed API. Ordinary visual UI work and rendered journey acceptance
remain separately bounded; no Accepted Task Inbox Figma target is established by
this query-only branch.

## Evidence inventory

- Fresh Task unit suite: 4 files / 79 tests passed. Initial Task typecheck
  identified only the test mock's zero-argument inferred signature; its explicit
  existing port type is corrected before final verification.
- Fresh isolated PostgreSQL acceptance: 1/1 passed, 8.78s. Actual canonical
  migrations, append-only Create/Assign/Claim/reassignment owner fixtures,
  restricted NOLOGIN/NOBYPASSRLS role, latest-version filters before pages,
  exact Task/source references, due equality, claimant and scope/queue isolation
  passed. Existing harness cleans its isolated resources. No live database used.
- Earlier pending-check entries below are historical selections. Current remaining
  scope and acceptance evidence are consolidated at the end of this brief.

### Closeout selection after lint findings

The first Task lint run rejected two non-null assertions in the new parser/test.
Replace both with explicit guards; no lint rule is weakened. Rerun Task tests,
typecheck/lint/build and affected format after that code change. Earlier real SQL
acceptance remains applicable: owner SQL, fixtures, row matching, scope, toolchain
and installed dependencies are unchanged; the equivalent descriptor guard is
covered by fresh malformed/accessor unit tests. Existing API typecheck and its
three Task consumer suites passed (22 tests). Eventing build supplied the clean
worktree's existing runtime export. Architecture/security checks passed:
Import22, Domain57, DatabaseOwnership1079, DatabasePermission23, SecretScan2;
validators pass, database test/config ESLint and changed-file formatting pass.
These are local runs, not new external/CI evidence.

### Authenticated read continuation selection (2026-09-27)

Owner query acceptance is locally verified. Continue this same in-progress WP
through its existing authenticated consumer; do not create another branch or
import WP-2402's unrelated dirty screen/runtime code. Section88.7/88.22 allow
status/type/severity/owner/overdue and safe reference filters. Add a single bounded
JSON filter header, never URL parameters, with duplicate/unknown/PII/scope input
rejection. Masked owner relationships derive the actor from current server
session. Keep current Store/Queue/source authority, transaction and no-store;
returned rows must match the requested filters, including mock/untrusted ports.
No claim/resolve command or different permission is added.

Fresh checks: existing API Task read, persistent Inbox, Dining source and actual
HTTP route suites, API typecheck, changed-file ESLint/Prettier. Read mutation
broadened coverage requires the existing merchant BFF/security transport tests;
run `src/merchant-bff.test.ts` and `src/http-security.test.ts` once. Owner SQL and
Task contracts are unchanged, so their passing evidence above remains reusable.
Reassess architecture/security against the final diff; rerun affected validators
if an import/field flow changes, with SecretScan after the API edits.

### Authenticated continuation result and final remaining checks

Fresh actual HTTP transport and API consumer verification passed: 6 files / 116
tests (Task Inbox read, persistent composition, Dining source permission, Inbox
HTTP, merchant BFF and HTTP security). API typecheck and all six affected API
source/test ESLint checks passed. The 1024-character JSON header rejects duplicate
headers, malformed JSON, unknown fields, scope/actor selection, free text and
unaccepted status. Queries remain same-origin/no-store and emit safe errors.
Current authenticated actor determines masked ownership; source-denied pages
retain their owner cursor and do not imply no work. No new command is exposed.

Final closeout selection: API build for its changed public composition; direct
import/domain validators after new API imports; fresh secret scan; all 14 changed
tracked/untracked files format and diff checks. Previous validator fixture suites
and DatabaseOwnership/Permission suites remain valid: those tools, manifests,
ACL/schema inputs and dependency installation are unchanged. Task unit79/type/
lint/build/format passed after the explicit-guard repair; real SQL test1 remains
valid as noted above. No repeat of unchanged business/full-repository suites.

Scoped security review: request fields are exact codes, opaque safe Task/source
references and masked owner labels; no employee identity is accepted from the
client or returned. Internal current Actor and configured Tenant/Brand/Store/Queue
remain fenced in one transaction. SQL values are bound parameters; no new logs,
analytics, browser storage, exports, raw credentials, source business writes or
external service changes. Source permission remains independent of Task filters.
Open Blocker/High findings for this scoped diff: zero. Production data scale/
performance, current-clock moving results and mandatory exact-head CI remain
unproven. This read contract makes no snapshot or full Screen completion promise.

### Owner/API checkpoint and next browser read continuation

Final API build, direct import/domain validators, fresh secret-scan2, all14-file
Prettier and `git diff --check` passed. Tested source is baseline03ad510 plus the
14 named modified/new paths, uncommitted. No migration, manifest, lockfile, grant,
external resource or original-WP2402 source changed. Owner and authenticated read
criteria are locally verified. The whole project and TASK-INBOX remain incomplete.

Next authorized continuation stays in this WP/worktree: add the same closed
masked filter contract to the existing nonvisual browser client/controller,
transport only in the bounded header, reset pagination and prior snapshot on
filter/context changes, cancel/discard earlier reads, and reject responses that
conflict with the selected filter. Do not implement a new visual layout without
resolving the existing accepted Screen/Figma evidence. Scope extension allowlist:
`apps/merchant-web/src/task-inbox-client.ts`, `task-inbox-state.ts` and their two
existing test files, plus one pure browser filter module if needed. No Node owner
runtime import or dependency addition in the browser bundle.

Before those edits/checks: use existing focused browser client/state suites plus
Merchant typecheck, affected ESLint/Prettier and normal Merchant build for bundle
compatibility. Preserve existing no-store/timeouts, in-memory/offline read-only
behavior and explicit refresh. Owner/API/SQL evidence remains reusable only while
their covered inputs stay unchanged; new browser tests are not rendered UI proof.

### Assembled read acceptance selection (2026-09-27)

Fresh browser client/controller2-file suite44 tests, Merchant typecheck and all
five changed source/test ESLint checks pass. Reuse this unit/type evidence while
browser files stay unchanged. Extend the existing owning isolated SQL test to
exercise real loopback HTTP with the actual browser client/controller, BFF,
Task read adapter and restricted-role PostgreSQL owner query. Synthetic authority
ports are explicitly labelled; this is not OIDC/Secure-cookie or rendered browser
acceptance. Add more than50 real owner tasks to prove matches beyond an unfiltered
first page and source-trimmed pagination. Verify masked ownership, filter/context
clearing, overdue semantics and permission loss through the assembled chain.
Run the same existing task-queue Vitest config once after this integration edit;
previous1/1 owner-only SQL result is historical, not the new assembled result.
Then normal Merchant build, affected format/lint, import/domain validators and
secret scan for new import/field flow. No repeated Task/API unit or type suites
unless those inputs change. Full project release/merge regression remains open.

Initial assembled run failed at the first browser-controller Ready assertion,
not an owner-only SQL assertion; investigate transport versus payload before
changing behavior. Added only status-safe HTTP diagnostic assertion (no response
body/headers/credentials logging). Database test lint also identified Node-global
URL/fetch references; use existing explicit node:url and globalThis conventions.
Rerun only the affected assembled config after these diagnostic/test repairs.
The normal Merchant build passed (existing large-chunk advisory); browser unit44/
types/lint results remain valid. The later validator/security/format group stopped
at database-test lint and has not yet executed in that group.

The safe status diagnostic located403 at transport. A separate ephemeral Node
loopback probe confirmed Node24 fetch ignores a caller-supplied Host while sending
Sec-Fetch-Site (only match booleans were observed). Bind the synthetic BFF's exact
acceptedHost to its actual ephemeral loopback address; remove the ineffective
Host override. This changes test wiring only, keeps the exact Host fence, and
makes no HTTPS/Secure-cookie claim. Rerun the owning assembled config after this
concrete transport repair. Database-test lint, import/domain validators, fresh
SecretScan2 and affected formatting/diff checks now pass.

### Current scoped acceptance checkpoint (2026-09-27)

Assembled repaired config passed1/1 in9.05s, including the original owner/RLS cases
and actual browser client/controller → HTTP BFF → Task read → PostgreSQL flow.
More than50 current owner tasks prove LOW-severity matches beyond the unfiltered
first50, and a56-item type filter returns50 then6 using the correct cursor.
Source permission trims entire pages while preserving continuation; exact claimant
relationships, strict due equality, offline explicit refresh and authority-loss
clearing pass. All fixtures are synthetic; authority/source ports are explicit
simulations. This is loopback HTTP transport, not an actual rendered browser,
OIDC provider, Secure-cookie, workforce, production or pilot acceptance.

Final after-fix database-test ESLint/Prettier and diff checks pass. Merchant normal
build passed (existing >500kB chunk warning); no Node owner import or dependency
was added. Import/domain validators and SecretScan2 pass for the expanded source.
No additional source change invalidated Task79/API116/browser44/type/lint/build
results. The final changed/new set has19 scoped files:17 executable/config source
files and2 documentation files. Executable snapshot SHA256:
`a2fe2ffb15981adf257867ed582d4ad49895d8ce56ab8b5d37a318b78db229e6`.
This is SHA256 over sorted changed/new .ts/.mjs path, NUL, file bytes, NUL at
baseline03ad510 plus the named WP edits. Documentation updates do not change it.
No commit, push, merge, deploy or original WP-2402 source mutation occurred.

Acceptance1–5: PASS (Task79 + actual owner SQL/RLS). Acceptance6: PASS (API116 and
assembled HTTP/owner read). Acceptance7: PASS (browser44 and assembled read).
Scoped diff reviewed: fixed Store/Queue, public Task source contract, before/after
fences, masks, parameter binding, strict time, source trim, bounded immutable data,
no credentials/PII/URL/private storage and no lifecycle/schema/ACL change.

Still open: integration with the retained WP-2402 normal-route screen and enhanced
client error/runtime/multi-Store composition; visual filter controls/Accepted
Screen evidence; terminal/history search, assignment/actions/source resolution,
SLA facts and other full TASK-INBOX requirements; assembled project release/CI and
external activation gates. The retained original TaskInboxPage/client are newer
uncommitted inputs, so replacing them with this clean-base branch would lose
features. Future integration must apply the additive changes with a reviewed
reconciliation, never copy these whole files over retained work. Query acceptance
is not a complete Task Inbox, pilot, entire project or new runtime publication.

### Retained-input reconciliation selection (2026-09-27)

Current original WP-2402 source has bounded error states, hidden sourceReference
and configured multi-Store queue selection. These are explained retained inputs,
not speculative new policy. This WP will explicitly bring only their Task-owned
adapter/client/test enhancements into its isolated candidate, then keep the
additive filters; the original checkout remains untouched. Snapshot hashes below
identify the actual retained inputs read before reconciliation (HEAD03ad510 plus
its original uncommitted edits). No source bundle or unrelated App/runtime change
is copied. Add the existing persistent Inbox test to the WP allowlist.

- `apps/merchant-web/src/task-inbox-client.ts`: `575fef2bd71ec5b6cf0659ccd77325036e91465af91bca9402797662c275d690`
- `apps/merchant-web/src/task-inbox-client.test.ts`: `35571c94699ae876cdbed626e667fa0b87f1c7431a19a61c6b52fe80b613988b`
- `apps/merchant-web/src/task-inbox-state.ts`: `5940a5837c9bcedf01db362dac5c5ce33f382f9535ad36211a08204a33175d49`
- `apps/merchant-web/src/task-inbox-state.test.ts`: `fb59af796e36d89a5928c9e01f4f97479b4c60f73e4dbebd68bff2d8e3e97e52`
- `apps/api/src/persistent-merchant-task-inbox.ts`: `96017e2d965c57416b922ae599a0384c7d02edc363f78673217dbfdb8169eda8`
- `apps/api/src/persistent-merchant-task-inbox.test.ts`: `87662b0ea71584755db3db45a96c85f2998e0557644a2e5f7638c991b3ec1a0d`
- `apps/api/src/merchant-task-inbox-http.test.ts`: `7fb097b9975e527aa4a6ebcf7462a45874c0bd829f5a3051a59842ce9fc1d188`

Privacy: retain no sourceReference in Task Inbox DTO/HTTP/browser fields. Task
owner row validation still checks exact Task/source reference internally before
source permission and pagination. Browser revalidation is limited to visible
status/type/severity/owner/due facts; it cannot independently compare a deliberately
hidden source ID. Existing generation cancellation and no-store prevent prior
filter snapshots. Add assembled exact-source filtering with no source ID disclosure
rather than reintroducing the identifier or inventing a UI label.

Fresh checks: selected API read/composition/source/HTTP+BFF/security suites and API
type/lint/build, browser client/state suites and Merchant type/lint/build, assembled
SQL/HTTP config for changed DTO/filter matcher. Reuse unchanged Task79/owner schema
and installation/ACL checks. New persistent multi-Store cases verify filters travel
only to the currently authorized queue, configuration mutation is isolated and
permission loss clears the read. UI layout/controls and live runtime remain outside
this reconciliation; original page remains retained for a later bounded import.

### Runtime composition compatibility selection

Fresh reconciled browser tests48 and API tests118/typechecks pass. Existing pilot
bootstrap still calls the legacy single `queue` adapter input, whereas retained
multi-Store runtime uses `queues`. Preserve both trusted configuration forms as a
closed exclusive union; reject both/neither, and normalize to the same captured
configuration map. This keeps legacy bootstrap valid without changing live files
or creating a new real Store queue. Add focused compatibility and filtered-target
Store tests, then rerun only the affected API composition suite/typecheck and the
assembled SQL/HTTP config (DTO/client semantics changed).

Bring the retained optional Task Inbox composition into `merchant-runtime.ts`
using its existing public Task and Dining source adapters. Only the Task option/
imports/spread are included, not unrelated Dining administration changes. Keep
feature absent by default and configure exact server queues explicitly. Add that
runtime file to the current WP allowlist. Required runtime integration evidence
will be selected separately before running it; no live v14 publication/restart.

The selective runtime import splice initially duplicated an existing BFF type
import and missed the earlier Dining Task source import; API typecheck correctly
failed. Fix only these imports, then rerun the affected typecheck. The enhanced
persistent adapter11 tests passed including legacy/scope/filter configuration;
that suite remains valid because only runtime import statements change next.

### Persisted authority/runtime acceptance selection

The reconciled assembled owner/HTTP/browser config passes1/1 (10.11s), including
exact-source filtering without returning the source ID and bounded permission
error state. Runtime API types pass after import correction. The optional runtime
Task branch now needs real persisted session/permission/selected-Store coverage,
not another constructor-spy test. Extend only Task-related portions of the existing
`persistent-merchant-bff.mjs` and `persistent-merchant-bff-http.mjs` helpers under
`vitest.current-permission-policy.config.ts`: restricted Task SELECT/schema grant,
explicit workflow.operate grants for the two existing synthetic Stores, optional
runtime Task configuration, normal/filtered reads, rotated-session denial, selected
Store read and no-store. Reuse existing actual IAM/Permission/Store fixture setup;
Task queue stays genuinely empty and gives no positive source-finality proof.
All Provider/directory facts remain the existing explicitly synthetic fixture.

Add those two helpers to this WP allowlist. Configuration command ports in the
Task-only runtime probe fail closed and must never execute; no Store write is
requested by the new read probes. Select the existing one-file isolated config
once for this actual-consumer risk. If unrelated historical fixtures fail, record
and investigate exact ownership before changing them. Run changed helper lint/
format and remaining affected builds/architecture/security; no live installation
or pilot service changes and no new workload/security scope.

The persisted-runtime probe initially stopped during existing Store configuration
constructor validation because its Task-only fixture provided an empty action map.
Supply the five existing accepted store.service codes from the unchanged
merchant-configuration-command helper; keep configuration command ports throwing,
with a zero-call assertion. No production code or permission check is changed.
Rerun the affected isolated authority config after this fixture repair; the
failure was not a Task read or unrelated historical-data failure.

### Reconciled local acceptance checkpoint (2026-09-27)

The earlier 19-file checkpoint is historical. Current candidate reconciles the
retained Task privacy/error and multi-Store adapter inputs without altering the
original WP-2402 checkout. Fresh browser client/state: 2 files / 48 tests pass.
Fresh API read/composition/source/HTTP/BFF/security group: 6 files / 118 tests
pass; after exclusive legacy/multi-queue compatibility changes, the directly
changed persistent composition suite passes 1 file / 11 tests. This is component
evidence, not a new combined 120-test run. API typecheck and build pass after the
recorded import repair; Merchant typecheck and normal build pass. Affected ESLint,
import/domain validators and SecretScan2 pass. Unchanged Task79 and the unchanged
architecture fixture checks remain reused from this WP's named earlier runs;
installation, manifests, lockfile, toolchain, owner schema and ACL inputs remain
unchanged. No full regression or exact-head CI is claimed.

Fresh owner/HTTP/browser isolated config passes 1/1 in 10.11s, including private
source-reference exact filtering without DTO disclosure. Fresh persisted current
permission policy config passes 1/1 in 13.74s after the recorded fixture repair.
The latter uses actual persisted IAM/Permission/Store and optional runtime Task
composition: empty authorized queues return no-store responses, filtered reads
retain exact selected Store, injected scope is rejected, old rotated sessions are
denied and the new session reads its selected Store. Configuration write-port
call count stays zero. Existing Provider/directory fixture facts remain synthetic;
empty queues do not prove positive Task source finality or workforce acceptance.
Neither config supplies rendered-browser, real Provider, live Store or pilot UAT.

Current source snapshot has 23 scoped files, including 21 executable/config
files and 2 documents; SHA256 of sorted changed/new .ts/.mjs path, NUL, bytes, NUL
at baseline03ad510 plus these uncommitted edits:
`8a07c9d2ab881a3fa79fec41f723804044c15a6d75b6ae028c1b7486fa40249d`.
Documentation updates do not change this source hash. Acceptance1–7 remain PASS
for this bounded read scope. Final diff review retains public owner boundaries,
server-derived actor/Store/Queue, immutable filters, before/after authorization,
latest-version pagination, masked fields, bounded errors and no Task/Store writes.
No schema, migration, dependency, credential, live service or original source edit.

Remaining: normal-route Task page integration and visual filter controls; full
TASK-INBOX actions/history/source/SLA requirements; assembled project/release/CI
and external activation evidence. Enhanced errors, optional runtime composition
and multi-Store queue selection are now reconciled locally, rather than still
listed as missing. Accepted Task Inbox Figma target remains requested from the
Owner: bop-screen-contract requires "Visual implementation requires the Accepted
Figma frame/node". Dependent new visual controls wait for that input; independent
repository work can continue. This checkpoint is not entire project completion.

Final remaining selection: the last fixture action-map/counter repair changed
security-scanned inputs, so run SecretScan2 freshly once. Format all current scoped
files and check whitespace after this evidence update. All directly affected code
and integration checks already have valid evidence; do not rerun them merely for
this documentation checkpoint. Full `pnpm verify` remains the assembled release/
merge milestone; no publication is authorized by the present execution.

Remaining selected closeout checks passed: fresh SecretScan2 (2/2), all23 scoped
files Prettier (no executable change), and `git diff --check`. No checks remain
running. Preserve this isolated candidate for additive normal-route integration;
proceed to the independently owned Recipe source-coverage contract brief without
reopening this query acceptance or discarding either worktree's retained edits.
