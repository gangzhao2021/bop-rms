# WP-2402 historical records — part 2

Archived implementation evidence; current status remains in [WP-2402](./WP-2402.md).

### Published payment-action implementation

Ordering wrapper now invokes capacityForOrder with the current locked decoded Order for each
claim; no shared current-state variable. New customer-payment-workflow-action.ts captures that
Order and explicit technical bindings, constructs the current Order resource/version/state
request, and invokes actual evaluatePublishedAction. Current customer access and Brand/Store
publication gates run there; the exact selected Inventory rule evaluates owner facts. Unknown
rule sets, unsupported effects, wrong permission, or a non-self-loop payment request deny.
The isolated Workflow fixture now publishes the payment action and its synthetic permission/
rule binding through the actual existing lifecycle, not a supplied publication boolean.

The composed helper tests incorrect permission, rule, command and unavailable action bindings
against the actual published definition; each must leave zero Payment/Attempt/operation/Audit.
Its normal valid path uses the production action evaluator. Current-rule selection remains
explicit fixture configuration; no real Store approval or Workflow execution history is claimed.
payment-action-types.log PASS API types; payment-action-lint.log clean; Domain/import
boundaries PASS. Pickup composed run pending, Dining follows.

Published payment-action composed evidence: /tmp/bop-wp2402-payment-action-pickup.log
PASS both quote/lot variants, 67.64 seconds; payment-action-dining.log PASS both, 94.39 seconds.
Wrong permission/rule/command/action bindings leave zero Payment writes; actual access,
published action, formal Inventory predicate, deadlines, owner fences and recovery pass.

Final review tightened the capability: configured command must be the actual CreatePaymentIntent,
so a Workflow cannot rename another command into this executor. payment-action-command-unit.log
PASS 4 constructor boundary tests; payment-action-types-final.log PASS; command-lint.log clean.
Earlier composed valid-command evidence is reused for unchanged accepted inputs and owner path;
unknown command now rejects earlier, covered directly by the new boundary tests. Those composed
runs predate this guard and are not represented as fresh runs after it. No dependency/toolchain,
schema, Provider or runtime change. Prior full Inventory rule evidence remains valid.

Next connect the verified preparation/admission/Payment service through the application's actual
request composition and canonical HTTP contract. Inspection found server.ts runtime options
without a Payment handler; app.js is its route composition entry. Keep Provider/runtime
activation unavailable without actual scoped configuration. Workflow action evaluation is now
implemented for the explicit intact-reservation prerequisite; execution history, other selected
timing modes and the full merchant/Kitchen/handoff/refund/ops journey remain required.

### Canonical Checkout Session prerequisite

Continue on codex/wp-2402-pilot-submission at a0f35440 with the existing authorized dirty
worktree preserved. Source route contract requires a Checkout Session before Payment Intent.
Ordering owns an immutable session binding to parsed checkout-validation evidence and distinct
server-assigned session/create-operation/submission/payment-operation references. Record creation
within validation validity; do not invent a session TTL or treat historical validation as current
payment permission. Stored records remain readable after validation expires for recovery.
No new Provider calls, Store policy defaults, schema writes or runtime activation in this increment.

Files: Ordering domain checkout-session, public export, targeted tests. Acceptance: strict closed
input, valid quote versions, distinct references, no future/expired validation at creation, immutable
decoded facts and recovery after time passes. Run focused tests, Ordering typecheck, affected
format/lint and domain/import boundaries. Persistence, audit/idempotent creation and canonical
HTTP composition follow; this domain value alone is not an operational checkout session.
Reuse prior installation evidence with unchanged manifests/lock/toolchain. Full connected-journey
pnpm verify and pnpm test:integration remain release milestones, not repeated here.
Correction: apps/api/src/app.ts is the application route source; app.js is its emitted import path.

Checkout Session domain increment evidence: focused Ordering test command
pnpm --filter @rms/ordering test src/tests/checkout-session.test.ts passed 7 tests (9ms),
pnpm --filter @rms/ordering typecheck completed without diagnostics; affected prettier and
eslint completed cleanly; domain-layer-boundary and import-boundary validators passed.
Execution session 17995 completed exit 0 against HEAD a0f35440 plus the preserved worktree
and new checkout-session domain/test/index changes. Final source review and scoped diff
whitespace check passed. No persistence, dependency or runtime changes in this increment;
these checks do not establish HTTP, PostgreSQL or complete pilot acceptance.
Next: an Ordering-owned idempotent session creation/query service with current customer
authorization, followed by scoped append-only persistence/Audit and canonical routes.

### Checkout Session creation service

Implement Ordering-owned service with closed request (create operation, Cart/version, Quote/version),
current authorization capability bound to actor/Brand/Store and observation time, actual validation
port, server-generated independent IDs, and atomic repository create/recover plus Audit input.
Reauthorize before save and before returning original history. Existing operations recover without
revalidating an expired quote, but request/actor/scope must match. Repository must fence current
authorization/Cart/Quote and atomically persist Audit; interface documentation is not database evidence.
Test new creation, response-loss/concurrent recovery, changed intent, denied or changed authorization
and expired validation. No Provider calls. Run focused service/domain tests, Ordering types and
affected lint/format/boundaries; persistence implementation and integration tests follow.

Checkout Session creation service evidence: session 30179 completed exit 0. Fresh commands:
pnpm --filter @rms/ordering test src/tests/checkout-session-service.test.ts src/tests/checkout-session.test.ts
PASS 16 tests (9 service, 7 domain); pnpm --filter @rms/ordering typecheck without diagnostics;
affected prettier/eslint clean; domain-layer-boundary and import-boundary validators PASS.
Tested a0f35440 plus preserved uncommitted work and new service/test/index. Final service review
and scoped diff whitespace check clean. No secrets, real Store facts, Provider calls, schema changes
or generated artifacts introduced. Service tests use explicitly synthetic authorization/Audit ports.

PASS at service scope: generated IDs, original replay after validation expiry, competing-winner
identity recovery, changed-intent rejection, denied/changed actor, post-write response denial with
subsequent original recovery, expired validation and extra client identities. Atomic operation
uniqueness and current access/Cart/Quote fences are required repository contracts, NOT proven by
these mock-port tests. Actual Identity adapter, session query, persistence/Audit, HTTP and browser
flows remain incomplete. No full verify/integration rerun: deferred to previously named connected
journey/release gates; actual persistence implementation must add isolated PostgreSQL evidence.
Next migration ordinal observed 1300_019 (current last 1300_018); recheck before creating.
Use immutable session table with scope RLS, foreign Cart binding and operation uniqueness, no
mutation to historical sessions. Implement transaction-level current authorization and Cart/Quote
validity checks, Audit atomicity, scoped original recovery, then wire canonical API handlers.

### Checkout Session PostgreSQL schema

Add 1300_019 immutable Ordering-owned checkout_session_record with Brand/Store forced RLS,
scoped Cart FK, unique create/submission/payment operation identities, non-aliased IDs, mandatory
snapshot/column identity agreement, and finite millisecond timestamps. Register table ownership
and catalog. This is a new forward migration; never edit an applied migration. Add isolated
PostgreSQL schema tests for identity/operation constraints, append-only behavior and RLS.
Run migration:check, database ownership, affected format/lint and the isolated test; adapter
current authorization/Cart/Quote fences and atomic Audit remain next, not implied by schema.

Checkout Session schema evidence: session 11245 exit 0, pnpm migration:check PASS 106 tests
and canonical catalog 131 immutable migrations (/tmp/bop-wp2402-session-migration.log).
Database ownership validator PASS. New isolated PostgreSQL config checkout-session passed
its schema acceptance case in 11.84s: scoped read/write rejection, operation/submission/payment
uniqueness, aliased IDs, absent snapshot guest binding, and immutable update/delete.
Fixture intentionally supplies minimal column-bound JSON; it is NOT a domain-validation,
application authorization, Cart/Quote freshness or Audit atomicity test. Those belong to the
next repository adapter and its expanded actual PostgreSQL tests.
Affected eslint/prettier clean, module-manifest validator PASS and scoped diff whitespace clean.
No running sessions remain. Current HEAD a0f35440 plus preserved worktree and this schema,
manifest/catalog/test/config increment; no remote/deployment action or applied-migration rewrite.
Next implement createPostgresCheckoutSessionStore over CartQueryTransactionRunner, operation
serialization, forced scope, strict domain decode, current authorization callback, Cart lock/current
quote binding/deadlines, atomic validated Audit and original-history query. Use current authority
even for recovery while avoiding a new-quote validity requirement on existing sessions.

### Checkout Session transaction adapter

Implement scoped Ordering repository with operation advisory lock then Cart row lock. Decode
historical sessions through the domain parser; recovery checks intent and current authorization
without requiring current Cart/Quote validity. New writes require actual Cart state/version/channel,
latest attached Quote identity/version/digest/guest and unexpired validation/Cart/Quote deadlines.
Read database clock before and after write/Audit. Current authorization callback must use the
same transaction and actual Identity composition; no built-in allow default. Audit is generated
for exact session and validated before same-transaction append. Add actual PostgreSQL adapter
tests for contention, response loss, authorization denial and Audit rollback. Keep migration
unchanged and reuse its just-completed schema evidence; rerun affected ownership/types/lint
and checkout-session PostgreSQL config after implementation.

Adapter verification found two concrete integration defects: fixture case ID exceeded the
isolation helper's 20-character maximum; shortened it. Ownership tooling requires explicit
exact-path admission for each new repository; registered only the Ordering checkout-session
adapter with required Cart/Quote/session tables and added wrong-owner/schema/table/path/driver
rejection cases. This expands affected tooling tests; it does not disable the ownership gate.

Checkout Session transaction adapter evidence: focused actual PostgreSQL adapter run session
41870 PASS, 11.23s. Creation plus Audit atomicity, lost-acknowledgement recovery, concurrent
same-operation winner, changed intent, denied access and stale Cart rejection verified; original
history recovers after Cart changes. Authorization callback is explicitly synthetic in this test:
actual Guest/CSRF/Identity adapter remains required. No claim of complete user journey.

Initial session 67982 failed before adapter setup because of invalid fixture case ID; schema test
passed separately (11.23s). Corrected ID and reran only adapter file, preserving that schema result.
Initial ownership validator rejected unregistered new asset; corrected exact scoped registration.
Fresh full ownership suite session 49246 PASS 474 tests (9.1s), validator PASS, tooling eslint clean;
source /tmp/bop-wp2402-session-ownership.log. Ordering typecheck PASS; affected adapter/test eslint,
prettier and Domain/import boundary checks passed; final source and scoped diff review clean.
HEAD remains a0f35440 with existing authorized worktree plus these adapter/test/tooling changes.
No dependency/toolchain/migration modifications after prior 131-migration acceptance.
No running process remains. Full verify/release and integrated Identity/HTTP/browser evidence
remain pending. Next bind Checkout Session authorization to actual Guest session/CSRF in the same
transaction and existing validation composition, then expose canonical create/get and payment paths.
The persistence gates perform pre/post current checks but do not claim a generic Identity lock;
the concrete Identity adapter must establish its applicable current-access semantics.

### Request-local Checkout Session identity capability

Add API request-local authorization using actual GuestSessionService and its PostgreSQL owner
store bound to the supplied transaction, plus explicit transaction-bound current-binding adapter.
Load actual Cart through Ordering public reader. Bind exact guest/Brand/Store/channel; Pickup
must own Cart and have no Dining context; Dining must have matching active binding/session/
participant. Preserve guest fingerprint across calls, reject clock rollback and identity changes,
return only scoped references and earliest Guest expiry. Keep raw credentials in closure.
Current-binding implementation remains supplied through its required owner port, never default
Current. Targeted tests/types/security review required; concrete runtime/HTTP composition remains.

Request-local authorization implementation uses real Identity service/credential verification and
PostgreSQL owner readers on a lent transaction, with captured scope and Cart, Guest fingerprint,
mode binding and expiry. Unit test SQL results/binding are synthetic: this proves service/adapter
wiring and denial semantics, not full persisted Identity/Dining acceptance or revocation locks.
Added customer-checkout-session-composition.ts to connect this capability, actual session repository
and creation service; actual validation and current-binding owner ports are required, without defaults.
HTTP/runtime activation and end-to-end persistence composition remain next.

Identity capability evidence: API focused customer-checkout-session-authorization.test.ts PASS
7 tests (68ms, session 28773). Initial API typecheck exposed branded cross-domain ID comparisons;
fixed via explicit string comparison. Initial lint rejected two non-null assertions; replaced with
explicit test guards. Final affected lint clean and API typecheck PASS (34223). Then composition
added and final API typecheck/import boundary PASS (27536), composition prettier/eslint clean.
Earlier behavior tests predate only equivalent explicit null guards and composition addition;
no fresh claim for composition behavior or actual persisted Identity integration.
Security review: raw credentials stay in closure; SQL sees hashes through Identity owner; no log,
URL, output or audit credential propagation added. Current-binding port is required. Generic
error messages do not expose records. Ordering source Cart includes restricted fields internally
but authorization result returns no Cart contents. Remaining high-priority acceptance work:
actual persisted Identity/current-binding composition and canonical HTTP safe response projection.
No Provider/runtime/schema/dependency changes. Goal remains incomplete; next wire actual
validation/binding adapters and exercise full session creation in isolated PostgreSQL.

### Persisted Identity session-creation composition evidence scope

Extend the isolated Checkout Session adapter acceptance with real GuestSession owner creation,
actual HMAC credentials, application composition and persisted revocation. Verify wrong CSRF
writes nothing, valid creation and replay, and revoked Identity rejects replay. Keep current Store/QR
binding and checkout validation explicitly synthetic in this test; do not label it full Pickup journey.
Use this narrower existing fixture because the larger Pickup fixture itself has synthetic Current
binding and cannot prove the missing binding requirement. Next production integration still needs
actual binding and validation sources (including capacity operation identity coordination).
Run changed PostgreSQL adapter case and affected lint; reuse unchanged schema and service tests.

Persisted Identity composition PASS in session 78005 (11.18s): actual Identity owner inserts
Guest record, actual credential provider verifies Session/CSRF, API composition reads Identity/
Cart on supplied transaction and creates persisted session/Audit; wrong CSRF and persisted
revocation deny, valid repeat returns original. Earlier attempts failed because synthetic Guest
deadlines violated exact 4h/24h Identity invariants and fixture role lacked cart_line SELECT;
corrected those fixtures, not production authorization. Counts verify exactly three session/Audit
pairs including the composed case. Full latest adapter case passed after corrections.
Changed fixture lint/format had passed before final grant/constant correction; final check follows.
No production source/schema/toolchain changed this increment.

Next integration design issue identified: existing Pickup capacity preparation requires stable
submission identity, while new session service currently generates submission/payment refs after
validation. Do not fabricate an ID or invoke real preparation with unrelated refs. Coordinate
identity allocation and validation before connecting actual capacity-backed validation, including
concurrent/retry behavior. Current mocked validation does not prove that coordination. Actual
Store/QR current-binding source, Dining variant and canonical HTTP also remain outstanding.

### Durable pre-validation identity allocation

Resolve the capacity/submission identity gap with an Ordering-owned immutable operation allocation,
not deterministic IDs tied to a new secret or regenerated random IDs on retries. The allocation
binds create operation, Guest/Brand/Store, Cart/version, Quote/version and three distinct server IDs.
Persist allocation before capacity-backed validation, recover exact original intent/IDs on retries,
and require final session to match it. It is preparation history, not a ready Checkout Session.
Add forward migration 1300_020, ownership/catalog and schema constraints first; then implement
atomic allocation plus Audit/current authorization and service integration. No legacy backfill or
silent alteration of already created session history. A session created before this new mechanism
must remain recoverable through its existing original record.
Run migration catalog/ownership and isolated PostgreSQL constraints for new table. Existing
checkout-session application behavior stays unchanged until durable allocation adapter is connected.

Durable allocation schema evidence: session 43551 completed exit 0. migration:check PASS
106 tests and 132 immutable migrations; log /tmp/bop-wp2402-session-allocation-migration.log.
Database ownership PASS. Expanded isolated PostgreSQL schema test PASS 11.10s, verifying
allocation operation and all three generated-reference uniqueness, aliased-ID rejection, foreign
Store read/write isolation and immutable history. Affected fixture prettier/eslint passed.
No existing session migration changed; no Provider/runtime behavior activated. Allocation
application/transaction adapter and audit remain next; current creation service still uses its
old generation path until that atomic allocation integration is complete.
Next add typed allocation record and repository allocate/recover method, then pass recovered
submission/payment references into actual validation before final session creation. Enforce
final-session match against allocation and cover failure/retry/concurrent ownership with actual
database tests. Legacy already-created session recovery must remain original-record-first.

Allocation adapter implementation scope: closed typed allocation parser and owner repository,
exact operation serialization and current authorization, Cart/version/deadline gate for initial
allocation, immutable original replay for matching intent, atomic allocation Audit with pre/post
access checks. Register precise ownership assets and validate actual PostgreSQL contention/
rollback/recovery. No service switch until this allocation capability is verified.

Allocation adapter evidence: session 69154 PASS Ordering typecheck and expanded actual PostgreSQL
adapter acceptance (12.10s). Lost allocation response and concurrent same-operation requests recover
original IDs; changed Quote intent conflicts; failed allocation Audit leaves no allocation/Audit.
Exactly two successful allocation/Audit pairs observed. Existing session/Identity checks also pass.
Typed allocation boundary test PASS 8 cases (6ms). Ownership full suite PASS 481 tests (10.75s),
validator PASS, log /tmp/bop-wp2402-allocation-ownership.log. Affected eslint/prettier and final
Domain/import/whitespace checks passed. Initial dynamic record type failed TypeScript and was
replaced with explicit parsed fields; no unsafe assertion introduced.
No migration/toolchain/dependency change this increment. Actual allocation authorization in this
adapter case is synthetic; existing API Identity composition can supply the real access gate next.
Current service generation path has not yet switched. Next wire repository.allocate into service
before validate, pass recovered allocation to API validation port, use IDs for final session and
check allocation match on new final session insertion. Preserve old-session recovery before allocation.

### Switch session creation to durable allocation

Service now resolves original completed session first, otherwise persists/retrieves an exact scoped
allocation before validation; validation receives recovered IDs. Final candidate and competing
winner must match allocated IDs. New PostgreSQL session insert requires a matching persisted
allocation; existing completed history remains readable without backfill. API composition uses
actual allocation store/current identity gate and explicit allocation Audit factory. Update focused
service and actual PostgreSQL tests, including retry after validation failure; no Provider calls.

Durable allocation service switch evidence: focused service suite PASS 9 tests (17ms);
API and Ordering typechecks PASS. Actual PostgreSQL composition initially passed 12.65s,
then final explicit missing-allocation/mismatched-payment-ID assertions passed in session 20755
(11.65s). Real Identity composition deliberately fails validation once, retries and observes
identical allocated IDs and final submission binding. Current Store/QR and actual checkout
validation contents remain synthetic as previously disclosed. Allocation survives validation
failure by design; final session/Audit is written only on successful validation/admission.

Ownership suite PASS 482 tests; validator PASS; /tmp/bop-wp2402-allocation-binding-ownership.log.
Affected eslint/prettier, Domain/import and scoped final diff checks passed. No schema/dependency/
toolchain changes; no Provider activation. Existing session recovery is still first and needs no
allocation backfill. New writes require exact allocation, with parser and DB intent/scope bindings.
Next connect actual Pickup/Dining validation producers using allocated submission identity; reconcile
their existing owner-generated Payment operation IDs with this session allocation before exposure.
Canonical HTTP create/get/payment, real current-binding adapters and complete pilot journey remain.

### Actual Pickup session validation producer

Add API producer using actual existing Guest authorization, Catalog/Quote checkout validation and
ASAP capacity preparation. Request-local reference provider supplies the durably allocated Payment
operation ID only for PaymentOperation; other owner IDs retain existing generation/recovery.
Bind exact allocation/intent/scope/Guest and reject recovered capacity with a different Payment ID.
Prepare owner evidence before validation observation and reauthorize after validation. Quote v1/v2
both supported using existing configured quote history/snapshot producer. No Order/Payment writes
or Provider calls here. Add to actual Pickup PostgreSQL fixture for both quote/lot variants, with
existing synthetic Store/QR and catalog safety configuration clearly retained as test-only.

Actual Pickup session validation evidence: /tmp/bop-wp2402-pickup-session-validation.log PASS both
existing PostgreSQL quote/lot variants, 67.30s (session 91328). New producer obtains actual owner
capacity evidence and actual Catalog/Quote validation, retains session validation reference,
rejects a different allocated Payment operation ID, and leaves existing full fixture Order/
Inventory/Payment behavior passing. This test supplies an allocation-shaped binding to an
already prepared actual capacity record; durable allocation/session persistence is separately
verified and the entire chain is not yet exercised together. Store/QR binding, safety configuration
and actual Store approval remain synthetic/unavailable as already disclosed.
API typecheck and affected eslint/prettier passed after explicit comparison of cross-domain
instant strings; initial branded instant comparisons failed typecheck and were corrected.
Domain/import validators passed; no schema/toolchain/dependency changes. No process remains.
Next compose the actual validation producer with durable session creation in one PostgreSQL
journey (including first capacity creation with allocated Payment ID), add Dining producer using
the accepted current-table/session interpretation, then canonical HTTP routes and UI integration.

### Full durable Pickup session composition in existing journey

Capacity Prepared consumes the fixture's only slot, so preserve that accepted capacity limit.
Persist real allocation with actual transaction-bound Identity access before first capacity
preparation; the owner reference provider takes its Payment ID. Then call actual session creator
with actual Pickup validation producer over this record and verify final/replay identity binding
and exactly one allocation/session plus two Audit records. Continue existing Order/Inventory/
Payment journey unchanged. Covers both quote variants; actual Store/QR binding and catalog
safety remain explicitly synthetic. This avoids creating a second competing capacity request.
Run affected fixture lint/format and the existing Pickup PostgreSQL config once after edits.

### Dining session validation producer

Mirror the scoped integration using actual Dining current-table/session identity and commitment
preparation, not Pickup capacity. Take Payment operation ID from durable allocation and reject
different owner history. New preparation derives source deadline from actual Cart/Quote; original
commitment keeps its original deadline. Current Catalog/Quote validation and reauthorization
remain required. Add producer now, then run API types/lint and targeted Dining integration;
no claim of shared-session expiry/close/move/payment lifecycle completion.

Full durable Pickup session composition PASS: /tmp/bop-wp2402-durable-pickup-session.log, both
quote variants 68.50s (session 2674). Actual allocation with transaction-bound Identity precedes
first owner preparation; actual session creation consumes the same allocation and actual validation,
recovers original session and verifies one allocation/session plus two Audit records. Existing
Order/Inventory/Payment fixture continues passing. Owner preparation is invoked explicitly before
session creation in this test; production validation's create-if-missing path remains structurally
available but this is not a claim that it was first invoked from validation. Synthetic Store/QR and
safety gates remain. Fixture lint/format passed.

Dining producer uses real current Dining identity and owner commitment, explicit allocated Payment
ID and actual Cart/Quote deadline. API typecheck and producer lint/format passed; configured
export name corrected before integration. Initial Dining integration failed at a fixture variable
(at undefined); changed to observedAt and lint passed. Final Dining PostgreSQL run is pending
here; its specific handle is 35613, not evidence of completion.

Dining producer integration completion: /tmp/bop-wp2402-dining-session-validation-final.log PASS
both quote variants, 89.22s (35613). Actual persisted Dining/Identity/Cart/Quote producer returns
current owner commitment evidence and rejects mismatched allocated Payment ID while existing
Order/Inventory/Payment fixture remains passing. This test provides allocation-shaped binding to
existing owner history, not durable Dining session allocation/creation. Complete that combined
path next, keeping accepted no-Pickup-capacity Dining semantics and original clock.
No running checks remain. No migration/dependency/toolchain changes; final Domain/import checks
passed after producer addition. Full verify/release, actual Store/Provider readiness and customer/
merchant/Kitchen/refund/ops end-to-end remain outstanding.

### Full durable Dining session composition

Before first owner commitment, persist session allocation using actual transaction-bound Identity
and Dining public readers/current table/session/participant admission. Keep base Store/QR fixture
context explicitly synthetic. Override only owner PaymentOperation generation with allocated ID.
Actual Dining validation then creates/replays the durable session, verifies exact commitment IDs
and one allocation/session plus two Audit rows, and existing Order/Inventory/Payment journey
continues. Grant only required Identity/Dining read tables to isolated Ordering test role.
Run affected fixture format/lint and existing Dining PostgreSQL config; no production permission,
schema, Provider or toolchain change. HTTP/runtime and real Store/QR remain subsequent work.

Full durable Dining composition PASS: /tmp/bop-wp2402-durable-dining-session.log, both quote
variants 94.01s (session 1450). Actual Identity and current Dining table/session/participant
owner reads run on the lent allocation/session transaction. Allocation precedes first commitment,
its Payment ID is used by owner preparation, actual validation creates/replays session and exact
IDs are asserted. One allocation/session and two Audit records; existing Order/Inventory/Payment
journey remains passing. Base Store/QR context and safety policies are still fixture values.
Affected fixture lint/format and scoped diff check passed; production source, schema, dependencies
and toolchain unchanged this increment. No processes remain.
Next canonical POST /api/v1/carts/{cart_id}/checkout-sessions and GET session API, safe minimal
response projection, route-template logging protection, OpenAPI contract and current-authorized
read composition; then connect payment-intents route and PWA. Do not expose raw session records,
Guest/operation IDs or Provider values. Complete pilot and actual external readiness remain open.

### Canonical Checkout Session HTTP creation

Implement POST cart checkout-sessions using actual session composition port, closed body,
same-origin/CSRF/Guest credentials and idempotency header. Reparse and bind owner result;
return only session/cart/quote identifiers and historical createdAt, never Guest/internal
operation IDs or implied current payment permission. Register logging route template.
Required affected checks: API types, handler HTTP behavior tests, lint/format; OpenAPI
contract/generation and current-authorized GET remain to complete before API handoff.
Existing durable Pickup/Dining PostgreSQL evidence is unchanged by HTTP-only work.

HTTP creation evidence: 9 targeted tests PASS (2026-09-11, 2.37s), including both quote
versions, exact minimal projection, original replay, closed body, cross-origin/CSRF/duplicate
cookie rejection, service error mapping, foreign/malformed owner result and unconfigured 503.
OpenAPI generated with existing openapi:generate; openapi:check PASS. API and contracts
typecheck, affected lint/format and scoped diff whitespace checks PASS. Tested current
a0f35440 worktree including these uncommitted HTTP/contract changes; PostgreSQL owner
implementations and dependencies unchanged. This is HTTP boundary evidence using synthetic
owner results, not runtime or browser journey acceptance. Current-authorized GET, runtime
composition and payment/PWA integration remain next. Full pilot goal remains incomplete.

### Current-authorized session read composition

Read within one lent transaction: current credential-derived Guest permits scoped historical
lookup; source Cart is obtained only from parsed owner history and then authorized with
actual Identity/Cart reader before any return. Recheck identity fingerprint, current Store/
channel and monotonic clock; missing/foreign/revoked access is non-disclosing. No writes,
quote renewal or payment admission. Add scoped behavior evidence before HTTP GET exposure.

Read composition verification: initial 8-test run found two authorization-loss paths
incorrectly mapped to DEPENDENCY_UNAVAILABLE by the store wrapper. Catch actual Identity
denials inside the read gate so they become PERMISSION_DENIED. Corrected run: all 8 PASS
(2.39s), actual credential verification and owner parsers with synthetic SQL/current Store
binding; one transaction, missing history, wrong CSRF, changed identity, lost binding,
clock rollback and unavailable source Cart covered. No real PostgreSQL read journey claim.
Typecheck passed; fixture empty callback lint corrected without behavior change. HTTP GET
and composed PostgreSQL read acceptance remain next; full pilot remains incomplete.

GET /api/v1/checkout-sessions/{checkout_session_id} now registered with a redacted route
template and minimal historical response. Requires same-origin Fetch Metadata and CSRF;
optional Origin must match when present (browser same-origin GET can omit it). No query
parameters accepted. Shared credential parsing retains duplicate-cookie rejection. 10 HTTP
tests PASS (2.43s), API types and affected lint/format PASS. These mock owner port tests
do not establish runtime wiring or persisted read acceptance. OpenAPI GET added; generation
and check follow. Next actual PostgreSQL read composition and runtime/PWA/payment linkage.

GET OpenAPI generation/check, contracts typecheck and lint PASS after route addition.
Extend existing checkout-session PostgreSQL adapter acceptance with actual read composition:
exact created session recovered, missing ID/incorrect CSRF denied, persisted Guest revocation
prevents subsequent read. Reuse existing isolated database/role; Store/QR binding remains
explicitly synthetic. Run affected fixture lint/format and this existing targeted config.

Actual PostgreSQL read composition PASS: /tmp/bop-wp2402-session-read-postgres.log,
13.92s total, scoped adapter test including current Identity/Cart/session recovery and
persisted revocation refusal; existing allocation/Audit/replay checks remain passing.
Fixture lint/format passed. Store/QR binding and validation still synthetic.
Add explicit runtime option assembling POST and GET from the same owner options; absent
configuration keeps 503. No fabricated Store, credential, Provider or automatic activation.

Runtime factory typecheck/lint/format and existing server tests (6, 2.56s) PASS.
HTTP-to-PostgreSQL composed session acceptance PASS: /tmp/bop-wp2402-session-http-postgres.log,
14.72s. Actual factory + Express routes + current Identity + PostgreSQL session/Cart reads:
POST original-operation recovery returns minimal expected summary, GET matches, persisted
Guest revocation returns HTTP 404. Existing allocation/session/Audit counts unchanged.
This run tests POST replay, not first creation through HTTP; actual creation is earlier
in the same fixture. Store/QR and validation are explicit synthetic ports.
Initial fixture lint required globalThis.fetch; corrected after behavioral run with no
semantic change, final lint/format PASS. No redundant database rerun for that spelling.
Next session-to-order/payment orchestration using server-held submission/payment IDs,
current capacity/Inventory/Workflow checks, then PWA consumption and full pilot journeys.

### Session-owned order submission bridge

Resolve current-authorized persisted session from credentials and session ID only. Use
its server-held submission/payment IDs in actual Pickup/Dining submission compositions
(both quote versions), reject mismatched owner links before repository access, validate
returned original Order binding and reauthorize session before return. Existing current
Cart/Quote/capacity/Inventory write gates remain inside owner compositions. No Provider
call or HTTP payment admission is implied. Add bridge then types/lint and connected
Pickup/Dining evidence before exposing payment endpoint.

Session-order bridge types/lint/format and Domain/import boundaries PASS. Pickup
integration now invokes actual bridge for first Order through existing HTTP test adapter
and original recovery, preserving real Inventory rollback/finalization and Payment tests.
Initial run failed because Order HTTP did not map CheckoutSessionServiceError (503 vs404
for bad CSRF). Added explicit safe mapping; 30 Order HTTP tests PASS (3.03s). Final
Pickup run /tmp/bop-wp2402-session-order-pickup-final.log PASS both quote variants,67.27s.
Original session matches, response-lost Order recovers, Inventory does not reserve twice,
revoked Guest cannot use bridge; browser cannot supply internal submission ID.
This adapter exercises the bridge through existing Order HTTP, not a completed canonical
payment-intents route. Actual Store/QR/safety facts remain synthetic. Next Dining bridge
acceptance, then actual Payment composition and canonical customer payment flow.

Dining bridge acceptance now routes initial Order/recovery through actual session bridge
and checks forbidden client PaymentOperation input. First run reached late replay assertion
but compared older {status,record} result to new {status,record,session} envelope. Changed
comparison to exact original Order result and retained separate session equality; added
revocation rejection through bridge. No production source changes this increment. Fixture
lint/format PASS. Final run uses /tmp/bop-wp2402-session-order-dining-final.log; pending
until observed terminal result. Actual Store/QR remains synthetic; Payment route remains next.

Final Dining bridge run PASS both quote variants,89.12s (session71057), log above.
Actual persisted session/current Dining identity drives original Order creation and
response-loss recovery; session equality, no repeat Inventory reservation and revoked
Guest rejection verified. Existing payment preparation/admission scenarios remain passing.
No process remains. Complete canonical Payment HTTP/runtime/PWA and pilot journeys still open.

### Session payment-clock handoff

Extend actual session Order bridge with preparePaymentClock for both channels/quote versions.
Current-authorized persisted session supplies internal IDs; actual owner composition seals
or recovers original clock. Parse owner history and assert exact Order/Batch/Cart/Quote/
Guest/payment binding, PaymentPending and non-null original payment/expiry instants;
reauthorize before returning. No Provider call or current payment eligibility implied.
Run types/lint then extend existing Pickup/Dining clock recovery acceptance.

Session payment-clock bridge typecheck/lint/format and Domain/import checks PASS after
explicit string comparison of already-parsed cross-domain branded references. Both
existing PostgreSQL fixtures now call session preparePaymentClock for first seal and
original recovery, retain separate session equality and assert revoked access denied.
Fixture lint/format PASS. Pickup /tmp/bop-wp2402-session-clock-pickup.log PASS both quote
versions,69.59s. Dining isolated run remains live as session6421 pending observed result.

Dining /tmp/bop-wp2402-session-clock-dining.log PASS both quote versions,93.14s.
Session-based initial seal and original clock recovery retain exactly original payment
request/30-minute deadline, actual owner/session identity and no repeated Inventory
reservation. No processes remain. Test Store/QR/safety/Provider configuration is not
actual pilot readiness. Next current-authorized tip selection and PaymentIntent composition.

### Session-owned tip selection

Current session ID and credentials resolve server-owned Order/Cart/Quote/payment IDs.
Client supplies selection ID (retry intent) and exact CAD Money only. Actual Pickup/Dining
tip services retain existing pre-clock eligibility and recovery rules; wrapper binds
original load and append candidate to session before writes, checks returned exact amount
and selection ID, and reauthorizes before return. Both quote versions supported. No default
tip, Provider call or payment admission. Types/lint then extend existing composed evidence.

Session tip bridge types/lint/format and Domain/import boundaries PASS. Actual Pickup
and Dining fixtures now select through session IDs, recover response-lost original tip,
reject changed amount and reject new selection after clock seal; original selection
recovery and revoked Guest denial verified. Both quote variants PASS: Pickup
/tmp/bop-wp2402-session-tip-pickup.log 72.58s; Dining
/tmp/bop-wp2402-session-tip-dining.log 96.79s. Fixture lint passed; final Dining formatter
changed layout only while run was active, no behavior change. Actual Identity/Order/
capacity/Inventory/tip/Audit persistence exercised; Store/QR/safety remain synthetic.
No processes remain. Next PaymentIntent application composition, actual provider adapter
and canonical customer payment HTTP/PWA; full pilot still incomplete.

### Session PaymentIntent composition

Add internal orchestration: current session -> actual session Order creation/recovery ->
actual immutable tip selection -> original payment clock -> actual Inventory owner load
-> parsed payment preparation snapshot -> existing PaymentIntent creation service. Required
factory supplies real authorization, kill-switch, admitted repository and Provider adapter;
no default external settings. Client has no internal operation IDs or requestedAt.
Current write admission remains in required repository, not granted by historical snapshot.
Validate types/lint first, then actual composed service evidence before HTTP exposure.

Payment composition types/lint/format and Domain/import checks PASS. Review found original
Payment recovery unnecessarily repeated Order/tip/clock/Inventory preparation. Added required
public Payment history reader: existing operation uses parsed original preparation and
checks requested tip amount, then existing Payment service reauthorizes and verifies request
digest (including selection ID). Its replay path performs no ordering preparation, current
Inventory admission or Provider call. A disappearing original fails closed instead of
creating a replacement. New operation retains complete preparation path. Post-change types/
lint/format PASS; behavioral replay evidence remains required next (not yet claimed).

Payment recovery orchestration evidence: 5 tests PASS (3.45s), actual Payment creation
service/parsers with mocked current-session boundary and synthetic repositories/Provider.
Expired preparation recovers original without Order/tip/clock/Inventory preparation or
Provider calls; current authorization denial, changed tip/selection, forbidden client
operation IDs and disappearing original deny safely. Extracted existing Payment service
harness to shared fixture rather than duplicating it; original 40 service tests PASS
(2.28s). API/Payment types, affected lint/format PASS. No actual Provider/database
combined PaymentIntent claim is inferred from these unit tests. Next full composed
Payment service and admitted PostgreSQL write evidence, then canonical HTTP/PWA.

### Actual Payment service + admitted PostgreSQL claim

Extend existing Inventory/Order/capacity admission fixture at successful claim boundary:
actual PaymentIntent creation service creates canonical record/Audit using current
credential authorization and real admitted store; force lost local commit acknowledgement
and verify retry Processing with original record and zero Provider calls. Existing
negative Inventory/Workflow/Audit checks retained. Kill-switch fixture remains explicitly
synthetic; no external network call. Run both existing connected journey configs.

Actual Payment service claim added to existing admitted PostgreSQL fixture. Initial
combined run denied malformed synthetic kill-switch evaluation after spreading its frozen
structure; restored required frozen outer/control/scope objects without weakening verifier.
Final Pickup /tmp/bop-wp2402-payment-service-pickup-final.log PASS both quote variants,
71.53s. Actual service-generated canonical Payment record and Audit commit with actual
Order/capacity/Inventory/Workflow admission, lost local acknowledgement yields dependency
error, retry returns Processing original with zero Provider calls/no repeated admission.
Existing negative write checks retained. Fixture lint/format PASS; Dining final session65044
is still running until observed terminal output. Synthetic kill-switch and no live Provider.

Dining final /tmp/bop-wp2402-payment-service-dining-final.log PASS both quote variants,
97.23s. Same actual service/admitted store/lost-ack recovery evidence as Pickup. No
processes remain. Full session PaymentIntent orchestration still needs this actual store
integration, then Provider result/callback and canonical HTTP/PWA flow; pilot incomplete.

### Full session PaymentIntent with actual owner persistence

Both fixtures now pass actual session access/Order/tip/input into Payment helper, which
uses actual session PaymentIntent orchestration and actual Inventory reader/admitted
Payment repository. Forces lost local Payment acknowledgement; original recovery leaves
Provider untouched and does not rerun admission. Fixture lint/format PASS. Pickup
/tmp/bop-wp2402-session-payment-pickup.log PASS both variants,74.03s. Dining ordinary
variant PASS in /tmp/bop-wp2402-session-payment-dining.log; configured variant failed
with ECONNREFUSED to local test database, not business assertion. Only configured variant
rerun using existing config -t configured=true, session95026, result pending. Synthetic
kill-switch, Store/QR and no Provider network remain explicit.

Configured Dining isolated rerun PASS,48.03s, /tmp/bop-wp2402-session-payment-dining-configured.log.
Ordinary variant intentionally filtered (previous run passed), not rerun. Full session
Payment orchestration now has actual persistence/lost-ack/recovery evidence for both
channels and quote versions. No live processes. Next canonical payment HTTP with safe
response and Provider handoff/result integration; real pilot readiness remains outstanding.

### Canonical session payment HTTP

CUST-PAYMENT POST checkout-sessions/{id}/payment-intents: same-origin/CSRF/Guest,
closed tip body with exact decimal minor units (CAD), idempotency key identifies immutable
tip selection. Server session fixes submission/payment operation IDs. Strictly parse/bind
result, expose only session/intent/Order references, creation status and total; no Guest,
Provider IDs/secrets or claim of paid. Processing=202, Created=201, replay=200.
Register route template for safe logs. HTTP tests/OpenAPI/runtime follow before handoff.

Payment HTTP implementation types/lint/format PASS after using Pricing currency parser.
11 HTTP tests PASS (2.63s): created/replay/processing projection, exact decimal Money,
CSRF/origin/duplicate cookie/idempotency rejection, typed errors, foreign session/unsupported
status and unconfigured503. Fixtures use actual Payment result parser/service data but
HTTP owner port is mocked. OpenAPI contract now records no paid-status inference, exact
amount range, required credentials, stable selection key and safe response. Generation
and check follow; runtime/real HTTP+DB and Provider handoff remain next.

### Explicit Payment HTTP runtime assembly

The API server now accepts CustomerPaymentIntentRuntimeOptions and constructs the
canonical handler with createCustomerSessionPaymentIntent and supplied real owner ports.
No Provider, credentials, policy or Store defaults are introduced; absent configuration
retains the unavailable handler. This exposes the composition through the runtime but
does not establish actual deployment configuration or Provider readiness.

Fresh affected evidence at current uncommitted worktree: prettier and ESLint for
customer-payment-intent-runtime.ts/server.ts PASS; contracts-events openapi:check PASS
(schema and references); api typecheck PASS; api vitest server.test.ts and
customer-payment-intent.test.ts PASS,17 tests,3.96s. These existing tests cover HTTP
behavior and server lifecycle, not a fully configured Payment runtime/database journey.
Earlier database owner evidence is unchanged by this runtime-only wiring and was not
rerun. Next: real HTTP-to-persisted Payment journey, then Provider handoff/result and PWA.

### Persisted Payment recovery through canonical HTTP

The existing owner-persistence fixture now sends actual HTTP requests through createApp
and CustomerPaymentIntentHandler into the actual session Payment service. Lost commit
acknowledgement returns503; replay returns202 Processing with the original intent and
a closed safe projection/no-store. Original records remain singular, Inventory admission
and expiry resolution are not repeated, Provider calls remain zero. Store/QR/kill-switch
facts remain synthetic; this is not a live Provider success journey.

Affected fixture ESLint PASS after explicit globalThis.fetch. Pickup both quote variants
PASS71.50s, /tmp/bop-wp2402-payment-http-pickup.log. Dining equivalent run is active
in exec session41775, /tmp/bop-wp2402-payment-http-dining.log; no result claimed yet.

Dining HTTP persisted recovery PASS both quote variants,102.07s,
/tmp/bop-wp2402-payment-http-dining.log, session41775 terminal. Together with Pickup
this covers both channels and quote contracts through actual HTTP/session/owner storage.
Provider success and client handoff remain unverified.

Payment HTTP now maps typed Order/Checkout/Cart/Tip preparation failures into existing
400/404/409/422 responses, retaining503 for unavailable dependencies. This prevents stale
quotes, version conflicts and immutable tip conflicts from being advertised as transient
service failures. Only known error classes are mapped; generic safe response remains.
Initial typecheck caught stray Session keys in the owner map; removed them. Final API
typecheck, affected lint/format PASS; payment HTTP18 tests PASS2.76s including seven
preparation-error cases and retry-header behavior. No database rerun for this isolated
error mapping: successful/recovery paths and persistence inputs unchanged.

### Stripe online intent request encoding

Payment-owned infrastructure now encodes validated OnlineCard create/retrieve requests.
Exact decimal CAD minor units, Stripe eight-digit ceiling, original idempotency key,
explicit automatic capture/card method and confirm=false. No owner metadata/PII added.
Retrieve validates pi_ identifier before constructing internal path; no credential/default
account configuration. This internal encoder is not yet a complete transport/adapter and
does not send network requests. Terminal encoding, response normalization, configured
transport and ephemeral client handoff remain outstanding.

Primary reference: https://docs.stripe.com/api/payment_intents/create (read this turn):
amount smallest currency unit/up to eight digits; creation requires subsequent confirmation.
Requests must still pass Provider/account/currency-specific limits when transport is added.
Affected prettier/ESLint and Payment typecheck PASS; three focused encoder tests PASS829ms.
No database inputs changed and no database suite rerun.

### Scoped Stripe online HTTP transport

Added internal create/retrieve transport using the validated encoder and fixed
https://api.stripe.com origin. Configuration explicitly supplies Brand/Store/environment,
API version, secret/restricted key and nullable connected account. Rejects mismatched
scope/key environment before network; uses original mutation idempotency key, no GET
idempotency, redirects disabled,15s timeout,1MiB streamed response cap. No automatic retries.
HTTP failures discard Provider error body; thrown errors contain only safe fixed text.
Success payload is internal/ephemeral and still requires normalization before persistence
or client projection. The transport is not yet installed into Payment runtime.

Primary references read: https://docs.stripe.com/api/authentication,
https://docs.stripe.com/api/connected-accounts,
https://docs.stripe.com/api/idempotent_requests. No real credentials or Provider calls.
Affected prettier/ESLint and Payment typecheck PASS; four transport tests PASS868ms using
mock fetch: request headers/origin, scope isolation, ambiguous failures/no retry, malformed
and oversized response handling. Next response normalization and actual adapter assembly,
then safe client-secret handoff. Pilot remains incomplete.

### Stripe online response normalization

Create/retrieve requests now expand latest_charge. Internal normalizer binds environment,
currency, intent ID for retrieval, exact requested amount for creation, automatic/card
policy and strict known statuses. Captured requires matching expanded Charge, paid/captured
state and amount_received/amount_captured equality; refunds use amount_refunded and existing
owner invariants. Missing/unknown/inconsistent facts fail closed. Pending customer action
is not paid. Only selected owner facts enter snapshot/digest, never raw payload, client_secret,
billing data or receipts. Retrieve amount remains subject to caller's stored-intent comparison.

Primary sources read: https://docs.stripe.com/api/payment_intents/object,
https://docs.stripe.com/api/charges/object and https://docs.stripe.com/api/expanding_objects.
Affected formatter/ESLint/Payment typecheck PASS;18 request/normalizer/transport tests
PASS864ms (11 new normalization cases). Synthetic responses only. Actual adapter assembly,
ephemeral customer handoff and live Provider readiness remain outstanding; no pilot claim.

### Composed Stripe create/retrieve adapter

Public Payment export createStripeOnlineIntentAdapter composes validated requests,
scoped transport and normalized snapshot. Returns only actual create/retrieve ports;
cancel/capture/refund implementations remain separately required, no fake lifecycle methods.
Unknown HTTP/network/invalid-result outcomes remain Unknown with Unknown retry disposition
and fixed safe reason; no automatic retry or false failure/success claim. Credentials/raw
responses do not escape public outcome. Server runtime configuration still outstanding.

Affected format/ESLint/Payment typecheck PASS; three composed-adapter tests PASS901ms,
covering normalized creation, original retrieval/foreign-result rejection and ambiguous
outcomes with exactly one transport invocation per attempt. All HTTP responses simulated.
Next actual Payment service integration and ephemeral client handoff, alongside remaining
lifecycle operations. No live Provider or complete pilot evidence claimed.

### Actual Payment service with Stripe create adapter

Added composed service tests using real createPaymentIntentCreationService plus real Stripe
encoding/transport/normalizer, with synthetic in-memory owner ports and simulated fetch.
Proves local claim precedes network, transmitted amount equals canonical preparation total,
transmitted idempotency key hashes to saved attempt digest, response observation is recorded,
and original replay invokes network only once. Covers normal customer-action response and
ambiguous lost Provider response, neither interpreted as captured payment. Initial test type
error correctly exposed that only idempotency digest is stored; assertion corrected to hash.

Payment typecheck and formatter PASS;5 composed-adapter tests PASS2.59s. Earlier lint passed
before assertion correction; no new final lint claim. These are service composition tests,
not PostgreSQL+Stripe or actual runtime/deployment evidence. Remaining customer handoff,
lifecycle operations, real owner runtime configuration and external readiness still required.

### Ephemeral Stripe client handoff port

Server-internal handoff retrieval uses original Provider intent, current Stripe status and
expected canonical amount; only RequiresCustomerAction exposes a structurally matching
client credential, separately from normalized snapshot. Processing/cancelled/changed amount,
missing/foreign secret fail closed with safe errors. Raw response is not retained or logged.
This low-level port is deliberately not an HTTP route or authorization service: current
Guest/Order/payment-deadline authorization before/after retrieval is the next required layer.

Local Section87 reference line21257 requires Stripe.js page memory only and redirect
if_required; line21267 clean result route excludes Provider credential/ID. Primary external
reference: https://docs.stripe.com/payments/payment-intents (client-secret handling).
No actual credential/Provider access. Format/ESLint/Payment typecheck PASS;8 local handoff
tests PASS938ms, synthetic data/mock fetch only. Customer endpoint/PWA, current owner
authorization and real runtime configuration remain outstanding.

### Current-authorized customer Payment handoff service

Payment application service requires loadCurrent to perform current request-local
Guest/Store/Order/payable-state/Provider admission authorization. Loads before and after
Provider retrieval; denies null, changed owner record, exact capacity deadline expiry,
backward server clock and mismatched Provider snapshot/credential. Returns only ephemeral
clientSecret; no write port accepts it. Provider record must remain RequiresCustomerAction.
This mandatory current-owner callback is not yet implemented in API runtime; no endpoint
is exposed by this change and it does not establish production authorization evidence.

Format/ESLint/Payment typecheck PASS;3 service tests PASS2.24s: positive two-sided check,
revocation before/during retrieval, exact expiry while Provider is in flight. Actual Payment
record parser/service fixtures with mocked authorization/Provider, not live or database
handoff acceptance. Next wire current session/Order/Payment owners into loadCurrent, then
CSRF-protected no-store customer endpoint and page memory use.

### Session handoff owner composition (integration in progress)

New API composition reads actual current CheckoutSession/Guest access, resolves Payment
owner history, strictly binds operation/submission/Guest/Store/Cart/version/Quote, and runs
configured actual current Order/capacity/Inventory admission under its transaction. Requires
explicit allowConfirmation policy including in-flight safety semantics, with no default.
Session reauthorization is repeated around owner checks and by the handoff service before/
after Provider retrieval. No endpoint/runtime wiring yet. Actual admission configuration
must use read-only evaluation, never replay a stock mutation.

Initial API typecheck found cross-domain branded instant comparison; changed to canonical
UTC strings. Formatter and initial lint passed; final typecheck result observed separately.
Behavior tests for the new API composition and real PostgreSQL handoff remain next; this
entry is progress, not completion evidence.

### Session handoff rejection evidence and owner deadline fix

Added6 API composition tests: positive before/after owner checks, admission/policy denial,
foreign Store Payment history, revoked session during Provider retrieval, and earlier
Inventory deadline expiring during asynchronous policy evaluation. Found and fixed the last
boundary: retain owner validUntil and check it again after policy/session awaits, rather than
checking only within the admission transaction. Provider is not invoked after expiry.

Final API typecheck, affected formatter/ESLint PASS;6 tests PASS2.32s. Final test label clarified
Store binding coverage (label only, assertions unchanged). Actual Payment parsers/service
fixtures, mocked session/admission/history/Provider; not PostgreSQL handoff evidence.
Next real owner database integration and CSRF/no-store HTTP handoff. No external calls.

### Persisted current-owner payment handoff acceptance

Shared DB fixture now records a normalized synthetic Stripe observation through actual
Payment observation store, then uses actual session handoff/Stripe handoff ports with mock
HTTP and real Identity/Cart/Ordering/capacity/Inventory/Workflow read fences. Retrieves only
ephemeral client credential, verifies persisted record remains normalized, then denies
current Inventory/Workflow admission and proves no second Provider retrieval. Synthetic
confirmation safety policy explicit; no real Provider or approval implied.

Affected fixture format/ESLint PASS. Pickup both quote variants PASS73.93s,
/tmp/bop-wp2402-handoff-pickup.log. Dining equivalent run dispatched, result pending.
Existing HTTP lost-ack recovery checks remain within same run. No full regression rerun.

Dining persisted handoff both quote variants PASS104.22s,
/tmp/bop-wp2402-handoff-dining.log, session24970 terminal. Thus both channels have actual
owner database handoff evidence with synthetic Provider/confirmation policy.

### Customer payment handoff HTTP boundary

POST /api/v1/checkout-sessions/{id}/payment-handoff accepts closed empty JSON body,
same-origin/Fetch Metadata, unique Guest cookie and CSRF token; no query or internal IDs.
Returns only schemaVersion/clientSecret with no-store/no-referrer; safe errors and default
unconfigured503. Route template registered to avoid logging concrete session IDs. Strict
owner envelope/credential shape enforced. Runtime assembly/OpenAPI remain next.

Affected format/ESLint/API typecheck PASS;4 HTTP tests PASS2.63s covering safe output,
cross-site/CSRF/cookie/body rejection, invalid owner output/error mapping and missing runtime.
Mock owner port here; separate DB handoff tests above are not HTTP+DB acceptance. No real
Provider/payment and no complete pilot claim.

### Payment handoff runtime and OpenAPI

Server runtime now accepts explicit CustomerPaymentHandoffRuntimeOptions and constructs
the actual session/owner composition plus HTTP handler. No implicit Provider credentials,
Store policy or safety approvals. OpenAPI registers the POST read with closed empty body,
Guest/CSRF/same-origin requirements, safe error statuses, no-store/no-referrer and ephemeral
page-memory-only credential. No creation/confirmation side effect or paid inference.

Runtime affected prettier/ESLint/API typecheck PASS; server6 + handoff HTTP4 tests PASS3.78s.
These cover existing lifecycle/HTTP behavior, not configured runtime with database.
Contracts catalog prettier/ESLint, openapi:generate, openapi:check (schema/references) and
contracts-events typecheck PASS. Next real HTTP-to-owner handoff and PWA payment page.
No full database repeat for runtime/contract-only edits; prior owner evidence unchanged.

### HTTP-to-persisted customer handoff

DB fixture now constructs actual handoff runtime handler and createApp HTTP server. Valid
POST reads ephemeral credential with no-store/no-referrer from actual session/Payment/
Ordering/capacity/Inventory chain; denied current Workflow/Inventory returns422 without
another Provider retrieval. Payment observation remains normalized. Synthetic Provider and
confirmation policy still explicit. Pickup both variants PASS73.18s,
/tmp/bop-wp2402-handoff-http-pickup.log. Fixture format/ESLint PASS. Dining run dispatched;
observe its original handle before claiming completion.

PWA inspection: existing PaymentPage/controller consumes a different generic create/observe
contract, and checkout/order-submission still POSTs directly to /api/v1/orders. Next frontend
work must connect canonical CheckoutSession creation/recovery before PaymentIntent/handoff,
preserving page-memory credentials and authoritative payment-result semantics.

Dining HTTP-to-owner handoff both quote variants PASS103.58s,
/tmp/bop-wp2402-handoff-http-dining.log, session73058 terminal. Both channels now cover
formal HTTP handler/runtime factory with actual owner persistence and synthetic Provider.

### PWA CheckoutSession client

Added canonical create/read client using existing bounded fetch and current CSRF context.
Creation takes explicit stable operation key, sends only Cart version/Quote reference,
strictly binds safe response to selected Cart/Quote/version. Read binds session ID.
No operation IDs generated on transport retry; no credential storage. Malformed/extra
response fields and obsolete CSRF context are rejected. Client is not yet wired to page
controller/navigation; existing direct Order submit remains until that coordinated change.

Affected formatter/ESLint/PWA+service-worker typecheck PASS;4 client tests PASS253ms:
same-key create/replay, read binding, mismatched/extra payload rejection, and credential
change in flight. Mock fetch only; next integrate CheckoutPage and payment client/controller.

### PWA session intent controller

Added page-level CheckoutSession controller retaining first selected Cart/Quote and generated
operation key, deduplicating concurrent clicks, and retrying only original intent after
unknown/offline outcomes. Denies retry after CSRF context revocation and never starts offline.
No Web Storage or credential retention. Existing CheckoutPage has a permanently disabled
continue button and details form needs readiness propagation; those UI changes remain next.
Controller/client must be wired together before claiming actual customer flow completion.

### CheckoutPage session navigation wiring

CheckoutDetailsForm now reports saved, unchanged, current-authorized, online and unexpired
readiness for its exact Cart/Quote. CheckoutPage gates Continue on this matching readiness,
nonblocked/unexpired quote and explicit changed-price confirmation (previous checkbox had
no state). Uses session client/controller, retained-intent retry messaging and deduplicated
creation. On ready, stores only session reference in foreground memory and navigates to
canonical /checkout/payment. CSRF replacement clears that reference. Quote actions lock
once session creation starts. PaymentPage itself remains next; it still uses unavailable
default client, so this is not completed customer payment.

PWA/service-worker typecheck, affected lint/format PASS. Initial existing SSR assertion
expected permanently-unavailable copy; updated to saved-details requirement. Final14 SSR
page tests +1 context isolation test PASS515ms. Earlier session client4/controller2 PASS
remain unchanged. Browser interaction/visual evidence for the new enabled flow is still
required; SSR does not prove click/save/navigation behavior.

### PWA session payment HTTP client

Added canonical PaymentIntent create and ephemeral handoff client using current CSRF
context and bounded no-store/same-origin requests. Explicit stable selection key and exact
CAD tip string; strict status/HTTP agreement and session/intent/order/amount projection.
Creation never becomes paid state. Handoff accepts only HTTP200 no-store with closed
credential envelope; discards obsolete session responses. No storage or credential logging.
PaymentPage/secure Provider component still needs this client wired; authoritative payment
result endpoint remains separate outstanding work.

### Stripe.js hosted card component

Installed exact accepted @stripe/stripe-js9.10.0 and added StripeCardForm using pure lazy
loader. Stripe Payment Element owns card input; Apple/Google wallet UI disabled; explicit
external HTTPS sanitizer return URL required and no query/fragment/userinfo accepted.
Uses redirect if_required and current CSRF lease before confirmation; SDK outcomes only
trigger authoritative verification, never mark paid. Credential remains component/SDK
memory and is absent from SSR HTML. Component not yet mounted by PaymentPage.

Component prettier/ESLint/PWA/service-worker typecheck PASS after cleanup lint fix;1 SSR
credential-isolation test PASS284ms. Browser mount/confirmation/cleanup tests still needed.
Fresh pnpm install --frozen-lockfile PASS42 workspaces,1.8s,
/tmp/bop-wp2402-stripe-js-install.log. This replaces old install evidence after manifest/
lockfile change; no other version upgrades requested. Existing workspace-link changes
preserved. Real publishable configuration/sanitizer deployment remain external inputs.

### SessionPaymentPage draft integration

Default /checkout/payment now mounts SessionPaymentPage using current in-memory session,
canonical session read, PaymentIntent creation/handoff client and StripeCardForm. Explicit
public key/sanitizer URL build configuration required, no credentials/default facts supplied.
Shows canonical server total before card submission; SDK completion clears credential and
enters verification-pending, never paid. Offline clears secure form and requires explicit
same-intent readiness retry. Existing injected legacy controller remains for test/result path.

Draft discrepancy to resolve next: tip selection currently appears in Payment page but
CUST-PAYMENT contract requires already-selected tip. Move selection to Checkout with retained
immutable selection key before final browser acceptance. Result route still lacks authoritative
server observation integration. No complete payment flow claim.

Affected format/ESLint/PWA/service-worker typecheck PASS; existing PaymentPage9/client5/
Stripe SSR1 tests PASS430ms. These do not prove new interactive page behavior; browser
save/session/tip/create/handoff/SDK and response-loss tests remain necessary.

### Checkout tip placement and retained payment identity

Resolved the draft CUST-PAYMENT discrepancy: CheckoutPage now requires an explicit CAD tip
(including zero) before session creation; SessionPaymentPage displays the previously selected
tip without editing it. Exact decimal parsing uses BigInt without rounding. The session-bound
selection UUID and amount are immutable in current CSRF memory and survive payment page
remounts; replacing CSRF or the checkout session clears the binding. Lost-response retries
retain the original selection. No Web Storage or background replay was introduced.

Affected files: CheckoutPage, SessionPaymentPage, customer-transaction-context, tip-amount
and their scoped tests plus App route assertions. Same WP-2402 baseline and existing
uncommitted worktree. Fresh PWA typecheck PASS, lint PASS after removing a test non-null
assertion, production build PASS (/tmp/bop-wp2402-checkout-tip-build.log).
PWA test run: 727 passed, two obsolete App placeholder assertions failed
(/tmp/bop-wp2402-checkout-tip-tests.log). Updated those assertions for actual checkout/payment
loading boundaries; targeted App12 and tip parser1 PASS714ms. The unchanged 45 passing test
files remain evidence from that run, not a second full test run. New context tests cover
immutable amount/identity, CSRF replacement, session replacement and invalid money.
Prior frozen-install evidence remains valid: manifests/lockfile/pinned toolchain unchanged
by this slice. No backend or database source changed, so prior composed DB evidence was
not rerun. Browser save/navigation/SDK/recovery and authoritative result integration remain
outstanding; page-memory retention does not yet provide full refresh recovery.

### Browser checkout-to-card continuity

Extended the existing checkout-continuity.spec.ts under WP-2402 for desktop and 390px
touch: explicit tip validation, saved details and fresh Quote, lost session-create response,
offline/reconnect without automatic replay, identical session key/body recovery, PaymentIntent
response loss, identical tip key/body recovery after SPA remount, canonical total, ephemeral
handoff, secure component mount/destroy and confirmation-pending display. Synthetic SDK
success never becomes Paid. No client secret in DOM or transaction Web Storage.

Found and fixed a real reconnect bug in session-controller: offline before any session plan
left the controller in offline after reconnect, preventing Checkout UI continuation. It now
returns to idle without sending any request. Also fenced StripeCardForm asynchronous submit
by current mounted SDK identity; offline/unmount during pending element validation cannot
continue confirmPayment. Synchronous flight guard prevents duplicate confirmation; loaderror
revokes ready state. Browser fixture deliberately pauses submit, disconnects/destroys the form,
resolves the stale submit and proves zero confirmations before an explicit fresh readiness
retry. The final valid submit confirms once and destroys the form.

Evidence: six desktop/mobile Quote/details/session/payment continuity scenarios PASS13.9s
(/tmp/bop-wp2402-checkout-payment-browser.log). Later SDK extension initially failed because
the synthetic fixture returned AlreadyCreated with HTTP202; the strict production client
correctly rejected it. Corrected fixture to HTTP200; the final two affected desktop/mobile
card scenarios PASS8.1s (/tmp/bop-wp2402-secure-card-browser.log), including in-flight offline.
Session controller2 PASS301ms; Stripe credential SSR1 PASS242ms; PWA lint/typecheck PASS.
Browser runner built the current PWA successfully. Unchanged non-payment browser scenarios
retain their six-scenario run evidence, not relabeled as fresh after the SDK extension.
Test-only public key and reserved .invalid sanitizer target are scoped to Playwright preview
environment. HTTP/SDK responses are intercepted synthetic evidence; this does not prove real
Stripe iframe, 3DS, payment capture, sanitizer deployment or Store operation.

Next required delivery remains authoritative server payment-result/reconciliation integration,
then actual Order progression and complete Store pilot journeys. Full refresh recovery and
actual external Provider/Store readiness remain open. No deployment or Provider action taken.

### Terminal persistence composition plan

Payment owns the terminal fact, provider observation and intent/attempt source. Existing
1400_003 and 1400_005 already define append-only terminal facts and allow ProviderRetrieval;
no migration change is needed for the source adapter. First implement
payment-terminal-source.ts in Payment persistence and export it through the public module.
The adapter resolves current scoped intent/attempt plus the exact persisted normalized
observation, with explicit configured internal Provider account and environment. Caller
supplied intent/status/amount/digest cannot replace persisted evidence. VerifiedWebhook
additionally requires the matching durable receipt. Raw credentials/Provider payloads never
enter this contract. Commit adapter will then atomically write terminal fact/Audit/Outbox;
customer result must wait for that durable fact, not a browser result.

Affected checks: Payment types/lint, actual existing terminal database acceptance extended
to invoke this source, architecture/manifest checks for added owner reads. Existing migration
and install inputs unchanged; no full regression until the composed terminal-to-Order journey.

### Terminal source adapter evidence

Implemented/exported createPostgresPaymentTerminalSource. Reads only Payment-owned intent,
attempt, normalized provider observation and (for VerifiedWebhook) matching durable receipt.
Explicit configured internal account and environment; exact Store, intent, attempt, observation,
Provider intent, timestamp, digest and captured amount binding. ProviderRetrieval does not
invent a webhook receipt. Uses the supplied transaction runner and Store RLS context.
No migration or Provider call, and no terminal write or customer success claim in this adapter.

Extended existing actual PostgreSQL terminal acceptance to call the adapter: positive verified
receipt and retrieval paths, rejection of changed amount, Brand/Store, account/environment,
attempt/observation, Provider intent, timestamp/digest and receipt/event. PASS14.04s, database
test11.41s (/tmp/bop-wp2402-terminal-source-db.log), also retaining original append-only/unique
terminal checks. These are real database calls with explicitly synthetic payment records.

Payment tsc/lint PASS. Database ownership initially rejected the unregistered asset. Added
an exact owner/schema/path/table-set allowance in tooling/database-ownership/validate.mjs
with eight corresponding positive/negative/driver-boundary tests; 490 tests and repository
validator PASS. Domain boundary57 and import boundary22 tests PASS. One attempted text edit
failed before mutation and caused an unnecessary repeated ownership run; no success was
claimed from either failing repository-validator run. Future dependent commands must remain
conditional on successful mutation. No blanket allow-list or validation bypass introduced.

Outstanding next: actual atomic terminal fact/Audit/Outbox commit adapter, current customer
result authorization/HTTP and PWA result read, Provider reconciliation wiring and Order event
consumption. Prior browser/DB slices do not prove these unfinished requirements.

### Terminal atomic commit implementation scope

Add payment-terminal-store.ts as Payment owner persistence using the existing terminal table,
PaymentTerminalService and BOP appendAuditRecordInTransaction/appendEventInTransaction.
Serialize on scoped PaymentIntent, re-resolve normalized immutable source in that same
transaction, enforce fact/event/audit correlation and scope, return the original fact on exact
replay, and reject conflicting terminal observations. Expose scoped read for later authorized
result composition. No direct foreign-table SQL or migration changes. Extend existing real
PostgreSQL acceptance with actual service/store concurrency, response-loss recovery, injected
audit/outbox rollback, source mismatch and unchanged fact/event identity. Register this exact
asset and owner reads/writes in existing manifests and boundary rules.

### Terminal atomic commit evidence

Implemented/exported createPostgresPaymentTerminalStore with scoped terminal read and atomic
commit. Parses the fact and exact public terminal envelope, verifies minimal restricted Audit
and operation correlation, serializes same-intent writers, re-resolves the exact immutable
Payment source inside the transaction, writes append-only terminal fact, BOP Audit and BOP
Outbox, then reads back the original fact. Same observation replay returns original transaction,
event and timestamps; conflicting observations return Conflict and service rejects them.
Source account/environment and Store scope remain explicit; no direct foreign-table SQL.

Actual PostgreSQL test runs service + source + store under a NOSUPERUSER/NOBYPASSRLS role.
Concurrent duplicate service calls produce one Created and one AlreadyCommitted with identical
facts and one fact/Audit/event. Cross-Store read returns null. Injected Audit or Outbox failures
leave zero facts/Audits/events, followed by successful retry. Lost commit acknowledgement is
reported unavailable; subsequent read and retry recover the exact original fact, with no second
Audit/event. Failed payment also writes a PaymentFailed event and null captured amount.
PASS13.88s (database test11.51s), /tmp/bop-wp2402-terminal-atomic-db.log. Filter skipped the older
source/table scenario because it already passed11.26s in this turn's first run; only the new
test had failed to start due to an overlong caseId, corrected to wp2402_terminal.

Payment tsc/lint PASS; terminal event8 PASS2.31s. Database ownership499 + repository validator,
domain boundary57 + validator, import boundary22 + validator PASS. The new exact persistence
allowance includes owner/schema/path/all source tables and terminal table; no generic bypass.
Build command equals the successful Payment tsc typecheck command. Existing frozen-install
evidence remains valid: manifests/lockfile/toolchain unchanged. No migration or live Provider
call. Full customer result composition, normalized retrieval/webhook pipeline and Order event
consumption remain next requirements, not proven by these store tests.

### Customer payment result composition scope

Add customer-session-payment-result.ts in API composition using current CheckoutSession
authorization, Payment public creation history and the actual terminal store read. Bind
operation/submission/Guest/Brand/Store/Cart/version/Quote before terminal access, and bind
terminal event intent/attempt/order/amount/correlation before projection. Reauthorize the exact
session after all reads. Report Succeeded/Failed only from persisted terminal event; missing
terminal stays Pending or Unknown. No Provider call, mutation, expiry-based inferred failure
or owner-capacity release. Canonical scoped HTTP/PWA consumers follow this composition.
Affected tests cover permission replacement, forged cross-session source/event, amount mismatch,
pending creation and missing terminal; types/lint and existing API tests as needed.

### Customer result HTTP and runtime integration

Added GET /api/v1/checkout-sessions/:checkout_session_id/payment-result, runtime factory and
server option plus safe route template. Current Guest cookie, CSRF and same-origin Fetch
Metadata required; Origin, if present, must match. No query/body accepted. Closed no-store/
no-referrer output contains only session/PaymentIntent/Order references, state and exact CAD
requested total. No Provider identifiers, credentials or raw observations. Missing runtime
configuration remains503; current permission denial404. Null creation is Pending with no
references/amount. A persisted Succeeded/Failed event must match current owner history and
original operation, intent, attempt, Order, Store and captured amount. Reauthorization after
reads withholds stale access. No capacity-expiry inference or Provider call.

API focused result composition4/HTTP4/server6 PASS3.85s, then API54 files816 tests PASS9.16s
(/tmp/bop-wp2402-payment-result-api.log), lint/typecheck/build PASS. OpenAPI generated from
the closed discriminated response, schema/reference check and contracts tsc PASS. Tests use
actual Express transport and domain parsers with synthetic mocked session/owner reads;
composed actual PostgreSQL result HTTP is still required. Prior terminal store DB evidence
proves its source/atomic persistence separately, not this whole result chain. Final review
retains the domain terminal time rules without adding a new Provider-clock ordering rule.

Next: connect the PWA result route and explicit current-result refresh, then exercise the real
database HTTP chain, normalized Provider retrieval/webhook ingestion and Order consumption.
No live Provider/Store readiness, refresh recovery or pilot completion is claimed.

### PWA authoritative result delivery plan

Implement a no-store current-CSRF GET result client, an in-memory result controller tied to
the exact existing checkout session, and CUST-CHECKOUT-RESULT rendering. SDK submission
navigates to the clean result route and clears the secure form. Only a validated server result
can show confirmed/failed. Pending/unknown supports explicit refresh; offline revokes in-flight
responses and never auto-replays. Missing page-memory context fails closed rather than trusting
callback query claims. Full reload/redirect recovery remains a separate outstanding dependency.
Affected evidence: client/controller tests and existing desktop/narrow checkout browser journey
extended through result Pending, offline, explicit refresh and success. No backend change.

### PWA result page evidence

Added session-payment-result-client/controller and SessionPaymentResultPage. Default result
route now uses current session GET; legacy injected controller remains only for existing tests.
SDK submission clears secret and replaces route with /checkout/result. Server Pending/Unknown
supports explicit status refresh, Succeeded displays paid amount and Order-status link, Failed
offers safe Store help. Offline removes the result and invalidates in-flight responses; reconnect
does not send a request. Context replacement/missing context denies or requires Store help.
No URL claim, browser SDK success, local storage or automatic mutation/replay determines state.

Fresh PWA typecheck/lint PASS; 47 files734 tests PASS1.74s
(/tmp/bop-wp2402-result-pwa-tests.log), including five result client/controller tests for closed
responses, int64, current CSRF, deduplication, stale in-flight offline response and missing
session. Browser built current PWA and tested desktop/narrow touch Pending -> offline ->
explicit read -> Succeeded, same PaymentIntent request identity and no repeated create:
two PASS11.3s (/tmp/bop-wp2402-result-browser.log). Added separate Failed + full reload with
?paid=true: two PASS8.4s (/tmp/bop-wp2402-result-failure-browser.log), no success inference or
additional payment/read calls with missing context. Final fixture lint and diff check PASS.
No source changed after passing application checks; later fixture edits only added failure
branch, whose separate browser run is recorded. Existing frozen install remains valid.

These browser journeys use synthetic HTTP and SDK responses; they prove UI wiring and
state boundaries, not actual Stripe/3DS or the composed PostgreSQL HTTP chain. Real redirect/
reload recovery still cannot restore in-memory session and remains unfinished. Next required:
composed database result HTTP, normalized Provider observations/terminal recording, Order
consumption and actual single-Store operator journey. Pilot readiness remains unproven.

### Follow-up Provider observation persistence

The creation store intentionally permits only the first Provider observation; do not weaken its
idempotency rule for reconciliation. Add a separate Payment-owned append-snapshot adapter,
using the existing observation table, exact operation/attempt/Provider intent/amount binding,
same-operation transaction lock and caller-stable observation reference. Exact replay is
idempotent, conflicting identity/payload is rejected, and no raw Provider payload is stored.
No new migration. Extend the real Dining/Pickup submission helper through normalized captured
snapshot, terminal service/store and result HTTP; require Pending before terminal commit and
Succeeded only after it. Actual Stripe response is synthetic; all owner/HTTP/DB plumbing is real.

### Composed database payment-result evidence

At baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus the current WP-2402
uncommitted implementation, both existing composition commands completed successfully:
pnpm exec vitest run --config packages/database/vitest.pickup-checkout-composition.config.ts
(two tests, 78.71s; /tmp/bop-wp2402-result-pickup-db.log), and
pnpm exec vitest run --config packages/database/vitest.dining-order-submission.config.ts
(two tests, 106.35s; /tmp/bop-wp2402-result-dining-db.log). Existing running sessions were
resumed to completion; no additional rerun was launched to collect these results.

The shared submission helper now exercises actual PostgreSQL owner state, append-only
normalized Provider observation persistence, exact replay/conflicting observation identity,
terminal service/source/store with atomic Audit and PaymentSucceeded Outbox, and the real
Express customer-result GET. Result remains Pending after the captured snapshot alone and
becomes Succeeded only after terminal commit. Repeated terminal recording retains the original
fact; wrong current Guest CSRF cannot read it. Both Quote configurations run for each mode.

The earlier executions reached these new assertions but failed an older total-Outbox count:
the chain now correctly adds PaymentSucceeded alongside OrderCreated. The existing order
assertion was scoped to OrderCreated; the helper independently requires exactly one
PaymentSucceeded. The successful executions above include that correction.

Provider responses and Provider account identity are synthetic fixtures. This evidence does
not establish actual Stripe access, webhook/reconciliation ingestion, Ordering consumption,
merchant/Kitchen fulfillment, redirect recovery, or Store pilot readiness. No new migration,
external operation, or complete repository regression was performed in this evidence step.
The next implementation must connect normalized reconciliation retrieval to durable observation
recording and the terminal source, then consume authoritative payment events through Ordering's
public outcome contract and transaction-bound persistence. Do not infer Order confirmation
from customer payment-result success.

### Reconciliation live-call clock correction plan

Before wiring actual retrieval, fix payment-reconciliation-service.ts to measure operational
check time after Provider retrieval and run completion after all candidate work. Reject local
clock regression and cross-environment outcomes. Existing authorization, lease, financial
classification and terminal port remain unchanged. Update payment-reconciliation.test.ts with
advancing-clock, future-observation, regressing-clock and environment mismatch cases. Required
checks: focused reconciliation suite, Payment typecheck/lint and affected formatting. No schema
change or full repository regression for this local application-service correction.

### Reconciliation clock correction evidence

Updated the existing Payment reconciliation service to read operational checkedAt after
retrieval, reject a clock earlier than the pre-call instant, bind outcome environment to the
candidate, and obtain completedAt after candidate processing. Added four behavior cases:
observation arriving during retrieval, future observation, regressing clock and Live-for-Test
response. Focused existing reconciliation suite: 14 tests PASS (2.34s, session output
c8f16b). Payment typecheck PASS (42d36a); Payment lint, both changed TypeScript files'
Prettier check and git diff --check PASS (0d9100). Build uses the exact same tsc command
as this fresh typecheck; no second identical compiler run was performed.

Evidence applies to baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus the existing
WP-2402 working changes and this service/test correction. No dependency, schema, SQL,
public port signature or external environment was changed by this correction. Earlier
database evidence remains about its recorded composition; these unit tests do not prove
durable reconciliation ingestion or Order consumption. Those implementation tasks remain.

### Reconciliation observation port plan

Add a required Payment-owned observations.record port to the existing reconciliation service.
Before terminal healing, persist the exact normalized snapshot with explicit PaymentIntent and
caller observation identity; terminal recording must use the acknowledged same identity.
Failure or mismatched acknowledgement stops terminal recording and run completion. The port
preserves the retrieval run context; a persistence composition must resolve the original Payment
operation through owner history rather than treating the run ID as the creation operation.
Affected files: reconciliation ports, service and existing unit tests. No foreign table access
or schema change. Run the focused suite and Payment typecheck/lint/format checks.

### Reconciliation observation prerequisite evidence

The required observations.record port now receives the normalized retrieval snapshot, exact
PaymentIntent and generated observation reference before terminal.record. It must acknowledge
Recorded/AlreadyRecorded with the same reference. Storage failure or identity mismatch aborts
healing, does not commit the run, and releases the lease. Existing successful terminal test
asserts observation persistence precedes terminal recording; two new cases cover failed and
mismatched acknowledgements. Focused suite: 16 PASS, 2.33s (da270a). Payment typecheck and
lint completed without diagnostics (da270a/d12874). Prettier initially reported only the new
parameterized test's layout; targeted Prettier write fixed it, and diff check passed. No behavior
changed after the successful checks.

This is an application port prerequisite, not a claim that PostgreSQL reconciliation is wired.
The append store resolves original creation operation while retrieval context contains the
reconciliation run ID. The next Payment-owned composition must resolve original operation from
the exact intent/attempt and preserve this distinction. Do not pass the run ID to creation
history or mark actual reconciliation ingestion complete from these mocked-port tests.

### PostgreSQL reconciliation observation binding plan

Extend the existing Payment observation store with record, satisfying the reconciliation port.
Within the scoped transaction, resolve original operation by exact intent, attempt, environment,
Brand and Store; append via the existing same-transaction operation-lock path. Retrieval context
run identity remains with the caller/terminal causation; only owner storage binding uses original
operation. No schema or ownership asset expansion. Extend the actual submission DB helper with
a distinct retrieval run ID, exact replay and wrong-intent rejection. Required evidence: affected
Payment static checks, existing ownership validator and the Pickup/Dining composition commands.

### PostgreSQL reconciliation observation implementation

The existing observation store now exposes record with exact intent/attempt/environment and
Brand/Store resolution to original payment_operation_id. Its bound append runs inside the same
transaction through the existing operation lock, amount/Provider identity checks and replay
logic. It returns only status and the acknowledged observation reference to the reconciliation
port. No migration, new table, foreign owner access or external Provider call was added.

The actual shared database fixture now records capture through this entry with a distinct
retrieval run context, rejects a wrong PaymentIntent, repeats the exact observation successfully,
and continues through the existing terminal/result assertions. Pickup two variants PASS77.57s
(/tmp/bop-wp2402-reconciliation-pickup-checkout.log). Payment typecheck, affected ESLint,
Prettier write, repository database ownership validator and diff check passed. Initial Dining
command mistakenly named a nonexistent composition config and exited before tests; corrected
to existing vitest.dining-order-submission.config.ts. Its current numeric session is 76243,
log /tmp/bop-wp2402-reconciliation-dining.log; completion is not yet claimed here.
The reconciliation scheduler/candidate/run persistence and full service composition still remain.

Dining observation-binding completion: session76243 exited0; two tests PASS104.73s,
log /tmp/bop-wp2402-reconciliation-dining.log. Both mode compositions now cover the new
record entry. Next extend the shared fixture to call the actual reconciliation service with
the real observations and terminal ports. Authorization, lease, candidate selection and run
repository remain explicitly synthetic fixture ports; do not claim their persistence.

### Actual reconciliation-service composition evidence in progress

The shared DB fixture now invokes createPaymentReconciliationService with the real observation
store and terminal service/source/store. It verifies Healed and the persisted customer result,
then terminal replay; synthetic ports are explicitly retained for authorization, lease,
candidate selection, Provider retrieval and run repository. Thus this proves orchestration
through actual financial persistence, not real Provider access or scheduler/run persistence.

Pickup two tests PASS78.64s (/tmp/bop-wp2402-reconciliation-service-pickup.log).
Dining configured=false PASS54.89s; configured=true failed with isolated DB ECONNREFUSED
before completing its business assertions (/tmp/bop-wp2402-reconciliation-service-dining.log).
Only configured=true is being retried using the same existing config and -t configured=true;
do not repeat the three passing variants. Fixture Prettier, ESLint and diff check passed.

### Reconciliation composition completion and Ordering persistence scope

The only failed Dining variant was retried through the original config with -t configured=true:
one PASS53.77s, the already-passed variant intentionally skipped; session85302 exited0,
log /tmp/bop-wp2402-reconciliation-service-dining-retry.log. Together with the preceding run
and Pickup's two passing variants, all four cover the exact unchanged service-composition
fixture. The isolated ECONNREFUSED failure is retained in prior evidence; no business code
was changed to bypass it. These runs still use synthetic scheduler/candidates/run repository
and Provider retrieval, with actual observation and terminal persistence plus result HTTP.

Ordering inspection found no payment outcome persistence adapter or outcome table in current
1300 migrations. order_header in 1300_007 deliberately stores only immutable initial
Submitted/Open/NotReported/version1. Existing order-payment-outcome-consumer-service already
requires exact source disposition and a transaction-bound outcomes port; AwaitingAcceptance
must retry, Confirmed alone may append OrderConfirmed, and PaidWithoutFulfillableOrder blocks
Kitchen release. Existing OrderAcceptanceEvidence with TerminalAuthorization is not evidence
of OnlineCard merchant acceptance and must not be repurposed as such.

Next bounded implementation under WP-2402:

- Resolve the existing order-payment-outcome contract's exact fields into an additive Ordering
  payment outcome/failure record migration (next free 1300 slot, recheck before creation).
  Keep initial submission history intact; scope keys to Brand/Store/Order and source event,
  preserve event identity/digest and distinguish Confirmed from paid-unfulfillable disposition.
- Implement order-payment-outcome-store.ts against those owner tables using the existing
  ConsumerTransaction. Inbox, outcome, Audit and optional OrderConfirmed Outbox must commit
  together; exact replay returns original effect, conflicting event identity rejects.
- Resolve authoritative acceptance/fulfillability source through public owner contracts and
  current owner fences. Do not manufacture OnlineCard acceptance, suppress paid-but-unfulfillable
  compensation, or read Payment/Inventory/Dining private tables.
- Add exact database ownership manifest/validator coverage and actual PostgreSQL acceptance
  for scope, replay, rollback and confirmed-versus-blocked Kitchen event behavior. Name actual
  existing migration/integration commands after reading the target harness. The full journey
  regression milestone from this WP remains required once composition is ready.

No Ordering migration or source change has yet been made for this plan. The next action is
resolve acceptance/fulfillability source and transaction adapter before implementing its writer.

### Ordering source transaction binding prerequisite

WP-1310 requires exact source disposition and caller-owned atomic Inbox/outcome transaction.
Extend OrderPaymentOutcomeConsumerPorts.source.loadExact with the existing ConsumerTransaction,
and pass the same transaction from processAuthorized. This enables an owner persistence source
to lock/revalidate current Order facts through the same transaction used for the effect.
Update the existing confirmation/replay test to prove source and successful writer receive the
identical transaction. No business acceptance policy, schema or event payload changes here.
DEC-H04 is still marked Proposal in customer-order-payment-handoffs.md; do not fabricate a
production acceptance source from TerminalAuthorization evidence or payment success.
Checks: existing order-payment-outcome test, Ordering typecheck/lint, affected formatting.

Ordering source transaction prerequisite evidence: existing payment-outcome suite11 PASS1.89s
(fa50a0), now asserting source lookup and successful effect commit receive the same transaction.
Ordering typecheck PASS84ba23; lint, three affected-file Prettier checks and diff check PASS7361f4.
No implementation changes followed these checks. These are application-port tests, not proof
of database lock behavior; actual migration/store and current acceptance source remain required.
The existing compiler command is identical for build/typecheck, so no duplicate compiler run.

### Order policy source reconciliation

Scoped local Handoff read establishes existing Section24 rules for configurable channel/order-type
payment prerequisites, Brand-authorized Store overrides, cancellation phase boundaries and
close/reopen finality. Updated customer-order-payment-handoffs.md to separate these source rules
from proposed producer/concurrency mechanics. This does not accept the local0.5.9 file as a
new baseline or select a Store policy. Earlier notes that DEC-H04 is proposed must not cause
reapproval of already defined rules. Next resolve actual published Workflow policy and accepted
Section88 permissions, then implement decision/outcome persistence with the existing consumer
transaction. No Store facts, automatic acceptance choice or new permission was invented.

### Ordering PaymentFailed persistence schema plan

Add 1300_021_create_order_payment_failure.sql and register order_payment_failure_record in
Ordering's database-access manifest. The append-only record stores the existing closed
OrderPaymentFailureRecord contract, unique source Payment event and financial transaction,
scope-bound Order FK, bounded reason/retry enums, exact digest and millisecond UTC terminal
instant. Enable and force Store RLS, revoke PUBLIC access, and preserve initial order_header.
No confirmation, cancellation, refund or Kitchen event follows this record by implication.
First validate migration catalog and ownership; actual writer/Inbox/Audit rollback and real
DB acceptance are required before claiming this schema delivers failed-payment consumption.

PaymentFailed schema registration evidence: initial migration:check ran106 tests,105 passed
and exact catalog list failed because the newly added133rd migration was not yet listed.
The standalone ownership validator also found the missing module.manifest.ts table declaration.
Added both exact registrations; targeted catalog test passed632ms with96 unchanged cases
intentionally skipped, node packages/database/src/check.ts reports133 valid migrations, and
database ownership validator passes (5f5838). No validator was weakened. Affected TypeScript
Prettier write and diff check passed. The initial composite command did not pass and is not
reported as a successful full rerun. Actual database application, writer and failure/replay/
scope/rollback acceptance are still pending. Earlier132-migration DB evidence is historical
and cannot establish this new table's behavior.

### PaymentFailed persistence adapter implementation started

Started order-payment-failure-store.ts with a scoped caller-transaction history reader using
the existing record parser. The writer, Audit and replay/conflict transaction path are still
required. This source is not exported or wired yet; database access registration and boundary
checks must be completed alongside the writer before readiness is claimed.

### PaymentFailed writer and boundary implementation

Added commitFailed to the owner adapter and exported its factory. It binds the parsed failure
to PaymentFailed event identities, reason/time/retry and canonical digest; scoped event lock
serializes replay, which retains the original record reference. It appends a strictly scoped
System Order Audit with minimal PaymentFailed summary in the same caller transaction as INSERT.
It exposes only failure read/write ports; success handling is not stubbed. Exact database access
declarations and owner/schema/table/path allowance were registered; direct pg imports remain
prohibited. Ordering typecheck/lint and repository ownership validation passed (4d44a2/af3f4b).
Five new boundary cases PASS973ms (/tmp/bop-wp2402-order-failure-boundary.log); initial missing-
table fixture failed due to absent directory, corrected fixture setup before successful run.
Actual database application, Inbox integration, Audit rollback, parallel replay and event mismatch
behavior remain unverified and are the next required implementation/acceptance work.

### PaymentFailed actual database acceptance plan

Add dedicated existing-harness test/config order-payment-failure-acceptance and
vitest.order-payment-failure.config.ts. Synthetic Order/event fixtures, actual133-migration DB,
non-superuser forced RLS, real owner adapter and Audit: parallel duplicate retains original,
cross-Store read null, mismatched event rejected, injected Audit failure rolls back record,
retry succeeds with exactly two records/Audits. Run pnpm exec vitest run --config
packages/database/vitest.order-payment-failure.config.ts. This is failure persistence proof;
Inbox integration and successful disposition remain separate outstanding work.

### PaymentFailed database persistence evidence

Dedicated actual PostgreSQL test PASS13.16s (/tmp/bop-wp2402-order-failure-db.log; session75916
exit0). The harness applied current133 migrations. Non-superuser/NOBYPASSRLS writes prove:
two concurrent same-event attempts retain one original failure record; Store mismatch reads
null; changed event-bound reason rejects; injected Audit INSERT failure rolls back the failure
record; retry succeeds; final two distinct financial events yield exactly two failure records
and two Audit records. Order/event fixtures are synthetic. Initial launch used an overlong
caseId and was rejected before database setup; shortening to existing harness rules fixed it.
Affected fixture/config ESLint and diff check PASScc81d3; Prettier formatted before execution.

This evidence covers the failure repository and real Audit transactions, not consumer Inbox,
actual Payment event dispatch, successful confirmation/compensation source or end-user workflow.
Next compose the real Ordering consumer with this failure branch in the same transaction and
prove Inbox/record/Audit rollback and recovery without a synthetic success writer invocation.

### Real failure consumer composition plan

Extend the same dedicated DB test through createOrderPaymentOutcomeConsumerService and
real platform_eventing.consumer_inbox. Under the scoped non-superuser transaction, injected
Audit failure must leave no Inbox or failure record; retry processes once and duplicate returns
the original result. Confirmation source/success writer fixture ports throw if called; they are
not success implementations. Run only the dedicated failure DB config plus affected fixture lint.

### Real failure consumer composition evidence

Dedicated133-migration PostgreSQL acceptance PASS12.63s
(/tmp/bop-wp2402-order-failure-consumer-db.log; session52891 exit0). The test now runs
the actual Ordering payment-outcome consumer and real BOP Inbox with the failure store and
Audit. Injected Audit failure rolls back both Inbox and failure record; retry returns processed,
duplicate returns duplicate_completed and the identical original failure result. Final counts
are one Inbox for the consumer event and three distinct failure/Audit records including the
earlier repository cases. Confirmation source and success writer are never invoked.
Affected fixture ESLint and diff check PASS93cdb7.

Scope remains synthetic authorized PaymentFailed events in isolated DB. Actual Payment Outbox
dispatch/runtime registration, successful acceptance/confirmation or unfulfillable compensation,
merchant/Kitchen/fulfillment and external pilot conditions remain outstanding. No full-regression
or real Provider claim follows this failure-path evidence.

### Successful-payment disposition schema

Added1300_022_create_order_payment_disposition.sql for the existing Confirmed or
PaidWithoutFulfillableOrder union, with scoped event/transaction exclusivity, exact Order/
Batch/Submission FKs, source version/checkpoint/digest, confirmation event identity or blocked
reason. AwaitingAcceptance is not a final stored disposition. RLS and append-only protections
follow existing Ordering migrations. Registered module ownership, table governance and exact
catalog entry. No Store acceptance policy or new runtime writer is implied. Validate catalog
and ownership; actual successful writer/Audit/Outbox and DB acceptance remain next.

Disposition schema evidence: pnpm migration:check PASS106 tests17.39s and catalog reports134
migrations (/tmp/bop-wp2402-disposition-migration.log). Repository database ownership validator
PASS7bd5ae; affected formatting and diff check passed. This is catalog/ownership validation,
not actual DB constraint or event emission evidence. Next writer must additionally verify exact
Batch-to-Submission pairing through owner history, bind source event/digest and record the
original OrderConfirmed envelope with Audit/Outbox/Inbox atomically. No134-migration DB
acceptance is claimed yet; prior133-migration evidence remains historical.

### Disposition reader implementation

Implement order-payment-disposition-store.ts beginning with exact scoped history decoding.
Reconstruct the original OrderConfirmed envelope from persisted event reference/correlation
and canonical disposition fields, not a new generated event. Return no event for blocked
unfulfillable records. No acceptance is inferred from this reader. Writer, source revalidation,
Audit/Outbox transaction and database acceptance remain required before runtime integration.

Disposition reader progress: scoped SQL decodes the closed disposition and reconstructs the
original confirmed envelope using stored event/correlation identities; blocked disposition
returns no OrderConfirmed event. Ordering typecheck PASS5c3f9e. Exact read asset registration
and five boundary cases PASS1.00s (/tmp/bop-wp2402-disposition-boundary.log), repository
ownership and diff check pass69010a. Reader is not yet exported/runtime-composed. Actual
reader DB replay evidence and the successful writer/source validation/Audit/Outbox remain
required; these static/boundary results do not establish confirmation or Kitchen release.

### Disposition writer implementation

Add commitSucceeded to the same owner adapter and export its factory. Bind exact Payment event/
disposition digest and canonical confirmation envelope; reject AwaitingAcceptance as a final
write and prohibit an event for paid-unfulfillable. Scoped transaction lock serializes financial
transaction disposition; original replay retains original event identity. Verify exact owner
Batch/Submission pairing, append minimal scoped System Audit and optional OrderConfirmed
Outbox through BOP helpers in the same caller transaction. Current acceptance/fulfillability
source remains the caller's required same-transaction fence, not inferred by this repository.
Affected static/ownership checks followed by actual confirmation/blocked/rollback DB acceptance.

Disposition writer static evidence: initial typecheck found two unbranded event-ID arguments;
replaced them with the already parsed disposition event reference. Ordering typecheck then
PASS4bc485. Initial lint found unused destructured names in replay comparison/column mapping;
replaced with explicit field filtering/omitted binding, affected-file lint/Prettier/diff check
PASS3a29b2. Repository database ownership validator passedb94fd6. No runtime/DB claim yet.
Actual134-migration DB tests must prove confirmation event reconstruction, branch exclusivity,
Batch/Submission mismatch denial, duplicate original event, and Audit/Outbox/Inbox rollback.
Current policy-source authorization/fence remains a composition dependency.

### Actual disposition database acceptance plan

Extend the existing dedicated failure database harness with synthetic exact Order/Batch/Submission
and PaymentSucceeded/disposition sources, actual disposition store/Audit/Outbox. Prove original
confirmation event replay, blocked branch without event, Audit and Outbox injected rollback then
retry, exact disposition/event counts. This validates repository composition, not current policy
acceptance source or actual provider. Run same dedicated config; no full success journey rerun.

### Actual disposition repository evidence

The dedicated134-migration PostgreSQL test PASS13.60s
(/tmp/bop-wp2402-order-disposition-db.log; session32830 exit0). Actual scoped writer/
reader and BOP Audit/Outbox preserve original confirmation event on retry with a newly generated
candidate event ID. PaidWithoutFulfillableOrder stores no confirmation event. Injected Audit
and Outbox failures each leave no disposition, then retry succeeds. Four distinct disposition
rows produce exactly three OrderConfirmed Outbox events, while earlier failure/Inbox cases
remain covered in the same run. Fixture lint and diff check passed.

Synthetic Payment and acceptance-source fixtures are explicit; this is not a live provider/
merchant decision. Still required: competing confirmed-versus-blocked decisions for one payment,
Batch/Submission mismatch and Store denial cases, actual successful consumer Inbox composition,
current published policy source and complete runtime dispatch/Kitchen workflow.

### Successful consumer and conflict acceptance plan

Extend the same134-migration dedicated DB test with competing Confirmed/blocked transactions
for one Payment event (exactly one outcome, event only if confirmed), digest-valid wrong
Submission rejection, cross-Store read denial, and actual success consumer Inbox/Outbox
rollback/retry/original replay. Source disposition remains an explicitly synthetic same-
transaction port. Run the same dedicated config once for this combined set.

### Successful consumer and conflict evidence

Dedicated134-migration PostgreSQL test PASS13.66s
(/tmp/bop-wp2402-order-success-consumer-db.log; session11927 exit0). Concurrent Confirmed
and paid-unfulfillable for the same source event/financial transaction produce exactly one
committed disposition; Outbox count follows only the winning confirmed branch. Digest-valid
wrong Submission rejects and cross-Store reader returns null. Actual successful Ordering
consumer plus real Inbox/store/Audit/Outbox rolls back on injected Outbox failure; retry returns
OrderConfirmed and duplicate_completed replay preserves original result with one causation-bound
confirmation event. Affected fixture ESLint and diff check PASS9413d7.

Source policy remains synthetic in this test. Next source implementation can use the existing
@bop/workflow evaluateWorkflowAction contract: resolve current versions, validate publication/
Brand-authorized Store override, authorize current resource and action, evaluate referenced
rules, and retain caller fences through commit. It evaluates intent only; an actual Ordering
acceptance decision and current capacity/Inventory authority still need producer/persistence.
Do not treat a Workflow return value as a reusable authorization or as an OrderConfirmed fact.

### Unified payment outcome repository

Add createPostgresOrderPaymentOutcomeStore to the existing owner adapter: complete success/
failure ports, shared source-event transaction lock, dual-history conflict detection and cross-
branch rejection before delegated writes. This replaces ad hoc runtime branch composition.
Audit factory receives explicit outcome to choose the existing branch-specific action code.
No new SQL table access beyond existing delegated owner readers/writers. Verify types/lint,
then use this public factory in the actual database consumer fixture.

Unified repository evidence: actual134-migration consumer/repository suite PASS14.43s
(/tmp/bop-wp2402-unified-outcome-db.log; session66174 exit0). The success consumer now uses
createPostgresOrderPaymentOutcomeStore rather than hand-written reader composition. Existing
confirmation/blocked race, scoped denial, original event replay and Audit/Outbox/Inbox rollback
cases remain passing. Ordering typecheck and adapter lint passedbf9ff0/8b1965; fixture lint,
repository ownership validation and diff check passedb72813. The dedicated simultaneous
success-versus-failure same-event conflict branch is not yet exercised by this test; it remains
required before claiming complete new-lock coverage. No actual Store policy or runtime event
dispatch was added by this composition.

### Actual Worker registry compatibility fix

Direct consume() tests bypass ConsumerRegistry. Actual Worker registration revealed same
ordering.payment-outcome:v1 is legitimately registered for PaymentSucceeded and PaymentFailed,
but registry keys solely by consumerName and rejects it. Ordering's prose sideEffect also
violates the registry's safe-code contract. Change registry to resolve consumer name plus
event type, still reject duplicate pairs and inconsistent owner/version/scope/ordering/replay
metadata for one consumer identity. Use a bounded safe sideEffect code for Ordering. Cover
both routing and duplicate rejection in existing Eventing tests, then actual Worker DB delivery.
This shared eventing change requires Eventing tests/types/lint/build and affected Worker tests.

### Worker registry and database delivery evidence

ConsumerRegistry now supports distinct event types for one consistent consumer identity,
retaining duplicate-pair and inconsistent identity rejection. Ordering uses a safe sideEffect
code. Eventing58 tests PASS360ms (/tmp/bop-wp2402-registry-tests.log), typecheck/lint/build
PASS124642/6ef0ae; Worker22 tests PASS635ms (/tmp/bop-wp2402-worker-registry-tests.log).
No Worker source was changed.

Actual134-migration DB suite now additionally proves unified success-versus-failure same-event
competition commits only one branch, and real ConsumerDeliveryWorker + actual registry accepts
both Ordering registrations and delivers a synthetic PaymentFailed once with duplicate recovery.
Initial Worker DB run returned retry_required because the fixture transaction entry omitted RLS
context before Inbox access; adding the supplied Brand/Store context there made the unchanged
consumer pass. Final run PASS14.15s (/tmp/bop-wp2402-worker-outcome-db-retry.log; session11426
exit0). Earlier failed log retained separately. Diff check passed.

This proves Worker delivery through the real registry/transaction interface, not a running
production Outbox scheduler or external transport. Actual configured transaction adapter,
source policy/acceptance producer, successful Worker delivery and complete Store operations
remain outstanding. Shared Eventing registry build is fresh; earlier consumers should be
considered for the next broader cross-domain milestone.

### Worker consumer transaction adapter plan

Add consumer-transaction.ts in Worker composition root with injected real connection acquisition.
Begin transaction, set local Brand/Store RLS before Inbox, invoke work and commit. Pre-commit
failure rolls back; COMMIT rejection is classified COMMIT_OUTCOME_UNKNOWN and discards connection
so ConsumerDeliveryWorker can recover against original Inbox in a fresh transaction. Never log
raw errors or pretend rollback proves a rejected COMMIT did not happen. Unit tests cover ordering,
invalid scope, rollback and unknown commit; real DB fixture will use this adapter next. Required
Worker lint/typecheck/test/build per local AGENTS; no queue/timer/provider simulation.

### Worker transaction adapter evidence

Worker26 tests PASS678ms (/tmp/bop-wp2402-consumer-transaction-tests.log), covering scope-before-
work, handler rollback, uncertain commit disposal/no false rollback claim and invalid scope.
Initial type/build failed implicit generic method parameters; explicit generic signature fixed
both (d439c2). Worker lint passed; final adapter/fixture ESLint and diff check PASS123d8a.

Actual134-migration DB/Worker suite PASS13.92s
(/tmp/bop-wp2402-worker-transaction-db.log; session80059 exit0). The real Worker uses the new
transaction adapter with actual non-superuser PostgreSQL connections. A query wrapper throws
after an actual COMMIT has succeeded; adapter discards that connection, Worker rereads original
Inbox using a new transaction and returns duplicate_completed. Only one failure record exists
for that event. Repeated delivery remains duplicate. Prior disposition/race/rollback cases pass.

Connection acquisition is injected, not a deployed pool/configuration. No production credentials,
scheduler, external transport or Store acceptance facts were supplied. Next progress should
connect actual accepted Workflow/Ordering source and the full payment-to-Kitchen runtime journey.

### Published acceptance Workflow composition plan

Add apps/api/src/order-acceptance-workflow.ts as a composition-only evaluator: parse the public
Ordering creation snapshot and Workflow request, bind exact Store/Order/OrderType/version/state,
then invoke actual Workflow evaluatePublishedAction through the caller transaction. Required
resource/action/rule and Store-override gates are caller-supplied owner capabilities, with no
allow defaults. Return the evaluated action only; it does not persist acceptance or emit
OrderConfirmed. Existing Ordering/Workflow public imports only. API required static/suite checks;
actual publication-backed database acceptance and acceptance decision writer remain next.

Acceptance Workflow composition progress: new API composition parses the public Order creation
record and Workflow request, rejects mismatched Brand/Store/resource/version/phase/OrderType,
and delegates actual published-action validation using the same transaction and required owner
gates. It returns evaluation only, not acceptance/confirmation. API typecheck/lint/build passed
1ca061/5b77d1 before adding the six mismatch tests; full API test command subsequently passed
(log /tmp/bop-wp2402-acceptance-workflow-api.log). The six tests prove rejection before policy
access, not a successful published action. Publication-backed DB proof, canonical acceptance
action binding and durable Ordering acceptance producer remain outstanding.

### Acceptance action binding

Constrain the existing API evaluator to a required server-owned action/purpose/permission
binding. Reject requests before policy access when action/purpose differ or observedAt predates
Order creation. Wrap the required owner action authorization to require Accepted as destination
and the configured permission; retain all publication/resource/rule gates in the same transaction.
This is composition routing, not a newly accepted permission or durable acceptance fact.
Affected files: order-acceptance-workflow.ts and its tests. Run API lint/typecheck/test/build and
targeted formatting; no migration or new dependency, so installation evidence remains reusable.

Acceptance binding implemented: server action/purpose equality and creation-time lower bound
reject before policy access; the selected transition must enter Accepted and match the server
permission before invoking owner authorization. No acceptance permission value is defaulted.
Initial typecheck rejected direct comparison of separately branded domain instants; comparing
their parsed UTC timestamps fixed it. Final targeted Prettier, API typecheck/lint/build PASS;
55 files / 825 tests PASS7.09s (/tmp/bop-wp2402-acceptance-binding-api.log, session74251 exit0).
The three new tests cover action/purpose/time rejection. Positive publication-backed acceptance
and destination/permission gate scenarios are still required; this test run does not prove them.
git diff --check passed before this evidence-only append. No acceptance write or pilot completion
is claimed. Next use the existing workflow-definition-acceptance publication fixture to exercise
this composition, then implement the Ordering-owned durable decision under current owner fences.

### Publication-backed acceptance composition cases

Extend existing workflow-definition-acceptance.test.mjs using its actual Publishing lifecycle,
approval and release plus Workflow version, adding Submitted transitions before snapshot creation.
Use a synthetic public Order record with matching fixture scope; owner authorization remains a
synthetic gate, explicitly not Store operator evidence. Exercise Accepted success, wrong configured
permission, wrong destination, owner denial and archived publication. Run this existing isolated
database config and targeted fixture lint/format. API source is unchanged from its passing run.

Publication-backed acceptance cases PASS: existing PostgreSQL suite (134 migrations) completed
in 14.44s, test body11.88s; /tmp/bop-wp2402-acceptance-publication-db.log, session7290 exit0.
Targeted fixture Prettier and ESLint passed before the run. Actual Publishing Draft/Review/
Approval/Publish records and Workflow version supply the publication gate. Accepted evaluation
succeeds; wrong server permission and a published Rejected destination stop before action/rule
callbacks; denied owner action stops rules; archived publication stops before authorization.
Callbacks assert the same caller transaction. Order snapshot and owner grants remain synthetic,
not operator or durable acceptance evidence. Existing publication-lock and inventory-source
cases also passed; no API source or dependency changed since the preceding API825 run.

Next-source inspection found application/order-acceptance.ts only parses a closed
TerminalAuthorization evidence record tied to paymentAttempt/checkpoint. It is not a general
merchant acceptance application service or producer and must not be reused as proof that online
payment or arbitrary merchant acceptance is implemented. Durable source work must separately
bind the Section24 current published OrderType policy and existing confirmation/disposition
contract, preserving terminal authorization semantics. No proposed DEC-H04/H05 business choice
has been silently accepted by these composition tests.

### Ordering acceptance history persistence plan

Add 1300_023_create_order_acceptance_record.sql under the existing Ordering namespace and exact
module/governance/catalog entries. Record permanent operation, scoped Order/Batch, expected and
resulting order version, actor/purpose/permission/reason, published Workflow version/transition,
source digest and accepted UTC instant. This separate history is not TerminalAuthorization
evidence, Payment status or OrderConfirmed. User/System identity is explicit; no permission,
automatic acceptance or payment eligibility default is introduced. Unique scoped operation and
Order/resulting-version reject duplicates/competing versions; current-source validation and
authorization still belong in the forthcoming same-transaction writer. Preserve append-only
history, forced Store RLS and no PUBLIC rights. No foreign private table reference.
Run migration:check and owner declaration validation for schema; extend the existing isolated
order-payment fixture to check actual constraints/RLS/history after implementation. These checks
do not establish the still-missing writer, accept/cancel serialization or operator authorization.

Acceptance table added with explicit scoped identity, policy provenance, actor and consecutive
version constraints. migration:check PASS106 tests17.77s and catalog135 migrations valid
(/tmp/bop-wp2402-acceptance-migration.log); owner declaration validator PASS
(/tmp/bop-wp2402-acceptance-ownership.log), session1926 exit0. This was the real declaration
validator, not a fresh full ownership regression suite.

Existing actual DB/Worker/payment-outcome suite extended and PASS13.76s, body11.60s
(/tmp/bop-wp2402-acceptance-schema-db.log, session59437 exit0), using135 migrations.
New synthetic SQL cases prove one of two competing acceptance versions commits, invalid version
increments/User-System identity reject, foreign Store read is empty/write is denied, and
UPDATE/DELETE preserve the original history. Targeted fixture formatting/ESLint and diff check
passed. Original payment failure/success disposition, Audit/Outbox rollback and Worker lost-ack
cases remain passing in this run.
These direct test inserts are schema evidence only. No general acceptance writer, current source
lock, policy authority or OrderConfirmed was supplied by them. Next implement the closed owner
record and authorized atomic acceptance+Audit writer, then compose with published policy and
current capacity/Inventory/Payment sources. No API/Worker source changed in this schema step.

### Atomic acceptance writer plan

Add a closed general OrderAcceptanceRecord contract separate from TerminalAuthorization and
createPostgresOrderAcceptanceStore in Ordering. Trusted configured Brand/Store, caller transaction,
mandatory current authorization on every call (including replay) and mandatory current source
validation before a new write. Serialize permanent operation then Order disposition; verify exact
Order/Batch and refuse an already accepted Batch under a different operation. Source gate must
hold current policy/capacity/Inventory/Payment/execution fences through the caller commit.
Return original record on exact-intent retry (generated acceptance ID/time may differ); changed
intent conflicts. Append acceptance and strictly bound Audit in the same transaction, no event.
Add exact owner asset allowance with negative boundary tests. Validate parsing, actual writer
replay, denied/stale source, Audit rollback and competing operations in existing isolated DB suite.
Required affected Ordering typecheck/lint/test and targeted boundary/static checks; reuse unchanged
135-migration catalog evidence. Runtime gate composition and other producer adoption of the same
Order lock remain pending and are not implied by the writer.

Atomic acceptance writer implemented with closed parser and mandatory authorize/current-source
gates. Operation then scoped Order lock, exact persisted Batch and submitted-at bound, current
source gate on new writes, no second operation accepting the same Batch, original retry result.
Audit strictly binds scope/User-System actor, Order, operation, reason, acceptedAt and minimal
Accepted summary. No Outbox event. Caller transaction owns rollback/commit and gate fences.

Actual135-migration DB suite PASS14.28s, body12.18s
(/tmp/bop-wp2402-acceptance-writer-db.log, session19710 exit0): denied authorization bypasses
source, stale source denies, injected Audit INSERT failure leaves no acceptance, concurrent same
operation returns Created/AlreadyCommitted and identical original record, one ORDER_ACCEPTED
Audit, regenerated time recovers original, changed permission or second operation conflicts,
revoked authorization blocks original replay. Owner source/permission callbacks are synthetic in
these tests. Subsequent raw schema tests are explicitly separate physical-constraint evidence.

Ordering lint and typecheck PASS; 64 files1315 tests PASS3.94s
(/tmp/bop-wp2402-acceptance-ordering.log). Its build script is the identical
tsc --project tsconfig.json command with unchanged inputs, so this typecheck execution also
covers that command; no second identical run. New parser15 cases cover immutable User/System
records, exact version/identity/code/hash/time/closed-shape and nonexecuted accessor rejection.
Targeted ownership6 cases PASS950ms (/tmp/bop-wp2402-acceptance-boundary.log),517 unrelated cases
not rerun; actual repository declaration validator PASS. Both depend on exact Ordering owner,
schema, acceptance+Batch tables and file path; direct driver import remains rejected.
Targeted formatting/ESLint and diff check passed. No new migration/dependency changes this turn.

Remaining: actual current source implementation and policy-to-writer composition, all execution
producers sharing the Order fence, durable current acceptance query for payment disposition,
full success-to-Kitchen runtime and Store operations. This adapter is not exposed as an HTTP
command and never treats a caller-supplied record as authorization on its own.

### Merchant published acceptance composition plan

Add apps/api/src/merchant-order-acceptance-composition.ts: use public Ordering creation reader
withCurrentSubmission bound to the writer transaction, then actual published acceptance Workflow
and mandatory eligibility owner gate. Build Workflow request from server tenant/action/purpose/
permission plus authorized User record; require exact Order/Batch/version, published version and
transition. Only User merchant acceptance is exposed by this composition; System policy requires
a separately bound actor capability, not a fake User. Original retries retain writer reauthorization
and original outcome. No HTTP route, default allow, foreign SQL or payment policy assumption.
Extend actual workflow DB fixture with complete synthetic persisted Order history, this composition,
denied eligibility and successful acceptance+Audit; preserve synthetic owner eligibility disclosure.
API required lint/typecheck/test/build; targeted fixture/static and existing Workflow DB config.

Merchant acceptance composition implemented. Server-bound action/purpose/permission and scoped
tenant feed Workflow request; only an authorized named User is accepted. It uses the real public
Order creation query withCurrentSubmission under the writer transaction, checks exact Order/Batch/
version, actual published Workflow and transition, then mandatory eligibility before acceptance
and Audit. Original replay still reauthorizes through writer; no re-evaluation renews acceptance.
Complete original history remains distinct from current execution eligibility, which the required
owner eligibility callback must establish. No API-private SQL or new HTTP route.

Actual135-migration Workflow DB suite PASS14.72s, body12.13s
(/tmp/bop-wp2402-merchant-acceptance-db.log, session78938 exit0). Reused established seed field
mapping in test-support/acceptance-order-history.mjs to persist full synthetic original Order/
Batch/items/number history. Actual public reader reconstructs items; actual published release
validates; denied eligibility or wrong transition leaves no acceptance; success writes one
ORDER_ACCEPTED Audit, retry returns original, revoked merchant authority blocks replay.
Eligibility/permission gates remain synthetic test inputs, not current Store/capacity/Inventory/
Payment evidence. Existing earlier publication archival/lock cases also pass.

API typecheck PASS(session72554); lint/build PASS; 55files825 tests PASS7.20s
(/tmp/bop-wp2402-merchant-acceptance-api.log, session94236 exit0). New composition behavior is
covered by the above DB suite, not counted as new API unit cases. Targeted Prettier/fixtureESLint
and final diff check pass. No migration/manifests/toolchain changed since valid135 catalog.
Next connect actual owner eligibility and durable acceptance query into Payment outcome source;
initial submission history alone must never stand in for current execution version/cancellation.

### Acceptance history source plan

Expose createPostgresOrderAcceptanceReader from the existing owner persistence file, with required
transaction-bound current read authorization and parsed exact configured scope/Order/Batch. Take
the same scoped Order disposition lock as the writer and return the one durable acceptance or
null; ambiguous multiple rows fail closed. This is historical acceptance, never current fulfillment
eligibility or a Payment confirmation. Bounded query, strict canonical reconstruction, no writes.
Extend existing DB suite for absent/present history, current denial, foreign scope and held Order
lock; preserve writer replay and rollback cases. No migration or asset path change. Run affected
Ordering checks and the existing isolated DB suite; reuse unchanged migration/ownership inputs.

Acceptance reader implemented in the existing owner adapter and exported publicly. It parses
configured scope/Order/Batch, requires current read authorization before history access, takes the
same scoped Order disposition lock via a shared internal helper, performs bounded exact query,
and reconstructs a closed canonical record. Null means no acceptance history; multiple rows are
a conflict. It never asserts current execution/fulfillment eligibility.

Actual135-migration DB suite PASS13.61s/body11.59s
(/tmp/bop-wp2402-acceptance-reader-db.log, session46635 exit0): missing then persisted original,
revoked read authorization denied, foreign Store empty, independent PostgreSQL connection cannot
acquire the held Order disposition advisory lock, ambiguous later physical-schema fixture denied.
Original acceptance writer/payment outcomes/Worker recovery cases remain passing.
Ordering lint/typecheck PASS;64files1315tests PASS3.85s
(/tmp/bop-wp2402-acceptance-reader-ordering.log, session85579 exit0).
Build is covered by identical tsc command/config as recorded previously. Fixture ESLint/targeted
Prettier and final diff check passed. No migration, dependency or exact asset declaration changed;
do not relabel earlier migration/ownership evidence as a new run.

Next: Payment disposition writer currently takes its financial-operation lock but has not adopted
the shared Order disposition lock; align lock ordering when connecting this reader into its source.
Existing customer-capacity-payment-admission is an initial Payment claim gate with capacity deadline,
so it cannot be blindly reused as post-capture fulfillment authority or as a new expiry decision.
Current capacity/Inventory/Payment/execution evidence must be resolved under their accepted rules.

### Payment disposition Order fence alignment

Update the existing success disposition adapter to acquire the same scoped Order disposition lock
before financial-transaction locking. Unified success/failure adapter validates event shape/scope,
captures immutable configured scope and acquires Order before event lock, so source-reader-held
Order locks never invert with direct unified success writes. Keep original source gates: locking
does not validate fulfillment, authorize events or manufacture confirmation. Extend existing
successful DB transaction to prove held Order lock and observed Order/event/financial lock order,
without another synthetic output record. Tighten exact asset dependencies to include order_batch,
which the writer already reads. Run affected Ordering/static, targeted boundary and same DB suite.

Payment outcome adapter now takes scoped Order disposition lock before event lock; success
writer also takes Order before financial transaction lock, including direct branch usage.
Configured Brand/Store are parsed/captured; wrong-scope/malformed events reject before unified
locking. The required source remains authoritative; locks alone do not authorize confirmation.

Actual135-migration DB suite PASS13.79s/body11.65s
(/tmp/bop-wp2402-disposition-order-lock-db.log, session33097 exit0). Successful real write asserts
Order/event/Order/financial lock order and independent connection cannot acquire the held Order
lock before commit. Prior acceptance/source-reader, duplicate, outcome-branch race, Audit/Outbox
rollback and Worker lost-commit-ack cases pass. This is lock retention evidence, not complete
accept/cancel/payment race coverage with all real producers.

Initial typecheck found event envelope ID string not typed OrderingReference at reader call;
explicit parseOrderingReference(source.eventId) fixed it. DB evidence predates this one-line
conversion; its same strictly parsed UUIDv7 values and emitted lock/query values are unchanged,
so retain that runtime evidence rather than rerun a passing suite. Final Ordering typecheck and
64files1315 tests PASS3.83s (/tmp/bop-wp2402-disposition-order-lock-ordering.log, session58282
exit0); prior lint passed before only this safe parser-call adjustment. Build uses identical tsc.
Exact disposition owner allowance now requires both disposition and order_batch declarations.
Focused6 boundary cases PASS899ms (/tmp/bop-wp2402-disposition-order-lock-boundary.log),518 other
cases not rerun; actual ownership validator PASS. Diff check and targeted formatting passed.

Re-read WP-1310 closed contract: historical acceptance alone never confirms. Actual source must
still prove current scoped checkpoint/version plus Payment/Batch/submission identity and eligible
fulfillment; AwaitingAcceptance retries without confirmation/compensation. Next implement that
source using current owner capabilities, not an opaque preconstructed Confirmed test record.

### Captured Payment source for Ordering composition

Add apps/api/src/order-captured-payment-source.ts as a read-only public-contract composition.
Use actual Payment intent history keyed by success-event correlation (original operation) and
actual terminal store keyed by Intent under caller transaction and configured account/environment.
Require current caller authorization, canonical event identity/content, exact scope/Order/Intent/
Attempt/transaction, operation, total and terminal recorded-time bounds. Return only coherent
owner records internally; no Provider I/O, mutation, auto-confirmation or capacity decision.
Extend existing submission-inventory-payment runtime helper after formal terminal recording to
prove positive exact source, altered event rejection and revoked authorization; run one configured
Pickup session variant first. Other variants remain pending for broader journey milestone.
API required checks, helper static checks and targeted existing database config; no new dependency.

Captured Payment source implemented through actual public Payment history and terminal stores
on caller transaction. It binds original operation correlation, Intent/Attempt/Order/scope,
configured Provider account/environment, exact total and canonical successful event, and checks
recorded-time bounds/current authorization. It performs no Provider call or mutation. Original
Payment factory's unused observation generator is unavailable, not a fabricated new observation.
This supplies Payment facts only, not acceptance/capacity/current fulfillment authority.

API typecheck PASS(session58545), lint/build and55files825tests PASS7.32s
(/tmp/bop-wp2402-captured-source-api.log, session96158 exit0).
Initial helper lint found an existing captured variable name; renamed new result capturedPayment,
then helper formatting/ESLint passed. An initially selected configured-order-submission test
passed13.83s (/tmp/bop-wp2402-captured-source-pickup-db.log) but call-site inspection proved it
does NOT invoke the new helper. It is not evidence for captured source and is not counted as such.

Corrected actual135-migration complete Pickup configured=true composition PASS40.42s/body35.83s
(/tmp/bop-wp2402-captured-source-full-pickup-db.log, session70739 exit0), one configured=false
variant intentionally not rerun. This runs persisted Identity/Cart/Quote/capacity/Inventory/payment
session and normalized synthetic Provider response through actual terminal/reconciliation/Audit/
Outbox. New source reads exact persisted payment and terminal, rejects altered event identity or
amount and revoked read authorization. Existing counts remain2observations/1terminal/1success
event; no extra Provider call. Provider/network authorization remains synthetic; no Live capture.
Final diff check passed before this evidence-only append. Dining/Quote1 source variants and
complete captured-source + acceptance + current fulfillment composition remain next.

### Coherent paid Order context plan

Add apps/api/src/order-paid-context-source.ts composing the actual captured Payment source,
authorized durable acceptance reader and public withCurrentSubmission order reader in caller
transaction. Derive submission/Batch/cart/quote only from stored Payment preparation, verify
original Order history exact linkage and retain Order/header locks. Return immutable internal
context including nullable historical acceptance and observed instant, not Confirmed/current
execution state. Missing acceptance is factual, not a fabricated acceptance or compensation.
Extend the existing complete Pickup helper to resolve pending-acceptance context and read denial.
No extra acceptance seed or policy approval fabricated. API required checks and one existing
complete Pickup configured=true DB run; final current eligibility remains a separate required source.

Paid context source implemented using captured Payment facts, acceptance history reader and
public current-submission reader on the caller transaction. It derives submission/Batch from
stored preparation and verifies Order/guest/cart/version/quote before returning original history,
nullable acceptance and observedAt. Order disposition and header locks remain held until caller
commit. It neither invents acceptance nor asserts current execution/confirmation; current source
version and current eligibility still require owner facts beyond initial Order history.

Actual135-migration complete Pickup configured=true suite PASS46.78s/body42.13s
(/tmp/bop-wp2402-paid-context-pickup-db.log, session77882 exit0), configured=false deliberately
not rerun. New assertions resolve persisted matching Order/items/submission and formal terminal
with acceptance=null, and revoked Order read authority rejects even though Payment access was
allowed. Prior captured-source altered event/amount and revoked payment authorization cases pass.
No acceptance seed was added and no Confirmed claim follows from this test.
API typecheck PASS(session44798), lint/build and55files825tests PASS7.56s
(/tmp/bop-wp2402-paid-context-api.log, session50809 exit0). Targeted helper ESLint/Prettier and
final diff check passed; no migration/dependency changes.

Next available actual Inventory source is submission-final-validation-store.withCurrent: it loads
current items, reservations and accounts under owner fences, distinct from Payment claim admission
which applies initial-payment rules. Compose those factual reads and channel capacity facts into
the paid context before implementing current fulfillment decision; do not silently reuse initial
payment admission/expiry assumptions after capture.

### Current Inventory in paid context

Extend order-paid-context-source.ts with required configured Tenant and Inventory read authorization.
Use actual public submission final validation withCurrent under existing caller transaction after
Order history locking, matching stored submission/actor/Order/cart/version/quote. Return current
items/reservations/accounts alongside paid context. No initial Payment admission or expiry rule
is reused, and no Ready/Confirmed decision is inferred. Future channel capacity read must precede
Inventory locks in this composition to match established owner lock ordering.
Extend existing complete Pickup helper with real inventory fact assertions and independent
Inventory read denial. Required API checks plus one complete configured Pickup run; unchanged
migration/dependency evidence reused. No new fake acceptance/policy/expiry facts.

Current Inventory facts now included in paid context from actual owner withCurrent under the
existing caller transaction. Required configured Tenant/Inventory authorization; exact submitted
Order/cart/version/quote link checked. Returned items/reservations/accounts remain facts for
later policy evaluation. No expiration cutoff, admission success or confirmation inferred.

Actual135-migration complete Pickup configured=true suite PASS45.18s/body40.66s
(/tmp/bop-wp2402-paid-inventory-pickup-db.log, session86646 exit0); Quote1 variant not rerun.
New assertions verify same final submission, current item/reservation counts and independent
Inventory authorization denial. Existing captured Payment, full Order context and Order access
denial cases remain passing. Provider results and read-authority callbacks are synthetic; owner
persistence and transaction reads are real. No merchant acceptance or Confirmed record is seeded.
API typecheck PASS(session79917), lint/build and55files825tests PASS7.78s
(/tmp/bop-wp2402-paid-inventory-api.log, session45608 exit0). Helper ESLint/Prettier and final diff
check pass. No new schema/dependency or need to rerun unchanged migration/ownership checks.
Next add channel-specific current capacity facts before Inventory acquisition, then verify both
Dining and Pickup compositions at that shared milestone; current execution/confirmation producer
and cancellation finality still remain separate required work.

### Channel capacity facts in paid context

Add Dining owner withCurrentFacts to existing checkout commitment store: locked latest commitment
and parsed current session/participant identities, distinct from withPaymentPending eligibility.
No deadline/state admission check or mutation; original current table binding checks remain.
Add API order-paid-capacity-source.ts selecting Dining or ASAP Pickup by actual stored OrderType,
binding exact preparation allocation/submission/guest/cart/quote/Order/Batch/permanent Payment
operation and clock. Use current owner locks before Inventory; return state facts, not fulfillment
or compensation. Expired/moved/missing source does not synthesize a refund or close Dining.
Integrate into paid context and existing shared full journey helper. Run API/Dining affected checks,
full Pickup configured=true and Dining configured=true to cover both real owner branches.

Channel capacity facts integrated before Inventory read in paid context. Dining withCurrentFacts
reads locked latest commitment and parses current session/participant identities separately from
unchanged withPaymentPending eligibility; existing table-context mismatch still fails safely.
API reads Dining or ASAP Pickup from actual OrderType and matches exact preparation allocation,
submission/guest/cart/version/quote/Order/Batch/payment operation and original clock. It returns
capacity state facts without declaring readiness, expiry compensation or Dining table release.

Actual135-migration configured=true complete journeys both PASS (session19599 exit0):
Pickup46.44s/body41.44s, /tmp/bop-wp2402-paid-capacity-pickup-db.log;
Dining52.02s/body47.47s, /tmp/bop-wp2402-paid-capacity-dining-db.log.
Each new helper assertion verifies actual owner kind, exact Batch and permanent Payment operation,
with prior paid context/current Inventory/access-denial/captured-source assertions still passing.
Both configured=false variants deliberately not rerun. Real owner database reads/locks and
application flow; Provider responses and authorization callbacks remain synthetic. No accepted
Order or Confirmed/Kitchen event is introduced by these tests.

Dining lint/build passed; build tsc --project tsconfig.json also covers type checking (no separate
--noEmit duplicate);23files1023tests PASS1.70s (/tmp/bop-wp2402-paid-capacity-dining-unit.log).
API typecheck passed(session53431), lint/build and55files825tests PASS7.54s
(/tmp/bop-wp2402-paid-capacity-api.log, session80083 exit0). Targeted formatting/helper ESLint and
diff check passed. Existing exact Dining asset path/table declarations unchanged; no migration.
Next implement Ordering current fulfillment decision from this factual context plus authorized
accepted policy/current execution source, not from historical acceptance or captured payment alone.

### Real pending-acceptance Payment source

Connect the real paid context to the existing Payment outcome consumer's waiting branch first.
Add order-pending-acceptance-source.ts implementing source.loadExact: bind every incoming identity,
resolve real context, require no acceptance history and original Submitted history with current
capacity still PaymentPending inside its original clock. Outside this bounded pending state return
no source; never manufacture Confirmed or compensation. Use the actual immutable submission as
the initial source checkpoint/version; disposition ID is generated proposal identity, digest uses
the existing strict event binding. This is an intermediate source implementation, not final
fulfillment source. Add shared runtime-helper assertions for true AwaitingAcceptance and digest.
Later accepted/current execution and policy branch must replace the incomplete null path.

Real pending-acceptance source implemented with exact event identity checks and real paid context.
Only absent acceptance + original Submitted + current PaymentPending capacity inside original
clock produces AwaitingAcceptance. Other states return no source: accepted/current execution
confirmation and unfulfillable branches remain unimplemented here. Actual immutable submission is
the initial checkpoint; generated disposition is a waiting proposal, never a committed fact.
The existing canonical event/disposition binding supplies its digest.

Extended full Pickup helper now invokes actual OrderPaymentOutcomeConsumerService with real
outcome readers and Inbox twice. Both attempts require transaction rollback/retry; no completed
Inbox, payment disposition or OrderConfirmed remains. Audit factory is unavailable because
waiting must never write outcome Audit. System read capabilities remain explicit synthetic gates.

Initial DB run correctly threw ConsumerTransactionRollback/retry_required, but test used instanceof
against Eventing source class while Ordering imports built Eventing: duplicate class identity
failed the assertion. Fixed only test to check public error name and exact outcome contract.
Final actual135-migration configured=true Pickup PASS44.15s/body39.29s
(/tmp/bop-wp2402-pending-source-pickup-retry.log, session47891 exit0); failed log retained at
/tmp/bop-wp2402-pending-source-pickup-db.log. API typecheck PASS(session44643), lint/build and
55files825tests PASS7.70s (/tmp/bop-wp2402-pending-source-api.log, session57317 exit0).
Helper formatting/ESLint and final diff check passed. No API rerun for test-only class assertion.
This completes actual waiting behavior, not a confirmed Order, Kitchen flow or trial readiness.
Next replace the accepted-state null source with actual authorized current execution/policy
confirmation, preserving mutually exclusive unfulfillable handling.

### Paid Order release policy evaluation

Add order-paid-workflow.ts to evaluate actual current published action against paid-context Order
and acceptance provenance. Required configured action/purpose/permission/nextState; no hard-coded
new phase, permission or automatic release. Request must match exact scope/Order/OrderType,
accepted version, Accepted current state and context observation time. Mandatory Workflow
resource gate still proves current execution and all action/rule/publication gates run in caller
transaction. Historical acceptance alone is never that gate. Return evaluated policy only; no event.
Extend actual Workflow/merchant-acceptance DB fixture with a synthetic configured Accepted
self-transition, positive evaluation, wrong version/permission rejection and archived publication
denial. API required checks and existing Workflow DB config; full runtime eligibility still pending.

Paid Workflow evaluator implemented: server-configured action/purpose/permission/nextState,
exact accepted Order/version/OrderType/observation binding, and actual current publication with
mandatory resource/action/rule gates in caller transaction. Returns evaluation only. No new
Order phase or approval accepted; synthetic fixture uses an Accepted self-transition. Current
resource gate cannot be replaced by the historical acceptance record.

Actual135-migration Workflow DB suite PASS14.19s/body11.73s
(/tmp/bop-wp2402-paid-policy-db.log, session94916 exit0): persisted merchant acceptance plus
published release evaluates; wrong resource version/permission, denied current resource and
archived publication reject. Owner gates remain synthetic and complete capacity/Inventory policy
evaluation is not proven by this fixture.
Initial typecheck/build rejected equality across distinct branded UTC instant types. Explicit
String conversion preserves exact canonical string equality; final typecheck/build PASS
(session61561 exit0),55files825tests PASS7.18s (/tmp/bop-wp2402-paid-policy-api.log).
API lint passed before that single equivalent string conversion. DB evidence predates conversion;
same parsed string values and queries remain unchanged, so no redundant DB rerun. Targeted
format/fixture ESLint and final diff check pass. No dependency or migration changes.
Next connect this evaluation and current owner rule/resource capabilities into the actual accepted
payment source and Ordering confirmation builder; waiting branch remains the only connected
real payment consumer branch. Full accepted-to-Kitchen runtime remains unfinished.

### Ordering confirmation candidate builder

Add application/order-payment-confirmation.ts and owner unit tests. Builder accepts public original
Order creation snapshot, Ordering Payment preparation evidence, parsed success event and general
acceptance record after caller-held current execution/policy authorization. Require exact scope,
Order/Batch/submission/cart/version/quote/guest, accepted source version, exact captured total and
original item sum excluding tip, and nonregressing observed time. Snapshot digest reuses
orderCreatedSourceInput; source checkpoint is actual acceptance identity/version. Return a closed
Confirmed candidate with strict event binding, not a persisted fact or authorization token.
No automatic invocation/permission, event publication or stale-history authority introduced.
Export publicly for API composition. Run affected Ordering type/lint/unit checks; actual accepted
paid-source integration remains next and synthetic unit tests must not be called runtime proof.

Confirmation candidate implementation verified on branch codex/wp-2402-pilot-submission,
baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus the current uncommitted WP-2402 worktree.
The interrupted prior attempt had no live test process and no result log. Fresh lint found a
test-only forbidden non-null assertion; replaced with explicit fixture precondition.
Final Ordering lint/typecheck PASS and 65 files / 1328 tests PASS (3.75s,
/tmp/bop-wp2402-confirmation-candidate-ordering-final.log, session32792 exit0).
The 13 new synthetic unit cases cover exact acceptance and preparation identity/version,
captured amount including tip, original allocation, observation ordering, canonical original
snapshot digest, invalid digest rejection and strict payment-event binding.
Formatting and scoped diff check passed. No manifests, lockfile, toolchain, migrations or DB
queries changed; this application-only candidate does not require a fresh DB run. No full
repository regression was run or claimed. Candidate generation does not establish current
execution authority, release eligibility, persisted confirmation or Kitchen readiness.
Next action remains integrating actual current execution/rule gates and published release
evaluation with this candidate and the existing atomic consumer outcome writer; accepted-state
source is still unconnected and WP-2402 / the single-store pilot remain in progress.

### Compose published paid release with confirmation candidate

Add a paid-outcome source that resolves the real paid context once in the consumer transaction.
Keep the existing no-acceptance waiting branch; when acceptance exists require caller-provided
current resource/action/rule capabilities, server release configuration and an exact Workflow
request, then invoke the real published Workflow evaluator before Ordering candidate generation.
No default allow, hard-coded production action/actor, foreign private SQL or persistence in API.
Source factories alone do not implement the still-missing execution/cancellation authority.
Extend the existing Workflow PostgreSQL fixture to exercise this composition against actual
published policy and persisted acceptance; any supplied Payment/context and resource gates must
remain explicitly synthetic. API mandatory checks and that existing DB suite cover the change.

Paid-outcome source is now composed in apps/api/src/order-paid-outcome-source.ts. It validates
the exact incoming financial event before reads, resolves paid context once in the caller
transaction, preserves AwaitingAcceptance, and evaluates real current published Workflow before
calling the Ordering confirmation candidate builder. Required current resource/action/rule
capabilities are explicit. No default authorization, new production permission, canonical phase,
private-table access or runtime activation was introduced.

Final review identified a concrete missing-command risk: Workflow evaluation deliberately does
not execute transition effects. This composition now rejects nonempty effects rather than
silently confirming. Actual owner command execution remains required for such release policies;
the positive synthetic fixture intentionally has an empty-effect Accepted self-transition.

Actual PostgreSQL evidence (135 unchanged migrations, current uncommitted WP-2402 worktree on
baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26):

- Workflow/confirmation DB final PASS16.32s/body12.21s,
  /tmp/bop-wp2402-paid-confirmation-effects-db.log, session41580 exit0.
  Actual Order history and acceptance readers + actual published release evaluation + candidate
  - actual consumer/Inbox/outcome/Audit/Outbox now run together. Wrong event ID rejects before
    reads; denied current resource/rule and unapplied commands deny confirmation; injected Audit
    failure rolls back every outcome; successful consumption writes exactly one of each; replay
    does not reread sources; publication archival blocks a new candidate but preserves original
    completed consumer recovery. Payment context and owner capabilities in this fixture are
    explicitly synthetic: this is not full current execution/capacity/Inventory proof.
- Real persisted Payment context Pickup configured=true with unified source PASS41.53s/body36.93s,
  /tmp/bop-wp2402-paid-outcome-pickup-db.log, session23376 exit0. Absent acceptance never calls
  release evaluation or generates confirmation; two consumption attempts roll back Inbox and
  leave no outcome/Event. configured=false and Dining variants were not rerun. This result
  predates the accepted-only unapplied-effects guard; pending path, helper, dependencies,
  toolchain, migrations and environment inputs are unchanged, so evidence is reused.
- API final lint/typecheck/build PASS; 55 files / 825 tests PASS7.13s,
  /tmp/bop-wp2402-paid-confirmation-effects-api.log, session73713 exit0.
  Test-support ESLint, formatting and scoped diff check pass. No full repository regression.
  Ordering candidate evidence from the prior subsection remains valid: no Ordering source changed.

Next substantive dependency is the actual current Ordering execution/cancellation/finality
authority and owner release-rule/command composition under shared fences. Historical acceptance
and a current-looking status projection cannot replace that authority. Then exercise the complete
captured-payment + merchant acceptance + confirmation path for both Order Types and connect actual
Kitchen consumption. No Provider/Store external facts, commit, deployment or pilot-ready claim.

### Initial execution and serialized termination

Implement Ordering-owned append-only termination history for the accepted Section24 initial
Submitted/Accepted window. Rejected is allowed only from Submitted; Cancelled records termination
from Submitted/Accepted after explicit current actor/purpose/permission and source eligibility
gates. This does not implement guest cancellation requests, Kitchen loss decisions, later
fulfillment/close/reopen or refunds. Never infer those public owner receipts from this history.
Current initial execution reader derives exact original submission or acceptance checkpoint/version,
then applies a matching terminal record; retains OrderingOrderDisposition fence through caller
commit. Acceptance must reject a prior terminal record under the same fence. Operation retry
rechecks authorization and returns the original fact; mismatched intent/version/checkpoint denies.
Add root migration1300_024, manifest/catalog/strict persistence ownership registration, owner
parser/store and actual DB evidence with atomic Audit rollback, original recovery, RLS, unchanged
history and accept-vs-terminate competition. Only directly affected Ordering, migration/ownership
and the existing order-payment-failure DB fixture are required during this stage; broader current
source API composition follows once the owned fact is evidenced.

Initial execution/termination storage implemented with migration1300_024 and exact owner
registration. Strict closed record stores original expected version/checkpoint, previous phase,
terminal phase, scoped actor/purpose/permission/policy/reason/digest/time. Rejected from Accepted
is invalid; cancellation/refund/closure remain separate. One initial terminal fact per Order is
append-only and does not mutate the original header or acceptance.
Reader reauthorizes under scoped RLS and holds OrderingOrderDisposition while resolving original
submission -> optional exact acceptance -> optional matching termination. It deliberately does
not claim Kitchen, amendment, fulfillment or financial finality authority.
Both acceptance and termination writers now take Order before operation locks, matching Payment
and allowing callers already holding the Order fence. Acceptance rejects prior termination for
a new operation; original operation replay remains history recovery and rechecks authorization.

Final evidence on baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree:

- Ordering lint/typecheck PASS;66 files/1345 tests PASS3.84s,
  /tmp/bop-wp2402-order-termination-final-unit.log, session63152 exit0.
  Seventeen new parser cases cover immutable closed shape, actor/version/checkpoint/time/phase
  boundaries and accessor rejection. Initial inferred literal version type was fixed before pass.
- Actual136-migration order-payment-failure DB suite PASS15.32s/body13.15s,
  /tmp/bop-wp2402-order-termination-final-db.log, session45640 exit0.
  Adds initial reader, retained Order lock, denial before eligibility, stale checkpoint,
  Audit rollback, competing accept/cancel exactly one winner, cancellation after accepted version,
  parallel original replay without source rerun, changed intent/permission denial, one Audit,
  no update/delete, foreign Store invisibility and immutable original header.
  Actor/current source capabilities are explicitly synthetic; no guest cancel or Kitchen loss
  decision is proved by this fixture.
- Actual136-migration Workflow/merchant-acceptance/confirmation DB suite PASS16.64s/body12.55s,
  /tmp/bop-wp2402-order-termination-workflow-db.log, session78938 exit0. Existing actual acceptance
  now performs terminal exclusion read with explicit role grant; published confirmation still works.
- migration:check PASS106 tests18.70s plus catalog valid136; log
  /tmp/bop-wp2402-order-termination-migration.log. Migration bytes unchanged after this run.
  Focused ownership15 testsPASS1.07s (518 unrelated cases not run), log
  /tmp/bop-wp2402-order-termination-ownership.log. Initial repository ownership validation found
  missing new-table governance metadata; added exact append-only transactional indirect-identifier
  declaration, then actual database ownership validator PASS (session63152).
  Module manifest and actual database permission validators PASS (session78938).
  No ownership/permission validator source changed after applicable tests.
- Formatting, helper ESLint and scoped final diff check PASS. No API source, dependency, lockfile,
  toolchain, external services, commit or deployment changed. Full regression remains at the
  complete cross-domain journey milestone, not claimed here.

Next integrate createPostgresOrderInitialExecutionReader into paid context and prevent terminal
initial state from producing either pending acceptance or confirmation. Then replace remaining
current Kitchen/amendment/Inventory/capacity rule inputs with public owned capabilities, implement
unfulfillable compensation and later execution/closure actions. The new termination factory is
not yet activated through an HTTP/merchant/guest route; source gates are mandatory, not default
allow. The project goal and WP-2402 remain in progress.

### Bind initial execution and terminated paid disposition

Use the actual initial-execution reader in paid context under the same Order fence. Terminal
Cancelled/Rejected context returns before capacity/Inventory reads, because released or unavailable
resources must not strand compensation. Keep actual captured Payment and original Order binding,
authorization and nonregressing clock. Add Ordering closed initial execution parser and a terminal
paid-disposition builder: exact event/preparation/scope, terminal source checkpoint/version,
observed-time bound and canonical digest; Cancelled -> SubmissionCancelled, Rejected ->
OrderNoLongerFulfillable, always Kitchen Blocked. This produces only Ordering's WP-1310 public
disposition, not a Provider refund or closed Critical case.
Pending/confirmed branches require matching current initial execution; accepted history alone
cannot confirm. Extend actual Pickup and Dining paid-context helpers through durable termination,
compensation-required consumption and original replay with zero OrderConfirmed/extra Provider
mutation. Extend published-confirmation helper with actual execution read. Run directly affected
Ordering/API checks and these existing DB configs; no new migration or dependency.

Initial execution is now part of actual paid context. It is parsed as a closed owner snapshot,
observed under the shared Order fence, and checked against initial acceptance before confirmation.
Cancelled/Rejected context returns explicit null capacity/Inventory before any such owner read.
Ordering builds the exact WP-1310 blocked public disposition from current terminal checkpoint
and version plus actual captured Payment/preparation binding. No refund outcome is invented.
The prior pending-only compatibility source also rejects non-Submitted initial execution.
Reused confirmation test inputs were extracted into one owner fixture for the new terminal cases.

Fresh evidence on baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree:

- Ordering lint/typecheck PASS;67 files/1363 tests PASS4.15s,
  /tmp/bop-wp2402-terminated-paid-unit.log, session45588 exit0. Eighteen added cases include
  Cancelled v2/v3, Rejected v2, mismatched/nonterminal execution, exact amount/digest, late captured
  payment after resource deadline, regressing observation and accessor rejection.
- API typecheck PASS(session96404); lint/build PASS and55files825tests PASS8.35s,
  /tmp/bop-wp2402-terminated-paid-api.log, session60102 exit0.
- Actual136-migration published Workflow/acceptance/confirmation suite PASS16.35s/body12.42s,
  /tmp/bop-wp2402-terminated-paid-workflow-db.log, session33844 exit0. Source now uses the actual
  initial execution reader in addition to persisted acceptance; positive/denial/atomicity/replay
  evidence remains valid. Payment and capability inputs in that fixture remain synthetic.
- Actual136-migration configured=true Pickup PASS44.40s/body39.49s,
  /tmp/bop-wp2402-terminated-paid-pickup-retry.log, session52435 exit0.
  Configured=true Dining PASS54.45s/body49.55s,
  /tmp/bop-wp2402-terminated-paid-dining-retry.log, session6408 exit0.
  Both use actual captured Payment, original Order and initial execution readers, actual termination
  writer and same paid-outcome source through real Inbox/disposition/Audit transaction. Waiting
  first rolls back without confirmation; after cancellation, denied Inventory authority does not
  strand terminal processing, capacity/Inventory are explicitly absent, one CompensationRequired
  result persists, duplicate consumption recovers the original, zero OrderConfirmed is emitted,
  and Provider result retrieval/call counts remain unchanged. Named Staff/current policy and
  System capabilities remain explicit synthetic gates; real merchant cancellation permission,
  loss handling and Provider refunds are not proved by this test.
- Initial both-mode DB runs failed at the new execution reader: existing fixture roles allowed a
  header row lock but lacked UPDATE privilege on any Batch column for FOR SHARE OF b. Added only
  UPDATE(order_batch_id), retaining immutable Batch rules. Fresh retry results above pass; original
  failed logs /tmp/bop-wp2402-terminated-paid-pickup-db.log and
  /tmp/bop-wp2402-terminated-paid-dining-db.log remain. No production check or RLS was bypassed.
  Fixture-only permission/clock correction does not change API/Ordering/Workflow inputs, so their
  prior passes are reused, not reported as fresh reruns.
- Helper formatting/ESLint and scoped diff check pass. No migration, manifest, dependency,
  toolchain or external service change. Quote v1 full journeys were not rerun; no full regression.

Current evidence view updated to distinguish this actual terminal-disposition journey from future
Provider compensation execution and pilot activation. Next integrate actual current owner release
rules for successful accepted Orders and Kitchen, then durable Payment compensation case/claim,
Provider truth and independent Operations reconciliation. Cancellation routing/UI, preparation
started/loss decisions, later fulfillment/closure and ordinary refund boundaries remain separate.
WP-2402 and the single-store pilot goal remain in progress.

### Persisted confirmed Order source for Kitchen

Implement the existing WP-1401 public Ordering Kitchen source from immutable original Order
history and actual persisted OrderConfirmed disposition/event. No current Catalog/Recipe lookup
or opaque digest decoding. Match exact confirmation/event/Order/Batch/version/digest, retain
Order fence, and require current initial Accepted checkpoint/version before fresh Kitchen intake.
Current authorization is mandatory. Convert original ordered item snapshots (including saved
options/note) into the existing bounded Kitchen source with canonical per-line and evidence
digests. Evidence identity is original submission, captured time is original Order creation and
evidence version1. Data is returned only to the authorized public Query, never Events/logs.
Add owner snapshot builder + owner persistence composition and strict ownership asset admission;
no migration/dependency. Extend actual published-confirmation DB fixture for authorized source,
exact identity/digest denial, original options/note, reauthorization and cancellation prevention.
Affected Ordering checks, focused ownership and existing Workflow DB suite cover this increment.
This is a dependency for actual Kitchen tickets, not a completed Kitchen runtime.

Persisted Ordering Kitchen source implemented. The public scoped Query reauthorizes, reads current
initial execution under Order fence, finds the exact persisted confirmation/event, then reconstructs
the original Order through its owner reader. It verifies the opaque Order snapshot binding by
reusing Ordering's canonical original-source function; Kitchen never decodes that digest or
reads Ordering private tables. The source carries original ordered quantities, names, selected
options and bounded saved note with per-line/evidence digests, original submission evidence ID
and capture time. Fresh intake rejects cancelled state or mismatched identity/version/digest;
historical confirmation consumer replay still returns its original result after cancellation.

Evidence on baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree:

- Ordering lint/typecheck PASS;68 files/1368 tests PASS3.94s,
  /tmp/bop-wp2402-kitchen-source-unit.log, session45528 exit0. Five added snapshot cases cover
  exact original content/digests, mismatched Order/Batch/digest, future history and hash failure.
  Initial typecheck exposed the public reader's union including PaymentFailed; added the proper
  disposition discriminator before accessing confirmation fields, then checks passed.
- Actual136-migration Workflow/confirmation/Kitchen-source DB PASS16.69s/body12.70s,
  /tmp/bop-wp2402-kitchen-source-db.log, session12978 exit0. Includes actual Order/acceptance,
  published release, consumer outcome, and newly actual Kitchen source Query; wrong event,
  confirmation, version/digest and revoked read authority deny. Original content survives retry.
  An actual appended cancellation prevents a fresh Kitchen source, while completed confirmation
  consumption still recovers history. Payment and policy/actor gates in this fixture remain
  explicitly synthetic; it is not a complete actual Payment-to-Kitchen ticket journey.
- Focused strict ownership11 testsPASS1.17s (533 unrelated cases not rerun),
  /tmp/bop-wp2402-kitchen-source-ownership.log; actual repository ownership validator PASS.
  New allowance is exact owner/schema/path plus all seven declared source tables, with driver and
  altered/missing boundaries denied. Formatting, helper ESLint and scoped diff check PASS.
- No migration, module dependency, manifest table, runtime activation or external change. No API
  source changed; no repeat API/full repository regression. Quote v2 source uses the same original
  snapshot projection but has not yet received a fresh complete Kitchen-source DB journey here.

Next actual Kitchen dependency is ticket/work-item/action/Audit/Outbox persistence and current
routing/preparation plan provenance. Existing Kitchen SQL schema and pure consumer/service are
not yet a runtime adapter. Keep the outstanding owner release eligibility rules and complete
captured-payment + actual acceptance journey explicit; this source is not a Kitchen-ready or
pilot-ready claim.

### Durable Kitchen creation result, implementation increment

Kitchen must retain the original creation effect independently of mutable work progress.
Implement a versioned owner-only storage encoding with the original receipt, ticket/items,
creation action, Audit and KitchenWorkCreated event, including their exact identities and
digests. Reuse the existing full creation-effect validator; only its reference/hash dependencies
are needed for decoding. Restore only the four explicitly defined bigint fields, losslessly
within PostgreSQL bigint range; never reinterpret customer text or numeric event payload fields.
This is restricted persistence content, not a public Event or log representation.

Owned files: Kitchen creation service/ports, owner creation-record codec, existing Kitchen ticket
behavior tests and public composition exports as needed. Next persistence step will append a
scoped immutable creation record alongside normalized ticket/work items/action and Audit/Outbox
in the consumer transaction; no initial-write-only JSON store will replace those aggregates.
Required affected commands for this increment: Kitchen lint/typecheck/test and scoped Prettier.
The actual PostgreSQL transaction milestone must additionally cover rollback, semantic-key
concurrency, current authorization, original replay after work progress, and scoped RLS through
the existing database fixture before claiming durable Kitchen intake. No database/runtime or
full pilot claim follows from codec tests.

The version-1 Kitchen creation record codec is implemented. It uses the same complete effect
validation as the creation service, narrowed to reference/hash ports, and preserves the original
receipt, ticket/items, action, Audit and Event. Four declared bigint fields are encoded as decimal
strings and restored explicitly; event payload numeric versions and saved customer text are not
coerced. Unsupported record formats, altered effects, rounded/overflow versions and malformed
input fail with the bounded dependency-unavailable error. PostgreSQL bigint maximum and a value
above JavaScript safe-integer range round-trip exactly. This owner-internal codec is not a new
public Query and does not substitute for current authorization in the upcoming repository.

Fresh evidence, baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 edits:

- pnpm --filter @rms/kitchen typecheck and lint PASS; final session42528 exit0.
- pnpm --filter @rms/kitchen test PASS:12 files/263 tests,2.84s,
  /tmp/bop-wp2402-kitchen-record-unit.log;21 new codec cases use effects generated by the actual
  creation service. Existing creation/replay rules retain all prior behavior checks.
- Initial fixture typecheck failed for missing rowCount; corrected the fixture. Subsequent lint
  rejected explicit any in mutation cases; replaced with typed paths, then final checks passed.
  Those failed attempts did not execute unit tests and are not counted as passes.
- Scoped formatting and final diff whitespace review PASS. No SQL/migration, dependency,
  toolchain, API, runtime or external-state change in this increment. No database or full
  regression was run; this increment proves encoding/recovery validation only.

Next implement the actual scoped immutable creation record and normalized ticket/work-item/action
writes with mandatory Audit/Outbox in one consumer transaction, then exercise real database
rollback, current authority and concurrent/replayed intake. Kitchen runtime and the pilot remain
unfinished; no new persistence-completion claim is made.

### Actual Kitchen creation transaction

Implement Kitchen-owned 1500_008 creation record (forced scoped RLS, append-only, scoped identity
and action/ticket links) plus src/infrastructure/persistence/kitchen-ticket-store.ts. Existing
1500_001 aggregate migrations remain unchanged. Store normalized ticket/work items/action,
mandatory public Audit/Outbox, then original creation record LAST in the caller ConsumerTransaction:
application-level Audit/Outbox exceptions must not leave a recoverable false-success record.
Current System authorization applies to reads and writes. A mandatory current source/plan gate
runs only for fresh intake, before sorted Kitchen semantic fences; its Ordering source fence
must precede Kitchen fences. Semantic event/confirmation/batch collisions either recover the
fully validated original effect or conflict. No private Ordering/Audit/Eventing queries.
Replay reads original creation history independently of mutable work progress.

Owned additions: root Kitchen migration, Kitchen module/access manifests and public adapter
export, focused ownership admission/tests, catalog expected migration, actual database helper
under published-order-confirmation fixture. Test routing/preparation and System capabilities
remain explicitly synthetic until real published configuration composition exists. Reuse
unchanged codec tests; fresh affected Kitchen lint/typecheck/test, ownership/module/permission
validators, migration:check and existing workflow-definition DB suite prove this increment.
The broader runtime/captured-payment-to-Kitchen milestone remains outstanding.

Actual Kitchen ticket persistence is implemented and exercised through the real confirmed-Order
consumer. The adapter has no database connection/driver and no foreign private SQL; it receives
the same transaction as Ordering source, Audit/Outbox and Inbox. It reauthorizes original reads
and creation, validates current source before sorted Kitchen semantic locks, rejects conflicting
identity matches, and returns the original validated effect after mutable progress. The final
creation-record INSERT follows mandatory Audit and Outbox, preventing an application-level write
exception from being mistaken for successful creation by service recovery. Normalized ticket,
work items and action remain the runtime aggregates; creation JSON is restricted immutable history.

Evidence on baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree:

- Kitchen typecheck PASS (session command chunk4dc22d exit0). Kitchen lint and existing12-file/
  263-test suite PASS2.78s, /tmp/bop-wp2402-kitchen-store-unit.log, session73137 exit0.
  Kitchen build is the identical tsc command as typecheck, not separately rerun or claimed fresh.
- pnpm migration:check PASS106 tests17.74s and catalog137 immutable migrations,
  /tmp/bop-wp2402-kitchen-store-migration.log. No previously applied migration changed.
- Focused Kitchen ticket ownership8 testsPASS0.982s (544 unrelated cases not selected),
  /tmp/bop-wp2402-kitchen-store-ownership.log. Strict admission covers exact owner/schema/path/
  four owned tables and forbids a database driver. Actual ownership, module manifest and
  database permission validators PASS, session83079 exit0.
- Actual137-migration workflow-definition/confirmation/Kitchen DB PASS17.77s/body13.56s,
  /tmp/bop-wp2402-kitchen-store-db-retry.log, session59701 exit0. It connects actual original
  Order/source and persisted OrderConfirmed to the actual Kitchen service/consumer/repository.
  Work-item, Audit, Outbox, creation-record and Inbox-completion failures each demonstrably reach
  their selected boundary and roll back all7 counted artifacts. Concurrent consumers yield one
  Accepted and one AlreadyAccepted, one ticket/action/record/Audit/Event and the exact item count.
  A distinct semantically duplicate event adds only its Inbox row, recovering the original receipt.
  Identity collisions and revoked System authority deny. Original creation effect survives
  fixture-only work progress (not a lifecycle completion claim), immutable-row UPDATE/DELETE
  have zero effects, another Store sees no record, and historical intake still recovers after
  appended Order cancellation without re-reading source/plan/current creation eligibility.
- Initial DB run failed before Kitchen execution because the test imported an internal Ordering
  reader from the package root. Fixed the test to use the existing public outcome store's
  loadByPaymentEvent; did not add a private cross-module import or broaden exports.
  Initial log /tmp/bop-wp2402-kitchen-store-db.log retained. Only helper code changed after prior
  Kitchen/governance passes, so those passes remain valid and were not repeated.
- Helper ESLint, scoped formatting and diff whitespace checks PASS. No dependency/toolchain,
  actual Provider, runtime activation, commit or deployment change. No full regression rerun.

Business scenario evidence view now reflects actual Kitchen creation persistence. The fixture's
Payment facts, routing/preparation plan and System/merchant policy gates remain synthetic where
previously identified; this is not a complete real captured-Payment-to-Kitchen or browser journey.
Next replace synthetic plan provenance with current owner routing/preparation sources and compose
the complete release eligibility before Kitchen lifecycle/queue and runtime activation. Do not
reopen accepted Dining behavior or claim the single-store pilot complete.

### Persisted single-Station routing configuration

Section26.7 and WP-1402 resolve ownership: Kitchen owns Store Station/routing; Recipe owns
preparation instructions/capabilities. The WP-1402 pure planner deliberately left configuration
persistence absent. Under the authorized WP-2402 runtime completion scope, add only an immutable
Kitchen-owned single-Station configuration revision store and its internal authorized read/write
ports. No KDS device assignment is treated as Kitchen routing truth, no default Station/capability
is invented, and no human Permission seed or HTTP command is introduced.

Each Store configuration revision contains zero or one existing closed routing candidate, original
configuration evidence reference/version, effective-from instant, operation, named actor, explicit
purpose/permission/reason, recorded time and mandatory Audit. Creation/update compares expected
configuration version under the scoped configuration fence. Effective-from is no earlier than
recorded time and strictly increases over the prior revision; recorded time never regresses.
Existing Station/rule identities may keep a version only when their content is unchanged; changes
increment the owner version. New identities start at version1. Original-operation retry reauthorizes
and recovers original history; a changed operation intent conflicts. No previously applied bytes
are modified.

The read port strictly validates the existing ResolveKitchenStationRoutingEvidence System intent,
authorizes before configuration reads, holds the same configuration fence through dependent
Kitchen creation, selects the version effective at receipt.confirmedAt, and produces existing
per-rule/evidence digests at that exact instant. The minimum planner still rejects empty/inactive/
incapable evidence. Recipe preparation remains a separate actual-source dependency.

Owned files: Kitchen configuration domain/application and persistence, root1500_009 migration,
Kitchen manifests/public exports, scoped ownership admission/tests, catalog expected migration,
and the existing Kitchen database helper. Replace its synthetic final-plan stub with the real
planner and actual routing source; Recipe evidence and fixture operator capabilities remain
explicitly synthetic. Run affected Kitchen checks, migration:check, scoped ownership and actual
repository validators, and existing workflow-definition PostgreSQL suite. Full release/browser
and actual Recipe provenance remain outstanding; no pilot claim.

The single-Station routing configuration store is implemented. Every access fixes Brand/Store
context and authorizes before reading configuration. The common configuration fence remains held
through the caller transaction. Writes append a named-actor record and Audit, validate expected
revision/effective ordering, and compare Station and rule content against their last historical
occurrence (including removal/reintroduction), preventing an identity's version from silently
resetting. Operation replay does not repeat configuration validation or Audit but reauthorizes.
Reads select a configuration revision effective at the exact accepted release instant and derive
the existing time-bound rule/evidence digests. They neither choose a default Station nor derive
capabilities from KDS hardware or Recipe codes.

Fresh evidence on baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus WP-2402 worktree:

- Kitchen typecheck/lint PASS;13 files/276 testsPASS2.91s, including13 new configuration cases,
  /tmp/bop-wp2402-kitchen-routing-unit.log, session2012 exit0. Cases cover exact release digest
  binding, unchanged original history, invalid/overflow/extra metadata, backdating, malformed
  actor/purpose, altered digest/target, required owner version increments, identity reuse after
  removal and effective-time regression. Build uses the same tsc command and was not repeated.
- pnpm migration:check PASS106 tests18.06s;138 immutable migrations valid,
  /tmp/bop-wp2402-kitchen-routing-migration.log. New1500_009 only; earlier bytes unchanged.
- Focused ownership5 casesPASS0.929s (552 unrelated cases not selected),
  /tmp/bop-wp2402-kitchen-routing-ownership.log. Actual ownership/module/permission validators
  PASS, session24736 exit0. Admission is exact Kitchen owner/schema/path/table with no driver.
- Actual138-migration Workflow/Order-confirmation/Kitchen DB PASS17.76s/body13.75s,
  /tmp/bop-wp2402-kitchen-routing-db.log, session93670 exit0. Kitchen fixture now calls the real
  work-plan producer with the actual persisted routing source, instead of its former final-plan
  stub. Configuration absence, Audit rollback, write/gate rejection, concurrent original replay,
  changed-operation conflict, denied-read zero source queries, cross-Store/action rejection,
  future inactive revision and historical release-time selection, immutable UPDATE/DELETE and RLS
  all execute. The existing five Kitchen transaction failure boundaries and concurrent/semantic
  intake recovery continue to pass with actual routing and real planner.
- Helper ESLint/scoped formatting/diff checks pass. No dependency/toolchain, API/UI/Worker
  activation, Provider action, commit or deployment. No broad regression beyond the named affected
  database milestone; source/manifest checks were not repeated after passing.

The current scenario view now separates real routing persistence/planning from remaining Recipe
preparation evidence. Fixture Store facts and human/System policy capabilities are synthetic,
and no operational Station is provisioned outside the isolated test database. Recipe currently
stores versioned preparation step instruction/capability codes, while Kitchen requires bounded
instructions and capability references; do not invent a code-to-reference or instruction mapping.
Next implement the Recipe-owned evidence source and explicit reviewed content/capability bindings,
then compose current release eligibility and full runtime journeys. Pilot goal remains active
and unfulfilled.

### Recipe preparation content and configured effects

Section29.1/29.2/29.7 and WP-1402 require Recipe-owned instructions, duration, basic sequence/
parallel groups and capabilities. Existing RecipeSnapshot stores step instruction/capability
codes; current RecipeModifierRule stores ingredient changes only. Neither implies readable
instructions, capability UUID mapping, or an unchanged preparation effect for selected Options.

Add Recipe-owned preparation content bound exactly to Recipe version/preparation version/source
digest and every original step. Materialized steps retain the original code, sequence group and
duration plus explicit instruction text and capability reference. Add per-existing-Modifier-version
preparation content with explicit empty effects or Add/Remove/Replace step effects. Existing
modifier selection binds exact Product Option Binding, Option and quantity, so no quantity behavior
or complete Recipe copy per combination is inferred. Resolve only a complete matching selected
rule/content set; reject unknown, duplicate or conflicting step effects and preserve a deterministic
basic sequence/parallel grouping. Return preparation-only evidence without ingredients, cost,
allergens or Customer data. Verify canonical content/result digests.

Owned files for this increment: Recipe domain preparation-content contract/resolver, public
exports, focused Recipe test fixture and behavior tests. Authorization/publication/review and
actual persistence are separate mandatory source gates, not established by this pure resolver.
Next persist exact approved content and resolve actual Recipe/Option bindings before adapting to
Kitchen's existing bounded evidence. Run directly affected Recipe lint/typecheck/test and scoped
format/diff checks; no schema, dependency, API or runtime activation in the contract increment.
No declaration that Recipe preparation or the full pilot is complete follows from these tests.

Recipe preparation content contract/resolver is implemented. Base content binds every original
step's identity/code/sequence/duration plus explicit text and capability reference to the exact
Recipe/preparation version and source digest. Per-Modifier-version content additionally binds the
rule reference/version/digest and exact Binding/Option/quantity; an explicit empty change list
represents no preparation change, while missing content never implies that result. Independent
Add/Remove/Replace effects combine deterministically; colliding targets, missing targets, duplicate
identities/selections, unknown effects, empty final execution or ambiguous capability mappings
reject. Parallel groups retain their group numbers and deterministic ordering. Step-specific
explicit text may differ even when an instruction code repeats; no unapproved global instruction
dictionary restriction is imposed. Source data is immutable and the output excludes Ingredient,
cost and allergen facts. This pure function grants no authorization or review approval.

Fresh evidence, baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus WP-2402 worktree:

- Recipe typecheck/lint PASS;7 files/46 testsPASS0.899s, including24 new preparation-content cases,
  /tmp/bop-wp2402-recipe-preparation-content-final.log, command chunkc5191c exit0.
  New cases cover exact original bindings, explicit no-change option evidence, configured
  Add/Remove/Replace, stable ordering/parallel groups, conflicting effects, missing content,
  source/version/quantity mismatch, invalid text/duration/metadata, missing/duplicate targets,
  capability ambiguity, unpublished input, step-specific text, and bounded hashing failures.
- Initial lint stopped before unit execution on unused destructured digest variables; corrected
  binding construction. Intermediate44-test pass is retained at
  /tmp/bop-wp2402-recipe-preparation-content-unit.log. Review then removed an unnecessary shared
  instruction-code/text restriction and bounded hash dependency errors, requiring the final
  affected run above. No stale result is relabeled as covering those later changes.
- Scoped formatting and diff whitespace checks PASS. Build uses the same tsc command as
  typecheck and was not repeated. No schema/dependency/manifest/API/runtime change; no database
  or full repository regression is claimed or needed for this pure contract increment.

Next persistence work must bind actual publication/review evidence to these exact content digests,
read actual current Recipe and selected Modifier versions at the confirmation instant, and
provide the existing Kitchen evidence through a public owner composition. Do not default codes
to display instructions/capability IDs, infer no preparation change from ingredient-only rules,
or treat synthetic review/configuration facts as actual Store approval. Actual Recipe-to-Kitchen
persistence and the complete pilot remain unfinished.

### Reviewed preparation content persistence

Persist Recipe-owned Base/Modifier preparation content as immutable records bound to actual
published Recipe/Modifier versions, exact content digests and independent Cost/FoodSafety review
evidence. Reuse existing reviewer-independence validation with the reviewed subject explicitly
being the preparation content reference/digest; ordinary Recipe publication is not approval of
new readable text/capability mappings. Current writer authorization and a mandatory publication/
review-facts gate remain required. No actual approval is generated or inferred.

Add root1250_005 preparation-content table with Brand RLS, immutable history, scoped Recipe/
Modifier foreign keys, one Base content per Recipe version and one content per Modifier version,
and idempotent operation/Audit identity. Correcting a published preparation definition requires a
new owning Recipe/Modifier version rather than editing history. Reader authorization fixes the
System action/purpose/Brand/Store intent, reads actual published owner versions/reviews under
current configuration fences, and withholds content before its publication instant. Historical
operation replay reauthorizes but does not require the Recipe to remain currently active.

Owned files: Recipe preparation-publication domain/parser and owner store; root migration;
Recipe manifests/exports; exact ownership admission/tests; catalog inventory; existing Recipe
database suite/helper using its actual service-published Recipe and Modifier. Cover review binding/
independence, atomic Audit rollback, concurrent idempotency, mismatched content, revoked authority,
historical recovery, scoped RLS and immutable history. Required affected Recipe lint/typecheck/test,
migration:check, focused ownership plus actual repository validators, and existing recipe-management
DB command. Actual SKU/Option selection and Kitchen evidence adaptation follow separately.

Reviewed preparation persistence is implemented with caller-owned transactions, mandatory current
authorization/publication gates, exact independent review/content bindings, append-only scoped
storage, atomic Audit, concurrent operation recovery and owner configuration fences. Fresh reads
require currently usable published Recipe/Modifier sources; original authorized operation replay
can recover immutable history after the current Recipe is no longer usable. Public reads expose
content and publication identity/time only, excluding reviewer/author metadata.

Fresh database evidence: baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current
WP-2402 worktree; recipe-management acceptance PASS, 1 test, 14.71s total / 12.25s body,
session4538 exit0, /tmp/bop-wp2402-recipe-preparation-store-db-final.log.
The actual service-published Recipe and Modifier feed the real preparation store and resolver.
Coverage includes both Audit/content INSERT fault points with explicit reached assertions and
zero surviving rows, denied authority/publication, concurrent commit/replay, conflicting operation
content, review mismatch, explicit configured preparation effects, immutable history, Brand RLS,
and current-source removal versus historical replay. Both Base and Modifier reads return null
before preparation publication even though their owner versions already exist; reads at the
publication instant succeed. Reviews, capability mapping and authorization remain synthetic
fixture facts, not actual Store approval.

The preceding database run also passed (15.77s total), but lacked direct publication-time and
fault-point-reached assertions. Only the affected helper lint and database suite were rerun after
adding them. Initial helper lint rejected an unused initial assignment and stopped before database
execution; the assignment was corrected, without disabling lint. Final helper lint and repository
diff whitespace check PASS. No production source changed in this final test refinement.
Recipe 8-file/61-test typecheck/lint/unit evidence, migration:check 106 tests / 139 migrations,
focused ownership 9 tests and actual ownership/module/permission validators remain applicable
from the preparation-store runs: their covered source, configuration, toolchain and migrations
were unchanged by these helper-only assertions. Logs:
/tmp/bop-wp2402-recipe-preparation-store-unit.log,
/tmp/bop-wp2402-recipe-preparation-store-migration.log,
/tmp/bop-wp2402-recipe-preparation-store-ownership.log.
No full repository regression, runtime activation, commit, push or deployment occurred here.
Next: resolve actual SKU/Option Recipe bindings and compose reviewed preparation into Kitchen
evidence, retaining the transaction fences. Full paid-to-Kitchen journeys and pilot acceptance
remain incomplete.

### Recipe option resolution for Kitchen

Extend the existing public Recipe Modifier source with selected Option/quantity resolution when
Ordering's Kitchen projection does not contain a Product Option Binding reference. Recipe alone
resolves the unique published rule against the exact base Recipe version and confirmation instant;
multiple matching bindings/rules, missing rules or duplicate selected Options fail closed.
The existing explicit-binding API remains unchanged. This low-level source does not grant caller
authority; the eventual Kitchen composition must authorize before using it and retain caller
transaction/configuration fences. Own the existing Modifier source and Recipe DB helper only;
no foreign table access, new schema or runtime activation. Validate Recipe type/lint/unit and
actual Recipe DB selection, including wrong quantity and duplicate selections. Reuse unchanged
migration evidence. Full Recipe-to-Kitchen adaptation remains the next integration milestone.

The public Modifier source now exposes resolveOptions(base, options, at). It resolves by exact
Recipe version, Option and quantity across published effective rules, accepts exactly one row,
validates the actual rule/publication review and returns the owning binding with the rule.
Existing resolve(base, explicitBindings, at) retains its binding predicate. Duplicate selected
Options are rejected. This remains a low-level owner source, not an authorization boundary.

Fresh evidence on the same baseline plus WP-2402 worktree: Recipe typecheck/lint PASS, existing
8 files/61 unit tests PASS (0.918s), helper ESLint PASS and actual recipe-management PostgreSQL
suite PASS (14.89s total / 12.34s body), session64188 exit0.
Logs: /tmp/bop-wp2402-recipe-option-source-unit.log and
/tmp/bop-wp2402-recipe-option-source-db.log. New real-database assertions resolve the actual
published Modifier from Option/quantity without supplying its binding, reject a wrong quantity
and reject duplicate selections. Existing preparation persistence/replay assertions also pass.
The multiple-matching-rule rejection follows the existing exactly-one-row check but is not yet
directly exercised with multiple published bindings by these added database assertions.
Format and diff whitespace checks PASS. No migration or ownership table/path change; migration
evidence remains valid for unchanged schema inputs. No full regression or runtime activation.
Next integration must compose Base SKU resolution, unique selected Modifier resolution and
reviewed preparation reads under the same authorized caller transaction, retaining configuration
fences before producing the Kitchen evidence. Do not claim this API alone connects Kitchen.

### Transaction-bound configured preparation source

Compose actual Base SKU, selected Option rules and reviewed preparation reads inside the caller's
transaction using the existing Recipe configuration SHARE fence. Require explicit System action,
purpose, Brand/Store and current authorization before source SQL. Return preparation-only output
and binding/publication provenance; never return ingredients or reviewers. Own the existing Recipe
configured-source file/export and actual Recipe DB helper. No new tables or ownership paths.
Run affected Recipe checks and actual database composition, including current authorization denial
before source reads. Kitchen envelope adaptation is still separate.

Configured preparation composition is implemented through the public
createPostgresConfiguredRecipePreparationSource. It requires current System/purpose/Brand/Store
authorization before any configuration SQL, keeps the Recipe/ScopeBinding/Modifier SHARE locks
in the caller transaction, resolves actual SKU binding and unique selected rules, reads each
reviewed preparation publication and applies configured effects. Output carries binding and
publication references plus preparation-only content, without ingredient/reviewer snapshots.

Fresh evidence on a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus WP-2402 worktree:
Recipe typecheck/lint PASS; 8 files/61 unit tests PASS0.951s;
actual Recipe management DB PASS15.35s total/12.78s body, session23827 exit0.
Logs /tmp/bop-wp2402-configured-preparation-unit.log and
/tmp/bop-wp2402-configured-preparation-db.log. New DB assertions start from actual SKU206 at
Store500, resolve the actual published Recipe/Modifier and reviewed content, compare final steps
and publication provenance, exclude ingredient snapshots, reject before publication, and prove
denied authorization invokes zero SQL calls. Store/authority/reviewer facts remain synthetic.
Fresh actual database ownership and module manifest validators PASS, chunk536ecc exit0.
Scoped formatting/helper ESLint and diff whitespace PASS. No schema/dependency change;
prior migration checks remain applicable; no full regression or runtime activation claimed.
Next adapt this owner result to the Kitchen preparation evidence contract and replace the
Kitchen journey fixture's synthetic preparation source, then run the affected complete journey.

### Readable preparation projection for current Kitchen contract

Current KitchenPreparationSnapshot carries readable instructions, not structured execution steps.
Add a Recipe-owned readable projection alongside the authoritative structured preparation result:
each instruction states sequence group (equal groups may run in parallel), duration in seconds,
and complete authored text. Keep capability UUIDs explicit and deduplicated. No truncation,
translation of authored text or implicit zero-duration/default capability. This supports current
KDS display; it does not implement structured Kitchen scheduling. Kitchen's existing 32/500
envelope limits must fail closed at adaptation; do not trim actual Recipe content to fit them.
Own Recipe preparation domain helper/export (existing wildcard), configured-source return and
focused tests plus actual DB assertions; run affected Recipe checks and Recipe DB acceptance.

Readable Recipe projection now accompanies configured preparation output. It preserves each full
authored instruction, explicit sequence group/parallel interpretation and seconds, and emits
deduplicated capability references. Structured steps and their digest remain authoritative.
This changes neither Kitchen's schema nor its execution scheduling. The current Kitchen 32-line/
500-code-point limit still requires explicit adapter rejection for oversized projections.

Fresh evidence on the same baseline plus current WP-2402 worktree: Recipe typecheck/lint PASS;
8 files/64 tests PASS0.962s including three new display cases (full500-character text without
truncation, sorted sequence groups/deduplicated capabilities, invalid/empty steps rejected).
Actual Recipe DB suite PASS15.55s total/12.83s body: the real configured Modifier's 90-second
effect appears in composed display with actual capability references.
Logs: /tmp/bop-wp2402-preparation-display-unit.log and
/tmp/bop-wp2402-preparation-display-db.log. Helper ESLint, formatting and diff whitespace PASS.
Initial typecheck caught a wrong local array helper name; corrected to existing strict array
parser. Initial lint caught non-null assertions in new tests; replaced with explicit fixture
guards. No check was bypassed. No SQL/schema/ownership changes; preceding ownership and migration
evidence covers unchanged inputs. API/Kitchen runtime adapter and actual Recipe-backed Kitchen
journey remain to implement; this display projection alone does not close that integration.

### Kitchen / Recipe API composition

Add API composition using public Kitchen and Recipe contracts only. Kitchen owns strict parsing of
its preparation request; API authorizes exact Brand/Store/source evidence before invoking the
transaction-bound Recipe source. Map complete display/capabilities without truncation and bind
derived immutable preparation/evidence identities to original source and resolved Recipe digest.
Representation version1 identifies each derived immutable snapshot, not a fabricated Recipe
version. Enforce existing Kitchen bounds via its parser. No SQL or new business rules in API.
Own Kitchen request parser/public exports, API composition/tests and direct workspace Kitchen
dependency/lockfile. Run affected Kitchen checks; required API lint/typecheck/test/build; dependency
install with pinned tools and frozen lockfile; actual ownership/import validators. A real DB
composition assertion should use the existing actual Recipe fixture. Full Order/Kitchen journey
replacement and runtime activation remain follow-up integration work.

Kitchen / Recipe composition now exists in apps/api/src/kitchen-recipe-preparation-source.ts.
It uses only public contracts and the caller transaction, validates the exact Kitchen request,
authorizes the configured Brand/Store and source evidence before Recipe reads, checks returned
scope/SKU/time, and returns Kitchen-parsed preparation evidence. Identity/digest bindings include
the original source/version/digest/line plus actual Recipe binding/publications/structured result
and readable projection. Derived immutable snapshot representation version is1; it is not the
Recipe version. Recipe/Kitchen branded IDs are explicitly compared at the composition boundary.
No dependency exception, foreign SQL, new HTTP route or runtime activation was added.

Fresh evidence on baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree:

- pnpm install --lockfile-only --offline then pnpm install --offline --frozen-lockfile PASS,
  pinned pnpm11.13.0, /tmp/bop-wp2402-kitchen-recipe-install.log. API gains @rms/kitchen workspace
  dependency. Existing wider WP worktree manifest/lock changes are retained.
- API typecheck/lint/test/build PASS,56 files829 tests7.29s, session46761 exit0,
  /tmp/bop-wp2402-kitchen-recipe-api.log. Four added tests cover wrong Store, denied authority
  with zero Recipe/SQL calls, same transaction/exact intent and bounded dependency failure,
  unknown fields and duplicate source lines. Initial typecheck identified cross-domain branded
  reference comparisons; fixed explicit conversion, not weakened identifier types.
- Kitchen typecheck/lint PASS;13 files276 tests2.75s, and actual Recipe DB suite
  PASS15.64s total/12.78s body, session88676 exit0.
  /tmp/bop-wp2402-kitchen-recipe-kitchen.log and /tmp/bop-wp2402-kitchen-recipe-db.log.
  DB assertions compose actual SKU/Recipe/Modifier/reviewed content through the API adapter into
  Kitchen evidence, retain 90-second instructions and source quantity, verify canonical evidence
  digest, deterministic identical replay, and changed source digest changing preparation identity.
  Order source IDs/data and reviewer/Store/authority facts are synthetic in this Recipe fixture;
  the existing full Ordering-to-Kitchen journey still uses its prior synthetic preparation source.
- Actual database ownership/module validators PASS chunk764abf; import boundaries PASS chunk8c1fd7.
  Scoped formatting, helper ESLint and final diff whitespace PASS. No new schema or full verify.

The adapter enforces current Kitchen bounds through its parser; oversized projection rejection
is not yet directly exercised by these new adapter tests. Structured execution scheduling remains
outside this readable contract. Next replace the Ordering-to-Kitchen fixture's preparation source
with actual Recipe publication/bootstrap and this adapter, test the complete transaction and
oversized projection boundary, then progress Kitchen execution/handoff. Pilot remains incomplete.

### Actual Recipe-backed Ordering-to-Kitchen journey

Replace the existing Kitchen creation helper's synthetic preparation evidence with real Recipe
service Draft/Publish, Modifier service Draft/Publish for the Order's actual selected Options,
reviewed content store and API adapter. Fixture-only Brand permission/review/ingredient facts
and Store capability mapping remain synthetic and explicit; publication/history/Audit/Outbox,
SKU binding resolution, Recipe reading, Order source and Kitchen transaction are real.
Use isolated test DB only. Preserve existing Kitchen fault injection/concurrent replay/cancellation
recovery cases. Owned files are database test-support Recipe bootstrap plus existing Kitchen/helper
call; no production source or schema changes. Run helper lint and the existing workflow-definition
DB journey; prior API/Kitchen checks cover unchanged production sources.

The existing published Workflow -> actual Order acceptance/confirmation -> Kitchen consumer
journey now bootstraps Recipe through real CreateDraft/Publish services and PostgreSQL stores.
Actual Order SKU and selected Option/quantity resolve scoped bindings; selected rules are created/
published through the Modifier service, preparation content is stored with bound review evidence,
and the real API adapter supplies Kitchen evidence. Actual Store routing and the real planner
write ticket/work-item/action plus Audit/Outbox/Inbox/original creation record atomically.
Synthetic external Ingredient/reviewer/permission/Store facts remain explicitly fixture-only;
the parent journey's Payment evidence is still synthetic, not the configured captured-Payment path.

Fresh workflow-definition database acceptance PASS18.11s total/14.04s body, session69028 exit0,
baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree.
Log /tmp/bop-wp2402-real-recipe-kitchen-journey-final.log.
The new assertions prove Recipe read revocation and injected oversized owner display produce no
Kitchen ticket/work-item/action/Audit/Outbox/Inbox; the latter is a response-boundary injection,
not a mutation of stored reviewed content. Persisted preparation_instructions_json exactly matches
the actual resolved 60-second Base or 90-second configured Modifier instructions, retaining full
text and sequence group. Existing five explicitly reached transaction failure boundaries,
concurrent Accepted/AlreadyAccepted, semantic replay, scoped authority/RLS, immutable history and
recovery after actual Order cancellation pass with the real Recipe source.
The first integrated run also passed18.70s but lacked the new denial/persisted-instruction
assertions; retained at /tmp/bop-wp2402-real-recipe-kitchen-journey.log.
Only changed helpers' format/ESLint and the affected complete DB journey were rerun. No production
source, schema or dependency changed since the preceding API/Kitchen checks, so their exact source
coverage remains applicable; no new API/unit/full-verify run is claimed. Final diff whitespace PASS.
Next join this positive acceptance/Recipe/Kitchen path with actual captured Payment and resource
release evidence, and implement current Kitchen execution/queue/handoff. Pilot remains incomplete.

### Captured Payment to accepted Order and Recipe-backed Kitchen

Preserve existing cancelled-after-capture cases and add positive cases for both quote versions
and both Dining/Pickup. Extend the synthetic isolated published Workflow fixture with explicit
Accept and ReleasePaidOrder transitions; this is test configuration, not adopted Store policy.
Use actual captured context (capacity and Inventory fences), merchant acceptance composition,
published action evaluation, disposition consumer and existing real Recipe/Kitchen journey.
The configured intact-reservation prerequisite uses actual Inventory facts; external merchant/
System eligibility and remaining lot/food-safety policy facts stay explicit synthetic gates.
Own only database helpers and the two configured-journey test matrices. Verify focused new cases
first, then unaffected cancelled cases if shared fixture changes warrant the affected regression.

Captured-payment positive integration is implemented in test-support/captured-order-kitchen.mjs.
Both Dining and Pickup matrices now retain quote1/quote2 cancellation cases and add quote1/quote2
positive cases. Published isolated Workflow configuration explicitly includes Accept and a
ReleasePaidOrder Accepted self-transition with the actual intact-reservation prerequisite.
Merchant acceptance reads actual captured context/current capacity/Inventory under caller fences;
the outcome consumer re-reads that context and persists confirmation, then the real Recipe-backed
Kitchen helper consumes it. External merchant/System authority and remaining eligibility policy
facts are synthetic. No production policy default, Provider network call or runtime activation.

Fresh initial positive results on the current WP-2402 worktree:

- Pickup quote1 PASS44.53s total/39.38s body, session35258 exit0,
  /tmp/bop-wp2402-captured-kitchen-pickup-retry.log.
- Dining quote1 PASS61.84s total/56.57s body, session45125 exit0,
  /tmp/bop-wp2402-captured-kitchen-dining.log.
- Initial Pickup positive run failed both cases because the reused routing fixture's failAudit
  option was discarded by the new runner wrapper. Fixed forwarding with the actual Audit failure
  injection and removed extra fields from the strict Order Kitchen query. Failure log retained:
  /tmp/bop-wp2402-captured-kitchen-pickup.log. No production assertion or gate was weakened.
- Modified helpers/matrices format and ESLint PASS; diff whitespace PASS.
  Remaining affected tests are running: Pickup session33858 and Dining session13994, each selects
  positive=false OR configured=true,positive=true. This excludes the already passing quote1 positive
  case and covers the changed shared Workflow fixture's original cancellation paths plus quote2
  positive. Logs /tmp/bop-wp2402-captured-kitchen-pickup-remaining.log and
  /tmp/bop-wp2402-captured-kitchen-dining-remaining.log. These runs are not yet claimed passed.
  No API/Recipe/Kitchen production or schema/dependency inputs changed in this integration increment;
  prior affected production checks remain source-valid, not fresh runs.

Remaining matrix results: Pickup session33858 exit0,3 selected cases PASS (quote1 cancellation
36.73s, quote2 cancellation38.37s, quote2 positive40.52s), total120.90s. Together with the unchanged
quote1 positive run this covers all four Pickup cases; no full four-case command is claimed.
Dining session13994 exit1: quote1 cancellation PASS56.96s and quote2 cancellation PASS47.90s;
quote2 positive failed after8.02s with local test DB ECONNREFUSED, before positive-path completion.
The failure is not a passed business check. No source changed: only that case is being retried
in standalone session67386, /tmp/bop-wp2402-captured-kitchen-dining-configured-retry.log.
Do not restart this confirmed running handle merely because an observation times out.

Final missing case: Dining quote2 positive PASS56.11s total/50.99s body, session67386 exit0,
/tmp/bop-wp2402-captured-kitchen-dining-configured-retry.log.
No source changed between failed local-connection attempt and successful standalone retry.
Combined explicit run evidence now covers all8 cases: Dining/Pickup x quote1/quote2 x
positive/cancelled-after-capture. Selected-out cases in each command are covered by the cited
unchanged runs, not falsely labeled fresh passes. Final diff whitespace PASS; no running checks.

The positive milestone proves original persisted Identity/Cart/Quote/submission, real owner
capacity/Inventory facts, durable Payment provider-observation/terminal history, published
Workflow/merchant acceptance, OrderConfirmed consumer, actual Recipe/Modifier/reviewed-content
storage and actual Kitchen ticket/work-item/Audit/Outbox/Inbox. Provider transport, Store operator/
System capabilities and external eligibility/review facts remain synthetic. It does not prove
live Provider activation, full food-safety/resource release policy, Kitchen lifecycle/queue,
fulfillment/receipt/refund/ops or actual pilot readiness. Next implement Kitchen lifecycle
persistence and connect current Start/Complete/Ready sources and queue before fulfillment handoff.

### Kitchen lifecycle immutable record representation

Before adding the PostgreSQL lifecycle repository, add version1 storage encoding of the existing
fully validated lifecycle effect. Reuse the service's complete intent/operation/mutation/Audit/
Event/Ready semantic validation with only reference/digest ports. Restore bigint only at explicit
storage paths; command/result/event-payload version strings remain strings. Reject unknown record
versions, missing/tampered fields and noncanonical/out-of-range database versions. No authority
grant, new event or schema in this increment. Own Kitchen service validation extraction, record
codec and existing lifecycle service tests. Cover Accept/Start/partial/full completion, automatic
and manual Ready plus corruption, using real service-generated effects. Run Kitchen type/lint/
tests and scoped formatting; the actual lifecycle repository and DB journey remain next work.

Kitchen lifecycle record version1 codec is implemented. The existing full service effect parser
is now an internal reusable export with only deterministic references/digests required; live
authorization, admission, Expo, clock and repository ports are not invoked to validate history.
Encoding validates before serialization. Decoding restores PostgreSQL bigint versions only at
explicit operation/mutation/admission/captured-Expo/Ready/event envelope paths, while command,
result and event payload version strings retain their contract types. Full semantic validation
then checks intent, mutations, Audit/Event and Ready bindings.

Fresh Kitchen typecheck/lint PASS;13 files290 tests PASS2.90s, session85581 exit0,
/tmp/bop-wp2402-kitchen-lifecycle-record.log, baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26
plus current WP-2402 worktree. Fourteen added cases cover service-generated Accept, Start,
partial/full Complete with Expo Enabled/Disabled, eight corrupt version encodings and record
version/actor tampering. The existing manual Expo Ready test now also proves exact codec recovery,
including preserved captured decision and ready events. Scoped formatting/diff whitespace PASS.
No DB/schema/dependency/API changes, so no database/full regression was run for this record-format
increment. This is not lifecycle persistence or pilot completion. Next add the owner PostgreSQL
repository with row-version fencing, original operation recovery and atomic Audit/Outbox/Ready
writes, then join actual current admission/Expo/queue and fulfillment sources.

### Lifecycle storage schema extension

Add nullable effect_record_json to the existing append-only lifecycle operation table through
new root1500_010 migration. Existing rows and automatic child operations remain unchanged; new
idempotent command writes will persist the full codec record. Bind record version/shape,
operation and scope/target identities, versions, idempotency, effect digest and Audit/Event IDs
to existing columns with null-safe checks. Existing forced RLS and immutable triggers protect the
new field. Never backfill invented prior effects or treat a missing record as recoverable.
Own migration/catalog and existing lifecycle DB schema test; run migration:check and that DB
suite. These database binding checks complement, not replace, full service codec validation.
Repository writes/source reads remain the next implementation step.

New 1500_010_alter_kitchen_lifecycle_effect_record migration adds the immutable operation record
column and null-safe binding constraints. Existing NULL history and automatic children are
preserved, not backfilled. The existing append-only trigger protects the new column. New command
writers will store the complete previously validated codec record; missing historical records
must fail recovery rather than fabricate an effect.

Fresh evidence, baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current WP-2402 worktree:
migration:check PASS106 tests18.85s and140 immutable migrations; actual lifecycle DB schema suite
PASS11.63s total/11.36s body, session69861 exit0.
Logs /tmp/bop-wp2402-kitchen-lifecycle-record-migration-final.log and
/tmp/bop-wp2402-kitchen-lifecycle-record-db.log. New direct SQL assertions reject changes to all16
identity/version/Audit/Event/intent bindings, empty/unknown/extra-field record envelopes, recover
the correctly column-bound JSON and reject clearing it through UPDATE. Existing lifecycle,
Ready, uniqueness and Store RLS tests still pass with legacy NULL rows.
These are storage binding assertions with explicit minimal SQL fixtures; complete semantic effect
validation is separately covered by the preceding service codec tests. No fabricated full effect
is claimed for those SQL fixtures.
Initial helper lint required explicit globalThis.structuredClone; corrected. Initial migration
catalog run rejected unsupported filename action 'add' (6 catalog failures;100 tests passed),
before any DB test. Renamed this unapplied new migration to permitted 'alter'; failure log retained
at /tmp/bop-wp2402-kitchen-lifecycle-record-migration.log. No applied migration was edited.
Helper lint/format and diff whitespace PASS. No production service/API change or full regression.
Next implement lifecycle owner repository commit/source/idempotency using this field, existing
normalized operations/Ready tables and public Audit/Outbox in the same caller transaction.
The complete Kitchen execution/queue and pilot remain unfinished.

### Lifecycle normalized row mapping

Map the validated lifecycle effect to existing operation, automatic Ready child, item Ready result
and Ready publication columns. Preserve original codec record on the command operation only;
automatic child has no independent idempotency identity. Use decimal strings for PostgreSQL
bigint and JSON work-item versions. Keep captured Expo source/decision provenance, Audit/Event
semantic digests and Ready causation exact. This owner persistence helper executes no SQL and
grants no authority. Own helper and existing service-generated record tests; verify Kitchen
type/lint/tests and review mapped columns against existing migration schemas. Atomic repository
commit/load remains the next consumer of these mapped rows.

Actual ownership validation rejected the new persistence helper path. Extend the WP-owned exact
file admission only for @rms/kitchen/rms_kitchen and all three declared lifecycle/Ready tables;
add focused wrong-owner/schema/path/missing-table and driver rejection cases. No generic
persistence or foreign table exception is authorized. Run those focused cases and actual validator.

Lifecycle row mapping is implemented for all67 operation,34 Ready-result and21 Ready-publication
columns, with captured Expo fields shared explicitly. Command rows retain complete original codec
records; automatic children retain separate Audit/effect identities and no independent command
record/idempotency key. Version values and Ready work-item JSON versions use decimal strings.
No SQL execution or current authority is implied by this helper.

Fresh Kitchen typecheck/lint PASS;13 files290 tests PASS2.71s, session11174 exit0,
/tmp/bop-wp2402-kitchen-lifecycle-rows.log. Existing service-generated codec cases now additionally
verify normalized rows for Accept/Start/partial/full completion, automatic child causation/Audit
separation, Ready publication IDs and manual Ready captured Expo ancestry.
Read-only column inventory comparison against1500_003/004 plus010 confirms exact67/34/21 column
sets (chunk0d9bb6); this checks names/completeness, not SQL value/constraint execution.
Ownership originally rejected the new unregistered path. Added exact Kitchen/schema/path/three
table admission;7 focused cases PASS1.03s including wrong owner/schema/path/missing each table and
driver rejection;566 unselected cases not claimed run. Actual ownership PASS, chunk827b51.
/tmp/bop-wp2402-kitchen-lifecycle-rows-ownership.log.
Formatting and diff whitespace PASS. No schema/dependency/API changes; no new database/full
regression run. Next implement the actual repository transaction using these rows and codec,
current normalized source reads, version fences and public Audit/Outbox. Pilot remains incomplete.

### Lifecycle atomic writer

Implement owner lifecycle transaction writer in kitchen-work-lifecycle-store.ts using validated
normalized rows. Require current caller authorization and source validation; lock ticket then
target work item and reject stale versions before writes. Persist status/version, command/automatic
operations, Ready result/publication and public Audit/Outbox in one caller transaction. Use a
savepoint so a caller catching an error cannot commit partial mandatory effects. Current-source
loader and original recovery will compose this writer next. Run affected Kitchen type/lint/tests
and actual lifecycle PostgreSQL acceptance when the composition is connected; no pilot Done claim.

Lifecycle writer draft now performs current gate callbacks, ticket/item row locks, pre-write
version/status/quantity conflict checks, scoped updates and normalized operation/Ready plus
public Audit/Outbox writes. Savepoint rollback protects mandatory effects when an outer caller
catches a write failure. No independent transaction or connection is created.
Fresh typecheck initially found missing empty query parameter arrays; corrected. Kitchen
typecheck and lint then PASS (session84155 exit0). This is compile/lint evidence only:
writer is not exported or connected; original-operation recovery, normalized source loading,
ownership exact-path admission with negative tests and real PostgreSQL writer acceptance are
still required. Existing database tests do not prove this new writer. No full regression rerun.

Lifecycle repository now adds owner-scoped original effect recovery with current authorization,
locked current ticket/item reads, validated historical predecessor/Expo/Ready reconstruction,
and rejection of unexplained normalized progress or missing original evidence. Public factory
is exported; caller still supplies real authority and cross-owner current eligibility.
Exact ownership admission covers only this Kitchen path and five declared owner tables.
Nine focused ownership cases PASS (573 unselected), actual ownership validator PASS.
The existing isolated lifecycle database acceptance now drives actual service Accept, Start,
Complete with automatic Ready, original retries after progress, normalized Ready loading and
Audit/Outbox write failure injection. Initial run PASS13.95s (11.45s body), session42580 exit0,
/tmp/bop-wp2402-lifecycle-store-db.log. Authority/admission/Expo remain synthetic fixture decisions.
Strengthen failure test to catch repository failure inside an outer transaction that commits;
add stale direct commit and wrong-Store recovery checks. Fix two new helper lint findings.

Final lifecycle owner persistence evidence:

- Fresh Kitchen typecheck PASS (chunk3c2513); Kitchen lint PASS (chunkb75a55).
- Existing service/codec/row unit evidence remains from session11174: those implementation/test
  inputs, dependency manifests, lockfile and pinned toolchain were unchanged by this repository
  addition. It does not cover SQL; actual new SQL is covered separately below.
- Nine exact-path ownership tests PASS1.05s,573 unselected; actual validator PASS (chunkb75a55).
- Database helper lint corrections PASS before final SQL runs. Savepoint test now explicitly
  catches writer failure inside a transaction that then COMMITs: original ticket version1 and
  zero operation rows remain after both Audit and Outbox injected failures.
- Automatic Ready source/recovery/stale-write/wrong-Store checks PASS14.38s (11.88s body),
  session59640 exit0, /tmp/bop-wp2402-lifecycle-store-db-final.log.
- Added actual Expo Enabled/manual Ready alongside Disabled/automatic Ready. First combined
  run failed because two same-Store fixture tickets reused a command idempotency key, before
  the intended fault point; production correctly refused it. Give fixture commands ticket-specific
  keys. Final combined existing schema+service/repository acceptance PASS13.61s (11.29s body),
  session30578 exit0, /tmp/bop-wp2402-lifecycle-store-expo-db-retry.log. Both modes verify original
  retries after progress, current predecessors/captured Expo/Ready, and one Ready publication.
  Failed fixture run retained in /tmp/bop-wp2402-lifecycle-store-expo-db.log.
- PostgreSQL service writer checks here use the isolated administrator connection with explicit
  tenant scope; existing schema RLS assertions use the restricted role. This is not a composed
  least-privilege runtime or concurrent-command proof, and synthetic permission/admission/Expo
  decisions are not real Store policy evidence.
  No schema/manifests/lockfile changes in this increment. Full regression not rerun. Next connect
  this public repository to the actual paid-order Kitchen journey, with current owner gates,
  restricted-role transactions, multi-item progress and concurrent command evidence; then onward
  Ready consumption/fulfillment and visible operator/customer flows. Full pilot remains incomplete.

### Paid Kitchen lifecycle composition

Replace fixture-only Kitchen progress SQL in the existing real ticket-creation journey with
actual lifecycle service/repository commands under its restricted role and caller runner.
Use actual Ordering source fences before Kitchen locks; keep remaining operator/admission/Expo
policy evidence explicitly synthetic. Drive each actual ticket item through Accept/Start/Complete,
race distinct initial commands and duplicate commands, recover original records and assert one
order Ready publication only after every item is Ready. Own test-support/kitchen-paid-lifecycle.mjs
and its invocation in kitchen-ticket-creation.mjs. Run selected real Pickup and Dining positive
composition scenarios; broaden only on failures or changed covered inputs.

Paid lifecycle composition results:

- Replaced fixture-only UPDATE progress in kitchen-ticket-creation.mjs with actual public
  lifecycle service/repository. Real Ordering source evidence is re-read/fenced; role receives
  only required lifecycle/Ready SELECT/INSERT and ticket/item UPDATE fixture grants. Audit,
  Outbox and existing runtime transaction permissions remain the prior restricted runner.
- Initial Pickup attempts failed before SQL with KITCHEN_WORK_INPUT_INVALID. Diagnosis found
  ownerScope includes tenantReference; spreading it into the strict Kitchen command/authority
  contract was invalid. Map only Brand/Store at this adapter boundary. No production parser
  or permission was loosened. Diagnostic logs include only static SQL prefixes/error codes.
  Logs: /tmp/bop-wp2402-paid-kitchen-lifecycle-pickup.log,
  /tmp/bop-wp2402-paid-kitchen-lifecycle-pickup-diagnostic.log and
  /tmp/bop-wp2402-paid-kitchen-lifecycle-command.log. The latter repeated the same failed
  input because a diagnostic text replacement did not match; no pass is claimed.
- Pickup quote1 positive PASS44.17s/38.32s body, session93899 exit0,
  /tmp/bop-wp2402-paid-kitchen-lifecycle-pickup-fixed.log.
- Dining quote2 positive PASS53.82s/49.03s body, session82060 exit0,
  /tmp/bop-wp2402-paid-kitchen-lifecycle-dining.log.
  Each selected one of four cases; three unselected per command. Existing other combinations'
  old ticket-only evidence is not claimed to cover this changed lifecycle invocation.
- Each proves a distinct-key concurrent Accept race has one success and one rejection,
  Start and full Complete, one item and order Ready publication, exact retry after progress,
  current permission revocation and unchanged original ticket-creation recovery.
- Inspection showed these paid fixtures have one item. Added a separate actual normalized
  two-item case with independent PostgreSQL connections to lifecycle acceptance; no order
  publication after first Ready, exactly one after last Ready, and same-key concurrent Accept
  returns the same original result. Uses administrator connections and synthetic Ordering source;
  restricted-role real payment cases above are separate evidence.
  Existing lifecycle schema/service acceptance with the added two-item case PASS14.02s/11.68s body,
  session66502 exit0, /tmp/bop-wp2402-paid-kitchen-multi-item.log. Existing manual Expo and
  savepoint failures remain covered in that same run.
- Affected helper/database lint PASS. No production code, migration, dependency or toolchain change
  in this composition increment; previous Kitchen type/lint/owner tests remain unchanged evidence.
  No full verify or unaffected cancellation rerun. Final diff whitespace PASS.
  The next missing owner boundary is Fulfillment: its KitchenItemReady service and 1700_001/002/005
  schemas exist, but readiness and pickup repositories are absent. Implement actual aggregate
  initialization from accepted Order public contracts, readiness consumption and persisted handoff;
  do not fabricate a Fulfillment aggregate in the real paid flow or treat synthetic Start/Expo gates
  as deployed Store policy. Visible queue/operator runtime and the complete pilot remain unfinished.

### Pickup fulfillment owner persistence

Implement application/pickup-fulfillment-record.ts and owner persistence/pickup-fulfillment-store.ts.
Use existing immutable fulfillment/item/creation-operation schema; persist exact original effect
in a nullable new operation record column through 1700_009_alter_pickup_fulfillment_record.sql.
No legacy backfill, state overwrite or Dining-to-Pickup conversion. Strict codec validates effect
and semantic digests, restores only source aggregate bigint. Recovery requires current authority;
new creation requires current Ordering owner fences before Fulfillment fences. Caller service
retains mandatory Audit and Inbox transaction ownership. Add owning migration catalog entry,
exact database asset admission and affected codec/store/database tests. Full paid-Pickup creation
and Kitchen Ready consumption remain the broader milestone after actual Ordering source wiring.

Pickup fulfillment persistence implementation/evidence:

- Added public createPostgresPickupFulfillmentStore: exact Brand/Store authorization on recovery
  and creation; mandatory current source callback before sorted Order/confirmation/event fences;
  immutable root/item/creation-operation writes in a savepoint; original record recovery and
  same semantic binding convergence. Caller Pickup service owns mandatory Audit and Inbox in
  the same outer transaction. No connection creation or cross-domain SQL in this owner store.
- Added strict version1 codec preserving only sourceAggregateVersion as bigint; all other original
  types are unchanged. Validate full effect and semantic binding digests before encode/after decode.
  Added nullable creation_record_json to existing append-only operation with16 null-safe column
  bindings and closed record envelope. Legacy NULL remains unavailable to new recovery; no backfill.
- Fresh Fulfillment typecheck PASS (chunk095188, and final session27693); lint PASS.
  20 files317 unit tests PASS3.41s (chunk8eab8a),
  /tmp/bop-wp2402-pickup-fulfillment-unit.log. Includes9 new codec cases for exact service-generated
  roundtrip, malformed bigint versions, quantity/digest tampering and closed record envelope.
- Migration check PASS106 tests18.79s, catalog141 immutable migrations,
  /tmp/bop-wp2402-pickup-fulfillment-migration.log. No old migration bytes changed.
- Seven focused exact-path ownership cases PASS1.02s,582 unselected; actual ownership validator
  PASS (session6142 output). New helper lint initially found an unused reached initializer;
  removed it and final helper lint PASS.
- Actual existing Pickup schema acceptance now exercises real service/repository/Audit/Inbox,
  root/item/operation writes, original replay, repository authority revocation, immutable JSON,
  and four reached failure points: item INSERT, operation INSERT, Audit INSERT, Inbox UPDATE.
  Each rolls back all root/operation/Audit/Inbox effects. Source and current authority are synthetic,
  and this extension uses administrator connection; existing schema RLS tests remain separate.
  First PASS14.37s (session99420), final with malformed/version/identity/source-binding SQL
  rejection checks PASS14.27s/11.60s body (session27693 exit0),
  /tmp/bop-wp2402-pickup-fulfillment-store-db-final.log.
- Final diff whitespace PASS. Unchanged manifests/lockfile/toolchain retain prior valid installation
  evidence; no new install or full regression claimed. Full real paid Pickup + Ready consumption
  is not yet connected, so this is owner persistence evidence rather than pilot readiness.
  Next add the actual Ordering fulfillment public source using original Order snapshots and
  confirmation/initial execution gates, then persist Fulfillment Ready consumption. The existing
  Pickup consumer currently resolves source before recovery, which must be considered explicitly
  for later terminal-state historical retries. Dining remains its own serving/closure path.

### Actual Ordering fulfillment source

Own application/order-fulfillment-snapshot.ts, persistence/order-fulfillment-source-store.ts and
public input parser/export, plus focused snapshot/ownership tests. Reuse Ordering's existing
initial execution, confirmation disposition and immutable submission readers; check accepted
checkpoint and exact event/snapshot in caller transaction before exposing quantity-only fulfillment
evidence. No foreign SQL, current catalog re-read, or customer note/pricing output. Both quote
formats and DineIn/Pickup retain original order type; Pickup service decides applicability.
Wire into actual captured-order helper and run the selected Pickup positive composition including
real Fulfillment creation/Audit/Inbox. Broader Ready/handoff remains next.

Ordering fulfillment source implementation now reads actual initial execution/confirmation and
immutable submission snapshots under the caller transaction. It exposes order type and exact
quantity-only lines with canonical line/evidence digests; no catalog display, options, note,
pricing or Payment details cross into this contract. Public input parsing is shared by its
source service and owner store. Exact source checkpoint/event/hash and current authorization
are checked before returning evidence. Scope is explicitly Brand/Store.
Fresh Ordering typecheck PASS (chunk665850); lint and7 directly affected source/snapshot tests
PASS2.24s (chunk8efe99). Eleven focused ownership positive/negative cases PASS1.28s,
589 unselected; actual ownership validator PASS (chunk283866).
Actual configured Pickup positive composition now additionally creates Fulfillment Pending
root/items/operation with real Ordering evidence and public Audit/Inbox through restricted role,
then continues real Kitchen lifecycle. Repeated event returns original effect and stored item
quantities equal original Order quantities. PASS45.90s/40.84s body (session12481 exit0),
/tmp/bop-wp2402-real-order-fulfillment-pickup.log; three unselected cases not claimed run.
Dining quote1 positive PASS60.68s/55.95s body (session20937 exit0),
/tmp/bop-wp2402-real-order-fulfillment-dining.log. Actual DineIn source returns NotApplicable
to Pickup creation and leaves zero Pickup aggregates for that Order. Three unselected cases
are not fresh runs. No live Provider or Store capability facts are supplied.

Next readiness persistence plan: use existing Fulfillment-owned initial records plus append-only
Ready operations/results to reconstruct current Pending/Ready, validate contiguous versions and
exact item quantities, and serialize per Order. Detect existing pickup handoff history rather
than report already handed-over items as Pending/Ready. Original replay must use immutable
Ready effects; new effects require current authority. Persist full original Ready effect in an
owning nullable record extension; legacy missing effects remain unavailable rather than fabricated.
Service owns Audit/Inbox transaction. Consume actual KitchenItemReady public envelopes, never
Kitchen private tables or KitchenOrderReady alone; only all individual items make Fulfillment Ready.

Final helper lint and source/store/test formatting PASS; diff whitespace PASS. No migration,
manifest, lockfile or toolchain change in this source-wiring increment. Reuse prior valid
installation; no full regression or unchanged owner unit suite repeated. New source logic is
covered by7 focused tests and both actual quote formats above. Ready consumption, handoff,
receipts, operator runtime and full pilot remain outstanding.

### Fulfillment Ready implementation files

Own application/fulfillment-ready-record.ts, persistence/fulfillment-readiness-store.ts,
1700_010_alter_fulfillment_ready_record.sql and catalog/ownership admission/tests. Reuse the
existing service semantic binding (export it without changing meaning). Persist original effect
on Ready operation; read current state from immutable initial items and contiguous Ready history,
reject missing/corrupt history and any handoff. Validate exact scope/order/batch/item/quantity
and versions before append; caller owns Audit/Inbox. Add real KitchenItemReady callback in paid
journey helpers to invoke this owner consumer after producer transaction commits. Test affected
owner code, migration and actual paid Pickup Ready; no handoff/receipt completion claim.

Fulfillment Ready persistence and paid-flow evidence:

- Added strict version1 Ready codec with complete effect + existing service semantic digest
  validation. Restore only operation before/after bigint versions. Added17 null-safe operation/
  result column bindings through1700_010; no historical mutation or fabricated legacy backfill.
- Added public owner readiness store. Current state uses validated immutable creation record and
  contiguous Ready effects; exact original item identity/quantity and before/after phase/version
  must match. Per-Order advisory and root row locks serialize append. Existing handoff blocks new
  state reads/writes; original Ready recovery reauthorizes and precedes current-source gates.
  Savepoint protects result/operation pair; existing service owns mandatory Audit/Inbox rollback.
- Initial typecheck found branded Creation/Readiness reference comparisons; fixed with respective
  public parsers and explicit scalar comparison, without type assertions bypassing validation.
  Final typecheck PASS (session80221). Fulfillment lint and affected helper lint PASS.
  20 files326 tests PASS3.51s, /tmp/bop-wp2402-fulfillment-ready-unit.log. Includes9 new codec
  cases, both Pending and Ready roundtrip, invalid versions in both bigint fields and tampering.
- Migration check PASS106 tests21.29s and142 immutable migrations,
  /tmp/bop-wp2402-fulfillment-ready-migration.log. Existing package manifests/lockfile/toolchain
  unchanged; prior installation retained.
- Ownership negative tests caught three omitted table requirements in the initial predicate.
  Added all six actual required tables; ten focused cases PASS1.05s,600 unselected,
  /tmp/bop-wp2402-fulfillment-ready-ownership.log. Actual validator then found existing
  1700_004 pickup_handoff_record missing from module governance metadata. Reconciled this already
  Fulfillment-owned table (not a Domain ownership change), append-only transactional owner-read
  classification and personal/indirect-identifier metadata. Actual ownership, module manifest and
  database permission validators now PASS (chunkfcc663). No access to foreign tables was admitted.
- Real configured Pickup positive (quote2) PASS48.66s/43.56s body, session88316 exit0,
  /tmp/bop-wp2402-real-fulfillment-ready.log. It now continues actual Payment/Order/Recipe/Kitchen
  through public KitchenItemReady, Fulfillment result/operation/Audit/Inbox, exact replay and
  current Fulfillment Ready. Consumer runs after producer transaction commits, with restricted role
  and real current Ordering source. Four reached failures (Ready result INSERT, Ready operation
  INSERT, Audit INSERT, Inbox UPDATE) leave all consumer effects equal to baseline. Provider,
  System/Store authority and Start/Expo policy remain synthetic. Three unselected cases not run.
- This paid fixture has one item. Two-item Pending-to-Ready is covered by owner unit fixtures;
  actual two-item readiness persistence, handoff guard/recovery and record-binding negative SQL
  remain to be added before full readiness closeout. No handoff/receipt/runtime completion claim.
- Removed static SQL prefixes from earlier Kitchen fixture diagnostics; retain error codes only,
  consistent with database guide. Do not use a passing unit/one-item journey as whole pilot proof.
  Next complete targeted Ready persistence edge coverage and actual pickup proof/handoff, preserving
  the existing aggregate/event/operation contracts and current authorization. Dining serving,
  operator queues/runtime, receipts/refunds/ops and live pilot conditions remain outstanding.

### Ready persistence edge evidence before proof issuance

Extend the existing actual Pickup creation fixture to two original items; invoke an independent
test-support/fulfillment-ready-store.mjs with actual owner readiness service/repository. Cover
Pending after first item, Ready after last, contiguous versions, exact retry after further progress,
current-gate-independent authorized original recovery, denied recovery, and SQL record-binding
negative cases. Ordering and Kitchen facts in this isolated owner test remain synthetic; the
existing paid one-item composition is separate evidence. Run only the affected existing Pickup
database acceptance and helper lint; no unchanged full regression.

Ready edge evidence result:

- Actual creation fixture now contains two immutable Order item quantities (2 and1). New
  fulfillment-ready-store.mjs drives both through the real readiness service/repository:
  first yields aggregate version2/Pending with [Ready,Pending], last yields version3/Ready
  with both full quantities; first-event replay after last preserves original effect.
- Current source gate denial rejects current-state reads, but authorized original apply/recovery
  returns AlreadyApplied before that fresh gate. Current authorization denial rejects recovery.
- SQL rejects missing/unsupported/extra envelope, altered aggregate version and wrong Store in
  Ready record; append-only trigger rejects clearing the record. Original Ready rows remain two.
- Existing Pickup schema/creation/readiness acceptance PASS13.91s/11.25s body, session42616
  exit0, /tmp/bop-wp2402-two-item-fulfillment-ready.log. Affected helper lint and formatting PASS.
  This fixture uses administrator connection and synthetic original Ordering/Kitchen evidence;
  it is not a paid two-item or restricted-role test. Prior paid single-item run remains separate.
  No production code, migration or dependency input changed, so those prior checks were not rerun.

Pickup proof contract review confirms existing planPickupProofIssue/validatePickupProof and
1700_003 tables support issuance, regeneration with invalidation, and verification separately.
Only purpose-hashed capability input belongs in Fulfillment; raw QR/PIN generation/hashing remains
Public Capability owner responsibility. Source must include authoritative all-ready instant,
current proof generation and aggregate version including proof Issue/Regenerate operations.
A successful verification explicitly grantsCompletionAuthority=false; handoff still requires
fulfillment.pickup.complete and independent quantity/actor/device/location checks.
Next implement that actual proof history source and owner persistence, including regeneration
and expiry/history recovery; do not invent readyAt from request time or treat a Ready-only
version as current after proof issuance. Existing handoff guard real-record evidence remains
pending until proof/verification/handoff records can be composed.

### Pickup proof persisted-effect boundary

Implement strict parsePickupProofIssueEffect and parsePickupProofVerificationRecord in the
existing Fulfillment pickup-proof Domain contract, plus a versioned application record codec.
These validate stored facts, never authorize a new issue, verification or handoff. Bind scope,
generation, operation and invalidation identities; enforce bounded aggregate versions and
closed fields so raw credentials cannot enter records. This is prerequisite to the actual
owner repository, not a persistence completion claim.
Affected files: fulfillment/src/domain/pickup-proof.ts,
application/pickup-proof-record.ts and existing tests/pickup-proof.test.ts.
Fresh checks: pnpm --filter @rms/fulfillment typecheck and lint, and its existing test command.
No schema/dependency changes in this increment; previous database/migration evidence stays
at its recorded revision, not rerun or claimed as proof of this new record boundary.

Pickup proof record boundary result:

- Added strict immutable issue/regeneration and verification parsers to the existing public
  Domain contract, and application/pickup-proof-record.ts version1 codecs. Issue history binds
  generation scope/capability/time to operation, validates contiguous bounded bigint versions,
  and binds regeneration invalidation to prior/replacement generations and references.
  Verification parser requires grantsCompletionAuthority=false and excludes selector/raw fields.
  These are record validators, not substitutes for locked current authorization or proof evaluation.
- Four new behavior tests cover issue/regeneration roundtrip, mismatched invalidation and Store,
  operation identity/time/version, raw-field rejection, malformed/overflow decimal versions and
  unsupported envelopes, and verification history without selector or completion authority.
- Fresh pnpm --filter @rms/fulfillment test PASS20 files330 tests3.54s, outputf33891,
  /tmp/bop-wp2402-pickup-proof-record.log. Typecheck and lint PASS, session73302 exit0.
  Changed source Prettier write completed; git diff --check PASS outputb7f170.
  Tested baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 with current WP uncommitted changes.
  Reviewed three source files: no foreign SQL, dependency/schema changes or credential logging.
  No database acceptance or full regression rerun for these pure record functions; prior runs
  are not evidence that the new proof repository exists.
- Next implement actual proof source/history and transaction repository. Stored-effect
  consistency alone cannot prove current generation, original Ready lifetime, freshness,
  authorization, Audit or atomicity; those remain necessary repository/service work.

### Pickup proof actual history and owner transaction

Use existing1700_003 normalized immutable tables; no duplicate JSON column or new migration is
needed because all issue/invalidation/verification operation fields are already persisted.
Add infrastructure/persistence/pickup-proof-history.ts to reconstruct strict effects, and
application/pickup-proof-history.ts to replay issue/regeneration against the actual all-item
Ready source. Extend readiness-store with a locked proof-source method and include proof
Issue/Regenerate versions in its ordinary current reader. Add pickup-proof-store.ts for
authorized original recovery, version-checked issue/regenerate and selector-checked verification.
Use existing root lock/order advisory order, caller tenant transaction, required current-source
and authorization hooks, and mandatory same-transaction Audit append hook. No raw credential
transport, handoff completion, actor policy invention or external activation.
Reconcile exact owner assets/table metadata. Actual existing Pickup acceptance will extend the
two-item Ready fixture through issue/regeneration/verification and failure recovery. Run affected
Fulfillment type/lint/tests, targeted ownership negative tests and actual ownership/manifest/
permission validators, existing Pickup PostgreSQL acceptance; if shared readiness composition
needs new grants, rerun one actual paid Pickup case. No migration/install rerun: inputs unchanged.

Pickup proof actual history/store evidence (2026-09-12):

- Existing normalized1700_003 rows reconstruct exact issue/invalidation and verification
  effects; unmatched generation/operation/invalidation/verification histories are unavailable.
  No applied migration bytes or dependency inputs changed; no new JSON storage was introduced.
- Current readiness reader now folds proof history against actual maximum item Ready time:
  issue/regeneration advance aggregate version, Verify does not. Regeneration preserves the
  original all-ready expiry ceiling; history must be contiguous, scope-bound and no later than
  the trusted read clock. Added locked proof-source read, current capability and last issue time.
- New createPostgresPickupProofStore authorizes Current/Recover/Issue/Verify, gates current
  Ordering source before the existing aggregate lock, and recovers original idempotent results
  before fresh eligibility. New writes re-evaluate the actual locked source with the Domain
  planner/validator. Same-transaction mandatory Audit callback receives only operation metadata,
  never selector hash. Savepoint rolls back generation/invalidation/verification/operation/Audit
  even when the caller catches failure and commits its transaction.
- Actual two-item Pickup database acceptance PASS14.75s/11.62s body, session63340 exit0,
  /tmp/bop-wp2402-pickup-proof-store-db.log. Proves version3 Ready -> issue version4 -> regenerated
  version5; both generation verifications, old-code new-validation rejection, wrong selector,
  expiry, current authority denial and original first issue/verification replay after regeneration
  and current eligibility denial. Nine reached failpoint cases (generation, invalidation,
  verification, operations, post-Audit failure across the three paths) retain baseline counts.
  Exactly2 generations,1 invalidation,2 verifications,4 operations. This owner fixture uses
  administrator connection, synthetic Ordering/authority/clock and synthetic hashed capabilities.
  It is not a paid-order proof-issuance or real-device/operator/credential-transport test.
- The ordinary restricted-role Ready composition now needs SELECT on proof history. Updated
  only its actual fixture grants; configured Pickup quote2 positive rerun PASS44.83s/39.49s body,
  session32860 exit0, /tmp/bop-wp2402-proof-history-paid-pickup.log,3 unselected cases not rerun.
  That run still ends at Ready and does not issue a proof; it validates existing paid flow after
  the shared reader change. No extra broad regression was run.
- Fresh Fulfillment typecheck PASS output49c82a and final session84082. Initial lint flagged
  two object type aliases; changed to interfaces with eslint --fix. Final Fulfillment lint PASS;
  affected database helper lint PASS. Unit20 files332 tests PASS3.38s, session84082,
  /tmp/bop-wp2402-pickup-proof-history-unit.log. Two added history cases cover missing/repeated/
  reversed generations, wrong source scope/Ready time/future history, with prior codec tests retained.
- Added exact owner/schema/table/path admission for proof store/history and all four proof tables
  required by Ready reader. Also corrected the existing Ready negative fixture: it previously
  omitted several required tables in every negative case; now removes exactly the named table.
  Focused24 ownership cases PASS1.53s,600 unselected, /tmp/bop-wp2402-pickup-proof-ownership.log.
  Actual ownership, module-manifest and database-permission validators PASS output9a6dea.
- Changed sources formatted, final scoped diff whitespace check PASS5dd2d6. Reviewed current
  new store/history and helper sources for private-table boundaries, scoped queries, raw credential
  absence and bounded write errors. Baseline remains a0f35440cacff1ab55be78edfb08cb4de90c1a26
  plus ongoing WP uncommitted changes. No install, migration, full pnpm verify, commit or deploy.
  Next compose proof issuance/verification in the actual paid restricted-role journey, implement
  authorized pickup handoff and completion publication/Order fulfillment, then receipts. Full
  Dining serving, current policy/worker/operator runtime, refund/ops and real pilot conditions
  remain outstanding. Do not treat these owner fixtures as finished pilot or full current Order.

### Paid Pickup proof composition and handoff boundary

Extend existing test-support/pickup-proof-store.mjs to accept actual source fencing and original
Ready clock/item count. Invoke it after all actual paid Kitchen items become Ready in
captured-order-fulfillment.mjs, using restricted runner transactions, real Ordering source fence
and precise proof-table INSERT grants. Synthetic hashed candidate, System authority and clock
remain explicit; no raw code/Provider transport or operator policy is fabricated.
Run affected helper lint and one configured positive Pickup PostgreSQL case. Reuse previous
owner-unit and ownership checks while their production inputs are unchanged. Handoff implementation
will follow the accepted WP-1603 contract under WP-2402, not change the assigned WP.

Handoff persistence prerequisite: add strict unknown-input CompletePickupHandoff command and
effect parsers in the existing Domain file plus application/pickup-handoff-record.ts codec.
Keep accepted full/partial quantity semantics and permission checks. Reject extra/accessor/
prototype fields, malformed verification, alias identities, unsafe masks and bigint overflow.
Recovery codec validates record/operation/Audit/version consistency but does not grant current
authority or prove a database write. Follow with actual owner repository/history and completion.
Fresh checks for this production boundary: Fulfillment typecheck/lint and tests. No schema change
yet; do not relabel previous database proof tests as handoff persistence evidence.

Paid proof first runs failed at regeneration post-Audit injection (sessions69757/18881):
the intended failpoint was not reached. Bounded diagnostics showed no database error. Actual
paid fixtures use wall-clock instants, unlike the old August owner fixture; advancing synthetic
regeneration by5 minutes exceeded validateAuditRecord's now+300000 allowance. Keep the production
Audit rule unchanged and compress successful issue/verify/regenerate fixture offsets to6/12/30/36
seconds; retain the original60-minute expiry and separate post-expiry rejection. Rerun only the
failed configured positive case after this relevant fixture correction.

Paid Pickup proof and handoff boundary result:

- Actual configured Pickup quote2 positive now extends persisted Identity/Cart/Quote, capacity/
  Inventory, Payment capture, Workflow/Ordering, Recipe/Kitchen, Ready through restricted-role
  proof Issue/Regenerate/Verify with real Ordering source fence. The existing helper now derives
  initial version from actual item count, expiry from actual Ready time, and accepts owner source
  validation. Restricted role receives exact proof-table INSERT grants; no foreign SQL introduced.
- Final paid proof run PASS46.05s/40.47s body, session30252 exit0,
  /tmp/bop-wp2402-paid-pickup-proof-final.log. It covers nine reached rollback checkpoints,
  authorized original recovery after regeneration/current-gate denial, wrong/old/expired proof
  rejection, preserved original Ready/expiry, version increments and no authority grant on Verify.
  Synthetic capabilities, System authorization, Provider transport and clock remain explicit;
  no real QR/PIN generation, operator policy, handoff, receipt or runtime proof is claimed.
- Two failed preceding runs are retained (/tmp/bop-wp2402-paid-pickup-proof.log and
  /tmp/bop-wp2402-paid-pickup-proof-diagnostic.log); they exposed the fixture's future Audit time.
  Corrected only fixture offsets, not production Audit limits or failure assertions. Diagnostic
  helper records checkpoint ordinal and bounded DB error code only, never SQL/binds/raw errors.
  Three unselected paid cases and unchanged owner/migration/full-repository checks not rerun.
- Added parseCompletePickupHandoffCommand, used by the existing Domain planner, and strict
  parsePickupHandoffEffect plus version1 application/pickup-handoff-record.ts codec. Full/partial
  semantics remain. Unknown/raw/accessor/prototype fields, forged proof completion authority,
  sparse/accessor quantity vectors, unsafe recipient mask, malformed calendar time, inconsistent
  cumulative quantities, operation/Audit identity/time/permission and invalid bigint versions reject.
  Codec recovery is immutable history validation, not current authorization or persisted handoff.
- Fulfillment lint PASS;20 files336 tests PASS3.49s output8fcc28,
  /tmp/bop-wp2402-handoff-record-unit.log. Typecheck PASS168a57 and final60c19a after added tests;
  helper lint and scoped git diff --check PASS60c19a. Final helper time correction formatted and
  linted before the successful paid run. Baseline and current uncommitted WP unchanged otherwise.
- Source review for next handoff repository: accepted WP-1603 and Sections34.10–34.13 require
  partial InProgress followed by remaining handoff. Existing1700_003 has a per-generation/kind
  unique operation constraint including Verify;1700_004 permits only one handoff per verification;
  current proof source accepts only Ready/zero-handed quantities. These combined limits must be
  reconciled for partial continuation using accepted sources before persistence closeout, not
  silently bypassed or omitted. Locally readable Section87 capability rule says validity ends
  on completion/cancellation (or60-minute expiry), with regeneration invalidating previous proof;
  local file comparison alone does not accept a new baseline. No constraint or rule changed here.
  Next implement actual Handoff original-effect storage/current item history, explicit Actor/
  device/location authorization and atomic Audit; resolve partial-continuation compatibility within
  accepted source scope, then completion publication and Ordering/receipt. Goal remains incomplete.

### Actual Pickup handoff persistence and partial continuation

Reconciliation: accepted WP-1603 requires partial handoff and its positive later-handoff example
reuses the validated proof while enforcing a new aggregate version/remaining quantity decision.
Sections34.10–34.13 require item-level remaining delivery; accepted capability policy keeps proof
valid until completion/cancellation/expiry. The storage-only one-handoff-per-verification unique
constraint prevents that accepted continuation. Forward migration1700_011 will remove only that
constraint, preserving its scoped FK, operation/idempotency uniqueness and append-only records.
A valid verification can evidence several separately authorized quantity/version-checked handoffs
of this same Fulfillment while its generation remains current and unexpired. It never grants
authority or permits repeated quantities. Proof issuance/new verification readiness rules and
per-generation Verify uniqueness remain unchanged here; no broad capability policy relaxation.
Migration also adds nullable original handoff record JSON to operation, with closed envelope and
column binding; legacy rows are not fabricated. Add owner handoff history reader/fold and store,
explicit Current/Recover/Complete authorization plus mandatory current Actor/device/location
admission before writes, transactionally appended public Audit. Existing Ready/proof current
readers reject after handoff; separate current handoff reader reconstructs InProgress/Completed.
Fresh checks: affected Fulfillment type/lint/tests, migration:check, owner admission negative tests/
actual metadata validators, existing Pickup database acceptance, then one actual paid Pickup
composition after shared-reader grants change. No install or full regression absent changed inputs.

During final review, harden the new uncommitted1700_011 envelope against SQL CHECK NULL:
use IS NOT DISTINCT FROM for recordVersion and test omitted version with otherwise valid effect.
Only this draft migration is adjusted before handoff; existing accepted/applied migration bytes
remain untouched. Rerun affected migration/DB checks because this covered input changed.
Also reject backdated new proof verification after the current proof expires (current locked
clock guard); preserve authorized original recovery. Add concurrent same-command handoff in
the real paid runner and actual record-binding/append-only database negatives.

Actual handoff persistence result (2026-09-12):

- Added1700_011 draft forward migration: preserves all scoped FKs/append-only/idempotency
  constraints, permits independently authorized remaining-quantity handoffs referencing the
  same still-current verification, and stores original effect JSON with null-safe version1
  envelope and12 operation/record column bindings. Existing accepted migration bytes unchanged.
  Catalog now143; legacy NULL original records are unavailable, never synthesized.
- New owner handoff history reader validates original JSON against normalized record/items/
  operation; pure historical fold uses actual stored verification, versions, remaining quantities,
  Actor/Audit identity and chronology to reconstruct InProgress/Completed. The prior Ready/proof
  reader still rejects current reads after handoff; new lockPickupHandoffByOrder exposes the
  separately reconstructed current state. Original Ready/proof operation recovery remains intact.
- createPostgresPickupHandoffStore requires explicit actor-bound Current/Recover/Complete
  permission callback, independent current actor/device/location admission and current Ordering
  source. Fresh commands match actual stored proof verification, current generation and expiry;
  already-completed/overquantity/stale/conflicting commands reject. Original idempotency recovery
  remains available under current read/complete authorization after current eligibility/admission
  closes. Savepoint covers record/items/original operation and mandatory public Audit callback.
- Current expiry guard also prevents new proof verification using a backdated observed timestamp
  after capability expiry; original authorized historical retry remains separate. Positive paths
  do not relax the existing proof generation/verification policy.
- Actual owner two-item database acceptance final PASS15.27s/12.27s body, session68833 exit0,
  /tmp/bop-wp2402-handoff-db-final.log. First quantity leaves InProgress; remaining vector becomes
  Completed with contiguous versions and the same actual verification. Rejects omitted permission,
  denied device admission, absent verification, new delivery after completion and changed original
  quantities. Four reached record/item/operation/post-Audit failures are caught inside caller TX;
  commit retains baseline counts. Replay returns exact original without new rows. SQL rejects
  missing version, unsupported version, extra envelope and wrong Store; append-only update rejects.
  This fixture uses administrator connection and synthetic Ordering/staff/device/location facts.
- Actual paid configured Pickup quote2 positive final PASS49.31s/43.84s body, session83613 exit0,
  /tmp/bop-wp2402-paid-pickup-handoff.log. Restricted transactions now continue actual submission/
  capacity/Inventory/Payment/Workflow/Ordering/Recipe/Kitchen/Ready/proof history through actual
  handoff and current Completed. Concurrent identical handoff requests yield one Applied and one
  AlreadyApplied with identical original effect; no duplicate delivery. Provider transport and
  operator/device/location eligibility remain synthetic; no live device/payment or UI proof.
  Three unselected cases not rerun; paid multi-item coverage is not inferred from owner two-item.
- Final migration:check PASS106 tests19.50s/143 immutable migrations, session68833,
  /tmp/bop-wp2402-handoff-migration-final.log. Earlier draft run143/106 tests and owner DB pass
  were superseded only for changed envelope inputs. No install/full pnpm verify was run.
- Fulfillment unit20 files336 tests PASS3.72s, session44690,
  /tmp/bop-wp2402-handoff-store-unit.log. Initial typecheck caught branded canonical-time
  comparisons; explicit String comparisons preserve strict parsed UTC instants. Final typecheck
  PASS68815; source lint and corrected helper lint PASS. Earlier helper lint found an unused
  initial reached assignment; removed without changing failpoint assertions.
- Exact owner/schema/table/path tests25 PASS1.51s,610 unselected,
  /tmp/bop-wp2402-handoff-ownership.log; actual ownership/module-manifest/database-permission
  validators PASS2a4a51. Reconciled existing owner handoff item/operation tables in metadata.
  Scoped whitespace/diff check PASSf73833. Reviewed new owner files/SQL for scope, immutable history,
  record/Audit privacy, expected version and no foreign SQL. Baseline remains
  a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus ongoing local WP changes; no commit/push/deploy.
  Next persist FulfillmentCompleted publication plus Outbox atomically with final handoff using
  the existing WP-1604 contract. Ordering still must consume completion and advance its own
  Workflow, then issue receipt. Current Completed is Fulfillment-owned only: no Order closed,
  receipt, actual operator runtime or pilot readiness is claimed. Dining serving, refund/ops,
  real Store/Provider/worker/browser acceptance remain outstanding.

### Final handoff completion publication and Outbox

Add owner-only infrastructure/persistence/fulfillment-completion-store.ts using existing
WP-1604 creator/semantic binding and1700_005 normalized publication table. Invoke it inside the
handoff writer's existing savepoint after Audit only for final Completed, with original Order
identity already fenced by the owner current source and mandatory deterministic event/publication
references. Append through @bop/eventing public transaction API; no foreign private-table SQL.
Partial handoff emits nothing. Any publication/Outbox failure must roll back final handoff,
Audit and publication; original idempotency retries must not emit another event.
Reconcile owner publication metadata/event declaration and exact owner asset tests.
Fresh commands: Fulfillment typecheck/lint/tests, focused ownership tests and actual validators,
existing Pickup owner PostgreSQL and one paid configured positive Pickup case. No schema/package
dependency change: reuse143-migration evidence at previous run; no new install/full regression.

Final handoff completion publication result:

- New internal fulfillment-completion-store.ts parses the exact Completed handoff, creates the
  existing WP-1604 minimal public event and semantic digest with mandatory derived references,
  inserts existing1700_005 publication, and appends through @bop/eventing public transaction API.
  Handoff writer invokes it after mandatory Audit within the same savepoint. Partial writes do
  not invoke publication; original idempotency recovery does not append again.
- Existing publication table ownership/read classification and emitted event were reconciled in
  Fulfillment metadata; no schema, event contract or package dependency was changed. The record
  payload remains six public fields and System Actor, with no recipient mask, staff/device or
  credential data. Order identity is the actual owner-fenced Order supplied to the handoff writer.
- Actual two-item owner database acceptance PASS15.29s/12.23s body, session59760 exit0,
  /tmp/bop-wp2402-completion-db.log. Partial retains zero publications/events. Injected final
  publication INSERT and public Outbox INSERT failures roll back final handoff/items/operation/
  Audit/publication in a caught-and-committed caller transaction. Successful final handoff has
  exactly one publication/event and retry keeps counts unchanged. Persisted event strict-parses,
  binds actual Order/final handoff/version/causation and matches the saved semantic digest.
- Actual configured positive paid Pickup quote2 PASS46.26s/41.41s body, session29376 exit0,
  /tmp/bop-wp2402-paid-completion-publication.log. Restricted role has exact publication grants;
  actual paid Order/Kitchen/Ready/proof/handoff now commits final completion event alongside
  delivery. Concurrent identical final handoffs retain one original delivery and one event.
  Three unselected cases not rerun. Synthetic Provider transport and staff/device/location
  authority remain; no worker delivery to Ordering or commercial Order closure is claimed.
- Typecheck PASS19f543; Fulfillment and affected helper lint PASS;20 files336 unit tests
  PASS3.47s outputfcf3f1, /tmp/bop-wp2402-completion-unit.log. Ownership15 focused cases
  PASS1.32s,626 unselected, /tmp/bop-wp2402-completion-ownership.log; actual ownership,
  module-manifest and database-permission validators PASScb5ba1. Scope whitespace check PASS3bd05b.
- Reuse previous143-migration evidence: same SQL/catalog/config/pinned toolchain/installation;
  only existing same-owner publication metadata is now declared and actual validators plus the
  fresh full-schema PostgreSQL lifecycle cover that declaration. No migration:check/install/full
  verify repeat, commit/push or deploy. Baseline remains a0f35440cacff1ab55be78edfb08cb4de90c1a26
  with ongoing uncommitted WP changes.
  Next-action evidence: existing Ordering fulfillment-completed-event-consumer-service.ts only
  loads/replaces OrderStatusProjection and sets its canonicalPhase to Fulfilled. It does not write
  an authoritative Order lifecycle fact or execute the published Workflow. Its load port also has
  no transaction argument. Do not wire it as proof of commercial Order completion. Next implement
  the real Ordering-owned completion/history/Workflow path with Inbox/Audit and transactionally
  derived projection, then receipt. Current Order initial-execution reader remains initial-window
  only; full phase/version handling and runtime activation still require explicit implementation.

### Ordering authoritative fulfillment record boundary

Source review: accepted Order phases include Accepted/In Progress/Ready/Fulfilled, with applicable
Workflow stage skipping; Closure Status is separate and requires item/batch finality, no pending
amendment/cancellation, settled/refund/write-off outcomes and no blocking exception. Never infer
Closed from FulfillmentCompleted. Existing projection consumer is insufficient for authority.
Add application/order-fulfillment-completion-record.ts for a closed immutable Pickup completion
record binding original public event, Order/Batch, expected/new owner version, prior/current phase,
explicit System Actor/purpose/permission, Workflow version/transition, Audit identity and receipt
times. Closure remains Open; no financial assertion is made. Add strict versioned codec and
targeted cases in existing fulfillment-completed-event.test.ts. This is prerequisite record
validation, not executed Workflow or durable Order completion.
Fresh checks: Ordering typecheck/lint and targeted existing fulfillment-completed-event test.
No DB/API/schema/dependency change in this boundary slice; actual source/store/Inbox/Workflow
composition and transactionally derived projection still follow under WP-2402.

Ordering fulfillment record boundary result:

- Added order-fulfillment-completion-record.ts and public exports for closed parse/create/
  semantic binding/validate/version1 encode/decode. Binds original strict FulfillmentCompleted
  event to exact Brand/Store/Order, retained Order Batch, Order version increment, System
  purpose/permission, Workflow version/transition, operation/Audit identity and event/record time.
  Prior phases Accepted/InProgress/Ready are structural candidates only; live Workflow and
  current-source authorization still decide whether any actual transition is allowed.
- Phase is Fulfilled and closureStatus remains Open. No settlement, refund, cancellation,
  Amendment finality, exception clearance or Closed fact is inferred from the fulfillment event.
  Codec restores only source-event bigint version, enforces canonical bounded decimal text,
  preserves integer Order versions and recomputes record digest across the bound source/decision.
- Existing completion test file now8 cases (four retained projection cases and four new record
  groups) PASS1.91s, /tmp/bop-wp2402-order-fulfillment-record.log output44fa60. Covers exact
  roundtrip, terminal/unaccepted prior phase, explicit closure rejection, wrong Store/Order,
  chronology, identity alias, actor fields, source/Workflow/version digest tampering and closed
  envelope/bigint shape. No real Workflow execution or database write is implied.
- Ordering typecheck/lint PASS session12920 exit0; changed files formatted; scoped diff check
  PASS2f8fe6. Same baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 with current uncommitted
  WP changes. No API, DB schema, dependency or previously verified production adapter changed;
  no old database runs were relabeled fresh and no full tests/install/migration/build rerun.
  Next add Ordering-owned append-only completion storage, current lifecycle source and real
  published Workflow composition using this record, with atomic Audit/Inbox and projection
  derived from committed owner facts. Source store must guard cancellation/amendments and preserve
  the difference between immutable original header, current owner phase/version and status view.
  Continue to receipt and separate closure eligibility after the actual consumer is connected.

### Ordering completion source checkpoint binding

Before adding persistence, bind expectedSourceCheckpoint to the immutable completion record
and its digest. Version alone must not identify the prior owner fact. Require a distinct valid
Ordering reference and test missing, aliased and digest-tampered checkpoints. This changes only
the not-yet-persisted WP-2402 completion contract; no accepted migration or stored version is
rewritten. Run affected Ordering test, typecheck and lint, plus scoped formatting/diff check.
Actual database source matching, published Workflow, Inbox/Audit and current lifecycle remain
required next; this boundary does not establish a durable completion or pilot readiness.

Completion checkpoint binding result:

- expectedSourceCheckpoint is mandatory, parsed as an Ordering reference, included in the
  semantic digest and distinct from completion/operation/Audit/source-event/domain identities.
  Missing or aliased checkpoints fail parsing; changing a valid checkpoint invalidates the digest.
- Fresh command pnpm --filter @rms/ordering test -- src/tests/fulfillment-completed-event.test.ts
  unexpectedly selected all Ordering tests due to script argument forwarding: 69 files / 1377
  tests PASS4.42s, /tmp/bop-wp2402-completion-checkpoint.log, output02b74d. This was broader than
  intended, not a required regression milestone. Do not repeat the targeted file; future targeted
  execution must use the established direct Vitest invocation with explicit package config/root.
- Ordering typecheck and lint PASS session3423 exit0 outputfda36d; source formatting unchanged;
  scoped tracked diff whitespace check PASS. Baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26,
  codex/wp-2402-pilot-submission with ongoing uncommitted WP changes. No SQL/API/dependency changes,
  so no database, migration, API build, frozen install or full-repository verification rerun.
- Read current termination store: new termination compares version/checkpoint/phase/time after
  holding OrderingOrderDisposition fence; its initial state reader must gain a completion guard
  when completion persistence is introduced. Original termination retries resolve before current
  state validation and must preserve that recovery order. This turn added no completion DB row,
  Workflow transition execution, Inbox or runtime delivery; those remain the next implementation.

### Ordering durable completion schema

Add owner migration 1300_025 for append-only completion history with scoped Order/Batch FK,
one completion per Order/event/operation, expected source checkpoint, Workflow references,
System Audit identity, explicit Fulfilled/Open state and original version1 record JSON.
Bind indexed columns to the original record in SQL; require closed envelope, finite millisecond
times and monotonic Order version. No updates to immutable submission/header or accepted SQL.
Register owner table and catalog. Validate catalog/ownership and apply all migrations through
the existing isolated fulfillment-readiness test before adding the writer/current-state guard.
Do not claim operational completion until writer + Workflow + Inbox + actual paid journey pass.

Ordering durable completion schema result:

- Added 1300_025_create_order_fulfillment_completion_record.sql, scoped immutable owner table
  and governance metadata. SQL binds normalized identities/versions/phase/Workflow/digest/event
  scope/timestamps to original record JSON, rejects missing envelope version via IS TRUE, keeps
  Fulfilled/Open separate, and provides scoped uniqueness plus original Order/Batch FK.
- Catalog97 cases PASS18.36s, /tmp/bop-wp2402-order-completion-catalog.log outputc23678.
  Initial owner validator failed TABLE_METADATA_MISSING; added exact append-only owner-repository,
  transactional/indirect_identifier declaration. Actual ownership and permission validators then
  PASS cd622c; affected TypeScript formatting check PASS. No failure was counted as a pass.
- Existing isolated Fulfillment Ready PostgreSQL test PASS11.71s (body11.41s),
  /tmp/bop-wp2402-order-completion-schema.log outputeb8ac9. Confirmed isolated-database.mjs
  creates from template0 and applies runMigrationCommand over the full catalog: proves new DDL
  applies with existing schema, NOT completion insertion/replay/RLS behavior. Those tests remain
  required with the writer. No existing accepted migration was changed.
- Same WP branch/baseline and uncommitted worktree. No dependency/API/runtime edits; no install,
  API build or full-repository verify rerun. New migration invalidates prior catalog-only reuse;
  fresh evidence above replaces it only for the tested DDL scope.
  Next: implement completion store with same OrderingOrderDisposition fence, current permission,
  original retry recovery, actual Accepted checkpoint/Batch/OrderType/time matching, mandatory
  published Workflow callback and atomic savepoint Audit. Add initial-reader completed guard and
  its restricted-role grants together, then actual paid fixture + Inbox/projection composition.
  Schema alone does not change current Order state and is not pilot-ready.

### Ordering completion writer implementation

Implement the internal owner writer against 1300_025. Retain the Order disposition advisory
fence, current authorization on fresh/retry calls, operation/source identity uniqueness, exact
original record recovery, actual initial Accepted checkpoint and Pickup header, and mandatory
current Workflow/eligibility callback. Write original JSON and bound columns with public Audit
inside a savepoint; on failure rollback even when caller catches and commits. Do not export or
activate until current-reader completion guard and actual PostgreSQL/Workflow integration land.
Run affected owner type/lint and focused store tests; fresh PostgreSQL insertion/retry/failure
coverage remains required before this writer can be used by the public consumer.

Ordering completion internal writer result:

- Added order-fulfillment-completion-store.ts (deliberately not exported/activated). It validates
  the complete record digest, requires current authorization, holds OrderingOrderDisposition
  then operation lock, resolves any existing operation/Order/event to exact original JSON before
  fresh gates, matches actual initial phase/version/checkpoint/time and Pickup header, and
  requires current Workflow callback. No automatic phase transition or financial closure.
- Mandatory public Audit binds Audit identity/System/scope/Order/operation/time/Fulfilled/Open;
  insertion and Audit share a savepoint. Record/Audit failure rolls back and releases before a
  bounded unavailable error, even if caller catches. Current source/Workflow owner fences remain
  caller-owned until commit. Exact recovery requires deterministic original record inputs.
- Focused completion test13 cases PASS2.21s /tmp/bop-wp2402-completion-store-unit-final.log
  output63e3a9. Five new groups cover happy-path call ordering, permission on retry, recovery
  before fresh Workflow, changed provenance, stale checkpoint/Dining/denied Workflow, and both
  savepoint failure paths. Audit append is mocked explicitly; no durable atomicity claim.
  Initial two failures were invalid mixed-case synthetic Audit codes; fixed fixture only.
- Typecheck initially rejected test transaction's constrained generic; corrected to public
  ConsumerTransaction signature. Final typecheck/lint PASS session31437 exit0. Six precise
  ownership tests PASS0.979s (641 unselected), /tmp/bop-wp2402-completion-store-ownership.log
  outputb7a810, including driver/wrong owner/schema/path/missing table rejection.
  Actual owner validator PASS38e419; tooling lint and scoped whitespace PASS093fd2.
- No SQL/catalog/API/dependency changes this turn. Previous new-table migration application
  evidence remains valid for unchanged SQL only, not this new writer. No full regression,
  installation or unneeded migration repeat. Baseline remains a0f35440cacff1ab55be78edfb08cb4de90c1a26
  with ongoing WP changes; no commit/push/deploy.
  Next required: initial-window completion guard and restricted-role grants, actual owner PostgreSQL
  insert/retry/rollback and cancellation-after-completion cases, published Workflow composition,
  then consumer Inbox/projection and actual paid chain. Keep writer internal until these guards land.

### Paid Pickup Ordering completion integration

Add a completion-existence guard to the initial execution reader under OrderDisposition lock;
new cancellation rejects completed Orders while original cancellation recovery remains earlier.
Update exact SELECT grants for existing reader fixtures. Export completion writer after guard.
Extend the synthetic published Workflow with explicit Accepted -> Fulfilled action and execute
its actual PostgreSQL evaluator in the paid Pickup fixture. Feed persisted FulfillmentCompleted
from handoff through proof helper, then commit owner completion + actual Audit, exercise same
command concurrency/original recovery, insert/Audit failure caught inside caller transaction,
and completed-order cancellation refusal. This is local actual persistence with synthetic Store
Workflow/actor/Provider, not real Store approval or runtime Inbox delivery.
Checks: focused Ordering tests/type/lint, actual ownership validator, selected configured paid
Pickup positive PostgreSQL case. Broaden initial-reader regression only as affected by failures;
reuse unchanged migration evidence and no frozen install/full verify repeat.

Paid Pickup Ordering completion integration result:

- Initial execution reader now queries completion existence under OrderDisposition and rejects
  completed Orders before returning old Accepted state. Existing termination original recovery
  ordering is unchanged. Exact reader SELECT grants and ownership metadata updated. Completion
  writer is now publicly exported; production event consumer/runtime composition remains absent.
- Persisted handoff event returns through proof helper to new order-fulfillment-completion.mjs.
  Actual published synthetic Workflow includes explicit FulfillOrder Accepted -> Fulfilled;
  evaluator checks nextState/permission/transition and empty effects. Actual completion/Audit
  binding is exercised from the real paid immutable Order and current acceptance checkpoint.
- Positive configured Pickup PASS47.93s/body42.65s, session38055 output631ee5,
  /tmp/bop-wp2402-paid-order-completion-passed.log: record and Audit failpoints caught inside
  caller TX then committed leave zero rows; concurrent same-command one Created/one Already;
  strict recovered JSON equals original; exactly one completion/Audit; completed initial read
  and new cancellation reject; original retry skips fresh Workflow but current permission still
  required; Kitchen historical commands retain original results after downstream completion.
- First paid run failed after actual insertion because JSONB reordered event keys. Repaired
  canonical JSON serialization for digest and encoding across all nested objects; no existing
  production records or accepted migrations changed. New recursive key-reordering unit passes.
  Second run progressed through completion but old Kitchen fixture requested fresh actionable
  source after downstream completion. Moved producer current-state assertion before downstream
  event delivery, preserving all assertions and post-delivery original operation recovery.
  Failed logs retained: paid-order-completion.log and paid-order-completion-final.log.
- Configured cancelled-after-capture Pickup PASS42.71s/body37.41s, session24763 output922662,
  /tmp/bop-wp2402-completion-cancel-regression.log. Chosen for shared initial-reader risk, proves
  compensation/no Kitchen release remains intact. Other two Pickup combinations and Dining not
  rerun; earlier broader milestone remains historical, not fresh completion evidence.
- Fourteen affected Ordering cases PASS2.09s /tmp/bop-wp2402-completion-jsonb-unit.log outputc6a1b8;
  final Ordering typecheck/lint completed without errors (session84875; trailing grep returned1
  because no direct reader tests matched, not a type/lint failure). Fifteen ownership tests
  PASS1.13s,633 unselected, /tmp/bop-wp2402-completion-guard-ownership.log, outputa8cd6d.
  Actual ownership PASS68bc0e; affected helpers/tooling lint PASSa8cd6d, Kitchen helper lint
  PASScbf2d7; scoped whitespace PASSa5a8fd. No dependency/API/schema changes this turn;
  unchanged migration evidence reused only for that scope, no install/full verify/build repeat.
- Same branch/baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 with uncommitted WP changes.
  Next: authoritative current fulfilled lifecycle read, production published Workflow composition
  and transactional Inbox/projection consumer, then receipt and independent closure conditions.
  The prior projection-only consumer must not remain the authority. Real Store/Provider/operator
  runtime, Dining serving, refund/operations and full trial acceptance are still required.

### Authoritative Ordering execution query

Add createPostgresOrderExecutionReader alongside the initial-window reader, reusing the same
private immutable submission/acceptance/termination fold and OrderDisposition fence. Initial
reader keeps its completed guard. New reader loads and validates original completion JSON,
scope/Batch/checkpoint/version/phase/chronology and Pickup type; returns current Fulfilled
version/checkpoint plus completion record, retaining Open separately. It must reject contradictory
or unauthorized history, not infer phase from projection. Test against existing actual paid chain
before/after completion and permission denial; no new tables, migration or foreign reads.
Keep production Inbox/projection/Workflow composition next: existing consumer has no owner-write
port and transactionless load, and no real projection repository was found in Ordering.

Authoritative execution query result:

- Added publicly exported createPostgresOrderExecutionReader via existing termination-store
  export. Current permission and OrderDisposition fence precede all owner history reads.
  Private initialHistory fold is shared without relaxing initial-window completion guard.
  Query checks completion digest/scope/Batch/prior phase/version/checkpoint/time and actual
  Pickup header; returns original completion plus Fulfilled/version/completion checkpoint.
  Closure is available as original completion.closureStatus=Open, never inferred financially.
- Actual configured positive paid Pickup PASS46.90s/body42.14s session71595 output1b5688,
  /tmp/bop-wp2402-order-execution-read.log. Before completion query equals Accepted state with
  completion:null; after it equals actual Fulfilled version3/checkpoint/original record; revoked
  read permission rejects. Existing complete/Audit rollback, concurrent original recovery,
  post-completion cancellation refusal and original Kitchen retries remain covered in this run.
  Three other cases not rerun. Provider/Store/actor/publication authority remain synthetic.
- Ordering typecheck/lint and affected helper lint PASS session30379 exit0 outputa18f00.
  Actual ownership and scoped whitespace PASS899431. No new dependency/schema/API/tooling;
  previous SQL/catalog evidence remains valid for unchanged inputs. No repeated full unit,
  install, migration or release verification; paid case rerun was required for new query behavior.
  Same baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 and uncommitted WP worktree.
  Next-action findings: FulfillmentCompletedEventConsumerPorts lacks any owner commit/source port;
  its projection load is transactionless. Existing consumer directly changes snapshot phase and
  increments projection version using event identity. No Ordering status projection PostgreSQL
  repository exists despite 1300_008 tables. Current source/view contracts allow only
  Submitted|Fulfilled and fixed paymentStatus NotReported/kitchenStatus Unavailable.
  Next connect authoritative commit/Workflow + Inbox and owner-derived projection transactionally;
  then source real Payment/Kitchen statuses through public interfaces, not guessed labels.
  Full serving/receipt/refund/operational/runtime and real Store trial acceptance remain outstanding.

### Authoritative FulfillmentCompleted consumer contract

Replace projection-only consumption with required current authorization and owner completion
commit ports. Pass the caller transaction to projection load as well as owner commit/replace.
Validate returned owner record/digest against the exact event and projected Order Batch; use
owner version/completion checkpoint/digest rather than synthetic projection increments. Require
authorization even on completed Inbox retries. Enclose consumer Inbox + owner write + projection
in a savepoint so caught errors cannot persist a partial completion. Unit tests must prove same
transaction, mandatory authority, mismatched source rejection, duplicate reauthorization and
savepoint rollback. Production owner/Workflow/projection composition and PostgreSQL consumer
journey follow; do not relabel earlier direct-writer tests as Inbox/projection evidence.

Authoritative consumer contract result:

- Required authorization and completion commit ports replace projection-only authority;
  projection load now receives caller transaction. Handler validates full completion digest and
  exact event, retained Batch, owner version/checkpoint/digest; current projection version cannot
  supersede the completion. Saved projection must equal the entire normalized requested result,
  including guest audience. Projection time cannot predate authoritative record time.
- Authorization runs before Inbox handling, including completed duplicate delivery. New v2
  consumerName/version prevent old projection-only v1 Inbox rows from bypassing owner writes.
  Source FulfillmentCompleted schema remains v1. Outer savepoint encloses Inbox/owner/projection;
  any handler/Inbox error rolls back then rethrows. No production worker activation is claimed.
- Eighteen targeted cases PASS2.11s /tmp/bop-wp2402-completion-consumer-v2.log outputf4470c.
  Four additional groups verify same transaction/owner provenance, duplicate authorization,
  source mismatch, owner failure rollback call sequence, wrong saved audience and clock.
  Existing record/codec/writer unit coverage remains in file. These are mocked ports/Inbox,
  not PostgreSQL atomicity evidence. Earlier actual direct-writer paid chain is not relabeled.
- Typecheck/lint PASS session28064 exit0 ca6b07 before final literal v2 identity + registration
  assertions; no type-shape change afterward. Final targeted run includes v2 assertions, scoped
  whitespace PASSf4470c. No SQL/DB/API/dependency/ownership changes; unchanged record/store
  database evidence remains valid for those files only. No install/full verify or repeated paid
  test without a real consumer repository to exercise.
- Same baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 with current WP uncommitted work.
  Next implement actual Ordering-owned projection generation/current-pointer repository (existing
  1300_008 schema) and API Workflow/record composition; connect v2 consumer to paid fixture with
  real Inbox/owner/Audit/projection transaction and failure injection. Then runtime dispatcher and
  source real payment/kitchen statuses, receipt and separate closure. Pilot still incomplete.

### Ordering status projection persistence

Implement existing 1300_008 generation + current-pointer persistence in Ordering only, with
mandatory current authorization and source validation. Use OrderDisposition then projection
advisory fence, exact original retry and monotonically advancing source versions. Insert immutable
generation and update pointer under savepoint; failure rolls back generation. Read joins scoped
pointer/generation, checks indexed identity/audience/time against decoded snapshot, restores only
bounded canonical integer money. No schema/dependency change. Add codec/owner checks then connect
actual consumer integration; do not claim durable repository behavior from codec tests alone.

Ordering projection persistence and real v2 consumer result:

- Added order-status-snapshot-codec.ts and public createPostgresOrderStatusProjectionStore
  over existing 1300_008 tables. Mandatory authorization precedes owner/projection fences;
  source validator precedes new generation writes; same exact generation recovers, lower/
  conflicting versions reject. Immutable generation and scoped monotonic pointer upsert share
  a savepoint. Read checks normalized scope/version/checkpoint/guest/number/time against snapshot.
  Codec restores only canonical bounded money strings; no floating-point conversion.
- Actual configured positive paid Pickup PASS47.15s/body41.90s session21353 output05165d,
  /tmp/bop-wp2402-paid-completion-projection.log. Test constructs original Submitted snapshot
  from the actual immutable Order/catalog/pricing/batch/business-date facts, marked Stale because
  acceptance already progressed. Source validator compares exact owner-derived snapshot under
  current execution reader fence; completion projection becomes Fresh Fulfilled + Open.
- v2 consumer now runs in that fixture using actual owner writer, published synthetic Workflow,
  public Audit, real Inbox and new projection repository. Concurrent event deliveries yield one
  processed/one duplicate_completed; one owner completion/Audit/Inbox and two projection
  generations (original plus completed). Readback retains exact original quantities/money/
  audience and completion source version/checkpoint/digest. Consumer duplicate reauthorization
  rejects after permission removal. Operator/Store/Provider authority remains synthetic.
- Three new actual failpoints: generation INSERT, current-pointer INSERT/upsert, Inbox completed
  UPDATE. Caller catches then commits; owner completion/Audit/Inbox remain absent, original
  generation count and original current projection unchanged. Existing direct owner/Audit
  failpoints and completed-order cancellation/original-retry checks remain in this run.
  Original OrderCreated consumer/source composition is not yet connected; initial projection
  creation is fixture composition, not production runtime. Other three Pickup cases not rerun.
- Twenty targeted Ordering tests PASS1.97s /tmp/bop-wp2402-projection-codec.log; includes new
  signed-int64 bounds/zero/JSONB key-order roundtrip and numeric/overflow/noncanonical rejection.
  Six exact new owner asset tests PASS0.920s (648 unselected),
  /tmp/bop-wp2402-projection-ownership.log outputb0e4f2.
  Final Ordering type/lint, tooling lint, actual ownership and scoped whitespace PASS session54592
  exit0 outputdbaa5d; helper lint passed before paid case. Same baseline
  a0f35440cacff1ab55be78edfb08cb4de90c1a26 and ongoing uncommitted WP changes.
- Existing table/schema/governance/dependency inputs unchanged; only exact store asset admission
  added. No migration/install/full verify/API build repeated. No commit/push/deploy or runtime
  worker activation. Stored paymentStatus remains NotReported and kitchenStatus Unavailable;
  neither is misrepresented as actual paid/kitchen state.
  Next: production API composition for actual Workflow/owner record and initial source projection,
  then activate appropriate worker/query/UI wiring. Source real Payment/Kitchen status, add receipt
  and independent closure; Dining serving, refund/operations and actual Store trial gates remain.

### Application fulfillment Workflow composition

Move completion policy evaluation from database fixture into API composition using only public
Ordering/Workflow contracts. Trusted server action/purpose/permission/System principal and current
authorization remain explicit. Owner writer retains version/checkpoint fences and original retry
before fresh source/Workflow; composition reads actual immutable submission/Batch and evaluates
published expected Workflow transition. Reject nonempty effects until proper dispatch is wired,
rather than silently dropping them. Replace fixture-local evaluator with this composition and
run API required lint/type/test/build plus selected actual paid consumer transaction.

Application fulfillment Workflow composition result:

- Added API order-fulfillment-workflow.ts and order-fulfillment-composition.ts. Public Ordering
  source query retains actual immutable submission/Batch; owner writer handles current phase/
  checkpoint/version/clock and original recovery. Trusted server action/purpose/permission/
  System principal are separate from event input; current authority remains required on retries.
  Actual published Workflow checks expected version/transition/nextState/permission and rejects
  nonempty effects until owner effect dispatch exists. No foreign private SQL or Provider code.
- Replaced fixture-local Workflow evaluation with this API composition. Actual configured
  positive paid Pickup PASS47.52s/body42.58s session81618 output9b80a0,
  /tmp/bop-wp2402-fulfillment-api-paid-final.log. Existing actual completion/Audit/Inbox/projection
  atomic failure, concurrent duplicate, original recovery/current authorization and cancellation
  refusal assertions remain in this run. Three other combinations not rerun; real Store/system/
  eligibility and Provider facts remain synthetic. Runtime worker entry remains unconfigured.
- API required checks:57 files839 tests PASS8.11s /tmp/bop-wp2402-fulfillment-api-tests.log
  outputb87351, includes10 new mismatched owner-intent cases before DB/policy access.
  API typecheck/lint/build PASS session40057 exit0 output7fc60e. Initial typecheck TS2367 on
  distinct domain branded instants fixed by comparing their validated canonical string values.
  First paid suite did not start because helper import traversed one directory too far;
  fixed test import, retained /tmp/bop-wp2402-fulfillment-api-paid.log as failed evidence.
- Helper lint passed; actual import boundaries, ownership and scoped diff whitespace PASSdbbeb3.
  No source/schema/dependency changes after successful tests, aside from documentation.
  No migration/install/full repository verify, commit/push/deploy or production activation.
  Baseline remains a0f35440cacff1ab55be78edfb08cb4de90c1a26 with uncommitted WP changes.
  Next wire event-to-Order lookup and deterministic original record generation/recovery. Current API
  commit still accepts record + submissionReference from trusted composition; the minimal completion
  event supplies Order but not Batch/submission. Add a scoped owner query instead of foreign SQL or
  guessing an arbitrary Batch. Initial projection/source composition and worker activation remain;
  real Payment/Kitchen view states, receipt, separate closure, Dining serving/refund/ops and real
  Store/Provider trial acceptance are not finished.

### Completion event Order association lookup

Add public current-authorized Pickup completion lookup to Ordering owner persistence: scope +
OrderDisposition lock, exact Order/Batch/submission association, null for absent Order, reject
non-Pickup/ambiguous association rather than choosing a Batch. Retained association remains
readable after completion for original recovery. API completion commit derives submission through
this lookup and validates record Batch instead of trusting caller submissionReference.
Test actual paid consumer chain and lookup negative cases; API required checks apply to signature
change. No schema/foreign SQL/dependency changes. Event-only record generation remains next.

Completion Order association lookup result:

- Public createPostgresPickupOrderCompletionLookup reads scoped owner Header/Batch under current
  authorization and OrderDisposition + shared row locks. Absent association returns null;
  non-Pickup or multiple rows fail without guessing a Batch. Original Batch/submission
  association survives completion for retries. No private-table query was added to API.
- API completion commit now validates digest/scope before lookup, resolves association itself,
  checks record Batch, and uses returned submissionReference. Public commit input no longer
  asks caller for submissionReference. Lookup errors become bounded completion-unavailable.
  Writer still reauthorizes and recovers original before current Workflow/source evaluation.
- Actual configured positive paid Pickup PASS47.89s/body41.99s, session51884 output75d56f,
  /tmp/bop-wp2402-completion-lookup-paid.log. Association before and after completion equals
  actual immutable Order/Batch/submission; entire real v2 Inbox/Workflow/Audit/projection,
  savepoint failures, concurrency, canceled-after-completion refusal and retry remain covered.
  Other three combinations not rerun; actor/Store/Provider authority remains synthetic.
  -23 focused Ordering cases PASS2.17s /tmp/bop-wp2402-completion-lookup-unit.log output364415;
  adds missing/non-Pickup/ambiguous/no-authorization lookup cases. API required57 files839
  tests PASS8.47s /tmp/bop-wp2402-completion-lookup-api.log output55a670; API type/lint/build
  PASS session48468 exit0 output40d0e9. Ordering type/lint, helper lint, ownership and scoped
  whitespace PASS session5053 exit0 outputad4ab6.
- No schema/dependency/tooling/API transport/worker changes; prior migration and unaffected
  evidence retained, no install/full-repository verify repeat. Same baseline
  a0f35440cacff1ab55be78edfb08cb4de90c1a26 with ongoing WP worktree; no external actions.
  Next create event-only record preparation/recovery using this lookup and current execution record:
  authorize event, use original completion if present, otherwise derive stable references and
  validated observed time/current checkpoint plus expected published Workflow policy. Then compose
  the v2 consumer/initial projection and runtime entry, followed by real view statuses/receipt/
  closure and remaining Dining/refund/ops/live-Store acceptance. Existing commit still accepts an
  already-built completion record; automatic runtime event handling is not yet complete.

### Event-only completion preparation and original recovery

Add API event composition accepting only transaction + FulfillmentCompleted envelope. Require
event authority/scope first, resolve owner association/current execution through public contracts,
reuse original completion before reference/clock generation, or create fresh stable references
from event identity/current checkpoint and trusted Workflow configuration. Reused record must
bind the exact incoming event and still pass current writer permission. Wire actual v2 consumer
fixture to this entry, then prove retry works when clock/reference generation and fresh Workflow
are unavailable. No runtime dispatcher or Store configuration approval is implied.

Event-only completion composition result:

- Added createOrderFulfillmentEventComposition in API. It accepts transaction/envelope only,
  validates exact event and Brand/Store/current event authority, obtains owner association and
  current execution through public APIs under the same transaction, and constructs the fresh
  record from actual checkpoint/version plus trusted policy and event-derived identity ports.
  Existing completion is validated against the exact event and passed through current writer
  authorization/recovery before any new clock/reference generation or fresh Workflow.
- Actual v2 consumer fixture now calls commitEvent rather than supplying a prebuilt record.
  The separately built fixture record remains an expected-value/direct-writer assertion only.
  Configured positive paid Pickup PASS49.94s/body43.07s session14564 outpute83cd9,
  /tmp/bop-wp2402-event-only-paid.log. Includes real Lookup/Workflow/owner/Audit/Inbox/projection
  atomic failpoints/concurrent processing; after completion, disabled generation/clock and fresh
  Workflow still recover the exact original. Different event for same completed Order conflicts;
  revoked event authority rejects. Other three combinations not rerun.
- API57 files839 tests PASS8.01s /tmp/bop-wp2402-event-only-api.log output18ee7f.
  API typecheck/lint/build PASS session75433 exit0 outputae4293; helper lint passed before paid
  test; scoped whitespace PASSf0a189. No Ordering source/schema/dependency/tooling change;
  no migration/install/full-repository verification repeat. Same uncommitted WP baseline
  a0f35440cacff1ab55be78edfb08cb4de90c1a26, no commit/push/deploy.
- Stable references/clock/System authority/Store policy configuration remain fixture ports,
  not real Store activation. This application entry is not yet a scheduled/live worker.
  Next connect actual original OrderCreated projection/source composition and apps/worker dispatch.
  Preserve OrderDisposition-before-header lock ordering when initial projection reads source,
  so it can coexist with fulfillment processing. Existing snapshot payment/kitchen placeholders,
  receipt, independent financial closure, Dining serving/refund/ops and real Store/Provider trial
  acceptance remain incomplete. Full goal is unchanged and active.

### Actual OrderCreated initial projection

Build original snapshot in Ordering from validated immutable creation record and exact published
OrderCreated event/digest, using explicit locale without invented fallback names. Upgrade initial
consumer to required authorization, transaction-aware source/load, owner-derived Fresh/Stale
and outer savepoint. API composition uses public source query and execution reader, retaining
OrderDisposition-before-header ordering via projection load. Replace fixture manual seed with
actual Outbox event consumption; preserve newer projection on late/repeated initial events.
Required checks: owner focused tests/type/lint, API required checks and actual paid v2 chain.
No SQL/schema/dependency changes. Worker must dispatch through authorized service composition;
generic registration-only delivery must not bypass service pre-authorization.

Actual OrderCreated projection result (2026-09-12):

- Replaced manual initial projection insertion in actual paid Pickup helper with persisted
  OrderCreated Outbox envelope and createOrderCreatedProjectionComposition.consume.
  Snapshot comes from original owner creation record with explicit fixture locale, exact event
  binding/digest and event checkpoint. Current Accepted execution makes original snapshot Stale.
  Replaying original creation after Fulfilled preserves the complete current projection.
- Configured positive Pickup PostgreSQL journey PASS54.73s/body49.29s, session43046
  output1fb847, /tmp/bop-wp2402-created-projection-paid.log; 1 selected, 3 not rerun.
  Includes previously established completion atomicity/failpoints and original recovery.
- API/Ordering typecheck PASS session23322 output13d40e. API lint/test/build and Ordering
  lint plus focused OrderCreated5 tests PASS2.09s session6605 output27c49b.
  API57 files839 tests PASS8.80s /tmp/bop-wp2402-created-projection-api.log.
  These are fresh affected checks on ongoing uncommitted WP worktree; no dependency/schema
  change, so no additional frozen install or migration-only/full repository regression.
- Runtime dispatch still must route through authorized consumer service, not registration handler
  alone. Store/System authority and Provider transport remain synthetic fixtures; actual runtime
  activation, real payment/kitchen view status, receipt/financial closure, Dining serving,
  refund/operations and real Store/Provider acceptance are unfinished. Goal remains active.

### Authorized Worker delivery composition

Add an optional trusted service dispatch port to ConsumerDeliveryWorker. Registry validation stays
first; when configured, every initial/reconciliation transaction invokes that port, with no generic
Inbox fallback on failure. This permits owner service preauthorization before duplicate recovery.
Verify denied delivery, commit-unknown reauthorization and same transaction forwarding; run Worker
required checks. Then wire actual paid database journey through this Worker, retaining honest
fixture/runtime distinction. No timer, queue, schema or external service activation.

Authorized Worker delivery result:

- ConsumerDeliveryWorker now optionally routes resolved registration + same transaction/event
  through a trusted owner service port. Both first delivery and commit-unknown reconciliation use
  this entry. Configured service failure never falls back to generic Inbox handling.
- Actual paid Pickup helper now registers actual OrderCreated/FulfillmentCompleted consumers and
  delivers initial generation, concurrent completion and completed creation replay through Worker.
  Revoked authority for either completed event returns bounded retry outcome. Direct service
  failpoint tests remain to prove savepoint rollback even if caller catches and commits.
- Fixed both actual consumer sideEffect labels to registry-compatible stable aliases; previous
  prose descriptions did not satisfy ConsumerRegistry's existing bounded identifier contract.
- Worker lint/typecheck/build and8 files27 tests PASS0.482s output78c7b8,
  /tmp/bop-wp2402-worker-service.log. Synthetic unit test covers same transaction forwarding,
  reauthorization on unknown commit, denied subsequent delivery and no generic fallback.
- Actual configured positive Pickup PASS49.94s/body44.67s session75785 outputbb0246,
  /tmp/bop-wp2402-worker-paid.log;1 selected,3 not rerun. Ordering focused2 files28 tests
  PASS2.01s, Ordering type/lint, helper lint, import/ownership boundaries and whitespace PASS
  session3976 output62c563. Same ongoing WP baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26.
- No schema/dependency/API implementation changes. Previous API suite evidence from the preceding
  initial-projection milestone remains source-compatible; shared registration label changes are
  covered by actual Worker registry + paid journey. No full verify/install/migration repeat.
- This proves Worker delivery inside a real isolated database journey, not an activated
  Outbox-dispatching process. Current test still invokes Worker.deliver explicitly. Next wire
  trusted service dispatch and scope policy into runtime assembly, connect actual Outbox delivery,
  then real view statuses/receipt/financial closure/Dining/refund/ops and external trial gates.

### Outbox to authorized local consumers

Compose existing OutboxDispatcher transport with explicit event-to-consumer subscriptions and
ConsumerDeliveryWorker. Acknowledge only after all subscriptions return processed/duplicate;
reject missing routes and propagate bounded delivery failures. Reuse existing persistent claim,
lease and completion APIs. Test fanout retry and unknown events, then execute actual persisted
creation/completion Outbox rows through dispatcher; never acknowledge other unconfigured events.
Worker required checks and configured positive paid journey are the affected milestone.

Outbox composition development evidence:

- Added createConsumerOutboxTransport with explicit event subscriptions. All configured consumers
  must report processed/duplicate_completed before acknowledgment; missing route/rejection maps to
  TRANSPORT_REJECTED and retry/exception to TRANSPORT_UNAVAILABLE. Partial fanout retries invoke
  each consumer again, relying on persistent Inbox idempotency.
- Worker typecheck first exposed contextual typing loss through Object.freeze; corrected with
  explicit OutboxTransportAdapter generic. Worker lint/typecheck/build and9 files29 tests then
  PASS0.489s /tmp/bop-wp2402-outbox-consumers.log session10375 before DB test.
- Actual paid dispatcher attempt failed publication assertion45.23s
  /tmp/bop-wp2402-outbox-paid.log. Bounded diagnostic repeat
  /tmp/bop-wp2402-outbox-paid-diagnostic.log established FulfillmentCompleted attempt_count0,
  last_error_code null: synthetic handoff time lies in the future; Outbox correctly excludes it
  until available_at. No lease/availability/history rewrite or fake acknowledgment.
- Added bounded real-clock wait (maximum120s) before real dispatcher invocation so synthetic
  handoff time becomes due. Initial lint caught missing global setTimeout; replaced with standard
  node:timers/promises import. Current affected paid run is session41793,
  /tmp/bop-wp2402-outbox-paid-due.log; result pending. No broader checks repeated.

Outbox due-time result:

- Configured positive real PostgreSQL journey PASS101.25s/body96.02s,
  /tmp/bop-wp2402-outbox-paid-due.log, session41793, observed outputd913f2.
  Both actual OrderCreated and FulfillmentCompleted rows were claimed with persisted leases,
  routed through authorized ConsumerDeliveryWorker and marked published with null error.
  Previously committed projections/owner/Audit counts remain2/1/1; original duplicate behavior
  is preserved. Longer duration includes real wait for synthetic future event availability.
  No event clock/history/availability rewrite. Other3 combinations were not rerun.
- Helper lint and new-file formatting/whitespace PASS0c1f55; Worker9 files29 tests/type/lint/build
  evidence above remains valid (only database helper changed after those checks).
  Import/ownership boundaries PASS01e415. No install/schema/full verify repeat.
- This milestone covers real Outbox replay of already-processed events, not first processing
  driven solely by Outbox and not a deployed scheduler. Next move initial creation and completion
  processing behind dispatcher and compose trusted production/runtime configuration; retain
  separate savepoint/failure assertions. Missing unrelated routes stay rejected, never acknowledged.
  Real payment/kitchen view states, receipt/closure, Dining/refund/ops and live trial gates remain.

### First processing through Outbox runtime composition

Add Worker composition that builds registry, trusted service dispatch, explicit subscriptions,
delivery worker and Outbox dispatcher from owned ports. No registration-only fallback is exposed.
Use it in actual paid fixture: first creation from persisted Outbox, retain direct rollback
failpoints, then first completion from Outbox when due. Keep duplicate/concurrent checks after
first processing; assert both publication and owner/Inbox/projection state. Required Worker
checks and affected paid journey; no new queue/timer process, credentials or schema.

First-processing implementation:

- New apps/worker/src/consumer-outbox-runtime.ts composes registry + exact service bindings,
  subscriptions, authorized delivery and persistent dispatcher. Empty/invalid registrations
  fail construction, and configured service failures have no generic Inbox fallback.
- Actual helper consumes creation from Outbox before asserting initial projection; retains
  direct savepoint failure checks, then waits for real availability and consumes completion
  from Outbox before testing concurrent duplicate redelivery. It asserts actual publication
  and owner/Inbox/projection records; no manual first consumer call or projection insertion.
- Worker typecheck/lint/build and9 files29 tests PASS0.482s,
  /tmp/bop-wp2402-outbox-runtime.log. Helper lint passed in same execution.
  Import/ownership boundaries and whitespace PASSa049ff. Affected paid first-processing
  test runs as session4692, /tmp/bop-wp2402-outbox-first.log, result pending.

First-processing result:

- Configured positive paid Pickup PASS99.37s/body94.50s session4692 exit0 output026ab6,
  terminal log output1bdd6c, /tmp/bop-wp2402-outbox-first.log. Actual Outbox first processing
  produced original projection then owner fulfillment/Audit/Inbox/completed projection, with
  published confirmations. Direct caught-failure savepoint checks remain intact; after first
  dispatch both concurrent direct retries are duplicate_completed with no additional records.
  Other3 combinations not rerun. Duration includes real wait for synthetic handoff due time.
- Worker required checks recorded above remain valid; no subsequent Worker source edits.
  Final whitespace PASS1bdd6c. No dependencies/schema/API source changes; no frozen-install,
  schema-only, API full-suite or full-repository repeat. All current processes terminal.
- Same baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus ongoing uncommitted WP changes.
  Scope/Store/System/Provider authority remains synthetic; no external service or deploy action.
- Remaining runtime work: complete event subscriptions (other event types currently reject),
  trusted Store/System policy and transaction composition, persistent retry/failure handling,
  lifecycle startup/scheduling/drain. This reusable runtime exposes dispatcher operations but
  does not itself activate a live process. Payment/Kitchen status views, receipt/financial
  closure, Dining serving, refunds/ops and actual Store/Provider trial gates remain incomplete.

### Truthful Worker startup and business workload lifecycle

Replace empty MessageChannel keepalive with required workload start/stop hooks. Missing workload
must fail startup and exit nonzero; actual workload startup precedes worker_started. On startup
failure clean partially initialized workload, telemetry and signals. Add tests for missing
configuration and hook lifecycle. Keep no fabricated queue/poll task or production configuration.
Worker required checks; unchanged paid dispatcher milestone retains its existing evidence.

Truthful startup result:

- startWorkerRuntime now accepts required-in-practice WorkerWorkload start/stop hooks. Missing
  workload follows startup failure path (exitCode1), without worker_started. Removed empty
  MessageChannel latch. Actual workload start must finish before successful startup is logged.
- Startup failure stops partially initialized workload; shutdown/telemetry/signal cleanup is
  idempotent. Found and fixed startup-vs-signal race: shutdown waits for pending startup and
  suppresses later worker_started; both SIGTERM/SIGINT still stop exactly once.
- Worker typecheck/lint/test/build and whitespace PASS session27494 exite64af3.
  10 files33 tests PASS0.658s /tmp/bop-wp2402-worker-startup.log outputae9548. Four new
  startup cases cover unconfigured failure, partial-init cleanup, dual-signal drain and signal
  during pending startup. Earlier32-test pass preceded race fix and is superseded by this run.
- No dispatcher/owner/schema/dependency/API changes. Actual paid Outbox first-processing
  evidence /tmp/bop-wp2402-outbox-first.log remains valid for those unchanged components;
  it does not prove this process entry configured with a real persistent workload.
- Current CLI invocation without workload intentionally fails instead of pretending to serve.
  Next add actual bounded Outbox workload loop, background-failure propagation and trusted
  runtime assembly including persistent retry/subscriptions. No live process/deploy started.
  Same ongoing WP baseline; full trial goal remains active and incomplete.

### Continuous Outbox workload

Implement real periodic calls to supplied OutboxDispatcher.runOnce with explicit bounded poll
interval, no overlapping cycles, failure completion signal and bounded stop/drain. Integrate
workload completion into process startup so background failures log a bounded code, stop and exit1.
Unit timing controls prove lifecycle only, not real queue evidence; existing actual dispatcher
first-processing evidence stays separate. Worker required checks; then use workload in real
database acceptance once lifecycle is stable. No live deployment/configuration is implied.

Continuous workload implementation/checks:

- Added createOutboxWorkload using actual supplied dispatcher.runOnce, explicit1..60000ms polling
  and1..25000ms shutdown deadline. Next interval starts only after the active cycle completes.
  It exposes stopped/failed completion; failures end polling; stop is idempotent and waits for
  active cycle plus dispatcher drain or reports timeout. No idle fake job or external scheduler.
- Worker startup observes workload completion; background failure logs bounded
  WORKER_EXECUTION_FAILED, sets exitCode1 and performs normal stop/cleanup. Unit cases exercise
  non-overlap, pending-cycle drain, background failure, timeout and process failure propagation.
- Worker11 files37 tests PASS0.629s /tmp/bop-wp2402-outbox-workload.log; type/lint/build PASS
  session23815 exit0 output062507. Helper lint passed; import/ownership/whitespace PASSed792a.
- Actual paid helper now starts continuous workload for first completion and only observes
  persisted publication; it no longer manually invokes dispatcher for completion. It always stops
  workload in finally. Actual configured positive test currently session63557,
  /tmp/bop-wp2402-outbox-loop-paid.log, result pending (includes bounded real event due wait).

Continuous workload actual result:

- Configured positive PostgreSQL paid Pickup PASS103.94s/body98.27s session63557 exit0
  outputb978d8, log output980ade, /tmp/bop-wp2402-outbox-loop-paid.log. Real workload performs
  first completion delivery/publication; test observes persisted publication, then stops workload
  and verifies stopped completion, exact owner/Audit/Inbox/projection counts and original retries.
  Initial OrderCreated still uses bounded manual runOnce in this test before failure assertions.
  Other3 combinations not rerun; real synthetic due-time wait remains included.
- Worker37-test/type/lint/build evidence above remains valid (no later Worker changes).
  Helper lint/format passed; boundaries/whitespace PASSed792a. No schema/dependency/API changes,
  no full verify/install/migration repeat. All current processes terminal; no deployed worker.
- Next compose existing createConsumerDeliveryDatabase with actual configured connection pool,
  trusted scope/services and persistent Outbox/consumer retry ports. Remaining event routes must
  be resolved before live all-events polling; unconfigured events currently park as rejected.
  Receipt/financial closure, real Payment/Kitchen status, Dining/refund/ops and Store/Provider
  acceptance remain outside this milestone and incomplete under the unchanged full goal.

### Persistent Eventing ports for Worker

Compose owned Eventing claim/complete/fail, parked-Outbox scheduling and consumer-failure decision
APIs through one current-authorized transaction port. Require explicit scope authorization and
trusted clock/random/decision identities; never invent policy or query Eventing private tables in
Worker. Return conflict as failure, not successful recording. Verify current authorization before
database acquisition and required Worker checks, then wire these ports into real paid runtime.

Persistent Eventing port checks:

- createPersistentEventingPorts wraps every database operation in current scope authorization,
  then invokes only public Eventing APIs for claim/publication/failure, parked Outbox scheduling
  and consumer failure decisions. Uses existing resolveRetry policy with required caller clock,
  jitter and identity ports. A conflict throws so the transaction cannot commit false success.
- Worker12 files38 tests PASS0.647s /tmp/bop-wp2402-persistent-eventing.log; type/lint/build
  PASS session61675 exit0 outputa5634b. Scope revocation test proves denied operations do not
  acquire transactions or call clock/random/identity generation.
- Actual paid helper now uses these persistent ports for runtime database/dispatch/failureRecorder.
  Added least-scope synthetic-role grants for delivery_attempt/dead_letter_item and retry schedule.
  After owner authorization revocation, both consumer failures must persist2 attempt decisions and
  2 scheduled retries; owner/Audit/projection counts remain unchanged.
- Helper lint/format passed. Import/ownership/whitespace PASS007743. Real configured positive
  run session7227 /tmp/bop-wp2402-eventing-persistent-paid.log is pending; no full verify,
  install/schema or unaffected API checks repeated. Connection pool and retry delivery assembly
  remain outstanding; this does not establish real Store authority or live Provider use.

Persistent failure recording actual result:

- Configured positive paid Pickup PostgreSQL PASS101.63s/body96.49s session7227 exit0
  outpute5548d; log outputb68537 /tmp/bop-wp2402-eventing-persistent-paid.log.
  Runtime uses current-authorized persistent dispatch ports; both revoked owner-consumer
  deliveries persist actual delivery_attempt + scheduled retry rows (2 each) while no new
  owner completion/Audit/projection generations are created. Synthetic runtime scope authority,
  random and decision identity ports are explicitly fixtures. Other3 combinations not rerun.
- Worker38 tests/type/lint/build and boundary results above remain valid; only helper changed
  afterward. No schema/dependency/API changes; no full verify/install/migration repeat.
- Next connect consumer retry claim/load/complete through the existing ConsumerRetryScheduler,
  prove recovery after authorization returns and no duplicate owner effects; integrate real
  connection acquisition and remaining Outbox event subscriptions/policies. Parked-Outbox
  scheduling port exists but has not been exercised in this paid milestone.
  Whole Store trial, receipts/financial closure, Dining/refunds/ops and real Provider/Store
  acceptance remain incomplete. No process deployed or external service changed.

### Consumer retry execution and recovery

Add Eventing-owned scoped original Outbox envelope reader reusing canonical restoration. Extend
persistent Worker ports with retry claim/load/complete public APIs, and wire existing scheduler
in actual paid fixture. After current owner authority returns, wait for persisted due time, claim
both schedules, redeliver exact events and complete leases without additional owner effects.
Affected Eventing checks plus Worker required checks and real paid journey; no schema changes.

Consumer recovery implementation/checks:

- Eventing public loadOutboxEnvelope validates event reference and reads original immutable
  envelope with explicit current Brand/Store filters. It shares canonical envelope restoration
  with claimOutboxBatch, including Actor/System, bigint aggregate version and optional causation.
- Worker persistent ports now expose consumer retry claim/load/complete through owner APIs and
  current transaction scope authorization. Existing scheduler uses these ports with real leases.
- Eventing4 files58 tests PASS0.300s /tmp/bop-wp2402-retry-eventing.log; type/lint PASS.
  Worker12 files38 tests PASS0.649s /tmp/bop-wp2402-retry-worker.log; type/lint/build PASS
  session69858 exit0 output1fbefb. Eventing build/helper lint completed before actual paid run.
  Import/ownership/whitespace PASS06a499.
- Actual helper restores owner authority after asserting two failure plans, waits for database
  recorded retry availability, runs ConsumerRetryScheduler, and expects both schedules completed
  with leases cleared and no new owner/projection effects. Actual run session16519,
  /tmp/bop-wp2402-consumer-recovery-paid.log pending. No schema/dependency/whole-repo repeat.

Consumer recovery actual result:

- Configured positive paid PostgreSQL journey PASS102.12s/body96.90s session16519 exit0
  output754539; terminal log6caac0 /tmp/bop-wp2402-consumer-recovery-paid.log.
  After owner authorization restoration and persisted due time, existing scheduler claimed2
  actual retry plans, read original scoped Outbox envelopes, recovered completed Inbox results,
  and marked both schedules completed with null lease. Owner completion/Audit remain1 each,
  projection generations2, completion Inbox1. No history rewrite or duplicate owner effect.
  Other3 combinations not rerun; synthetic future-event wait is included in duration.
- Eventing/Worker tests/type/lint/build and boundaries above remain applicable; no later source
  edits. No schema/dependency/API changes or install/full verify repeat. All checks terminal.
- Remaining: actual pool/credential/Store configuration, continuous retry scheduling integration,
  remaining event routes and live process activation. Receipt/financial closure, Payment/Kitchen
  view states, Dining/refund/ops and real Provider/Store acceptance remain incomplete.
  Same uncommitted WP baseline; no commit/push/deploy/external action.

### Persistent Worker assembly and connection lifecycle

Compose actual connection acquisition adapter, current-authorized Eventing ports, owner services,
Outbox/consumer retry schedulers and continuous workload. Each cycle schedules parked Outbox,
runs consumer retries and dispatches due events; stop drains existing dispatcher. Runtime identity,
scope and credentials remain explicit caller ports. Extend isolated fixture connection provider
with tracked acquisition/release and use production transaction adapter for Worker operations.
Run Worker required checks and affected actual paid journey; no credentials or schema changes.

Persistent Worker assembly development:

- New createPersistentConsumerWorker composes supplied acquire/release connections through
  createConsumerDeliveryDatabase, current-authorized Eventing ports, service runtime, parked
  Outbox/consumer schedulers and a workload that runs all three stages sequentially per cycle.
  It does not load credentials or invent Store/system authority.
- Isolated Pickup runner now provides tracked real connection acquisition/release. Worker test
  operations use actual production transaction adapter (BEGIN/context/COMMIT/rollback/release),
  while direct writer failpoints retain their original runner. Existing end-of-test active
  connection assertion covers this acquisition path too.
- Added actual-attempt parameter to parked-Outbox decision identity callback; persistent port
  and fixture bind identity to event+attempt, preventing later failure attempts from reusing an
  earlier decision. Existing one-argument callbacks remain assignable; no schema change.
- Worker12 files38 tests PASS0.633s /tmp/bop-wp2402-persistent-worker.log; required type/lint/build
  passed before current paid run. Eventing tests/lint/build passed before it as well.
  Boundaries/whitespace PASSc307fd. Real configured positive run session8927
  /tmp/bop-wp2402-persistent-worker-paid.log pending. No unrelated full verification repeated.

Persistent Worker assembly actual result:

- Configured positive paid PostgreSQL journey PASS101.92s/body96.58s,
  /tmp/bop-wp2402-persistent-worker-paid.log, session8927; terminal log outputb3c33a.
  Worker dispatch and consumers use real tracked connections through createConsumerDeliveryDatabase;
  scope context, writes/recovery and release complete. Combined workload executes parked-Outbox
  decisions and restores both consumer retry plans without new owner/Audit/projection effects.
  Existing active-connection cleanup assertion passes. Other3 combinations not rerun.
- Eventing4 files58 tests PASS0.321s /tmp/bop-wp2402-retry-identities.log plus lint/build;
  Worker12 files38 tests PASS0.633s plus type/lint/build. Source changes limited to composition,
  callback attempt parameter and fixture wiring. Boundary/whitespace evidence above remains valid.
  No migration/dependency/API/full-repository verification repeat.
- Actual connection provider uses isolated test credentials and closes every acquired connection;
  this is not a configured production pool. Real Store/system/policy/Provider settings and complete
  event subscriptions remain prerequisites for live operation. Unknown routes still reject;
  parked decisions do not imply those business consumers are implemented.
- Next advance remaining business integration (Payment/Kitchen status projection and receipt/
  independent financial closure), while retaining runtime configuration/subscription gates.
  Dining serving/table close, refunds/operations and real Store/Provider trial acceptance also
  remain incomplete. No deployment or external change; full goal remains active.

### Payment status owner persistence

CUST-ORDER-STATUS (Section88.6) requires truthful payment/kitchen/fulfillment status. Existing
payment_status_v1 schema/contract are per payment intent terminal facts, not whole-Order paid or
financial-closed authority. Implement initial owner projection write/load against existing table,
current authorized scope and exact committed terminal event; no new schema or inferred Order
payment label. Follow with consumer/query/API/screen composition. Verify Payment affected
checks/ownership and actual captured payment fixture before claiming persistent integration.

Payment status persistence implementation:

- New createPostgresPaymentStatusStore writes/loads initial payment_status_v1 generations using
  existing1400_004 schema. Current per-intent Read/Write authorization, scoped owner fence,
  exact committed terminal fact/event comparison and recorded-time validation precede insertion.
  Same terminal returns original projection; different contents reject. Insert/readback is inside
  savepoint so caught errors cannot leave a partial write. Rebuild/Inbox consumer are not implemented
  by this adapter, nor is whole-Order paid/financial Closed inferred.
- First ownership check rejected module/owner-repository metadata: existing table authority is
  projection-builder @rms/payment.status.v1 and public-query-contract. Corrected access entries to
  that accepted definition, with exact-file whitelist; no table ownership/rule change.
- Payment typecheck/lint passed before metadata correction; Payment18 files287 tests PASS2.95s
  /tmp/bop-wp2402-payment-status-unit.log. Ownership tool654 tests PASS14.19s
  /tmp/bop-wp2402-payment-status-ownership.log; actual ownership, import boundaries and whitespace
  passed (sessions13685 initial gate failure then corrected3170; session53355 exit0 output100f9b).
- Actual captured-payment fixture now checks absent->stored status, caught insertion failure
  rollback, concurrent Completed/Duplicate, exact amount/terminal binding and revoked Read/Write.
  Active selected paid run session3170 /tmp/bop-wp2402-payment-status-paid.log remains pending.
  No migration/dependency/API/PWA changes or full verify/install repeat.

Payment status actual persistence result:

- Configured positive paid Pickup PostgreSQL PASS104.12s/body99.11s session3170 exit0
  outpute4bffe; terminal logcc93bf /tmp/bop-wp2402-payment-status-paid.log. Actual projection
  equals committed captured terminal amount/event/scope; simultaneous writes return exactly
  Completed+Duplicate. Injected insertion failure leaves no row even when outer caller catches
  and commits; mismatched amount and current unauthorized read/write reject.
  Other3 combinations not rerun. Full existing pickup runtime/retry chain remains in selected test.
- Existing schema1400_004 reused unchanged. Payment287 tests, ownership654 tests and type/lint
  evidence above apply to implementation; no additional migration/install/full verify.
- Next connect Payment terminal Outbox/Inbox consumer to this store and public status query,
  then compose customer-safe Order status with explicit ownership/freshness. Current PWA labels
  still placeholders, and no claim of whole-Order paid/refunded/Closed follows from this per-intent
  terminal projection. Kitchen status, receipt/closure and remaining Dining/refund/ops/live gates
  are still incomplete under full active goal. No external action or deployment.

### Quantity option rule focused verification correction

The new customer menu client fixture supplied an empty search string, which existing search validation correctly rejects before parsing. Change only that test to omit search; rerun the client file for versioned default quantities and dangling activation rejection. Existing Catalog, API, option helper, MenuPage and actual current-option PostgreSQL results remain applicable because their inputs are unchanged. Remaining checks: final Catalog build, API/PWA type checks, PWA build, affected lint/format and import boundaries; no reinstall or full regression.

Final API type check found unknown JSON access in the new test; replace it with whole-payload structural assertions and rerun API typecheck plus that test. Lint/format passed before this test-only correction. Import CLI invocation used the incorrect plural directory and did not execute; use existing tooling/import-boundary/validate.mjs. Catalog build and PWA typecheck/build passed; no relevant source changes require repeating them.

### Versioned option quantity and activation result

- Completed explicit rule semanticsVersion 2 from actual resolved bindings through reviewed/published content, channel-filtered customer query, API and PWA. Retains default quantities and conditional activation; validates per-channel reference graphs/cycles; legacy snapshot shape remains unchanged. Inactive defaults cannot activate descendants or enter Cart submissions.
- Actual current-option PostgreSQL scenario passed output08e71f (12.405s), including quantity-preserving review mapping. Catalog affected 11 tests passed f9f703. PWA helper 1 and MenuPage 18 passed in40d96d; client fixture correction passed all12 in6e795e. API6 passed494a62 after type-safe assertion correction. These are synthetic/local acceptance facts, not Store or Provider approval.
- Final Catalog build c1c903 passed; API typecheck and import CLI169f2f passed. PWA typecheck/build0d2a0b passed (existing Vite inlineDynamicImports deprecation warning). Affected ESLint and Prettier passed dd1fbe; final API test formatting/lint passed494a62. Incorrect plural import CLI path indd1fbe did not run; corrected singular command passed169f2f.
- Reviewed core mapper and activation/submission helpers474f5b; no new schema, dependency, secret, external change or deployment. Existing installation retained. No full verify or unrelated business suite repeated.
- Remaining: compose complete review preparation with all dependency/provenance facts and trusted publication binding, assemble business runtime in a fresh versioned local candidate while preserving old DB, complete remaining receipt/refund/operations and browser journey gates. Current candidate is not a pilot release; whole-project goal remains active. No fresh browser interaction is claimed for this increment.

### Menu review content assembly selection

Replace hand-written reviewed display content with a Catalog application builder from parsed Menu aggregate, exact current Product/SKU facts, resolved option rules and trusted provenance paths. Require exact sellable coverage, Brand/ProductVersion matching and complete enabled-option path coverage before using the existing allergen validator. Preserve Menu sections/placements/localized overrides and full reviewed option rules. This builder produces content only, never review/approval or proof of Recipe linkage; callers still obtain paths from trusted owner provenance and validate final content digest. No foreign SQL, new schema, external action or authority change.
Fresh evidence: extend existing actual menu-publication-persistence scenario to use assembled content plus missing/mismatched facts rejection; Catalog build, changed lint/format and import CLI. Reuse previous option quantity tests, migration178 and valid pinned installation because their inputs remain unchanged. Full pilot remains a later cross-domain/browser milestone; do not run unrelated suites.

Assembly build6fb310 passed. Affected lint flagged unqualified structuredClone in the new database test; use globalThis.structuredClone (same Node built-in and fixture behavior). Running database session6239 is retained; no restart for this qualification-only change. Rerun only affected lint and pending import CLI.

### Menu review content assembly result

- Added buildReviewedMenuContent: parses the owning Menu aggregate, requires unique/exact Product/SKU and provenance path coverage, matching Brand/MenuVersion/locale/ProductVersion, and exact coverage of enabled options. Uses existing allergen validation for disclosures, applies placement name overrides over Product/SKU fallback, preserves sections/bindings/presentation, and marks non-Active Product/SKU unavailable. Returns content only; temporary source-bound validation is not exposed as final Publishing evidence.
- Actual menu-publication-persistence scenario now replaces its hand-written snapshot with the builder output. PostgreSQL/HTTP lifecycle, immutable content, approval/publication/archive, original replay and Audit/Outbox atomicity passed037429 (13.337s) with missing/duplicate/wrong Brand/version/locale/path/option coverage rejection, suspended SKU and localization override checks. Synthetic provenance linkage, authentication and approvals remain clearly identified; actual owner rows do not establish real Store facts.
- Catalog build passed6fb310. ESLint initially rejected an unqualified test global; globalThis qualification preserves the same Node built-in and requires no repeat of the successful running DB scenario. Final affected lint/format and import CLI passed84a5c6. Reviewed scope: new pure Catalog application composition, export and existing scenario; no migration, foreign SQL, dependency or external action. No API/PWA source changed this increment, so their previous successful evidence remains reusable.
- Still required: trusted persisted Recipe/Product/Option provenance linkage and complete review dependency binding/recheck in executable runtime. Current builder checks coverage, not independent truth of supplied linkage. It does not create review/approval, issue credentials or complete the pilot. Candidate assembly, receipt/refund/operations and actual browser/Provider/Store gates remain under the unchanged active goal.

### Recipe owner review source selection

Expose configured Recipe review facts through the existing Recipe owner persistence composition. Exact User/Actor, Brand/Store/SKU, action ResolveMenuRecipeFacts and purpose ReviewMenu; caller retains transaction and source SHARE fences through dependent Menu review. Resolve published base, recursive SubRecipes and exact quantity modifiers via existing public/domain rules, returning full pinned snapshots, modifier changes and configured ingredients plus stable digest. Each explicit configuration is one request; caller must cover every Menu channel/Store/allowed option configuration. No claim that an incomplete enumeration establishes the full menu or proves external allergen facts.
Fresh: extend existing recipe-management PostgreSQL scenario for graph/modifier preservation, stable digest, duplicate/missing quantity and revoked permission. Recipe build, affected lint/format, actual ownership/import. Existing 178 migrations and pinned installation unchanged; no new schema or full regression. Existing owner asset recipe-demand-store already owns all queried tables; no new ownership exception.

### Recipe owner review source result

- Added createPostgresRecipeReviewSource to the existing Recipe owner composition asset. Closed User/Actor/Brand/Store/SKU/action/purpose input and current authorization before/after; retained SHARE fences on mutable Recipe root, scope binding and modifier version sources. Existing immutable version snapshots and recursive source resolution reused. Returns exact base/child snapshots, full modifier changes and configured ingredient requirements; stable RFC8785/SHA256 digest excludes observation time.
- Actual recipe-management PostgreSQL scenario passed75b680 (12.961s). Covers retained published base, option-added SubRecipe and complete modifier, stable digest at later observation, unavailable SKU/wrong Brand/duplicate selection/missing exact quantity, denied permission before and after reads. Existing quantity/dual-review/Brand-RLS/preparation persistence assertions also remained in this one selected scenario.
- Recipe build and affected ESLint passeddeed14; actual database ownership passed without new exception; import CLI passed6f2269. Prettier writeb12046 applied only three scoped files. Final source/scope reviewc1317c confirms no foreign tables, schema, dependencies, external mutation or approval creation; unrelated dirty inputs preserved. No failed checks, reinstall or unrelated regression.
- This is one explicit configuration's source, not all Menu combinations or proof of allergen documents. Next bind actual Ingredient/SubRecipe evidence subjects/versions through BFF public owner contracts, covering all applicable Menu options/Stores/channels and retaining full source digest before normal review/approval. Full pilot goal remains active; executable candidate and receipt/refund/operations/live gates still incomplete.

### Recipe to allergen subject/version binding selection

Compose existing public Recipe review and Catalog allergen sources in API BFF, one retained caller transaction and current User/Brand/Store permission. Build evidence requests from actual configured Ingredient/SubRecipe requirements, verify subject kind/id/source version and exact declared allergen set against Catalog evidence. Empty leaf evidence remains unavailable, never inferred allergen-free. This resolves one configuration only; complete Menu enumeration and final review remain separate.
Shared evidence is legitimate across base/options: preserve uniqueness within each path, union/deduplicate across paths before disclosure; no relaxed missing/expired/unverified checks. Fresh: existing Recipe PostgreSQL scenario with actual Catalog evidence rows and wrong subject/version rejection, Catalog focused allergen tests, API/Catalog type/build, affected lint/format and import. No new SQL in BFF, schema or dependencies; unchanged ownership/migration/install evidence reused.

9e4297 Catalog allergen5 tests passed; build rejected string IDs in the new typed test fixture. Use existing parseCatalogReference to create valid branded references, then rerun this focused file/build and still-pending API typecheck. Database session36898 remains live; retain it unchanged.

b012f8 actual cross-owner positive resolve succeeded, then rejection fixture failed because 1106 source evidence has no-update/no-delete rules: attempted version edit left original valid row intact. Correct the DB assertion to prove immutability and missing-registry/permission rejection; add targeted API owner-port tests for inconsistent subject/version/assertion inputs. Do not bypass immutable rules or claim attempted mutations occurred. Rerun this changed DB scenario and new API file; Catalog5/build results fromc1dd54 reusable after fixture reference correction.

### Recipe to allergen binding result

- createMenuRecipeAllergenSource now composes public Recipe and Catalog readers in the retained caller transaction. Requests evidence from actual configured Ingredient/SubRecipe requirements; verifies exact subject kind/id/version and allergen set, rejects unverified/missing leaf evidence and ambiguous reuse, retains source digests. User/Brand/Store permission remains required through both owners. No private cross-Domain SQL or fabricated absence/approval.
- Catalog disclosure now unions shared source references across base/Option paths while rejecting duplicate references within each individual path. Existing invalidated/unknown/expired/version-bound validation remains intact.
- Actual two-owner Recipe PostgreSQL scenario passedde446e13.561s after correcting the test's attempt to mutate immutable evidence. Real configured Recipe graph and Catalog registry/source/assertion rows join on source subject/version; source no-update protection, missing registry and revoked Catalog permission proved. Source document/legal approval data remain synthetic.
- API subject/version/kind/assertion mismatch, ambiguous reuse and missing-leaf tests9 passedcacd2d. Catalog allergen5 tests/build passedc1dd54; API types passed648b64 before new tests and again8dc98d after them. Affected ESLint/import passed8dc98d, formatting3e5baf. Earlier fixture-only failures and corrections recorded above; no unrun check represented as passed. No schema/dependency change or full regression.
- Scope review: new BFF owner composition plus focused tests, Catalog set union semantics and existing DB fixture; no external action, credential or approval. Still one configured recipe at a time. Next enumerate applicable Menu Store/channel/options, build final trusted provenance paths and bind full dependency digest through normal review creation/revalidation. Executable pilot assembly and receipt/refund/operations/live gates remain incomplete under unchanged active goal.

### Complete Catalog configuration coverage selection

Add a pure Catalog review enumerator using the same parsed rule graph as live selection validation. Topologically resolve activation, enumerate integer quantities within group totals, prune conflicts, preserve binding/option references, return only a complete deterministic frozen list. Explicit caller computation budgets bound configurations/search steps; exhaustion fails without returning partial coverage, and no feasible configuration is a lifecycle conflict. This is review coverage, not availability, approval or a new customer quantity limit.
Fresh: focused existing selection-validation tests comparing enumerated sets with the live validator for every small candidate (including quantities, conflicts, nested activation), malformed/unsatisfiable/budget cases; Catalog build and affected lint/format/import. Existing persistence unchanged; do not rerun DB or unrelated UI suites solely for this pure helper. Full Menu BFF composition must consume it before pilot completion.

Initial enumeration/live-validation19 tests and Catalog build passed3160ea. Final scope review identified explicit coverage still needed for nested activation and the existing live request limit of100 selected options; add these two cases before the final focused run. No implementation change after initial passing build.

### Complete Catalog configuration coverage result

- Added enumerateCatalogReviewSelections using the same parsed rule graph as live validation. Iterative depth-first traversal avoids recursive option-stack exhaustion; topological activation, integer group/per-option quantities, bidirectional conflicts and the existing100 selected-option bound determine complete configurations with binding references. Canonical ordering is independent of input rule order. Configuration/search budgets fail without returning partial results; unsatisfiable rules reject.
- Final focused21 tests passed82eeb4, including exhaustive small-candidate comparison against actual live selection validation, quantity2, reversed rule order, nested inactive groups,100-option bound, empty rule set, cycle/unsatisfiable/budget cases. Catalog build, affected lint and import CLI44728b passed; final scope/whitespace reviewdbc91d confirms live Brand/Store/source/order-type/time/freshness checks preserved.
- Initial19-case/build pass3160ea preceded two explicitly planned final edge cases; no failed run or unrelated suite repeated. Persistence, dependencies, installation, API/PWA source unchanged, so no database/build/UI regression beyond affected Catalog compilation. This generates review coverage only; BFF still must consume every result through actual Recipe/allergen readers and persist the complete reviewed dependency binding. Full pilot remains unachieved and goal active.

### Complete configuration evidence composition selection

Connect Catalog's complete enumerator to the actual per-configuration Recipe/Catalog provenance reader in the API BFF. Enumerate before owner queries; resolve every feasible configuration in the same caller transaction; merge identical registry/source evidence only, retain selection-specific source facts and include rule/context/configuration digests in the whole result. Any missing configuration, inconsistent evidence, lost authority or exhausted budget rejects the whole call; no partial review result.
Fresh: extend existing API binding tests for dispatch of all quantities, failure on a later configuration and pre-query budget exhaustion; extend actual Recipe/Catalog PostgreSQL scenario from one selected option to both legal base/selected configurations. API types, affected lint/format/import. Catalog21/build and migration/install evidence unchanged and reusable; no unrelated suites or new schema.

### Complete configuration evidence composition result

- Added createCompleteMenuRecipeAllergenSource. Complete Catalog enumeration precedes source I/O; every legal selection resolves through the existing real Recipe/Catalog owner composition in the retained transaction. Registry and shared evidence must agree exactly; final result retains every selection's facts plus merged evidence and context/rule/configuration digest. Failed later configurations and budget exhaustion return no partial result.
- API12 tests passed1d79a0: all quantities dispatch, shared evidence deduplication, later-source failure and zero I/O on incomplete enumeration, plus previous exact-subject/version checks. API typecheck/affected lint/import passed9c6f26; formattingd065e0 and source/scope/whitespace reviewefcb0a passed.
- Actual Recipe/Catalog PostgreSQL scenario passed2a4c8a13.610s. Both legal unselected/selected configurations read real published base/modifier/SubRecipe facts and real Catalog evidence, share one evidence record, keep digest stable across observation-only change, and reject the full result when quantity2 has no published modifier. Catalog rule input, document content and approvals remain synthetic fixture facts, explicitly labelled.
- No failed checks, schema/dependency/ownership changes, reinstall or unrelated regression. Previous unchanged Catalog21/build and migration178 evidence reused. Still required: outer Menu preparation must load actual Product/options per channel and invoke this for every applicable Store, build provenance paths and persist complete dependency binding before review/approval; candidate/runtime/receipt/refund/operations/live gates remain. Full pilot goal remains active, not complete.

### Whole Menu review preparation selection

Compose actual Menu draft, Product/SKU, per-channel options and complete Recipe/allergen configuration facts for every explicit Menu Store/channel in one retained transaction. Build provenance paths from actual resolved evidence, preserve owner names/placements/options and bind a canonical complete dependency digest into the immutable review record and final validation snapshot. Require explicit Stores/channels and whole-menu configuration budget; no partial preparation. Source permissions use server Actor/Brand/Menu/Store context.
Add optional dependencyDigest to review content records: old records keep the identical shape/hash; new records include the digest in their snapshot hash. Existing1104_003 JSON persistence supports this without schema change. Fresh: actual Recipe/Catalog scenario with seeded Menu/Product/options reads, prepared content save/read plus observation-stable and source-change-sensitive digest; existing menu-publication persistence scenario for legacy compatibility. API/Catalog compilation and affected lint/format/import. No full regression or reinstall.

### Whole Menu review preparation result

- createMenuReviewPreparationSource now reads actual Menu/Product/SKU/options, iterates explicit Store/channel combinations, resolves every legal Recipe/allergen configuration under retained source fences and authority, builds version-bound provenance paths and reviewed content, and emits final validation bound to the final snapshot digest. Whole-menu configuration budget rejects incomplete results.
- Optional dependencyDigest is stored in the existing immutable review JSON and included in new snapshot digests. Untagged/legacy records retain the same shape and digest. Full canonical dependency digest covers Menu configuration, Product facts, option source digests, Store/channel Recipe source digests and verified provenance. This stores the digest, not a separate historical copy of every raw upstream source.
- Actual Recipe/Catalog/Menu preparation+save/read scenario passed5d8adc13.826s: one Store/two actual Menu channels, observation-only stability, budget/permission rejection, current full owner-source reads, persisted dependency digest and final validation binding. With a fixed Menu name override, actual SKU name change leaves displayed content identical but changes dependency and snapshot digests; prior record remains readable. Options are empty in this whole-menu fixture; quantity/modifier coverage remains proved by the preceding actual component scenarios.
- Legacy actual Menu publication/archive/replay and Audit/Outbox scenario passed37206614.408s after record extension. Catalog build, API typecheck, affected lint/import passedb52239; formatting60c2f9 and final scope/whitespace review4a0677 passed. No failed tests or new migration/dependency/ownership exception; existing178/install evidence reused.
- Next wire preparation/save into normal Publishing review creation and install complete dependency revalidation in merchant publication binding. Existing publication callback still checks Menu configuration only; new digest generation is not yet proof that all runtime actions reject stale upstream dependencies. Candidate executable assembly, receipts/refunds/operations and actual browser/Provider/Store gates remain incomplete. Full pilot goal stays active; no deploy or external approval claimed.

### Publication dependency revalidation selection

For SubmitReview/Approve/Publish, read the immutable review content matching the command, re-prepare dependency-bound records at the server command clock/current Actor and compare configuration/dependency/final snapshot digests. Use original persisted record metadata for the Publishing lifecycle binding. Legacy records retain existing Menu-configuration validation; Archive and exact replay retain original recovery behavior. Cache successful/failed source evidence promises only inside this command's retained transaction; fresh permission remains checked on each invocation. No cross-request cache.
Fresh: existing actual Recipe/Menu source test checks current vs hidden-source-changed dependency binding; actual Menu publication HTTP scenario proves legacy flow/replay compatibility; add focused command-level test or actual dependency-bound HTTP path where feasible. API types/affected lint/import. Existing schemas and installation unchanged.

Initial API typecheck50cea8 passed before direct command test was added. Formatting caught a missing fixture brace in that new test (3d41d6); corrected fixture syntax before executing tests. Current-source mismatch now has a distinct internal error mapped to existing CATALOG_VERSION_CONFLICT; unavailable sources and lost permission retain their respective existing public errors. Direct tests cover all3 forward actions and transaction-local reuse.

9ff543 SubmitReview/Approve direct tests passed; Publish fixture used an instant string where the existing transport requires a zoned boundary object. Correct to instant/localDateTime/utcOffsetMinutes; rerun this4-case file. No production input rule relaxed. Actual Recipe dependency-binding and legacy HTTP DB scenarios are still pending and will each run once for this implementation.

### Publication dependency revalidation result

- Forward merchant Menu actions now read the exact immutable review record. Dependency-bound records are re-prepared with current server Actor/command time and retained owner fences; configuration, dependency and final snapshot digests must match, and original lifecycle/configuration binding must agree. Changed dependencies map to CATALOG_VERSION_CONFLICT; unavailable source/lost permission use existing public errors. No new approval evidence is persisted by revalidation.
- Evidence promises are cached only within one command transaction and full parsed command key, while each access checks current permission. No cross-request cache. Archive and exact operation replay retain recovery behavior; legacy records retain their existing Menu-only dependency semantics.
- Direct command4 tests passedbd7a6a: all3 forward actions reject mismatches; repeated service evidence requests perform one source read per transaction and recheck permission, next request reads again. Fixture-only brace/zoned-boundary corrections recorded above; no production input validation relaxed.
- Actual dependency binding passedafd67d14.482s: original saved record accepted at later observation, actual hidden SKU source change rejected as MENU_REVIEW_DEPENDENCY_CHANGED. Legacy HTTP publication/archive/replay/Audit/Outbox passed17f2bb14.447s. API types/affected lint/import passedee3440; final scope/whitespace review30abd8 passed.
- No new schema/dependency/installation or full regression. Evidence is split between real new dependency binding and direct command wiring tests; a new dependency-bound record's complete HTTP review-creation/approval/publish journey is still to be assembled. Next implement normal Publishing review creation from prepared content, then candidate runtime/business/browser acceptance. Full pilot remains incomplete; goal active and no external action claimed.

### Review creation operation recovery selection

Normal review creation needs exact operation recovery before reading changed upstream facts. Add public Publishing owner resolveOperation for caller-authorized tenant/scope/family/lifecycle/configuration/purpose and operation ID, with observation cutoff, immutable mutation/hash/audit/transition validation and the same operation advisory fence as commit. Recovery returns historical original input only, never current approval/release authority.
Fresh: extend existing actual publishing-mutation-store scenario for absent lookup, response-loss recovery, later lifecycle/archived state recovery, wrong scope/family/lifecycle/purpose and future cutoff; Publishing build, affected lint/format and actual ownership/import. Existing schema/install evidence unchanged; no unrelated regression. This is a prerequisite to atomic review creation, not its completion.

### Review creation operation recovery result

- Publishing owner resolveOperation now returns exact immutable original mutation under the existing operation fence, scoped to tenant/Brand/Store/family/lifecycle/configuration/purpose and observation cutoff. Verifies original intent hash, Audit ID/actor/target/classification/action/time and valid transition. It is historical recovery input only, never current approval/release authority.
- Actual Publishing persistence scenario passed8e2abb12.454s: absent lookup, acknowledged-loss original recovery, unchanged original Audit after retry, wrong identity/purpose/cutoff rejection, foreign tenant/Store isolation, and original draft recovery after later family lifecycle/rollback/archive. Existing atomic Audit/review/approval/race assertions remained in this selected scenario.
- Publishing build/affected lint/actual database ownership passedbfe1a7; import1d3054, formatting51e561 and final scope/whitespace reviewa83e01 passed. No failed check, schema change, dependency/install or unrelated regression.
- Next atomic review creation must use exact recovery before preparing current sources, compare original caller intent and save content plus Publishing Draft/InReview in one transaction. Current recovery requires lifecycleReference; creation must persist or deterministically resolve that server identity rather than generate a different one on retry. Formal review creation and full dependency-bound HTTP lifecycle remain unfinished, as do candidate/runtime/receipt/refund/operations/live gates. Full pilot goal remains active.

### Atomic Menu review creation selection

Add API owner composition that requires server Actor, Menu version/configuration digest, registry and operation identity. Server reference provider must deterministically return distinct lifecycle/validation/review-operation/Audit IDs for that operation. Exact original Draft and SubmitReview mutations recover before current-source reads; original actor/menu/version/configuration/registry and consumed validation must match. Fresh preparation saves immutable content plus Publishing Draft and InReview with three Audit records under one savepoint; any failure rolls all new rows back even if outer caller catches. Current permission applies on replay and before/after writes. No approval or Catalog forward transition is implied.
Fresh: extend actual Recipe/Menu fixture with successful creation, exact replay after dependency change, changed intent/denied authority rejection, and injected last Publishing insert failure caught inside caller transaction leaving no partial content/mutation/audit. API types/affected lint/import and existing owner metadata. No new schema/install or unrelated regressions.

Initial API typecheckccdfa0 found that API has no direct @bop/publishing dependency. Add only that existing workspace dependency; update the lockfile offline, inspect its scoped importer change, then run one offline frozen install to establish valid installation evidence. No new external package/version upgrade. This manifest change invalidates prior install reuse until the fresh frozen run completes.

Offline lock metadata update76d88e and frozen install67d8d1 passed (already up to date, no downloads). Lock diff includes existing WP workspace/Stripe entries and peer-context labels; preserve unrelated changes. API typecheck then identified two cross-Domain branded-ID comparisons in the new recovery path; compare their validated string values, preserving actual scope checks. No dependency/version upgrades intended; rerun affected API types after correction.

Previous two check outputs were truncated and their terminal handles are closed; results are unknown. Rerun only those checks with retained local logs to establish evidence.

### Atomic Menu review creation result

- Added API composition using public Catalog/Publishing stores in the retained caller transaction. Stable purpose-specific server references recover original Draft/SubmitReview before reading current upstream facts; mismatched actor/version/configuration/registry or denied current permission rejects. Fresh content and two Publishing mutations with three Audit records share a savepoint. This creates review evidence, not approval or the Catalog lifecycle transition.
- Actual PostgreSQL Recipe/Menu scenario passed 127f8d (13.651s): exact row increments, no duplicate retry, original recovery after source change, changed intent/current permission rejection, and injected second Publishing insertion failure leaves content/mutations/Audit counts unchanged even when caller catches and commits.
- API typecheck, affected ESLint and import boundaries passed d57710. Scoped source/rollback/whitespace review 0d8005 passed. The earlier two outputs were lost and terminal handles closed; those unknown results are not counted as passes. Only these affected checks were rerun, with logs /tmp/wp2402-creation-static.log and /tmp/wp2402-creation-db.log.
- Existing workspace Publishing dependency was added; offline frozen install 67d8d1 remains valid with unchanged manifests/toolchain since that run. No new schema or external dependency downloads. No unrelated regression, commit, deployment or live action.
- Next: integrate creation with the existing Catalog SubmitReview transaction and merchant HTTP flow, with stable server reference derivation and exact request recovery. Complete dependency-bound approval/publication journey, assembled candidate runtime, receipt/refund/operations and external pilot gates remain unfinished. Full pilot goal is not complete.

## Authorized instruction audit follow-up

The Owner requested the five minimal corrections from the instruction audit.
This documentation-only follow-up changes five nested AGENTS files and the
bop-work-package and bop-screen-contract skills on the current WP branch.
It aligns local check selection with root policy, removes obsolete WP-0004
shell restrictions, allows authorized brief preparation and read-only work
despite unrelated changes, and distinguishes Figma draft design from implementation.
Existing permission, privacy, Section 87.3/88, accepted-design implementation,
CI and external-action gates remain effective.

Verification selection: check the five audited decision boundaries and retained
controls through source/diff review and an independent scenario review; validate
skill structure with the existing skill-creator quick_validate.py for each changed
skill and `pnpm repository-guidance:check`. Fresh formatting uses
`pnpm exec prettier --check apps/{api,worker,customer-pwa,merchant-web}/AGENTS.md packages/contracts/AGENTS.md .agents/skills/{bop-work-package,bop-screen-contract}/SKILL.md`;
check only this appended WP section via
`pnpm exec prettier --check --stdin-filepath docs/spec/work-packages/WP-2402.md`.
Use `git diff --check` restricted to the seven guidance files and inspect this
section separately, preserving the pre-existing WP content and staged changes.

This selection explicitly resolves the obsolete nested every-change checks
under root policy and the Owner's requested corrections. Business tests,
application builds, database acceptance and a new installation are not applicable
to these text-only inputs. Full `pnpm verify` and `pnpm test:integration` remain
with the existing complete-journey/release/merge milestone. No existing business
check is relabeled as a fresh pass; full pilot completion is not claimed.

Fresh results at HEAD `a0f35440cacff1ab55be78edfb08cb4de90c1a26` plus the seven
guidance edits and existing uncommitted WP work: repository guidance passed
(33 ADRs, five skills, templates and boundary smoke; run 9b61d6); both existing
skill-creator `quick_validate.py` runs passed under WSL Python
(4cab53, d8ca5f); scoped Prettier and guidance-file whitespace checks passed
(3c7665). The independent five-scenario review found no residual conflict or
weakened safety boundary. Snapshot comparison preserved all pre-existing WP
bytes (0b2ebd). The first WP-section check attempt (c266cb) stopped before
Prettier because a non-login subprocess resolved system Node 18.19.1.
The retry uses the established WSL login shell with Node `24.18.0` and pnpm
`11.13.0`, matching project pins; this appended section passed its selected
stdin Prettier check before being written. No business checks, install,
commit, push or external mutation were run for this documentation follow-up.

- API production build passed d58543 after the atomic creation implementation. This was the directly affected build; no broader suite was rerun.

### Merchant Menu review submission integration selection

Wire CreateReview through the existing protected Menu publication BFF endpoint. Closed input supplies Menu/version, expectedVersion1, configuration digest, registry and operation; Actor/Tenant/Brand/time remain server-owned. One outer merchant transaction creates immutable content and Publishing review, then Catalog SubmitReview. Retry uses original creation time/digest and requires current catalog.menu.submit plus publishing.draft.create/publishing.review.submit. No approval implied. Separate owner operation namespaces share the correlation identity.
Fresh: focused command tests, protected BFF tests, API build/lint/format/import; actual Recipe/Menu DB scenario through this command for successful Catalog transition/replay and outer rollback on Catalog failure. Reuse unchanged install67d8d1 and owner evidence127f8d/8e2abb. No schema change/full regression. Complete approval/publication HTTP journey and candidate assembly remain required.
Native apply_patch failed before editing (Windows sandbox helper initialization); WSL fallback edits preserve existing dirty work.

### Merchant Menu review submission integration result

- Existing protected POST /merchant/catalog/menus/publication now accepts closed CreateReview input (operation/Menu/version/expectedVersion1/configurationDigest/registry). Merchant runtime exposes explicit reviewCreation budget/stable-reference configuration. Server identity/scope and clock come from current merchant context. Catalog submit and both Publishing draft/create/review-submit Brand grants apply; no approval created.
- Content, Publishing Draft/InReview, and Catalog SubmitReview execute in one outer merchant transaction. The persisted creation supplies binding/snapshot/original clock; exact retries retain them even after source changes. Response includes the snapshot digest needed by later actions. Existing publication commands retain their input contract.
- Actual HTTP/BFF/owner PostgreSQL scenario passed83c3cf13.498s: successful InReview, exactly one content/two Publishing mutations/four audits, response retry without duplicates after real SKU mutation, changed registry conflict, forged actor rejection, current Publishing permission denial, and injected Catalog revision failure hits the intended write and rolls back content/Publishing/audits. Authentication/policy/Store facts are synthetic fixtures, not live approval.
- Focused API6 tests/typecheck/affected lint/import passed41ab6a; original BFF30 plus previous command4 passed1edbb9 before the added2 tests (unchanged BFF source). Final API build and fixture lint passed62ea9e; source/whitespace review65b512 passed. Initial lint found four forbidden non-null assertions, replaced with explicit guards. Initial DB39dc5c failed before business execution because Docker was down; subsequent2a64e7 caught a missing test fault-counter increment, corrected before final pass. Never count the first shell exit0 as a test pass: its output explicitly reported failure.
- Docker recovery: Desktop startup failed on inaccessible stale Unix socket reparse points in Local/Docker/run and Local/docker-secrets-engine. Preserved only verified temporary endpoint directories as run.recovery-20260915-2039, run.recovery-20260915-2043 and docker-secrets-engine.recovery-20260915-2040; recreated empty directories. No images, volumes, credentials or configuration deleted. Docker Desktop start9ef36d and WSL engine29.1.3 check040b92 passed; new DB scenario ran afterwards.
- Adopted refreshed shared instructionsd438ab, preserving instruction-audit edits and existing evidence. No schema/dependency change or reinstall; frozen67d8d1 remains applicable on same installation/manifests/toolchain. No full regression. Still required: normal approval and complete dependency-bound publication journey, executable candidate assembly and customer/merchant/worker receipt/refund/operations flow with actual browser evidence; external Provider/Store gates remain unclaimed. Goal incomplete.

### Menu approval and complete publication integration selection

Add explicit configured approval composition to existing Approve command, after current Menu/full dependency revalidation and before owner candidate reads. Require current catalog.menu.approve and publishing.review.approve Brand decisions. Approval is authored by server Actor for exact immutable snapshot/review2, uses server validity policy bounded by original validation expiry, and commits Publishing approval with Catalog approval in the retained outer transaction. Exact Catalog replay bypasses new writes; Publishing operation recovery compares original approver/digest/references. No implicit approval, client evidence or invented four-eyes rule.
Fresh: extend actual dependency-bound Recipe/Menu HTTP journey through Approve/Publish, current-source drift rejection, permission denial and Catalog failure atomicity. API focused existing tests/build/lint/format/import. Existing installation/schema unchanged. Legacy externally supplied approval remains supported when normal approval composition is not configured. Full pilot assembly remains required.

Initial complete approval/publication HTTP DB scenario d6e77d passed14.746s; focused6/types/lint/import5c493a/135878 passed. Final review found current Publishing approval permission could be skipped by Catalog's exact replay path; add explicit current permission before/after execution and test post-approval revocation. Also assert an expired server validity policy fails without mutations. This source/test change justifies rerunning affected command/static checks and the same HTTP DB scenario; no unrelated expansion.

### Menu approval and complete publication integration result

- Added menu-review-approval-source using public Publishing owner mutation APIs. Explicit merchant Approve first checks current Menu/full dependency binding, then creates Actor-bound approval for exact InReview version2 and records Publishing/Catalog approval in one outer transaction. Runtime requires configured stable approval/Audit references and server validity policy; expiry cannot exceed source validation lifetime. Existing pre-supplied approval path stays available when reviewApproval is absent.
- Current catalog.menu.approve and publishing.review.approve Brand permission checks apply before/after execution, including exact successful retries. Input cannot supply actor, approval evidence or approval clock. No new four-eyes policy invented; actual approvedActor must match authorized command Actor.
- Final real HTTP/BFF/Recipe/Catalog/Publishing PostgreSQL journey passed02281714.980s: create review, source-drift409 before approval, Publishing permission403, invalid server expiry503 without writes, injected Catalog approval-write failure rolls back Publishing approval/Audit, successful approval and exact retry, revocation after approval denies retry, publish to real Catalog release, read exact immutable published content and retry without duplicate rows. Identity/policy and business facts are synthetic, not external readiness evidence.
- Final API build/focused6 tests/affected ESLint/import passed599f6b. Earlier API typecheck135878 remains applicable except the subsequently compiled permission guard. Formatting0befe9 and source/scope review completed. Initial complete path d6e77d passed; repeated selected scenario only because review identified missing exact-replay permission checking and added validity-policy failure coverage. No failed checks in this increment.
- No migration/dependency/installation change; reuse same installation67d8d1, unchanged schema178 and protected BFF30 evidence1edbb9 (router unchanged). No full regression or live approval/publication. Next integrate the explicit owner configuration into executable pilot runtime and merchant UI as needed, plus remaining receipt/refund/operations/customer journeys and actual browser acceptance. The complete single-store pilot goal remains unachieved.

### Ordinary refund merchant preparation route selection

Wire existing createMerchantOrdinaryRefundCommand into explicit merchant runtime ordinaryRefund configuration and protected POST /merchant/payments/refunds/prepare. Same-origin/Host/session/CSRF/no-query controls precede command execution; current Store executor and all Payment request/allocation/escalation/MFA rules remain in the existing command/owner. Return only PreparationRecorded, operationReference and replayed with202; no Provider call, financial payload echo or refunded-success claim. Register route template for bounded telemetry.
Fresh: existing merchant-bff tests plus new hostile-origin/credential/query/unconfigured/replay/redaction behavior; existing ordinary-refund-command9 for actor binding and injection rejection; API types/build/lint/format/import. No persistence/financial-rule/source changes, so prior owner DB evidence remains reusable and no DB suite is required just for this route wiring. Worker dispatch, receipt integration, actual credentials and full pilot browser journey remain unfinished.

### Ordinary refund merchant preparation route result

- MerchantRuntimeOptions now accepts explicit ordinaryRefund configuration and composes existing authenticated preparation command. Existing protected BFF exposes POST /merchant/payments/refunds/prepare, with same-origin/Host/session/CSRF/no-query controls and registered telemetry route template.
- Response202 contains only PreparationRecorded/operationReference/replayed. Internal Provider fields are not serialized; preparation does not imply dispatch, settlement or receipt issuance. Unconfigured runtime returns503; command failure returns bounded request_denied.
- API typecheck plus merchant BFF31 and ordinary-refund command9 passed72a6b9. HTTP tests cover hostile Origin/Host/fetch-site, missing cookie/CSRF, injected Store query, unavailable configuration, exact replay labeling and internal-error/result redaction. Existing command tests retain server Actor/Store/Provider identity binding and financial/authority injection rejection.
- API build, affected ESLint, import boundaries and scoped whitespace review passedcb32e5; formatting8268f0 completed. No failed checks, owner/schema/dependency changes or installation work. Existing protected middleware and preparation owner implementation were reused; no new DB run is claimed or needed for this transport-only composition.
- Next wire durable ordinary-refund discovery/dispatch/reconciliation into the Worker and issue corresponding receipts after confirmed owner outcomes; existing send runtime is internal and candidate process remains incompletely configured. Preparation request/approval UI, executable full Store runtime, browser journey and actual Provider/Store gates remain incomplete. Goal remains unachieved.

### Durable ordinary refund work discovery selection

Add bounded scoped work discovery to existing Payment-owned ordinary-refund-operation-store asset. Current authorization before/after read, explicit Tenant/Brand/Store filtering, operation cursor1..100, exact immutable record validation. Return only operation/order/request IDs and Dispatch/Reconcile according to durable dispatch journal presence. Scan is discovery, never authority to send or proof of settlement; include journaled work for reconciliation/receipt retry. Publicly export existing send/reconciliation runtimes for composition without private imports.
Fresh: extend existing ordinary-refund-request DB acceptance helper for discovery, cursor exhaustion, denied access and all scope boundaries, and Dispatch→Reconcile after actual journal creation. Payment build, affected lint/format, ownership/import. No schema/install changes. Current purpose is prerequisite to real Worker composition; full pilot remains incomplete.

Add ordinary-refund Worker workload using existing bounded polling/lifecycle primitive. It selects dispatch versus reconcile solely from owner discovery, calls receipt/projection callback only after durable reconciliation, records bounded failure code and revisits scans for recovery; no provider/state simulation in production. Existing send owner journals prevent duplicate sends even for stale discovered candidates. Fresh focused Worker tests cover journal-selected routing, receipt failure/retry, drain/no-overlap; Worker build/lint/import. Executable configured process and real receipt callback still must be composed.

### Durable ordinary refund discovery and Worker result

- Added public createPostgresOrdinaryRefundWorkSource in existing Payment-owned persistence asset. It authorizes before/after bounded reads, validates immutable operation payload against selected row/scope, filters explicit Tenant/Brand/Store, and returns only operation/order/request IDs plus Dispatch/Reconcile from actual durable dispatch journal presence. Cursor is scan progress, not a lease or permission grant. Existing send and reconciliation runtime exports allow public composition.
- Actual ordinary-refund PostgreSQL scenario passede6122b12.688s: newly prepared operation discovered as Dispatch, cursor exhaustion, denied scan, oversize limit rejection, foreign Tenant/Brand/Store isolation, and actual dispatch journal changes discovery to Reconcile. Existing preparation/dispatch/isolation assertions in selected scenario remain passing. Synthetic authority/provider facts remain labelled.
- Added createOrdinaryRefundWorkload using existing bounded lifecycle/polling primitive. Dispatch candidates use send port; journaled candidates use reconciliation port then owner-controlled receipt/projection callback. Callback failure is recorded with bounded code and later scan retries; no raw Provider errors logged. Owner send/reconcile runtime still controls durable idempotency, human authority and confirmed settlement.
- Worker2 behavior tests passed8ccd45: journal-selected path never re-sends during reconciliation/receipt recovery; stopping drains active dispatch without starting remaining candidates or overlapping polls. Worker build/affected ESLint/import/database ownership passedcb3f60; Payment buildabedb7, formatting and scoped source/whitespace review091773 passed. No failed check, schema/dependency/install change or full regression.
- No executable Provider/refund service was started. Next compose these actual owner adapters with configured transactions/authority/stable dispatch identities/Provider lookup/receipt issuance and durable failure recording in candidate Worker. Preparation/request/approval UI, complete Store runtime, receipt/operations/browser journeys and actual external pilot evidence remain incomplete. Full goal unachieved.

### Ordinary refund processing composition selection

Compose public Payment discovery/send/reconciliation runtimes with actual refund-receipt issuance in API application composition. Expose structural ports consumed by existing Worker workload; retain owner transactions and post-commit Provider boundary. Closed candidates/identities, configured scope equality, distinct dispatch versus reconciliation paths. Receipt callback opens its own transaction and re-reads complete owner coverage, never treating channel response/state as confirmed settlement. Stable dispatch IDs/current approval, fresh observation job IDs and freshness policy remain explicit server configuration.
Fresh focused API wiring/scope/error recovery tests, API type/build/lint/import. No owner SQL/financial logic/schema change; reuse prior actual scan e6122b and owner send/reconciliation evidence; no new actual combined receipt journey is claimed. Candidate configuration and durable failure recorder remain required.

Initial composition typecheck9104c5 exposed incomplete test receipt scope; corrected account/environment fields and added constructor equality guard. Final source review additionally found the new scan selected all accounts/environments within Store; require account/environment in scan scope and filter/validate both in owner SQL. This concrete isolation change requires rerunning actual ordinary-refund scan DB and Payment/API compilation, not unrelated suites.

### Ordinary refund processing composition result

- Added createOrdinaryRefundProcessing: public Payment discovery/send/reconciliation adapters plus actual refund-receipt issuance expose ports for the existing Worker workload. Closed candidates/identities; stable dispatch/current approval supplied by trusted configuration; new lookup observation IDs; Provider send retains committed-journal boundary. Receipt callback uses a separate transaction and full owner financial coverage, never Provider response amounts.
- Constructor binds Tenant/Brand/Store/account/environment consistently across processing and receipt sources. Final review corrected scan to require/filter/validate providerAccountReference and environment as well as Tenant/Brand/Store, preventing cross-account or Test/Live work selection within one Store.
- Focused API3 wiring/scope/failure-recovery tests passed2a8a44; API types/build/lint/import passedb75884 before the final scan signature extension, then Payment build and API typecheck6360f6 passed with that extension. The API composition source is unchanged since its passing build. Final lint/import/database ownership/scoped diff passed2f11d2.
- Actual scan/ordinary-refund DB scenario passedaab98813.787s including foreign account and Live-environment exclusion plus prior preparation/journal/RLS checks. First composition typecheck9104c5 failed because the test receipt scope omitted account/environment; corrected, no hidden pass. Final formatting3d3c09 completed.
- Evidence proves actual scoped scan and composition wiring independently. It does not yet prove this new composition's complete live or single-fixture send→lookup→receipt journey. Existing owner adapters remain actual implementations; unit ports are explicitly doubled. No credentials, schema/install changes, external refund or candidate-process activation.
- Next run combined actual processing/receipt acceptance, supply durable failure recording and explicit candidate configuration, then activate the configured workload alongside existing consumer worker. Complete pilot, merchant request/approval UI, original receipt issuance and browser/external Store/Provider gates remain unfinished.

### Actual ordinary refund processing journey selection

Extend the existing configured Pickup PostgreSQL/receipt fixture with the actual API
processing composition: committed dispatch, simulated successful Provider response
followed by observation commit loss, journal-protected retry, concurrent reconciliation,
and idempotent receipt callbacks. Provider HTTP remains explicitly synthetic. Reuse
the existing assertions for authority withdrawal, durable audit/coverage, immutable
original and pending receipts and protected customer receipt HTTP. Fresh: only the
affected configured Pickup acceptance and formatting/lint of two helper files.
No production code, schema, installation or toolchain change; previous compilation,
owner scan and Worker unit evidence remains applicable. No full regression.

Combined run efdb95: legacy cases2 passed; configured cases2 reached successful
processing recovery and receipt assertions but failed the final cumulative-provider
observation count (2 versus3). The newly selected response-loss branch omitted the
normal branch's older cumulative observation fixture. Extract/reuse that fixture
before receipt callbacks, retaining the original final count rather than weakening
it. Rerun only configured=true cases, including zero and positive tip. Legacy cases
are unaffected by this branch correction. Advisory lock waiting observed during
execution belonged to the existing scenarios; the run completed, not timed out.

Follow-up223a6e still failed the same final count in both configured cases.
Correction to the prior explanation: positive is successful fulfillment versus
cancellation, not tip selection. Only successful fulfillment with sessionPayment
executes the ordinary-refund receipt fixture. The final expected cumulative count
must include that branch condition. Added an explicit Recorded status and exact
observation-row assertion at the historical observation write. Run only
configured=true, positive=true to locate whether that path actually reaches
the write; no combined passing result is claimed yet.

Focused e7e396 exposed the actual composed response-loss lock-probe failure:
the Pickup transaction adapter requires a values array, but the reused probe
issued SET LOCAL without one, raising TypeError before the intended lock assertion.
Pass [] explicitly. Earlier final-count failures do not prove the receipt callbacks
completed; supersede that optimistic interpretation. Fresh rerun configured cases
only after correcting this concrete adapter mismatch.

### Actual ordinary refund processing journey result

72c01b passed both configured Pickup cases (successful fulfillment110.055s,
cancellation45.097s), command:
pnpm exec vitest run --config packages/database/vitest.pickup-checkout-composition.config.ts -t "configured=true".
The successful case now uses actual createOrdinaryRefundProcessing dispatch and
reconciliation plus real PostgreSQL owners and actual refund-receipt callback.
Synthetic Stripe succeeds once while observation commit fails; dispatch is durable,
retry makes no second Provider send, concurrent reconciliation persists one
observation/audit, and two callbacks append only one final refund receipt. Existing
original/pending receipts remain immutable and customer HTTP returns all three.
The older cumulative Provider observation is explicitly Recorded and read back.
Authority revocation and lock competition remain covered. Provider transport,
Store policy and fixture identity are synthetic; no live refund was made.
Cancellation now expects only its own two Provider observations, rather than a
third observation from a refund fixture it does not execute.

531f33 affected three-helper lint passed before the same acceptance; bda21a scoped
diff review passed. Legacy nonconfigured cases passed efdb95 and were filtered
from72c01b: their executed branch, inputs, dependencies and toolchain were unchanged
by the final configured-only corrections. Failures efdb95,223a6e,e7e396 are recorded
above; no failed run is represented as a pass. No production source/schema or
installation change, so prior build/type/ownership evidence remains applicable.
Same HEAD a0f3544 plus existing dirty WP inputs; no commit/push/merge/deploy.

Next: durable Worker failure recording and explicit runtime configuration/activation.
Candidate business API and complete browser/Store/Provider pilot gates remain open.
The single-store pilot goal remains active and unfinished. Stop this increment's
verification now that the scoped acceptance is supported.

### Ordinary refund durable failure recording selection

Compose the existing public Audit append owner in API for the Worker failure port.
Trusted configured Brand/Store, fresh audit identity and retention policy; explicit
before/after authorization; closed UUID candidate and exact bounded failure code.
Use the existing transaction runner and scope context; never persist raw errors,
Provider payload, customer facts or amounts. One audit per failed execution attempt,
not a financial outcome or retry authorization. No schema or domain-rule change.
Fresh focused authorization/bounded-payload/rollback tests, API build/lint/import;
extend existing configured successful Pickup acceptance to record and read the
failure audit after simulated observation commit loss. Reuse installation178-schema
and unrelated Worker lifecycle tests. Runtime activation remains subsequent.

### Ordinary refund durable failure recording result

Added createOrdinaryRefundFailureRecorder using public Audit append in a configured
transaction. Closed UUID candidate and exact failure code; configured Brand/Store
context and explicit authorization before and after append; fresh audit identity.
Stores only operation target, Dispatch/Reconcile stage, bounded reason and required
audit metadata. No raw exception, Provider payload, customer data or financial amount.
Audit/authorization failure propagates, so Worker cannot silently lose failure evidence.
This is operational evidence, not a financial outcome or retry authorization.

01fc1d focused3 tests passed (bounded content, injected payload/code rejection,
authority withdrawal and audit failure propagate without committing). Initial API
build6afde6 failed because a narrowed mutable record property was unknown inside
the transaction callback; immutable local workKind fixes typing without changing
validated values or side effects.4021d API build, affected lint, import boundaries
and scoped diff check passed. The already running DB acceptance5c5fe8 passed108.16s:
actual audit row readback after lost observation commit, plus no double Provider send,
reconciliation and immutable/idempotent receipt assertions. Provider transport and
authorization grants are explicitly synthetic. No restart or duplicate database run.

Tests executed against the current a0f3544 dirty WP; the type-only local-variable
correction preserves inputs and execution of the focused test and already-running
database scenario. Existing installation,178 migration and unaffected Worker
lifecycle/other Pickup-case evidence remain applicable because their inputs,
dependencies/configuration/toolchain did not change. No full regression,
commit/push/merge/deploy or live payment. No further checks selected for this increment.

Next assemble configured refund processing + durable failure recorder with
ordinary-refund workload and existing composite lifecycle; supply real accepted
Store/runtime configuration before activation. Current candidate remains incomplete;
the overall single-store pilot goal remains active and is not achieved.

### Configured ordinary refund Worker assembly selection

Add a trusted local configuration helper in tooling/environment composing actual
API processing and failure recorder with the existing ordinary-refund workload.
Lazy open at start; bind failure scope/transactions to processing configuration,
never independent defaults; close once after drain or failed construction/start.
Propagate workload failure and cleanup failure through completion/runtime. Existing
--configuration loader remains the process entry. No startup Provider/Store defaults
and no activation of an unconfigured candidate. Fresh lifecycle/wiring tests,
affected format/lint/import; reuse owner/receipt DB5c5fe8 and Worker lifecycle
behavior because no financial owner or workload implementation changes. Document
exact configuration contract and remaining external/runtime requirements.

### Configured ordinary refund Worker assembly result

Added tooling/environment/ordinary-refund-worker.mjs. A trusted --configuration
module can export this lazy workload: open resources at start, compose real API
processing and durable failure recorder with the existing ordinary-refund workload,
bind failure scope/transactions to processing, drain before closing, close once
across startup failure/stop races, and propagate bounded failure/completion.
README documents full explicit configuration, partial-acquisition cleanup ownership
and safe resource sharing when combined with event consumers. No credentials,
authorization policy or Provider/Store defaults are invented.

1f876f focused4 assembly/lifecycle tests, affected lint, import boundaries and diff
check passed. API factories are doubled in these wiring tests; the actual Worker
workload/lifecycle executes. c311b3 real Node import with the existing workspace
loader resolved actual built API/Worker exports without opening resources or
starting work.473726 initially passed4 tests but lint rejected throwing from finally;
rewrote shutdown to track cleanup failures explicitly and reran the affected tests.
A failed tool-script parse made no repository change. No hidden passing claim.

Financial owners, receipt processing, failure recorder and Worker polling logic are
unchanged; reuse DB5c5fe8 and API4021d at a0f3544 plus the same dirty inputs and
existing valid installation/builds. New files are JavaScript runtime composition,
so no new TypeScript build is required; real Node import proves module resolution.
No repeated database run/full regression/install, schema change or external action.

This is a usable configuration assembly, not an activated pilot process. Existing
.local/pilot configuration is demonstration-only and does not supply the required
current authorization, Provider/account and receipt/Store configuration. Next
resolve the remaining concrete local runtime inputs, assemble business API and
event/refund workloads, and run a full browser journey in a fresh versioned candidate
profile while preserving the older174-migration database. External identity,
Provider and Store acceptance remain explicitly separate. Overall goal active.

### Fresh candidate profile selection

Preserve existing .local/pilot and its174-migration database/volume. Create independent
ignored .local/pilot-v2, Compose project bop-rms-wp2402-pilot-v2, database
bop_rms_wp2402_pilot_v2 on55433; API53001, Merchant55175, Customer55176. New local
credentials stay0600 and never enter output. Copy only existing connection/health
runtime and restricted application-role provisioning with explicit new names/paths.
No old Store approvals/data or live credentials are imported. Apply the current
catalog to the new empty database using the existing Migration Runner exact target;
verify this actual new database and restricted roles once. Do not repair/baseline/
bypass the old out-of-order catalog or rerun unrelated business suites. Fresh
candidate remains health-only until business configuration is assembled.

### Fresh candidate profile result

Created ignored .local/pilot-v2 with independent Compose project/volume and database
bop_rms_wp2402_pilot_v2 on55433. Original .local/pilot, old container/volume and all
old credentials remain unchanged. New local administrative/API/Worker credentials
are0600 and were never printed. Restricted application roles are distinct v2 roles.

331bbd Migration Runner apply completed;0dc758 verify completed.4d1f7c summaries:
178 applied,0 pending,0 diagnostics,state current,status ok for both. Actual
application-role provisioning0dc758 verified API/Worker login, disabled superuser/
BYPASSRLS/role-creation/database-creation/replication/inheritance flags and denied
ungranted business table access. No catalog repair, baseline or bypass used.

9f423a actual new API process on53001 returned health200 and database-ready200 using
the restricted API account, then SIGTERM drained it and closed its port/pool. API
readiness proves database connectivity only; no business handlers or Store facts are
configured. PostgreSQL remains running for subsequent assembly; API probe is closed.
Merchant55175/Customer55176 are reserved configuration values, not running apps.

No code/schema/toolchain/dependency change. Reused existing connection/runtime and
role scripts with scoped profile/path/name/port replacements; actual provisioning
and migration checks cover those changed inputs. No business suite rerun needed.
Previous174-migration candidate is preserved. Same dirty WP/HEAD a0f3544.

Next populate/configure explicit development organization and public Store/menu
entry through existing owners, compose business API on this new profile, and continue
toward the full Dining/Pickup browser journey. Synthetic development facts must remain
distinguished from actual Store/legal/Provider approval. Full pilot remains incomplete;
goal active. No commit/push/merge/deploy or live financial operation.

### Fresh candidate development drafts selection

Restore explicit demonstration organization/menu/product/price drafts into the new
empty v2 candidate using reviewed existing local provisioning scripts, changed only
for profile/database/role references. Preserve their Draft states and audited
synthetic-only provenance; no public menu projection, operating approval, tax
approval or Provider data is manufactured. Reuse the existing fixture identities
only inside this independent database. Grant scoped entry/menu read and session
write permissions through the existing script, preserving denial of Ordering and
Catalog mutation. Execute each provisioning step once and use its owned readback
assertions. No full suite or schema re-verification:178 applied evidence unchanged.
Public Store/entry activation requires accepted Publishing/Live Gate content and
must not be bypassed merely to make the menu visible.

### Fresh candidate development drafts result

7957a4 completed all five sequential provisioning steps against v2 only:
demonstration Brand/Store drafts with two audits; Menu Draft; Product/SKU Drafts
linked to Menu revision2 with two audits; CAD5.00 PriceBook Draft with null published
pointer; API session/entry/menu privileges with Ordering access and Catalog writes
still denied. Existing scripts performed scoped readback/assertions as part of
provisioning.22bf71 copied only explicitly demonstration JSON and local scripts,
with v2 database/profile/role replacements; credentials were not copied or printed.
Old candidate unchanged;178-migration verification remains valid.

These are preparation data, not public entry/menu activation or accepted real Store/
tax facts. The public customer entry composition explicitly requires current QR
context, public profile, Open operating status/enabled mode and admission before
issuing a session. The current candidate cannot legitimately meet that from Draft
records. Located existing merchant-store-configuration command/review composition
and public Store configuration administration for the next activation step; do not
replace their Publishing/Live Gate checks with constant true values in runtime.

Next connect the existing configuration/review/publication flow for the development
candidate, compose current public Store sources, then enable customer entry/menu.
Full business API/browser/Provider/Store pilot acceptance remains incomplete. No
business suite rerun, no schema/toolchain changes, no commit/push/merge/deploy or
live financial operation; overall goal active.

### Published operating status composition selection

Store remains owner. Compose existing current Publishing/Live Gate proof with
business-date, complete weekly schedule and exceptions in the same retained
transaction. One proof per invocation, no cross-request cache. Require exact full
published content and exception interval digest; explicit current pause-operation
authority remains required. No SQL/schema or business-rule change, new wrapper in
existing infrastructure/public export. Fresh Store build, affected lint/import and
extend existing actual Store configuration DB scenario with positive current
publication, changed weekly content denial and current authority denial. Reuse
178 migrations/install and existing component behavior evidence.

Initial DB3ed8c1 rejected the test probe's attempted update to append-only exception
history. Production protection worked; no data persisted. Remove that probe update.
The legacy fixture deliberately uses a synthetic interval digest; configure its
hash callback to return that digest for interval arrays and canonical hash for
configuration, while still requiring exact complete exception equality. Test
schedule mismatch through the existing rolled-back appended Saturday interval,
not by modifying history. No constraint disabling or repair.

Follow-up fae55c failed because the new test incorrectly assumed no pause history;
the fixture already seeds PauseService/ResumeService before publication. Reuse its
existing explicit synthetic intent-digest proof, retaining actual persisted history
and current Publishing/Live Gate checks. No production behavior changed.

### Published operating status composition result

Added createPostgresPublishedStoreOperatingStatusReader through the existing Store
public export. Composes actual current Store publication proof (Publishing and
Live Gate), business date, complete weekly schedule, complete exceptions and
independently authorized pause history. All sources retain one caller transaction;
publication proof is local to each invocation, never cached across requests.
Exact full schedule/exception equality plus interval digest checks reject partial
or altered published facts. No new SQL, schema, asset registration or rule change.

0be160 Store build passed; c8bf90 import/initial lint passed; final bb4e64 affected
lint and scoped diff passed.561506 actual Store configuration acceptance passed
13.476s with current published Closed state/digest, revoked authorization denial,
and appended-but-unpublished Saturday schedule denial, alongside existing owner
persistence/publication/Store RLS checks. Fixtures explicitly use a synthetic
interval digest and pause intent proof; real current Publishing/Live Gate owner
reads execute. Failures3ed8c1 and fae55c were test setup mistakes recorded above,
not passing evidence. No candidate Store activation or actual external approval.

Current v2 candidate data remains demonstration Draft. Reuse178 migration/install
and prior underlying domain behavior evidence (unchanged inputs/toolchain); no
unrelated full regression. Next wire this reader into actual entry/checkout runtime
with current Store publication configuration and public profile resolution. Public
profile persistence/resolution and approved configuration inputs must be accounted
for explicitly; a working operating reader alone does not make the pilot usable.
Full goal remains active and unfinished. No commit/push/merge/deploy/live payment.

### Public Store profile persistence selection

Existing public-profile contract and service have no owned persistent content table.
Add Store-owned immutable profile versions under namespace1000. Store the existing
closed PublicStoreProfileCandidate payload as historical content, plus a separate
whole-payload digest, actor/audit references and recording instant. Exact scoped
version reads require current purpose authorization and independently verified
Publishing/effective-period/media authority on every call; stored evidence is not
current authority. Append/replay uses retained transaction, current verification
and mandatory audit callback; no update/delete/backfill.
Fresh Store build, catalog/ownership/permission/migration checks and isolated actual
profile persistence tests: scoped readback, idempotency/conflict, revoked proof,
audit rollback and forced RLS/append-only. Reuse current dependency installation.
Do not apply a new lower-namespace migration to existing178-migration v2; preserve
it, and assemble the final fresh candidate after required schema work stabilizes.

Initial531227 build failed on unused extracted fixture import; fixed, Store build
and32 existing profile tests then passed44eca6. Catalog98 tests passed9b3420.
Ownership d0f0ce required exact file/schema/table admission; add that guarded
registration and six boundary cases. Initial DB9b3420 lacked grants for RLS helper
functions in its restricted test role; add only required helpers. Source review
also clones parsed caller payload before asynchronous verification to prevent
caller mutation changing the retained snapshot. Rerun directly affected DB/build
and exact ownership admission tests; no catalog repeat (migration unchanged).

### Public Store profile persistence result

Added1000_007 public_store_profile_version: Store-owned immutable versioned payload,
scope-bound primary key, separate full-payload digest, actor/audit references,
bounded JSON size, forced Brand/Store RLS, no update/delete, PUBLIC privileges revoked.
createPostgresPublicStoreProfileStore appends with current proof and audit in one
caller transaction, supports exact idempotent replay, clones caller payload before
awaits, and rechecks authorization/current evidence for exact reads. Stored release,
timing and media data remains historical, not current approval. No automatic latest
selection or public-reference resolution is invented.

013a26 final Store build,6 exact ownership-admission tests and actual ownership
passed; fb5d49 permissions plus actual new isolated PostgreSQL scenario passed10.85s.
Database evidence covers append/readback/replay, conflicting content, current proof
withdrawal, authorization withdrawal, audit rollback, foreign Store invisibility,
append-only update rejection and delete preservation. Publication authority is an
explicit synthetic test callback; real current Publishing/effective/media proof
composition remains required before customer activation. Existing32 public-profile
business tests passed44eca6 after extracting their unchanged fixture.

9b3420 catalog98 tests passed. Final e7c94d migration:check passed109 catalog/config
tests and static catalog179; final lint/diff checks passed. The wrapper repeated
the already-passing98 catalog tests: this was avoidable command overlap, not new
coverage. Next closeout should use the remaining static check directly when its
test inputs already have valid evidence. No more checks selected here.
Initial unused-import build failure531227, missing asset admission d0f0ce and
test-helper permission failure9b3420 were corrected as recorded above.

No dependency/toolchain change; installation evidence retained. This schema addition
invalidates prior claims of a current178 catalog: v2 still has178 and remains
preserved. Do not force/apply the lower namespace into it. Final candidate creation
must use179 plus any further required schema, after persistence gaps are resolved.
Next bind actual current public-owner evidence and explicit public-reference routing
to this persisted profile read, then connect customer entry/menu. Full goal active,
not complete; no commit/push/merge/deploy or live financial operation.

### Public profile current-publication authority selection

Compose the existing public Publishing mutation owner for STORE_PROFILE /
CUSTOMER_ENTRY in the retained Store transaction. Require exact current lifecycle
and release equality with the saved profile and re-compute only the profile content
digest (excluding digest, Publishing and effective metadata). Current effective
period and pinned media verification remain explicit required public-owner ports;
a null logo needs no media authority. Before/after purpose authorization is mandatory.
Return false on unavailable evidence, with no stale release fallback. Fresh focused
binding/revocation/content/effective/media tests plus Store build/lint/import.
No SQL/schema change; existing Publishing owner and profile persistence database
evidence reused, no new combined real-publication acceptance claimed this step.

### Public profile current-publication authority result

Added publicStoreProfileContent (the explicit display-content digest input, excluding
digest/Publishing/effective metadata) and createPostgresPublicStoreProfileAuthority.
The latter invokes actual public Publishing.resolveCurrentRelease in the retained
transaction with Tenant/Brand/Store and fixed STORE_PROFILE/CUSTOMER_ENTRY binding.
It recomputes content digest, compares parsed current lifecycle/release exactly,
requires current effective evidence and (when logo exists) media evidence, then
rechecks purpose authorization. Missing/replaced/withdrawn publication or any
unavailable dependency returns false; no historical-release fallback.

213300 Store build and focused3 tests passed. Publishing owner is doubled in these
binding tests; they cover retained transaction, exact family/type/purpose, replaced/
unavailable release, wrong digest/scope, effective/media denial, late authorization
withdrawal and no Media query for null logo.47ce08 final affected lint/import/diff
passed. Initial9e7517 type errors were corrected with domain reference parsers and
explicit cross-contract string comparison;213300 also found test-only lint issues,
fixed without changing production inputs/behavior. The successful existing creation
call assertion was retained with an explicit missing-call guard, so prior test
evidence is reused rather than run again solely for lint cleanup.

No SQL/schema/dependency change. Reuse actual Publishing owner and public-profile
persistence evidence (fb5d49) on same a0f3544 dirty WP/toolchain; this turn does not
claim a combined real-publication profile journey. Candidate remains unactivated
and v2 still has178 migrations while catalog has179. Next exercise this authority
with actual profile Publishing lifecycle mutations, then provide current effective/
media readers and explicit public-reference resolution to connect customer entry.
No commit/push/merge/deploy/live payment. Full pilot remains incomplete; goal active.

### Actual public-profile Publishing journey selection

Extend existing profile DB acceptance with real Publishing CreateDraft/SubmitReview/
Approve/Publish/Archive and Audit owner persistence. Create a dedicated synthetic
profile publication fixture from the existing receipt-publication sequence, without
receipt-specific proof or modifying that fixture. Wire actual profile authority to
actual profile store: before Publish denied, after Publish append/read succeeds,
changed website digest denied, after Archive read/replay denied while history stays.
Validation/approver/effective-period facts remain synthetic; no real Store approval.
Fresh only this database scenario and affected helper lint/format. Reuse unchanged
Store compilation/authority tests,179 catalog, ownership/permissions and installation.

### Actual public-profile Publishing journey result

0f723a actual isolated profile DB acceptance passed12.048s. The new fixture uses
real Publishing mutation owner and Audit writes for Draft→Review→Approved→Published
then Archive. Actual createPostgresPublicStoreProfileAuthority is wired into actual
profile persistence: unpublished denied; published append/read succeeds; changed
website fails content binding; Archive denies read and append replay while retaining
the historical profile row. Prior RLS, idempotency, conflict and audit-rollback
assertions remain in the same run. No direct Publishing/history mutation.
Validation/approver/effective-period approval remains explicitly synthetic, and logo
is null (Media must not be queried). This is not full external Store/Media acceptance.

dcc6c6 affected helper/test format and lint passed;081339 final scoped diff/source
review passed. No failed check runs this increment. Production Store source,
schema179, dependencies/toolchain and ownership metadata are unchanged, so prior
build/authority/ownership evidence is reused. No repeated full/cross-domain suite,
migration apply or candidate mutation. Same a0f3544 dirty WP state.

Next complete current effective-period evidence and public Store reference resolution,
then connect profile and operating sources to the actual customer API. Candidate
v2 remains demonstration Draft/health-only at178 migrations; preserve it until final
schema-ready candidate assembly. Overall single-store pilot remains unachieved and
goal active. No commit/push/merge/deploy or live financial operation.

### Configured public Store resolution selection

Add a retained-transaction API composition for a server-configured public reference
binding. Reuse Tenant's existing scoped organization fact reader (not its caller's
Merchant permission). Require current binding/purpose/Tenant association authorization
before and after reads; resolve current Active Brand and Store only. Exact public
request shape, configured validity interval and unknown reference fail closed.
Binding configuration is explicit input, never generated approval or discovery.
Focused tests use the real Tenant reader with synthetic SQL rows to prove scope,
lifecycle, time, malformed request, unavailable source and revocation behavior.
Fresh API build/typecheck, focused test, affected lint/format and import boundaries.
No schema/SQL-owner change: reuse actual Tenant persistence and profile database
evidence; no full database regression, installation or candidate mutation.

### Configured public Store resolution result

Added apps/api/src/public-store-resolution.ts. Server binding is copied, parsed and
frozen; only the closed public reference/time/purpose request is accepted. Invalid
or out-of-window requests never query internal scope. The existing public Tenant
organization reader supplies current Active Brand/Store under scoped shared locks
in the caller-retained transaction. Current binding/purpose/Tenant authorization
runs before and after reads; exceptions or withdrawn authorization return null.
The function neither creates binding approval nor treats profile publication as
current merely because it was saved. Caller must supply trusted evaluation time
and retain the transaction for dependent reads.

699765/c73e4b API build and three focused tests passed (41ms). Tests use the real
Tenant reader with synthetic query rows, not actual PostgreSQL; they cover closed
input, unknown reference, half-open validity interval, Active/lifecycle/future facts,
unavailable database, revoked authorization, unchanged configured scope and both
public purposes. cd3f74/8d478b affected lint, import boundaries, API typecheck and
diff whitespace checks passed. Initial901059 missing explicit method parameter
type was fixed before the successful build/test. Test lint cleanup exposed an
unused parameter; the no-op argument read preserves behavior. A temporary bracket
error d7cc1a was corrected before the final successful lint/typecheck. Successful
behavior tests and production build were reused; no suite was repeated solely
for the test-only lint cleanup.

No Tenant SQL, schema179, dependency or candidate changes. Existing actual Tenant/
profile persistence evidence remains reusable, not newly run. Runtime activation,
current effective-period authority and full customer/merchant/Worker browser
journeys remain outstanding. Next complete effective-period persistence/evidence
and assemble those owner sources into customer entry. Overall pilot goal remains
active and unachieved. No commit/push/merge/deploy or live financial operation.

### Public profile effective-binding persistence selection

Source inspection found that persisted profile authority validated current Publishing
but relied entirely on verifyEffective for binding the timing payload to that release.
The existing Customer service already defines the exact type/purpose/scope/profile/
snapshot/digest/release/time-zone/created-time binding. Reuse that validator at the
persistence authority boundary before consulting the current effective owner.
Do not equate this structural binding with current timing approval. The mandatory
verifyEffective port remains required; durable timing approval is still outstanding.
Fresh Store build, both affected authority/profile test files and the existing
profile PostgreSQL scenario extended with rejected wrong-release append. Reuse
schema179/migration/install/ownership evidence: no SQL or manifest change.

### Public profile effective-binding persistence result

Reused the existing Customer validator as exported
validatePublicStoreProfileEffectiveBinding in the persistence authority before
verifyEffective. Its type/purpose/scope/profile/snapshot/digest/release/time-zone/
created-time rules are unchanged; both boundaries now enforce the same binding.
Current effective approval remains a separate required owner port, not inferred
from a saved timing record or from Publishing approval.

737179 Store build and36 affected tests passed. Added wrong type/purpose/profile/
snapshot/digest/release/scope/time-zone/future-time cases; invalid timing never calls
the current effective or Media port. c411f0 actual isolated PostgreSQL profile
acceptance passed11.443s: wrong-release timing append rejected and exact version
remains absent, then correct append/read and Archive revocation behavior succeed.
Fixture explicitly uses the actual publication release ID. Publishing/Audit/profile
persistence are real; effective approval remains synthetic in this fixture.
e27de0 affected lint/import/diff checks passed;1833c7 final scoped diff review.
No failed checks this increment. All process handles terminal. No schema179,
dependency, candidate database or runtime activation change; reuse unchanged
migration/ownership/install evidence. No full regression or dependency reinstall.

Inspection also confirms generic EffectivePeriod has no infrastructure or owned
schema. Catalog persists its own menu release periods, so it is not a Store timing
source. Next implement Store-owned profile scheduling with exact approval/period
binding, immutable timing history and atomic audit/overlap protection; do not invent
a generic BOP schema or substitute Publishing approval for timing approval. Then
compose the current timing source with profile and public-reference readers in the
customer process. Full single-store pilot remains unachieved and goal active.

### Store profile timing persistence selection

Add Store-owned immutable timing/approval records in namespace1000 using existing
EffectivePeriod constructors and overlap rules. Scope to STORE_PROFILE/CUSTOMER_ENTRY.
Scheduling requires current authorization plus a separate authoritative approval
callback; the stored evidence is not accepted merely because the caller supplied it.
Serialize writes, enforce contiguous family versions, immutable release/content
binding for renewals, exact period digest, approval binding and atomic Audit.
Expose current exact timing verification using saved approved records and current
read authorization. Approval validity applies when scheduling, not an automatic
expiry of the already approved profile period.
Fresh Store build, actual profile PostgreSQL scenario, affected lint, migration
catalog/ownership/permission checks. Catalog changes179→180; preserve candidate v2
at178 and do not apply this lower-namespace migration to it. Reuse installation.

Timing acceptance refinement: initial660241 database run passed. Before closeout,
identified untested renewal/concurrent-writer boundary: extend this same scenario
with two actual connections scheduling an identical contiguous non-overlapping
renewal (one Created, one Existing), changed-release renewal rejected, and reading
the approved period after the approval submission window expires. Rerun only this
changed scenario; existing build/schema evidence remains valid.

### Store profile timing persistence result

Added1000_008 and public_store_profile_timing under the existing Store owner.
Immutable scoped timing/approval JSON is versioned by family, protected by FORCE
RLS, no-update trigger, no-delete rule and unique timing/audit references. Public
owner createPostgresPublicStoreProfileTimingStore parses all EffectivePeriod
contracts, recomputes period digest, checks exact accepted approval binding and
submission window, requires authoritative approval permission, and serializes
append/version/overlap/Audit in the retained transaction. Renewals preserve the
same configuration/release/snapshot/digest. Exact current verification uses stored
approved history, evaluation instant and current read authorization, not a boolean
effective-period fixture. Caller supplies trusted recorded/evaluation instants and
retains its authorization fences through completion; no browser-supplied approval
is intrinsically trusted.

853334/660241 Store build, ownership, permissions and static180 catalog passed;
initial actual profile database scenario passed11.937s. ac239c98 catalog tests and
six exact new SQL-asset admission tests passed, with919 unrelated owner cases
filtered out. Affected lint/import/diff checks passed. c318dc/c8bb67 final changed
database scenario passed11.843s: authoritative-approval denial, Audit failure
rollback, missing timing, exact replay, expired period, overlapping renewal, wrong
approval digest and changed-release renewal denied; immutable history guarded;
two separate PostgreSQL connections produce one Created and one Existing renewal;
approved renewal remains readable after its approval submission window expires.
Current read withdrawal denies. The complete existing real Publishing→timing→profile
read/Archive scenario also passes. Approval actor/permission and Store facts remain
synthetic fixture inputs; this is not a production approver or real Store acceptance.
2a5912 final source/diff review passed. No failed runs this increment. Final test
change only added acceptance assertions; prior build/schema/static evidence reused.

Catalog is now180; preserved v2 remains178, so it is not schema-current or activated.
No existing migration edited, no candidate migration apply, no dependency reinstall,
no full business regression. No commit/push/merge/deploy/live financial operation.
Next compose these actual timing/profile/reference sources in the customer entry
transaction, and provide the authenticated operator path for timing approval and
profile publication. Null-logo pilot avoids requiring a Media asset, but any chosen
logo still requires current Media authority. Complete customer/merchant/Worker
browser journey and external Provider/Store/release gates remain outstanding.
Overall single-store pilot goal remains active and unachieved.

### Persistent public-profile composition selection

Compose configured public-reference resolution, actual Tenant organization facts,
current Publishing/profile authority, Store timing verification and exact profile
load in one retained request transaction. Expose request-scoped profile ports for
entry assembly and a transactional GetPublicStore reader for read consumers.
Configured exact profile selection is server-owned; no latest/historical fallback.
Read composition exposes no write methods and refuses scheduling/materialization
callbacks. Fresh API build/typecheck and actual existing profile DB scenario using
real Active Tenant rows and full public service result; reuse unchanged schema180,
Store build, database ownership/permissions, installation and authority tests.

### Persistent public-profile composition result

Added API persistent-public-store-profile composition. Request-scoped ports compose
actual configured public resolution/Tenant organization reads, current Publishing
authority, Store timing verification and exact profile storage in the caller's
retained transaction. A complete transactional GetPublicStore reader is also exposed.
Selection is an explicit server-configured profile reference/version, no fallback to
latest or historical rows. Read composition exposes no materialization/scheduling
methods, denies approval writes and throws on write Audit callbacks. Request time
and purpose are fixed per port instance; caller must provide a trusted clock and
must not reuse these transaction ports across requests.

fcfb27 API build passed. c61d8f final actual PostgreSQL scenario passed11.420s with
real Active Tenant rows, Publishing, approved timing history, exact stored profile
and public profile service. French locale/content and CustomerEntry/CustomerCart
reads succeed. Browser internal-scope extension is InvalidRequest; unknown public
reference, withdrawn binding authorization, expired selected timing, missing exact
profile version and archived publication yield StoreUnavailable. Public result
omits internal Store scope and effective approval records. Synthetic organization
bootstrap, binding/purpose permissions and timing approver remain explicit test
inputs, not real Store acceptance or authenticated operator approval.

Initiald4096b/dc3495 exposed two fixture requirements: Tenant FOR SHARE needs UPDATE
privilege on at least one column (granted lifecycle only to the test role), and
Tenant rejects noncanonical Etc/UTC. Fixture organization, profile and timing now
consistently use America/Toronto with matching local boundary/offset values.
The production checks were preserved.389774 affected lint/import/API typecheck and
diff checks passed;948224 final transaction/scope/error review passed. Successful
API build reused after test-only changes. No new schema or owner SQL: reuse180
catalog/ownership/permissions/Store build and installation evidence. All handles
terminal. No candidate process/database change or commit/push/merge/deploy.

Next wire these request-scoped profile ports into actual customer entry transaction
alongside operating status, QR admission and session establishment; connect the
transactional reader to Cart. Operator timing/profile approval and publication
still need the authenticated normal path. Candidate v2 remains178 and unactivated;
final schema-current candidate, browser journey and external Provider/Store/release
gates are outstanding. Overall pilot goal remains active and unachieved.

### Runtime persistent entry and Cart selection

Add a persistent entry configuration alternative (no unused legacy profile/QR
placeholders). Bind QR, operating and admission sources plus session binding to one
caller-owned transaction, compose actual profile ports and actual session writer
inside it. EntryUnavailable must roll back the enclosing transaction; only return
credentials after commit succeeds. Reuse the same persistent profile configuration
for Cart's transactional reader. Reject a configured Brand/Store mismatch at runtime
construction. Fresh API build/typecheck, targeted entry transaction tests and local
runtime tests, affected lint/import/diff; reuse actual profile/source DB evidence.
This proves runtime wiring/transaction control, not the complete real QR/admission/
session browser journey; that remains the next composed acceptance milestone.

### Runtime persistent entry and Cart result

Added persistent-customer-entry and a real LocalCustomerRuntimeOptions.entry
alternative with persistent configuration plus shared session settings. It needs
no legacy profile/QR placeholders. Request-bound QR/operating/admission/session
binding ports are supplied for one retained transaction; actual profile/timing
ports and GuestSession entry writer join that transaction. Foreign QR scope is
rejected. EntryUnavailable throws internally to roll back admission/session changes;
only a committed Established result can expose credentials. Runtime construction
rejects mismatched configured Brand/Store. Cart switches to the same configured
persistent public-profile reader. Documented transaction/owner requirements in the
environment README. Process configuration still must supply the actual sources.

d8083a46 tests passed (three new transaction tests plus43 existing runtime tests).
They use real entry domain composition with doubled profile/session persistence to
prove transaction binding, commit order, admission rollback, commit-failure
credential withholding, foreign QR denial and invalid clock rejection before DB.
fdc1bd added real HTTP runtime dispatch test passed58ms: persistent configuration
constructs without legacy placeholders, routes entry to configured transaction/
sources, preserves unavailable response and rejects foreign configured scope.
Other43 unchanged tests reused, not rerun. a7a6d4/fdc1bd final API typecheck/build,
affected lint/import/diff checks passed. Initial test-only generic-mock and zero-
argument spy typing failures a2fd5e/342d6a corrected; passing behavior evidence
reused after nonbehavioral test typing changes. ca659e final runtime diff reviewed.
No new schema, SQL owner, dependency or candidate change; actual180 profile/
Publishing/timing/Tenant database evidence remains valid but was not rerun.

Next assemble actual retained-transaction QR/operating/admission/binding sources
and exercise the persistent runtime with real profile and GuestSession rows over
HTTP, then Cart. This turn does not claim that complete composed database/browser
journey. Operator timing/profile approval path and final schema-current candidate
assembly remain outstanding, as do Provider/Store/release gates. Goal active and
unachieved; no commit/push/merge/deploy/live financial operation.

### Persistent profile-to-entry HTTP database selection

Inspecting source confirms no persisted QR context/key registry reader exists yet;
the existing entry fixture has real ES256 verification but synthetic registry,
operating/admission/binding facts. Do not call those actual persistence sources.
Extend the current real profile/Publishing/timing/Tenant DB scenario with the actual
persistent local HTTP runtime and actual GuestSession writer. Keep missing sources
explicitly synthetic. Verify successful Pickup cookies and durable scoped session,
then fail the outer transaction after session creation and prove no cookies or
additional session/history survive. Archive profile and prove entry denies before
session creation. Fresh only this changed DB scenario plus helper lint/format.
Reuse unchanged API build/runtime tests,180 catalog/ownership and installation.

HTTP rollback assertion refinement: cd2641 scenario passed. Final review found the
failure response/count assertion alone could also pass if entry failed before
creating the session. Add an explicit reached-commit-fault counter and require1,
so the rollback claim proves successful entry creation preceded the injected outer
failure. Rerun only this changed scenario; no unchanged code suites.

### Persistent profile-to-entry HTTP database result

Added persistent-profile-entry helper to the existing real profile DB acceptance.
It runs actual LocalCustomerRuntime persistent entry over loopback HTTP with
ES256 verification, real Tenant/current Publishing/timing/profile reads and actual
GuestSession/operation persistence. Pickup entry returns the canonical201,
one session Cookie and body CSRF token, with no raw session credential/internal
Brand scope in the body. Exactly one scoped session/history row is added.
A second successful entry reaches the injected pre-COMMIT fault; outer transaction
rollback leaves row counts unchanged and returns422 without Cookie or CSRF token.
Archive of the profile then denies HTTP entry without creating another session.
HTTP server is shut down in both success and failure cleanup.

1ff6eb final scenario passed12.034s. cd2641 prior scenario passed12.127s; final
refinement proved the injected commit point was actually reached after creation.
Initialb980c9 was a fixture expectation error (existing contract201 rather than200);
Cookie count and bounded error-body assertions were reconciled with the actual
handler contract without changing production.3bc161 lint required globalThis.fetch;
corrected helper lint passes in126941/5db97a.913240 scoped review/diff passed.
Production source, schema180 and toolchain unchanged: prior API build/runtime,
ownership/permission/catalog and frozen-install evidence reused. No full regression.

Important limitation: QR registry/context, operating, admission/abuse and session
binding decisions remain explicitly synthetic fixture sources. This proves actual
profile-to-session HTTP persistence/rollback, not durable QR registration or a
complete customer journey. Existing generic entry fixture still uses an in-memory
admission consumption set; no durable admission rollback is claimed here.
Next replace these remaining sources with actual configured/current public owner
reads and durable admission consumption, then verify returned credentials through
Cart and proceed to the complete browser journey. Operator timing/profile approval
and candidate schema-current assembly remain outstanding. v2 remains preserved at178;
no candidate process change, commit/push/merge/deploy/live payment. Goal active.

### Configured Pickup QR context selection

Replace Pickup's fixture-only context with a request-scoped API source: explicit
server-registered signed payload, Enabled/Revoked state, evidence reference and
validity; mandatory current registration authorization; exact payload match; actual
Tenant Active Brand/Store via existing configured public resolver in the retained
transaction. Registration is explicit server configuration, not invented persisted
QR approval. No table lookup for Pickup; Dining registration/table mapping remains
separate work. Fresh API build/typecheck, focused config/revocation/time tests and
existing actual profile-to-entry HTTP DB scenario using the new source.
Reuse schema180/ownership/install and unchanged signing/entry domain tests.

### Configured Pickup QR context result

Added createConfiguredPickupQrContext. It captures a parsed/frozen server registration
and trusted request instant, checks Enabled state, registration/QR validity and exact
signed payload equality (including QR/public Store, locale, channel, revocation
version and dates), then requires current registration authorization before/after
actual configured public Store/Tenant resolution in the retained transaction.
Returned context uses actual current Active Brand/Store facts and the earliest
registration/public-resolution/QR expiry. No browser internal-scope selection or
Pickup table discovery. Signature and key policy remain independently enforced by
Dining's existing QR service.

5ccb2b/7d700c API build and three focused tests passed14ms, covering closed public
resolution request, payload substitution, revoked/expired registration and early/
late authorization withdrawal.3d56ea actual profile-to-entry HTTP PostgreSQL scenario
passed12.802s after replacing the context fixture with this source. Successful
Pickup still persists its session; commit-failure rollback still holds; withdrawn
registration authorization returns422 with no Cookie and unchanged session/history
counts; profile Archive still denies entry.1b84ad/cb8d22 affected lint/import/API
typecheck/diff passed;242f4c final source/integration review passed. No failed runs
this increment. No SQL/schema/toolchain change, so180 catalog/owner/permission and
installation evidence reused; no full regression or candidate activation.

Registration and key registry configuration/approval remain explicit server inputs,
not a persisted QR administration implementation or real owner approval. Operating,
admission/abuse and session binding facts still use synthetic fixtures. Dining QR
registration plus current table/public-table mapping is not implemented by this
Pickup-specific source. Next connect the existing published operating-status owner
and durable admission source, then Dining mapping and actual Cart credential use.
The full single-store Dining+Pickup objective remains active and unachieved.
No commit/push/merge/deploy/live financial operation; v2 preserved at178.

### Published operating reader entry integration selection

Entry currently consumes publication candidate ports, while the actual persisted
Store owner returns evaluated operating state with current publication/Live Gate
proof. Add a direct request-scoped operating reader alternative; do not fabricate
a release or candidate from evaluated IDs. Bind public resolution and exact internal
scope/time, retain the transaction, and reject unavailable/closed/disabled modes
before admission. Fresh API build/typecheck, focused entry tests and existing Store
configuration DB scenario extended with actual Tenant/public resolution adapter.
Reuse schema180/owner/permission/install; no new SQL implementation or migration.

### Published operating reader entry integration result

Added CustomerEntryOperatingReader and an alternative composition input; legacy
candidate ports remain supported without changing their contract. Persistent entry
sources can now return operatingReader instead of operating. Entry enforces exact
QR-derived Brand/Store and request instant, Open state and channel enablement before
admission consumption. The new createPersistentEntryOperatingReader binds current
public resolution/Tenant organization to the actual published Store operating owner
in one retained transaction, including existing publication/Live Gate/schedule/
exception/pause proofs. No synthesized publishing release or candidate metadata.

a64efb/9646d5 API build passed. d89f66/f4e04e45 affected entry/transaction tests passed:
new path succeeds without legacy candidate reads; Closed/TemporarilyClosed/mode/
scope/time/unavailable states deny before admission/session creation.3bbdf9/ceaa5a
affected lint/import/API typecheck/diff passed. Initial DB attempt f4e04e failed
before PostgreSQL start because Docker Desktop/WSL integration was unavailable;
no database behavior result was claimed. After authorized recovery,2f8767/bf537f
actual Store-configuration PostgreSQL scenario passed12.131s. New adapter reads
real Active Tenant rows and current Store Publishing/Live Gate proof, returns exact
Closed state/time, rejects unknown public reference/wrong scope and withdrawn
publication authorization. Existing Store persistence assertions also pass.
Approval/public binding and pause-operation facts in this scenario remain explicit
synthetic inputs. c93bc1 final scoped source/diff review passed.

Docker recovery on2026-09-19: initial launch failed on stale dockerInference, then
Secrets Engine socket. Verified Docker processes exited and directories contained
only socket reparse points. Preserved, without deleting data:
C:/Users/gangzhao/AppData/Local/Docker/run.recovery-20260919-073109
C:/Users/gangzhao/AppData/Local/Docker/run.recovery-20260919-073233
C:/Users/gangzhao/AppData/Local/docker-secrets-engine.recovery-20260919-073233
7766cd confirms WSL Docker engine29.1.3 ready. No credential content read, no factory
reset, no image/container/volume deletion. Only the unstarted DB test was rerun;
successful code checks reused. No source SQL/schema180/dependency change.

Next combine this actual operating path with profile-to-session HTTP acceptance,
replace synthetic admission/abuse consumption with durable owner behavior, and
complete Dining public-table mapping and Cart credential use. This turn verifies
adapter DB behavior and entry control separately, not that full combined runtime.
Candidate v2 remains unactivated at178; full pilot and external Provider/Store/
release gates remain outstanding. Goal active; no commit/push/merge/deploy/payment.

### Combined operating/profile HTTP entry selection

Replace the remaining operating candidate fixture in persistent-profile-entry with
real Store configuration materialization, Publishing mutation history and Live Gate
records using existing public owners/fixture. Persist synthetic approved business
facts, not invented real Store approval. Run actual entry with both profile and
operating sources in the same transaction; verify Open creates a session and the
published closing boundary denies without admission/session side effects. Reuse
production builds and schema180; fresh only changed DB scenario and helper lint.

### Combined operating/profile HTTP entry result

Added entry-operating-publication helper: synthetic business facts are published
through the actual Publishing writer/Audit history; existing Store publication
authorization verifies the release/Live Gate before the actual Store materializer
writes configuration, weekly intervals and publication content. The existing
Live Gate fixture persists synthetic approved requirements. This is not the normal
authenticated operator authoring path and does not imply real Store approval.

Persistent-profile-entry now supplies createPersistentEntryOperatingReader in the
same retained request transaction as actual public profile/timing/Tenant resolution,
configured Pickup QR context and GuestSession writes. Dynamic trusted request time
flows into QR/profile/operating evaluation. At07:00 Toronto entry returns201 and
persists the session; at the published08:00 closing boundary it returns422 without
Cookie, admission consumption or additional session/history. Existing registration
withdrawal, post-creation commit-failure rollback and profile Archive denial remain
in the combined scenario. Signature verification remains real; key registry,
registration/Store approval, admission/abuse and binding permissions are synthetic.

007140/46d508 actual combined HTTP/PostgreSQL scenario passed12.147s. Initial8eb9e7
failed because the new test-role table list omitted store_configuration_authoring_
operation, required by the real business-date lineage query; corrected the fixture
grant without changing production authority checks. Affected helper lint passed;
8ada2b final dynamic-clock/source review, format and diff passed. Production code,
schema180 and dependencies unchanged, so API builds/entry tests/ownership/catalog/
installation evidence reused; no full regression or candidate mutation.

Next replace in-memory admission consumption with durable owner behavior and
current binding validation, then prove the returned credential through Cart.
Dining QR/table mapping, normal operator profile/timing approval and schema-current
candidate assembly remain outstanding alongside complete browser/Provider/Store/
release acceptance. Full goal remains active and unachieved. No commit/push/merge/
deploy/live financial operation; existing candidate v2 remains preserved at178.

### Durable Guest entry admission selection

Add Identity-owned single-use admission consumption in0200_018. Exact parsed
evidence and operation/request/time/scope are bound; unique request, operation and
evidence keys prevent replay/concurrent double consumption. Require current policy
authorization before and after insertion and atomic Audit in the caller-retained
entry transaction. No raw QR token, credential, IP or browser payload is stored.
This records consumption, not an invented abuse-policy decision. Integrate actual
store into the existing HTTP entry DB scenario and verify admission/session/Audit
rollback and replay denial. Fresh Identity build,181 catalog/owner/permissions and
affected DB scenario/lint; reuse unchanged API build and installation.

Admission verification inventory: actual HTTP DB fe8e49 passed. Add focused owner
tests for denied scope/time/policy, late authorization withdrawal and Audit failure;
these are new authorization boundaries not fully covered by the positive-policy DB
fixture. Run only this test file and Identity typecheck; keep DB evidence valid.
Concurrent-key protection is provided by database unique constraints; a separate
multi-connection admission race is not newly claimed by this scoped result.

### Durable Guest entry admission result (2026-09-19)

Identity now owns immutable, scoped single-use admission consumption in migration
0200_018. HTTP entry uses this owner, atomic Audit and GuestSession writes in one
retained transaction. Combined real PostgreSQL/HTTP evidence fe8e49 passed:
successful entry, replay denial, injected pre-commit failure rolling back all
three facts, retry eligibility after rollback, and immutable history. Current
abuse policy remains a synthetic authorization callback in this fixture; this
does not establish production abuse protection or normal operator approval.

5116aa/fe8e49: Identity build, database ownership, permissions and static migration
catalog (181) passed. 595d1f: three focused owner tests, Identity typecheck and test
lint passed, covering scope/time denial, current-policy denial, late withdrawal,
Audit failure and duplicate consumption. ee0740/c5035b: 97 catalog tests and six
owner-registration tests passed; the second exact migration-authority expectation
omitted 0200_018 and failed. Corrected that expectation; 35645b reran only the
failed test successfully, then affected lint, import boundaries and diff checks
passed. d23dff reviewed the new source/schema and all six affected code files
passed formatting. The remaining 97 catalog tests were deliberately filtered
from the retry, retaining their prior passing evidence.

No production changes followed the successful database run. Existing installation
and unchanged API build evidence remain valid; no full regression, reinstall or
candidate mutation. Candidate v2 remains at 178 migrations. Production abuse and
binding sources, credential use through Cart, Dining QR mapping, normal operator
approval, assembled candidate/browser journeys and external pilot gates remain
outstanding. The single-store pilot goal remains active and unachieved.

### Entry credential to persistent Pickup Cart selection (2026-09-19)

Extend the existing real profile/entry HTTP scenario using the issued Cookie and
CSRF token through Identity prepare/activate and Ordering Cart persistence. Assert
the rotated credential reads the empty Cart, the predecessor is denied, and an
invalid CSRF attempt has no writes. Keep policy/registration fixtures explicit.
Use existing owner services, no private SQL in API. Fresh combined PostgreSQL
scenario plus affected helper lint/format; production builds/schema/installation
remain reusable because only test-support composition changes.

First integrated Cart read returned503 after successful prepare/activate. The
scenario's transaction runner shared its admin connection across concurrent
profile and quote reads. Replace it with one bounded connection per transaction;
rerun the affected scenario because transaction isolation inputs changed. Fix
helper lint to use globalThis.fetch. No production source change.

### Entry credential to persistent Pickup Cart result (2026-09-19)

20eab3/d8733c passed the combined real HTTP/PostgreSQL scenario in14.424s with
independent bounded database connections per transaction. Entry-issued credentials
successfully prepare and activate Identity/Ordering binding; the rotated Cookie
reads the actual empty Active Pickup Cart and repeated reads retain its reference.
The predecessor Cookie receives401. Invalid CSRF receives503, no Cookie and no
additional Cart. HTTP responses do not expose raw session credentials or internal
Brand references. Actual Audit, session rotation and Cart rows use owner services.
Existing profile Archive, operating closing-time, QR registration withdrawal,
admission replay and injected commit-failure checks also passed in this scenario.

Initial f3be59 failed at Cart read with503 after successful activation because the
fixture shared one connection across parallel transaction runners;61715e corrected
that test harness. Affected three-file lint passed before the successful rerun.
No production behavior/schema/dependency changes this turn; prior builds,181
catalog/permissions and valid installation evidence retained. Synthetic lifecycle
policy, current binding/abuse permission and registration approval remain explicit;
no candidate activation, real Store/provider approval or full browser journey is
claimed. Next replace synthetic current binding validation and continue normal
configuration/runtime assembly. Goal remains active.

### Current Pickup session binding selection (2026-09-19)

Replace the fixture's unconditional Current binding with explicit configured Pickup
QR/Tenant composition. Identity retains session parsing/expiry/rotation ownership;
Dining's configured QR context retains registration matching, validity and
revocation checks; Tenant provides current Active Brand/Store facts. Add an
explicit public purpose to the context (default CustomerEntry for compatibility);
existing-session lookup uses CustomerCart. Reject foreign scope, QR/version or
channel before owner reads; retain before/after registration authorization and
caller transaction fences. No table or write-owner change and no new approval.
Fresh API build/typecheck, focused binding/context tests, affected lint/import and
the existing HTTP/PostgreSQL scenario proving registration withdrawal denies the
already-issued Cart credential. Reuse schema/install evidence.

### Current Pickup session binding result (2026-09-19)

Added createConfiguredPickupSessionBinding in the API composition layer. It uses
Identity session parsing/usability and the existing configured Dining QR context,
checks exact Store/public Store/QR/revocation version, and reads current Tenant
facts with CustomerCart purpose. Entry composition borrows its retained transaction;
subsequent Cart authentication uses an independent bounded transaction. The HTTP
fixture no longer uses unconditional Current session binding.

c8788b/364ebe production API build passed after explicit Identity method parameter
types and string comparison of parsed cross-Domain branded identifiers. Initial
build fccf00 reported those type errors; initial typechecks additionally exposed
the test mock's generic runner and unparsed time strings. Corrected the test
types without changing behavior. c3bfa9/a2d94b: API typecheck and six focused
context/session-binding tests passed. 1e5e58 affected lint and import boundaries
passed; af2c31 actual combined PostgreSQL/HTTP scenario passed13.980s, including
existing entry/Cart flow and newly withdrawn registration authority denying the
already-bound credential with401, then restored authority allowing the same Cart
read. No new credentials/session were issued during that withdrawal probe.
90111d reviewed source/transaction wiring and diff whitespace. No schema or
dependency changes; prior181 catalog/permission/installation evidence retained.

Current binding is no longer a constant answer, but registration approval and
public-purpose authorization callbacks remain synthetic test inputs; no real
operator registration/abuse-policy approval is claimed. Candidate assembly,
Dining table mapping and complete business/browser/external acceptance remain
outstanding. Full pilot goal remains active; no commit/push/merge/deploy.

### Dining public table fact source selection (2026-09-19)

Dining already persists table Publish/IssueQr/RevokeQr and operational state, but
its configuration repository explicitly requires Staff authority. Add a restricted
owner query in the same persistence asset instead of borrowing that authority.
Server caller supplies exact Tenant/Brand/Store/table and purpose; mandatory
authorization before/after the locked owner read must establish the public mapping
and current allowed purpose. Return only published active-QR table facts (version,
operational state/current session), no Staff configuration or arbitrary discovery.
No new tables/writes. Cover actual Draft/Publish/IssueQr/RevokeQr transitions in
the existing Dining Table database scenario, plus denied authorization. Fresh
Dining build/typecheck, affected DB scenario, owner/import and lint/format; retain
schema181 and installation evidence. API public-table mapping remains next.

### Dining public table fact source result (2026-09-19)

createPostgresDiningPublicTableReader is exported through the existing public
Dining index. It reads one exact table under Brand/Store RLS and Tenant predicate,
holds FOR SHARE through the caller transaction, strictly parses the owner snapshot,
requires current explicit-purpose authorization before/after, and returns bounded
facts only for Published/Active QR state. Operational blocking remains a returned
fact for the owning entry/join rule; this reader does not invent a new block or
shared-session lifecycle rule.

9be352/a2ec46 Dining build (full tsconfig typecheck), affected lint, database
ownership and import boundaries passed. 9ec2bf actual PostgreSQL table workflow
passed12.010s, including Draft/Publish denial, IssueQr current facts, RevokeQr
denial, authorization rejection/late withdrawal, foreign Store and future
snapshot rejection. Existing command replay, conflict and atomic Audit assertions
also passed in that scenario. No schema or dependency changes;181 catalog,
permissions and installation evidence reused. Authorization callback is explicitly
synthetic in this test, not public-map or real Staff approval evidence.

Next wire server-owned public-table mapping and actual Tenant resolution to this
owner query for Dining QR entry, then connect current-session binding. The API
mapping and candidate/browser assembly are not yet complete; full goal remains
active. No commit/push/merge/deploy or external service changes.

### Configured Dining QR mapping selection (2026-09-19)

Add explicit API composition of current Tenant public-store resolution and Dining
public-table owner query in the same retained transaction. Server configuration
binds the signed public table identifier to one internal table. Require exact
payload, current mapping approval, matching current table QR version and bounded
validity; configuration alone is not approval. The API owns no SQL or new business
state. Tests target substitution, stale QR version, missing table, late mapping
withdrawal and organization failure; run API build/typecheck and affected tests,
lint/import. Existing actual table-owner database evidence remains valid because
its inputs/source do not change. A composed actual Tenant/table run will be needed
before claiming persistent Dining entry is fully integrated.

Mapping integration selection: extend the existing table workflow with actual
Tenant Brand/Store records and the new API context factory; exercise current
published QR, public-table substitution, mapping withdrawal and normal RevokeQr.
Bootstrap/public-purpose/mapping approvals remain explicit synthetic inputs.
Run the affected Dining table database scenario because composition inputs changed;
do not rerun profile/Cart or other unrelated journeys.

### Configured Dining QR mapping result (2026-09-19)

Added createConfiguredDiningQrContext: server-owned signed public Store/Table/QR
registration maps to one internal Dining table. Exact parsed payload, registration
window/state and repeated current mapping authorization are mandatory. Real Tenant
resolution and locked Dining table read share the supplied transaction; matching
current table QR version is required. Signature/key verification remains the
existing independent QR service's responsibility. No API SQL or new tables.

a6a185/515b7e four focused tests, API typecheck and build passed. 7d73b6 affected
lint/import boundaries passed. 73a25d actual database workflow passed12.080s with
new Tenant rows and this API composition: issued QR resolves expected public/
internal table, public-table substitution and mapping withdrawal return null,
and normal RevokeQr makes the mapping unavailable. Tests retain explicit synthetic
organization bootstrap/public-purpose and mapping approvals. Existing table owner
commands, Audit and concurrency assertions ran within that affected scenario.

No source/schema/dependency changes to unrelated profile/Cart flows; their prior
evidence remains reusable. This proves the configured context composition using
real persistence, not an HTTP Dining admission or assembled candidate browser
journey. Next attach it to retained entry/session and Dining Join/binding sources,
then continue candidate assembly and complete pilot acceptance. Full goal active;
no commit/push/merge/deploy or real external approval claim.

### Persistent Dining HTTP entry selection (2026-09-19)

Extend the existing public-profile entry scenario with a real Dining table created,
published and issued through DiningTableService/owner store/Audit. Use configured
Dining QR context in the same retained entry transaction as profile, operating,
durable admission and GuestSession. Assert HTTP201 DineIn/ContextOnly session with
the exact public table, then normal owner RevokeQr causes422 without credentials
or additional admission/session rows. Restore Pickup request before the existing
profile Archive assertion so revoked QR cannot mask that gate. Staff, key registry,
mapping/abuse approvals remain synthetic fixtures; no live Store approval.
Run only the changed combined HTTP/PostgreSQL scenario and helper lint/format.
Reuse unchanged production API build, domain owner tests and schema181 evidence.
Dining Join/current joined-session binding remains separate outstanding work.

### Persistent Dining HTTP entry result (2026-09-19)

entry-dining-table prepares a real Draft/Publish/IssueQr sequence with Dining
service, owner store and Audit, using explicitly synthetic Staff permission.
The existing profile-entry HTTP fixture selects configured Dining QR context for
its server-owned DineIn registration. All context/organization/table/profile/
operating/admission/session work uses the established retained transaction.

72662f/47fc44 affected helper lint and combined actual HTTP/PostgreSQL scenario
passed14.779s. HTTP201 returns DineIn and the exact public table, one Cookie and
no raw session credential. The database contains one matching ContextOnly session;
admission and admission Audit each increase once. Normal RevokeQr then causes
HTTP422 with no Cookie/CSRF or additional session/admission/history. Restoring the
Pickup registration before the profile Archive probe preserves that assertion's
independent meaning. Existing Pickup Cart, current binding withdrawal, commit
rollback, operating closure and registration withdrawal checks still passed.

Production source/schema/dependencies unchanged this turn: retain prior API/
Dining builds,181 catalog and valid installation evidence. Signature verification
is real; key registry, Staff/registration/public-purpose and abuse approvals are
synthetic test inputs. This is HTTP entry only: the existing Pickup binding adapter
still rejects DineIn use, and this fixture does not yet expose a joined Dining
session. Next connect Dining current session binding and Join/admission to this
actual entry credential. Candidate activation and complete browser/business/
external acceptance remain outstanding. Goal active, not achieved.

### Current Dining Guest context selection (2026-09-19)

Add an authenticated Guest-to-configured-Dining-context adapter for
GuestSessionBinding/DiningJoin/DiningAdmission. Exact parsed Guest scope,
public table, QR and revocation version must match the server registration;
no signed payload is reconstructed from Guest/browser input. Identity owns
usability, Dining owns current table and QR facts. Preserve operation purpose
through table query and registration authorization; public Store resolution
uses CustomerCart for post-entry access. The QR binding layer is not participant
authorization: existing createCustomerDiningSessionBinding remains required
for current DiningBound membership. Fresh API tests/type/build and affected
HTTP/DB scenario; reuse unchanged schema/install. Verify actual entry Cookie
resolves through Identity plus current context, and owner RevokeQr denies it.

### Current Dining Guest context result (2026-09-19)

Added createConfiguredDiningGuestContext with purpose-aware resolve plus QR-context
binding validation. It parses/validates the authenticated Identity session, matches
exact Store/public table/QR/version, then resolves the original configured payload
through actual Tenant and Dining owner readers. Purpose now reaches the table
query and mapping-authorization callback; post-entry public Store access uses
CustomerCart. This context layer is not DiningBound participant authorization.

2b6262/8bdcf6 five focused tests, API typecheck and build passed. a1d867 lint
reported an unused test-mock rest argument; f96985 fixed that test-only issue.
aa6cb2 affected lint/import passed; c35eb5 actual combined HTTP/PostgreSQL scenario
passed14.224s. The actual HTTP-issued Dining Cookie resolves via Identity's real
session store/credential verifier and this current context; DiningJoin and
DiningAdmission contexts match the actual table. Normal RevokeQr subsequently
makes the same credential fail with GUEST_SESSION_UNAVAILABLE, and HTTP entry
remains rejected without new credentials or rows.

The complete Join/prepare/activate HTTP sequence and current DiningBound membership
are still outstanding in this integrated fixture. This turn does not claim that
context resolution alone constitutes joining a Dining session. Synthetic Staff,
registration/purpose/key-registry and abuse inputs remain explicit. Schema181,
installation and unchanged owner evidence reused; no full unrelated regression
or candidate mutation. Continue with actual session start/Join/Identity binding
assembly. Goal active and unachieved.

### Entry to Dining Join/identity binding selection (2026-09-19)

Compose actual session start, Join and admission/Identity binding owners against
the existing published table and HTTP-issued Guest credential. Exercise real
Join/prepare/activate HTTP handlers, rotated Cookie and DiningBound membership;
the predecessor must fail. Use real Tenant facts with explicitly synthetic Staff
permission/abuse authorization. Existing context callback supplies current QR/table
facts. Scope is integration, no new Domain rules/schema. Fresh affected combined
HTTP/PostgreSQL scenario and helper lint/format; reuse unchanged production builds.
Separate temporary HTTP listener hosts only Join/binding and closes in finally;
this is evidence of composed routes, not candidate process/browser activation.

First joined scenario stopped at Staff evidence: the synthetic permission object
was not frozen as the owner contract requires. Fix its shape, retain owner checks.
Also reload current table before the fixture's later RevokeQr: actual StartSession
changes table aggregate version, so the pre-start snapshot is no longer valid.
Rerun the affected scenario for these concrete composition corrections only.

### Entry to Dining Join/identity binding result (2026-09-19)

New entry-dining-join fixture starts a real Dining session on the already-issued
table using actual Tenant organization reads and owner session service. A bounded
temporary API listener exposes existing Join and binding handlers/compositions.
The actual entry Cookie/CSRF completes HTTP Join -> prepare -> activate. Real
Dining Join/participant/admission owners and Identity preparation/rotation/Audit
persist the result. The new Cookie resolves as DiningBound through current QR
context plus createCustomerDiningSessionBinding and the actual Dining membership
repository, with the exact started DiningSession and a participant reference.
The predecessor credential is rejected. After normal table RevokeQr, the newly
bound credential is also rejected; no new entry rows/credentials appear.

Initial da6669 failed on non-frozen synthetic Staff permission. 027059 fixed that
contract and current-table reload before revoke after StartSession version change.
603be0/96d176 affected actual HTTP/PostgreSQL scenario passed16.177s. Initial
helper lint had passed; final affected helper lint/format/diff is the only remaining
static closeout, not a reason to repeat this passing business scenario.
Production modules/schema/dependencies unchanged; prior builds/catalog181/
installation evidence remain valid.

This composes actual routes and owners across two ephemeral test listeners using
the entry-issued credential, not a browser or activated candidate process. Staff,
abuse/key-registry/registration/public-purpose approval fixtures remain synthetic.
Next bind this authenticated Dining member to actual Cart and Order flow and
assemble the persistent candidate; full pilot/business/browser/external gates
remain unmet. Goal active; no commit/push/merge/deploy.

3b43b1 final affected helper lint, formatting and diff checks passed. No required
check remains for this scoped integration change; broader pilot work continues.

### Bound Dining member to persistent Cart selection (2026-09-19)

Extend the existing Join/binding API listener with the actual Dining Cart
composition, current Identity/Dining participation readers and persistent public
profile reader. Use rotated Cookie/CSRF to create and read one empty Dining Cart;
repeat selection must retain the same current Cart. Reject predecessor Cookie
and unrelated Cart locator. Selection lifecycle policy remains synthetic; no
catalog item/price/order claim from an empty Cart. Fresh affected combined HTTP/
PostgreSQL scenario, helper lint/format; reuse unchanged production/schema/install.

### Bound Dining member to persistent Cart result (2026-09-19)

entry-dining-cart composes existing Identity/Dining membership, participation and
Ordering selection/read owners with persistent public profile and Catalog display
query. The same temporary Join/binding API listener now hosts Cart routes.
0519a4 affected helper lint passed;9faa47 combined actual HTTP/PostgreSQL scenario
passed20.878s: rotated Cookie/CSRF creates an empty DineIn Cart (201), a distinct
selection operation returns the same Cart (200), current read retains that Cart,
predecessor Cookie returns401, and unrelated Cart locator returns404. Actual
Ordering rows show exactly one Cart linked to the started DiningSession. Prior
normal RevokeQr still denies the bound credential.

The lifecycle policy is synthetic. Empty Cart does not require Catalog projection
rows and proves no product, price, quote or Order availability. Production modules,
schema181 and dependencies unchanged; builds/owner/catalog/install evidence reused.
No unrelated business rerun or candidate mutation. Next connect published catalog
selection and pricing/Order to this authenticated member, then persistently assemble
the process and complete browser/business/external pilot acceptance. Goal remains
active and unachieved; no commit/push/merge/deploy.

### Published Menu projection persistence gap and selection (2026-09-19)

Inspection found only a production projection reader and in-memory projection
service ports; existing Cart/menu fixtures insert projection rows directly.
Add transactional owner projection storage over the existing five tables. Lock
per Brand/Menu, strictly bind event/snapshot/generation, retain historical
generations, atomically advance active generation/checkpoint, and require exact
published snapshot verification before/after. Use the normal Menu publication
scenario's retained reviewed snapshot and real emitted event for fresh integration
evidence, including rollback and replay. No new schema. Run Catalog build, owner/
permission/import validation, affected lint and the publication persistence test;
do not claim Cart integration until this source is connected.

Projection check corrections: initial Catalog compile required the existing
parser's typed input cast for database JSON. Write manifest requires readPattern
null and the already-declared @rms/catalog.published-menu.v1 projection-builder
principal, not module ownership; preserved table authority. Initial DB run then
stopped before projection at an older HTTP assertion missing the current
snapshotDigest response field; reconcile against the current API and saved
lifecycle digest. Also retain publication verification after checkpoint/replay
reads. Rerun affected build and publication scenario for these scoped corrections.

### Published Menu projection persistence result (2026-09-19)

createPostgresPublishedMenuProjectionStore now supplies current-generation loading
and transactional replace over the existing five projection tables. Parsed event
and snapshot must reconstruct the exact projection; mandatory publication
verification surrounds the write or replay path. Per-Brand/Menu advisory locking
serializes updates; generations are assembled as Building, former Active becomes
Retired, then the new generation/checkpoint activate together. Metadata identifies
the existing @rms/catalog.published-menu.v1 builder; no table authority changed.

d734c2/00960d Catalog build and the normal Menu HTTP review/approve/publish/archive
database scenario passed13.506s. New evidence uses the actual Outbox MenuPublished
event and owner loadExact reviewed snapshot, writes no direct projection seed,
proves late publication-verification failure rolls all five tables back to empty,
then successful replacement/replay leaves one generation and the existing customer
query reads the exact reviewed snapshot. 52f5ca ownership/permissions and ab95ca
affected lint/import/diff passed. Earlier failures and corrections are recorded
above; no full regression or install/schema rerun.

This proves first-generation persistence, rollback, exact replay and customer
read compatibility. Multi-generation/concurrent delivery, actual Inbox/Worker
assembly and archive/stale-display handling remain to be joined and evidenced;
the writer alone does not make normal publication available in the pilot process.
These are now concrete dependencies before attaching normal published products
to the new Dining entry/Cart chain. Existing schema181/installation evidence reused.
Whole pilot goal remains active and unachieved; no external publication/deployment.

### Atomic Menu projection consumer selection (2026-09-19)

Compose existing Eventing Inbox and Catalog projection service/store with the
exact published-review snapshot owner in one retained transaction. Bound Brand/
Menu and event locators are checked before effects; current read authorization
remains mandatory. No Worker timer, queue simulation or dependency change.
Extend normal publication DB evidence with injected Inbox-completion failure
rolling back projection+Inbox, successful processing, and duplicate delivery.
Fresh Catalog build, affected publication scenario, lint/import; reuse schema/
permissions unless new access changes require a scoped check.

### Atomic Menu projection consumer result (2026-09-19)

createPostgresPublishedMenuConsumer now composes the actual Catalog projection
service, transaction-joined projection store and exact review-content owner with
Eventing Inbox. It rejects foreign Brand/Menu or non-MenuPublished events before
effects and establishes Brand context through authorized exact snapshot lookup
before Inbox insertion. No synthetic queue or worker loop was added.

71210b/923932 Catalog build, affected lint and import boundaries passed. bf2838
normal publication database scenario passed14.240s: injected Inbox completion
failure rolled back all five projection tables and Inbox, subsequent processing
returned processed, repeated event returned duplicate_completed, with one completed
Inbox record and one projection generation. Earlier direct-store rollback/replay/
customer-query assertions remain in the same affected scenario. Current read
authorization remains a synthetic callback in the fixture; owner data/event are
actual. Schema/installation and unchanged ownership/permission evidence retained.

Read-side gap confirmed: CustomerMenuQuery passes only Brand/Store to projection
loadCandidates despite having request time/channel/order type. It therefore cannot
yet consult the existing current-release owner with those facts before displaying
projection content. Next propagate that current query context and gate current
menu display while preserving exact historical display reads for existing Cart/
Order contexts. Dispatcher process activation, concurrent/multi-generation proof,
normal product Cart integration and complete pilot acceptance remain outstanding.
Whole goal active; no commit/push/merge/deploy.

### Current customer Menu publication selection (2026-09-19)

Propagate required request time/channel/order type into the current projection
reader, joining the existing current-release owner in the retained transaction.
Archived/inapplicable releases must disappear; a mismatching current version,
digest or timing must fail closed. Exact historical selection reads are unchanged.
Fresh evidence selected: affected Catalog query/store unit tests and build,
published-menu projection PostgreSQL scenario and normal publication/archive
scenario, affected lint/import and formatting. API typecheck covers the changed
port consumer. Reuse unchanged installation/schema/ownership evidence: no new SQL
asset, table, dependency or migration. No full business regression is selected.

The initial Catalog compile identified another actual caller: current selection
facts. Propagate its already validated channel/order/observed time too; include
the existing current-selection-facts database scenario for that consumer.

### Current customer Menu publication result (2026-09-19)

Current menu projection reads now require channel/order/time and consult the
existing current publication owner in the same transaction. Missing/archived or
Store-inapplicable publication is omitted; release/version/digest/timing mismatch
fails closed. Customer menu service and current selection facts pass their parsed
context. Historical loadVersionCandidates behavior is unchanged.

Fresh evidence on HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing dirty
WP-2402 tree and the changes in this section: 1dcc06 Catalog build and both
customer-menu-query/published-menu-query-store unit files passed (24 tests);
e01d6c projection PostgreSQL scenario passed11.720s; 1d3837 normal publication
and archive PostgreSQL scenario passed12.922s, including current display removal
and retained historical projection. 8cda3b current-selection-facts PostgreSQL
scenario passed11.866s after API typecheck in b2eea2 completed successfully.
d7d233 scoped Catalog ESLint and import validator passed; c9248b formatting and
diff whitespace review passed. The initial API filter matched no package and was
not counted; corrected command used @bop-rms/api. Initial compilation exposed the
second caller; corrected before the successful compile. No dependencies/schema/
new SQL ownership changed; prior valid installation and owner metadata retained.
Testing stopped after these acceptance questions were resolved.

Remaining: actual menu consumer dispatcher/process activation, concurrent and
multi-generation delivery evidence, normal published products in the Dining and
Pickup Cart chains, current-schema pilot process/UI assembly and full journey
acceptance. Existing external Store/payment/identity gates remain explicit.
Docker is operational as demonstrated by these isolated PostgreSQL scenarios.
Whole pilot goal remains active and unachieved; no commit/push/merge/deploy.

### Menu consumer Worker entry selection (2026-09-19)

Previous goal turn made progress: current display now follows actual publication
and preserves historical selection. Next add the Catalog owner service shape
accepted by the existing Worker delivery/transport. Fix the existing invalid
human-text registration sideEffect to a bounded registry identifier. Bind Brand
configuration, derive Menu locator from the envelope, and retain actual snapshot
authorization before duplicate Inbox recovery. No fake queue or timer.
Selected fresh checks: Catalog build and projection unit tests, real publication
DB scenario extended through existing Worker transport/delivery with injected
completion failure and duplicate retry, affected lint/import/format. No schema,
dependency or Worker source change; reuse installation/ownership evidence.
Full Outbox activation requires complete routes and remains a separate next step.

The first Worker DB attempt failed because its authorization callback used a
scoped request while the existing fixed-Menu content store accepts positional
operation/version. Make the new Brand-wide service boundary explicitly supply
Brand/Menu/version/operation to the authorizer, adapting to the fixed owner
signature internally. Re-run the failed affected scenario after this correction.

### Menu consumer Worker entry result (2026-09-19)

Catalog now exposes createPostgresPublishedMenuConsumerService with the actual
registration/consume shape accepted by createConsumerOutboxRuntime. Registration
metadata is shared with the existing projection service and sideEffect now meets
ConsumerRegistry syntax. The configured Brand is fixed; the actual Menu/version
and operation are explicit at the authorizer boundary. The fixed-Menu consumer
also exposes an authorized transaction-bound handler. consume still authorizes
before Inbox duplicate recovery.

Actual emitted MenuPublished event was delivered using ConsumerDeliveryWorker
and createConsumerOutboxTransport against PostgreSQL. The fixture authorizer is
synthetic and withdrawable; event, reviewed content, projection and Inbox are real.
Injected Inbox completion failure returns TRANSPORT_UNAVAILABLE and rolls back
all projection/Inbox rows; retry is acknowledged after commit; duplicate delivery
is acknowledged once; withdrawing authorization then rejects the same completed
event. Existing archive/current-display/history assertions also passed.

56583a Catalog projection unit suite passed6 tests (unchanged by later adapter
type correction). 14d9aa Catalog build passed after adapter correction.
44d03e normal publication plus Worker transport database scenario passed13.123s.
8a13c7 affected lint and import boundaries passed; d1aff6 final changed-adapter
lint, formatting and diff whitespace passed. Tested base remains HEAD
a0f35440cacff1ab55be78edfb08cb4de90c1a26 with the existing dirty WP-2402 tree and
this section's scoped edits. No schema, dependency, Worker source or permissions
changed. Prior valid installation/ownership and unchanged query evidence reused.

This is real Worker delivery integration, not activation of the persistent Outbox
dispatcher or pilot process. Complete event routes, multi-generation/concurrent
delivery, normal products in both Cart chains and full current-schema pilot
journeys remain. Full single-store goal remains active and unachieved.

### Actual Menu Outbox workload selection (2026-09-19)

Previous turn completed the owner/Worker delivery adapter. Inspecting the normal
Menu publication scenario shows only MenuPublished requires delivery before
archive; assert that exact pending route set rather than install fake handlers.
Extend that real publication scenario to run createPersistentConsumerWorker with
actual restricted-role connections. Following injected Inbox rollback, the
unpublished original Outbox event must be claimed and processed automatically,
commit one projection/Inbox, then be marked published once. Start/stop the actual
workload; no fixture SQL marks events published. Synthetic scope/read authority
remains explicitly test-only. Fresh normal-publication database scenario and
changed-file formatting/diff; no production code/schema/dependency change, so
reuse prior compilation, lint/import and installation evidence.

### Actual Menu Outbox workload result (2026-09-19)

795bff normal publication PostgreSQL scenario passed13.228s. The original
MenuPublished event was asserted pending, then createPersistentConsumerWorker
started with restricted-role real connections and the Catalog owner service.
Its existing dispatcher automatically claimed the event, consumed and committed
the first projection/Inbox, then marked the original Outbox row published with
attempt_count1 and no last error. No test SQL marked it published; fixture checks
one completed Inbox before graceful workload stop. The later direct transport
checks are duplicate/withdrawn-authority evidence, not the first consumption.
The existing rollback, archive visibility and historical-display checks passed
in this same run. 61b89e diff whitespace check passed; changed files were formatted
in0480bf. Unchanged production compilation, lint/import, schema and installation
evidence retained.

This closes actual automatic Menu Outbox delivery in the composed PostgreSQL
scenario. It does not claim the standalone pilot candidate process is activated:
current-schema candidate/configuration, normal published product Cart integration,
all pilot event routes, concurrent/multi-generation proof and complete journeys
remain. Synthetic fixture authority is not Store/operator/production approval.
Next integrate normal published products with the real customer Cart chain.
Whole single-store goal active and unachieved; no commit/push/merge/deploy.

### Published Menu to Cart selection connection (2026-09-19)

Previous turn proved automatic Outbox consumption. Next join normal publication
and its real Worker-generated projection to the existing current selection facts
owner in Repeatable Read/read-only transactions. Assert exact release/product
version, current SKU eligibility and option bindings; archive must remove new
selection eligibility while historical display remains. This is a prerequisite
to actual Cart write, not full Cart/Inventory acceptance. Fresh normal publication
DB scenario only plus changed-file formatting/diff; production sources unchanged.

The first joined read exposed missing fixture SELECT grants for current option
bindings: prior Menu publication used an explicitly empty reviewed option list
and did not read current binding tables. Add those exact owned-table SELECT
grants to the restricted fixture role; rerun this failed affected scenario.

### Published Menu to Cart selection result (2026-09-19)

d76031 normal publication scenario passed13.288s after adding only required
option-owner SELECT grants to the restricted test role. Actual HTTP publication,
automatic Worker-generated projection and current selection facts now join:
same release/product version, eligible current SKU and actual current binding
array are read in Repeatable Read/read-only mode. Archive returns null for new
selection while the prior exact historical projection remains readable.
601d1b whitespace review passed, d80d25 changed helper formatting completed.
No production code/schema/dependency changed; existing applicable evidence reused.

This proves actual Catalog inputs for add-to-cart, not the Cart command itself.
Current entry-to-Cart fixtures still prove empty Cart only. Actual current
Inventory and kill-switch Catalog safety adapters, normal-product Cart mutations,
current-schema pilot process assembly and complete journeys remain. The separate
current-selection test still uses synthetic safety evidence; do not treat that
as real inventory or a completed add-to-cart flow. Whole goal active/unachieved.

### Current Catalog Kill Switch source selection (2026-09-19)

Previous turn joined normal publication to current selection facts. Actual
Inventory requires Recipe plus option demand and stock candidates, not a balance
shortcut. First add the missing independent API composition for Catalog Kill
Switch evidence using actual Feature Control query/evaluation public APIs. Bind
Brand/Store/channel/order type, require configured key/rollout/evidence lifetime,
map absent definition to Indeterminate and fail closed on authority/read failure.
Add the existing workspace Feature Control dependency to API (no new external
package). Fresh lockfile update/frozen installation, API build/typecheck, focused
source tests with actual evaluator and owner query, lint/import and formatting.
Inventory and full Cart writes remain next; no full regression selected.

### Current Catalog Kill Switch source result (2026-09-19)

Added API createCustomerCatalogKillSwitchSource composing actual Feature Control
PostgreSQL query and current-authority evaluator. Brand/Store/channel/order type
are fixed configuration. Each call re-reads and re-authorizes; no default clear
for missing definitions, stale observations or rejected authority. Evidence has
the original observation time and configured bounded-use lifetime, not a renewed
lease or final checkout authorization. Configured key/bucket/lifetime must still
come from the pilot's actual approved configuration.

Existing workspace @bop/feature-control dependency added to API; offline lockfile
update and frozen installation passed9bb337/d392dc, pnpm11.13.0, no external
package added. 96bdd0/b77845/5a8174 API typecheck/build and5 focused source tests
passed after correcting the test request to use Catalog parsers. Tests exercise
real owner query and evaluator with synthetic database rows/current Tenant facts:
current inactive/active change, missing definition, foreign scope/channel,
authority withdrawal/read failure and expiry. They are not a real DB activation
claim. 35079f lint/import boundary and ee5704 final test lint/diff review passed;
source/test/package formatting completed. No schema/SQL ownership changes.

Next connect this source to actual persisted pilot Feature Control configuration
and complete Recipe-backed Inventory availability before real product Cart writes.
Whole pilot remains active/unachieved; no commit/push/merge/deploy.

### Pre-submission Recipe stock observation selection (2026-09-19)

Previous turn added current Kill Switch composition. Existing Inventory stock
planning unnecessarily requires Cart/Quote/Workflow submission identifiers for
a pre-Cart observation. Extract the same current Item/Recipe contribution and
stock allocation calculation into createPostgresRecipeStockPlanSource with only
scope, stock site and contributions. Retain exact submission input/output/digest
via the existing wrapper. No fake submission facts and no reservation writes.
Fresh Inventory build, scoped file lint/import and existing Inventory Item store
PostgreSQL scenario extended with direct observation equality, insufficient stock
and foreign Store rejection. This shared stock-plan calculation affects actual
reservation consumers, so keep the scenario's existing reservation/rollback
assertions. No schema/dependency change; reuse current frozen install evidence.

### Pre-submission Recipe stock observation result (2026-09-19)

Inventory now exports createPostgresRecipeStockPlanSource/RecipeStockDemand for
current scoped stock observation without fabricated Cart/Quote/Workflow facts.
It reuses the existing current Item, rational contribution aggregation, stock
candidate, hold/expiry and allocation calculation. The original submission
source delegates to this calculation and restores its exact full demand/digest.
No balance, ledger or reservation write was added.

abd72f Inventory build passed;6fb8bc actual Inventory Item/stock/reservation
scenario passed12.772s. Direct observation matched submission requirements and
allocations, required no submission reference, rejected foreign Store and
insufficient stock. Existing reservation recovery/current-version fencing and
atomic Audit assertions remained in that same scenario. 2f056e scoped lint,
import validator and whitespace passed;14b297 API consumer typecheck completed.
Formatting and scoped source review completed. Current frozen installation from
9bb337/d392dc reused; no manifest/schema/ownership change in this step.

Next actual Recipe-backed sale/default-option demand must feed this observation;
the Catalog safety port currently accepts only SKU/channel/order type and time,
not a selected quantity/options set. Preserve the distinction between a menu
availability observation and final selected-item/submission inventory validation.
Do not manufacture a submission or silently treat unknown options as zero demand.
Complete product Cart integration and full pilot processes/journeys remain.
Whole goal active/unachieved; no commit/push/merge/deploy.

### Selected Recipe Inventory observation selection (2026-09-19)

Connect current Catalog SKU sale units, Recipe selected-option demand and the
new Inventory observation through their public owners in one retained read
transaction. Add unlocked sale-demand Recipe entry using the same conversion
as submission; preserve SHARE locks for actual submission. The API accepts an
explicit selected quantity/options set and current product version, authorizes
before/after reads, maps only insufficient stock to Unavailable and bounds other
failures. No menu-base shortcut or fake submission reference. Caller must supply
a coherent Repeatable Read/read-only runner and actual selection authorization.
Fresh Recipe/API build, affected Recipe DB scenario for unchanged submission and
new observation conversion, focused API composition tests, lint/import/format.
No dependency/schema changes; reuse current install and Inventory allocation proof.

Initial focused checks exposed only test wiring errors: generic mock transaction
typing/expiry callback and a missing named import in the new Recipe DB assertion.
Correct those tests and rerun the affected checks; production observation code
compiled in40aaa0. No broader regression or reinstall is indicated.

### Selected Recipe Inventory observation result (2026-09-19)

Recipe now exposes unlocked createPostgresSaleRecipeDemandSource while retaining
the same exact sale-unit/quantity/option calculation and submission-only SHARE
locks in the original source. API createCustomerRecipeInventoryObservation joins
current SKU units, explicitly selected Recipe option demand and Inventory stock
planning on the caller-retained transaction. It checks selection authority before
and after owner reads; only STOCK_RESERVATION_INSUFFICIENT becomes Unavailable.
Other invalid/missing/unauthorized facts produce a bounded unavailable error.
No Cart IDs, Quote IDs or Workflow decisions are manufactured, no reservation
is written, and no Domain-private table is queried by the API.

40aaa0 Recipe build passed. a8b653 API typecheck/build and4 focused composition
tests passed after test wiring corrections. Those tests replace owner adapters,
so establish composition/authorization/transaction forwarding, not combined
PostgreSQL evidence. 1f7038 actual Recipe management scenario passed13.554s;
unlocked selected-sale demand equals the submission result for quantity2 and
unitQuantity2.5, including selected modifier contributions. Existing exact
quantity, review, Brand RLS and submission-lock checks passed in the same run.
541d8a scoped lint/import/diff and af7c89 final format/test lint/diff passed.
Existing Inventory owner calculation proof6fb8bc retained; no owner SQL/schema,
manifest or installation changed.

Still required: actual full SKU/Recipe/Inventory combined database observation,
current customer authorization, integration into selected Cart mutation or the
appropriate current-availability boundary without circular Catalog validation,
and standalone current-schema pilot API/Worker/UI complete journeys. The current
generic Catalog safety port does not carry quantity/options; do not silently
reinterpret that as selected-item inventory authorization. Whole goal remains
active and unachieved; no commit/push/merge/deploy.

### Combined selected Inventory PostgreSQL selection (2026-09-19)

Previous turn implemented the real-owner API composition. Extend existing Recipe
management data with actual Inventory Create/Activate commands pinned to the
Recipe's configuration-operation references, synthetic starting stock and actual
Catalog sale-unit facts. Exercise the complete observation through the API
composition in a real Repeatable Read/read-only transaction: quantity2 available,
quantity999 insufficient, unknown option refused, revoked authority refused,
no reservation/balance writes. Stock setup and current authority remain explicit
synthetic test inputs, not Store activation or receipt approval. Fresh affected
Recipe database scenario plus helper formatting/diff; reuse unchanged API/Recipe/
Inventory builds and unit evidence. No production or dependency change.

Initial combined scenario exposed invalid fixture balance initialization.
Respect the existing immutable ledger: initialize zero/version1, append the
synthetic receipt movement with actual Audit in one transaction, let the owner
trigger update balance. Correct the reservation-table assertion to the actual
version table. Re-run only this failed affected scenario.

Bounded diagnostic identified Recipe observation failure after current SKU read,
without a SQL error. Existing SKU creation hard-coded EACH/1; its immutable
unit fields ignored an attempted later PORTION/2.5 update. Make the shared fixture
accept optional sale units (existing defaults unchanged), configure this Recipe
fixture correctly at SKU creation, and remove the ineffective update/temporary
diagnostic. Re-run the failed combined scenario; no production rule is relaxed.

With correct immutable SKU units the combined source now returns an actual
insufficient-stock decision: the selected recipe aggregates multiple contributions
per Item, exceeding the initial synthetic10KG. Set the explicit initial receipt
to100KG for the available case while retaining quantity999 as the insufficient
case. This changes only fixture receipt data, not allocation or business rules.

The optional sale-unit fields changed shared price-menu fixture SQL. Run the
normal menu-publication database scenario once to cover its unchanged EACH/1
defaults, alongside formatting/diff checks. This is an affected consumer check,
not a full-repository regression.

### Combined selected Inventory PostgreSQL result (2026-09-19)

a2ed14 actual Recipe management scenario passed14.021s with the complete API
observation joining real Catalog SKU, published Recipe/modifier/SubRecipe
requirements, durable Inventory configuration and current stock ledger. Inventory
Items were created/activated via real owner commands and Audit, using the pinned
Recipe configuration-operation references. Synthetic starting stock was received
through append-only movement plus Audit after a zero opening balance.

The actual source ran on a Repeatable Read/read-only restricted-role transaction:
quantity2 with PORTION/2.5 sale units and actual selected option was Available;
quantity999 was Unavailable; unknown option and revoked authority were refused.
No reservation was created and balances remained100/on-hand and0/reserved.
This replaces the earlier owner-adapter-only evidence for the combined read.
Authority and initial stock remain synthetic; no real Store activation is claimed.

6a7da6 normal menu-publication scenario passed13.589s after the shared fixture
gained optional initial sale units, proving unchanged EACH/1 defaults and actual
Menu HTTP/Worker/archive checks. 14bd4f formatting/diff review passed. Existing
production build/type/lint/import and installation evidence remain valid because
this turn changed only these affected database fixtures and WP record. Temporary
diagnostic removed; immutable SKU and stock-ledger guards preserved.

Remaining: connect actual current customer selection authorization and the correct
quantity/options boundary to Cart mutation, with real Catalog safety sources
without circular validation; activate the complete current-schema pilot process/
UI routes and perform full Dining/Pickup journeys. Goal active/unachieved.

### Actual Cart selection context selection (2026-09-19)

Previous turn proved the complete SKU/Recipe/Inventory observation in PostgreSQL.
Cart command review confirms authorization/replay precede Catalog validation and
commit follows it. Its Catalog port currently drops quantity and authorized Cart/
session context. Add a second internal context argument carrying actual target
quantity, Cart/version and authorized Guest session. Existing Catalog validators
may ignore it; selected Inventory adapters can consume it without shared mutable
request state. No new authorization inferred and no reservation semantics change.
Fresh Ordering build and affected cart-item, Pickup and Dining item suites,
API typecheck for actual callers, scoped lint/import/format. Existing SQL/persistence
unchanged; reuse prior database evidence unless behavioral failures show need.

### Actual Cart selection context result (2026-09-19)

Ordering Add/Update now pass immutable target quantity, Cart reference/version and
currently authorized Guest session to selection validation. Pickup forwards the
context between its existing before/after authority checks; Dining uses the same
port directly. Original operation recovery and reservation semantics remain unchanged.

Initial compilation identified the Pickup forwarding wrapper still using one
argument; fixed that actual caller. 56c625/f7758b Ordering build and three affected
Cart item suites passed (108 tests). The first API filter matched no project and
is not evidence: corrected to the existing @bop-rms/api package; ff4150/3c689f
API typecheck passed. 0d3e1c scoped ESLint, Prettier and import boundary validation
passed. e71743 reviewed the scoped diff. Tested local HEAD remains
a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing uncommitted WP-2402 work
and these four Ordering file changes. No persistence/configuration/toolchain or
manifest changes; prior recorded database/install evidence is reused, not rerun.

Remaining: consume this context in the actual API selection/Inventory composition,
then assemble the current-schema process/UI and complete actual Dining/Pickup
pilot journeys. This interface change alone does not enable Inventory validation
in the running customer process. Goal remains active and incomplete.

### Quantity-aware Cart Inventory composition selection (2026-09-19)

Add an explicit API composition using actual Catalog public facts/availability and
selection validator, followed by actual Recipe/Inventory observation. Capture the
validated snapshot per call; resolve each selected option to exactly one enabled
binding. Pass authorized Cart context to the configured Inventory authorizer.
Existing generic availability checks remain mandatory; no Clear evidence is
fabricated. Wire this configuration into the existing Pickup Catalog composition.
It remains explicitly configured until complete process assembly.
Selected checks: API typecheck/build, focused composition and Cart adapter tests,
scoped lint/format and import boundary. Owner SQL implementations are unchanged;
reuse recorded real combined Inventory and Catalog database evidence. New tests
must prove actual quantity/options, rejected options bypass Inventory, shortage
rejects mutation and concurrent calls keep their context separate.

Iteration evidence: factory type initially described Catalog's single-argument
validator rather than Ordering's context-aware port; corrected the return type.
API typecheck/build then passed (aee629/ed5376). 13d0af existing Cart adapter and
Inventory observer suites passed35 tests. New composition fixture incorrectly
spread request-only fields into a closed Catalog snapshot; real validator refused
all four cases. Correct fixture fields, retain the production closed-shape guard,
and re-run only the failed composition suite plus changed-test type/format checks.

### Quantity-aware Cart Inventory composition result (2026-09-19)

API createCustomerCartSelectionInventory now composes actual Catalog owner facts,
current availability and selection validation, then actual Recipe/Inventory
observation for the accepted product version and exact option-to-binding mapping.
Each call captures its own snapshot; configured authorization receives the current
Ordering Cart reference/version, Guest session and target quantity. Insufficient
stock rejects selection; dependency failure propagates to Ordering's bounded
unavailable handling. No reservation or invented safety evidence is produced.
Existing Pickup WithCatalog composition accepts explicit selectedInventory
configuration and uses this path when provided. The legacy generic observation
path remains for existing callers; current process activation has not supplied
this configuration yet and is not established by this change.

701ec1/59ead8 final four composition tests, API typecheck and scoped ESLint passed.
Actual Catalog selection validator is used; snapshot source and Inventory observer
are mocked at the composition boundary. Tests prove exact quantity/product/binding,
rejected options bypass Inventory, insufficient/error behavior and overlapping
request isolation. The35 existing Cart adapter/Inventory observer tests passed
in13d0af and remain valid after a fixture-only correction. API build passed in
aee629/ed5376; production inputs unchanged since that build. adb654 import boundary
and b76128 final format/scoped diff review passed. No new database acceptance claim.
Tested revision: HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing WP-2402
uncommitted tree and these API composition/test changes. Existing frozen-install
and owner SQL evidence retained; manifests/toolchain/schema/owner SQL unchanged.

Next: exercise this configured path with actual customer Cart/session authority
and durable Catalog/Recipe/Inventory facts, then enable it in assembled Pickup/
Dining process routes. Complete browser/business journeys and external Store/
Provider activation remain outstanding. Goal active/unachieved.

### Actual Pickup Cart Inventory authorization selection (2026-09-19)

Prior turn's configured Inventory path still asks caller for an authorization
callback. Replace that gap in the existing Pickup composition with a concrete
Ordering-owner Cart recheck on the retained Inventory read transaction. The outer
Pickup service remains the credential/CSRF/current-registration authority before
and after selection. Inner check requires same scoped Pickup Cart, Guest owner,
exact version, active lifecycle and monotonic observation time. Never use it as
standalone guest authentication. Scope and stock-site configuration stay explicit.
Selected evidence: actual Cart database fixture exercises this authorizer against
persisted Cart; directly affected API type/build and targeted tests/static checks.
No new full regression or install; owner persistence implementations unchanged.

### Actual Pickup Cart Inventory authorization result (2026-09-19)

The existing Pickup WithCatalog composition now supplies concrete Cart ownership
checking itself when selectedInventory is configured; external callers no longer
supply its authorize callback. It uses Ordering's public Cart query on the retained
Inventory transaction and requires exact Guest owner/version, active Pickup Cart,
expected quantity and non-future/monotonic time. Current credentials, CSRF and
registration still belong to the surrounding Pickup command checks. This helper
is deliberately not standalone authentication and not applicable to shared Dining
ownership without its own session/participant rules.

8c9888/6c92ae API build and actual Identity/Ordering Cart database scenario passed
(18.013s). Restricted-role Repeatable Read/read-only checks allowed the real bound
Cart and rejected foreign Cart/Store, wrong Guest, stale version, changed quantity,
future observation and expired lifecycle. Counts remained unchanged; after the
actual HTTP Add committed, the previous context was rejected. That HTTP scenario
still uses synthetic generic safety; this run does not prove a full Inventory-
insufficient HTTP Add, which remains to be assembled.
28dbb1/afac58 API typecheck and35 affected composition tests passed; dd2607 scoped
ESLint/import boundaries passed;542f56 formatting and scoped diff checks passed.
Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus current uncommitted WP-2402
files and this authorizer/composition/database fixture change. Unchanged manifests,
toolchain and owner SQL retain prior valid installation/build evidence. No further
repeats warranted by this scoped result.

Next integrate real selected Recipe/Inventory facts into the same HTTP mutation
scenario, prove insufficient stock leaves Cart/Audit/operation history untouched,
then wire current-schema runtime configuration and Dining equivalent. Full pilot
journeys/real Store and Provider activation still incomplete; goal stays active.

### Actual stock-shortage HTTP mutation selection (2026-09-19)

Extend the existing actual Cart HTTP scenario with a synthetic persisted published
Recipe and actual Inventory Item activation/append-only stock receipt. Reuse the
existing Inventory fixture preparation by extracting it without changing its
original assertions. Configure selectedInventory with restricted-role read-only
transactions; actual outer Guest/CSRF and inner Cart checks remain in use.
Prove quantity999 shortage causes no Cart/Audit/operation/reservation changes,
then retain successful Add/Update/replay assertions using quantity1/2.
Run the single Cart database scenario; because the shared fixture extraction affects
the existing Recipe scenario, run that one as an affected consumer as well. Scoped
fixture format/diff only; production inputs and prior API checks remain unchanged.

The first Cart run failed during setup on a nonexistent tenant helper GRANT; remove that invented helper grant and use the existing Inventory owner scope mechanism. Re-run only the failed Cart scenario; original Recipe consumer is already running.

Cart HTTP caps quantity at100 (Ordering internal limit999 is not the HTTP contract). The first shortage request was correctly rejected at input parsing with400. Use supported quantity100 and an explicit2KG/unit synthetic Recipe against100KG stock, so the test reaches real stock shortage; assert the exact422 selection error. Original Recipe consumer passed0f1aef and is not rerun.

### Actual stock-shortage HTTP mutation result (2026-09-19)

f27370/feb86b actual Cart database/HTTP scenario passed17.686s. Existing real
Identity credential/CSRF authorization, Ordering Cart binding/version/lifecycle,
Catalog current publication/SKU/selection, Recipe demand and Inventory stock
observation now run together for the selectedInventory configuration. The fixture
published Recipe consumes2KG/unit and has100KG from an append-only receipt plus
Audit after actual Inventory Item creation/activation. Recipe/publication and
scope approval remain explicit synthetic facts; no live Store approval is claimed.

HTTP quantity100 was permitted by input validation, then rejected422 with exact
cart_selection_invalid after actual insufficient-stock calculation. Cart aggregate,
Audit and operation counts stayed unchanged and reservation count remained0.
The same configured route then passed quantity1 Add, acknowledgement-loss recovery,
concurrent original retries, quantity2 Update and the existing failure/revocation
cases. No new observation was treated as a reservation or final payment promise.
Generic availability/Kill Switch observations remain synthetic in this fixture;
full actual safety/process activation is still required.

Shared preparation was extracted as seedRecipeObservationInventory; original
Recipe management/selected-modifier observation assertions remained intact and
passed2332ca/0f1aef in13.788s. 5ff1d8 final formatting/scoped diff review passed.
This turn changed only database fixtures and WP evidence. Production API build,
type/lint/import and owner persistence evidence from prior recorded runs remains
valid with unchanged covered inputs; no install, business-suite or API rebuild
was repeated. Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing
uncommitted WP-2402 tree and these three fixture edits.

Remaining: Dining shared-session authorization and equivalent selected Inventory
composition, complete current-schema API/Worker/UI process activation with actual
configured safety sources, full Dining/Pickup business/browser journeys and real
Store/Provider external gates. Goal active/unachieved.

### Dining selected Inventory authority selection (2026-09-19)

Dining Cart is shared by authorized participants, not owned exclusively by its
creator. Pass the actual Cart diningSessionReference in the internal selection
context; use the already-established Dining authority around Catalog/Inventory
reads as well as commit. Add a session-scoped read-only Cart check for Inventory
which requires exact version/lifecycle/session but not creator equality. Existing
participation authority remains mandatory; do not accept session IDs from HTTP.
Selected commands: Ordering build and affected Dining/Cart/Pickup item tests, API
type/build plus affected context tests, scoped lint/import/format. No owner SQL
changes; actual Dining integration will follow the configured API assembly.

### Dining selected Inventory authority result (2026-09-19)

Internal Cart selection context now includes its actual diningSessionReference
(null for Pickup). Dining item Catalog validation runs inside existing guarded
current Guest/participant authority, matching its commit checks. New API Dining
Inventory authorizer reads via Ordering's public session-scoped Cart query and
requires exact version, session, active lifecycle and bounded time; it deliberately
does not compare the shared Cart creator to the acting Guest. It remains usable
only inside the authenticated Dining command, not as standalone authentication.
createCustomerDiningCartWithCatalogInventoryComposition wires actual Catalog,
Recipe/Inventory and this scoped authorizer using explicit server configuration.
No HTTP-derived Dining session assertion or reservation semantics introduced.

50ba60/319674 Ordering build and108 directly affected Cart/Pickup/Dining tests
passed, including membership version changes during Catalog and Cart expiry
before commit.7958ac/36e464 API typecheck/build and62 affected tests passed.
New6 authorizer tests exercise non-creator shared access, mismatched session,
stale version, wrong order type, expiry and missing session (owner query mocked).
7d7e88 scoped ESLint/import boundaries/diff checks passed; files formatted in7958ac.
Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing uncommitted WP-2402
work and this context/guard/API composition change. Installation/manifests/toolchain
and owner SQL unchanged; prior recorded persistence evidence reused, not new runs.
Actual composed Dining database/HTTP Inventory acceptance is not yet proved.

Next connect this required Inventory composition into real Dining entry/join/Cart
HTTP fixture with actual published Catalog/Recipe/stock facts; prove shared member
access, shortage no-write and membership withdrawal. Then complete runtime process
configuration and full pilot journeys. Goal active/unachieved.

### Dining actual Inventory HTTP selection (2026-09-19)

Use the existing real public-profile/entry/Dining join/Identity binding/Cart scenario.
Configure its new Dining Catalog/Inventory composition, synthetic published DineIn
menu plus Recipe and actual Item/stock receipt using already-tested fixture helpers.
Prove accepted Add and actual stock-shortage rejection leave correct persisted
Cart/Audit/history; retain original credential rotation and scope assertions.
Run only the public-store-profile database scenario and changed fixture format/diff.
Prior production type/build/tests remain valid; no production edit planned.

First Dining HTTP Add returned401 because its new fixture Audit action used the Cart-selection prefix rather than the required ORDERING_CART_ITEM action. Correct only the item Audit factory; preserve strict Audit/authorization validation and re-run the failed scenario.

### Dining actual Inventory HTTP result (2026-09-19)

9e8927/20393e actual public-profile/entry/Dining join/Identity binding/Cart scenario
passed25.064s. Entry Dining Cart now uses the configured Catalog/Inventory factory:
real consumed admission and DiningBound credential/CSRF, actual participant query,
actual shared Cart persistence, current Catalog selection, Recipe demand and stock
allocation observation on restricted-role Repeatable Read/read-only transactions.
Explicit synthetic DINE_IN published menu/Recipe and generic safety observations
remain fixture facts; Item creation/activation and stock receipt use actual owners
and append-only Audit. No live Store or Provider activation is claimed.

Quantity100 exceeded the100KG stock at2KG/unit and returned422 cart_selection_invalid;
Cart version/lines, operation count, Audit count and reservation count remained
identical. Quantity2 Add returned200/version2 and persisted exactly one operation/
Audit. Original replay returned200 with no extra writes. Pre-binding old credential
returned401 for a fresh Add with no changes. Original profile/entry/join and QR
revocation checks remain in the passing composed scenario. This run uses one
participant; actual second-member shared mutation/withdrawal remains outstanding.

e17706 changed-fixture format and WP diff checks passed. Only entry-dining-cart
fixture and WP changed this turn; prior production build/type/lint/import evidence
and installation remain valid. Existing stock/menu fixture implementations were
reused unchanged, so their separate passing tests were not repeated. Tested HEAD
a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing uncommitted WP-2402 work and
this fixture change. Temporary failure was incorrect fixture Audit action; fixed
input without relaxing production validation.

Next: actual second Dining participant shared Cart access and membership withdrawal,
then current-schema runtime activation and complete pilot UI/business journeys with
actual configured safety and explicit real Store/Provider gates. Goal active/unachieved.

### Second Dining participant HTTP selection (2026-09-19)

Existing entry fixture can issue a second actual Guest admission. Invitation is
single-use: use actual Dining regeneration service/store with current session/
capability/table versions, then real second join and Identity binding activation.
Prove the second Guest adds to the first Guest's shared Cart with correct participant
attribution and first Guest sees the update. Member Left read guards exist but no
public departure write command was located; do not fabricate a DB status mutation
as evidence of a complete departure flow. That lifecycle action remains separate.
Selected check: the one public-store-profile integration plus changed fixture
format/diff; production owner implementations unchanged, reuse prior checks.

Regeneration integration exposed fixture confusion between occupied Table aggregate version and the retained Dining session assignment version. Actual start intentionally increments only the Table aggregate. Use the current owner join/session snapshot for regeneration assignment evidence; keep actual table identity/active-session checks. Production version rules unchanged; re-run failed scenario.

Second member actual join/binding/Add and stored participant attribution passed before the final view assertion. Views intentionally personalize OTHER_PARTICIPANT_ITEM warnings. Compare shared content while explicitly asserting each viewer sees the correct opposite ownership warnings; do not remove or flatten production participant semantics. Re-run only the failed scenario.

### Second Dining participant HTTP result (2026-09-19)

a31924/f64f7c actual entry/Dining/Cart PostgreSQL scenario passed30.928s.
Second Guest obtained a real new entry admission/session through the running entry
HTTP endpoint. Existing actual Dining regeneration service/store reissued the
single-use invitation from current owner versions, with actual Audit. Second
Guest then completed actual join, admission consumption and Identity binding
prepare/activate HTTP operations; Guest and participant IDs differ and session
matches the first Guest's Dining session.

Second Guest read Cart version2, added quantity3 through the same actual Catalog/
Recipe/Inventory path and got version3/two lines. Database proves Cart creator
is different, new line actor/participant belongs to the second Guest, and session
is shared. First Guest reads the same content/version. Both personalized views
correctly mark only the other participant's line OTHER_PARTICIPANT_ITEM. Existing
shortage/no-write, first Add/replay/old credential and QR revocation cases remain
inside the passing scenario. Staff permission and publication/safety facts remain
explicit synthetic inputs; no live operation claimed.

c954be final fixture format/WP diff checks passed. Production files, dependency
inputs and owner SQL unchanged, so prior build/type/lint/import/install evidence
is reused. Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing WP-2402
uncommitted work and three entry fixture edits. Failures resolved only fixture
assignment-version and personalized-view expectations; no production guard relaxed.

Next prioritize current-schema process/route assembly and full pilot journeys.
Member departure write was not found while inspecting the current Dining API;
check accepted pilot requirements before treating it as required new scope. Existing
Left-state guards alone are not proof of an implemented departure action. Goal
active/unachieved; real Store/Provider gates remain explicit.

### Unified runtime selected Inventory configuration selection (2026-09-19)

The trusted API process loader and local supervisor already load executable
configuration. Unified LocalCustomerRuntime still only assembles legacy item
ports; add explicit catalogCartItems and catalogDiningCart configurations using
the verified actual Catalog/Inventory factories. Reject simultaneous legacy/new
configuration, require Cart transaction resources, retain shared scope/session/
clock ownership. Do not manufacture any Store/Provider/safety defaults or claim
candidate activation. Selected checks: API type/build, focused local runtime tests,
scoped lint/import/format. Existing actual owner/database evidence unchanged.

### Unified runtime selected Inventory configuration result (2026-09-19)

LocalCustomerRuntime now directly accepts catalogCartItems and catalogDiningCart
and invokes the already-verified actual Pickup/Dining Catalog/Inventory factories.
Configured Pickup requires selectedInventory (not optional); shared runtime owns
scope/session/readback/clock. Legacy cartItems/diningCart remain supported but
simultaneous old/new configuration is rejected before dependency use. Cart read
transactions are required for both. Environment README documents exact resource
and evidence requirements; no default safety/Store/Provider data was supplied.

02b567/a56cf8 initial typecheck passed; dd2adc/667983 final API typecheck/build
and48 local runtime tests passed. New tests build both real factories, verify
missing-read and legacy-conflict rejection, reject mismatched Inventory Store and
prove unauthenticated Add remains401 without querying dependencies. Owner data
is not loaded in these configuration tests. b0c957 scoped ESLint/import boundary
and20885d final format/diff review passed. Prior real Pickup/Dining HTTP/database
stock evidence remains valid for unchanged owner implementations; not rerun here.
Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing WP-2402 uncommitted
work and local runtime/test/documentation edits. Existing frozen installation
valid: no manifest, lockfile, toolchain or schema change.

Actual configured candidate process is not enabled by this option support. Next
supply current-schema scoped runtime resources/configuration, current safety
sources and complete quote/checkout/payment/order/receipt workflows; then browser
and operational acceptance. Real Store/Provider gates remain explicit and cannot
be replaced by fixture data. Goal active/unachieved.

### Current-schema candidate resources selection (2026-09-19)

Actual candidate v2 was stopped; restored its existing container without replacing
its data. Migration status4664e8 reports out-of-order pending0200_018,1000_007,
1000_008 below applied high-water mark. Do not repair/bypass this accepted migration
guard. Create separate local synthetic-only pilot-v3 on55434 and preserve v2.
Use existing compose and migration runner to apply complete current catalog;
provision fresh restricted API/Worker login roles with existing verified helper.
Selected checks: migration apply's final state, role privilege/access checks and
connection probe. No business-suite or reinstall justified by empty candidate setup.
This establishes resources, not Store activation or full pilot readiness.

### Current-schema candidate resources result (2026-09-19)

Actual v2 container was stopped (Exited127).4f9fa7 restored the existing container
and volume;4664e8 migration status then reported drift with three out-of-order
pending migrations. No checksum/order bypass, historical repair or data deletion.
New isolated synthetic-only pilot-v3 resources created under .local/pilot-v3 using
existing pinned compose, port55434, database bop_rms_wp2402_pilot_v3 and separate
volume.1a03a6 reports healthy. Original v2 remains retained.

0d5856/9c24df existing migration apply completed181 migrations, state current,
pending[],diagnostics[],status ok. Full result retained in ignored local
.local/pilot-v3/migration-apply.log; no repeat verify needed for unchanged inputs.
7a9b81 existing application-role helper created fresh API/Worker credentials in
mode0600 files and verified both logins. Superuser/RLS bypass/DB-create/role-create/
replication/inheritance disabled; ungranted business access denied. No credentials
printed or committed. Configuration/provisioning files are ignored local resources.

The new database is empty of operational Store/Catalog/Provider facts and no API
business process has been activated. This is current-schema infrastructure progress,
not completion of pilot or real Store readiness. Prior production checks unchanged;
no source/toolchain/install change and no business regression rerun this turn.
Next assemble explicit current owner configuration and minimum approved local
business data through existing owner contracts; keep demonstration and external
Store/Provider activation distinct. Goal active/unachieved.

### Configured quote runtime routing selection (2026-09-19)

Existing candidate bootstrap only creates demonstration Draft organization/menu
facts and must not be treated as active Store data. Unified runtime currently
exposes only legacy cartQuote; actual configured quote HTTP composition already
exists for both order types. Add an explicit pair of configured quote ports and
route using current authenticated Guest/CSRF/scope, retaining downstream quote
authorization and idempotency. Reject simultaneous legacy/configured quote setup.
Use shared runtime session binding including actual Dining admission. Selected:
API build/type, focused channel/runtime tests, scoped lint/import/format. No
commercial/tax policy defaults, DB seed activation or new reservation semantics.

Initial typecheck identified typed Domain-reference comparisons and widened status literals, plus unparsed fixture Guest reference brands. Compare validated reference values as strings, contextually type the returned quote port and parse the fixture Guest with its owner constructor. Re-run the failed type/build/test chain; no contract semantics changed.

### Configured quote runtime routing result (2026-09-19)

Unified LocalCustomerRuntime.configuredCartQuote accepts the existing actual
configured quote HTTP ports for Pickup/Dining and mounts CustomerQuoteHandler.
New channel port uses the runtime's shared current Guest/CSRF binding to select
the service, validates scope/time and refuses ContextOnly Dining. Each downstream
quote port retains full Cart/participant authority, commercial-policy validation,
durable expiry and original-operation recovery. Legacy cartQuote conflicts are
rejected and required Cart transaction resources are enforced. Environment docs
name the existing configured quote factory and required owner facts.

767107/fe2532 API typecheck/build and54 focused channel/runtime tests passed.
Tests use actual Guest parsing from established entry fixtures, with mocked current
authorize results and quote ports; prove correct routing, downstream outcome
preservation, credential/CSRF failure, foreign Store, ContextOnly Dining, backwards
clock, configuration conflicts and missing resources. This is routing evidence,
not new database/commercial-policy acceptance.076b1e/c616b7 scoped ESLint/import
checks and e0a4f9 final format/diff checks passed. No production DB, candidate data,
manifest/toolchain or install mutation. Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26
plus existing WP-2402 tree and this channel/runtime/test/documentation change.

Candidate v3 still lacks actual owner business configuration and active business
process; existing draft-only demo provisioning was inspected but not run because
Draft data does not satisfy operation. Next assemble complete configured quote
and checkout sources into the actual current-schema runtime, with approved scoped
commercial facts rather than inferred tax/Store/Provider defaults. Goal active/unachieved.

### Configured quote unified runtime database selection (2026-09-19)

Move the existing actual Pickup/Dining configured quote persistence scenario from
standalone CustomerQuoteHandler to createLocalCustomerRuntime.configuredCartQuote.
Expose its existing scoped Identity transaction/session settings to that runtime;
unused entry/menu fixture ports remain explicitly unavailable/unused. Real quote
ports still use actual Catalog/Pricing policies, durable requests/attachments,
expiry, current Guest and Dining participant stores. The unused opposite channel
throws if selected. Retain downstream actual Checkout/Order snapshot read assertions.
Run only configured-cart-quote-service acceptance (both modes), fixture format/diff.
No owner production change or broad regression; prior production checks reusable.

### Unified quote authorization response correction selection (2026-09-19)

babe8a: both configured DB scenarios reached the final revoked-session assertion
but returned503 instead of the existing404. Do not weaken that assertion.
The new selector must preserve the quote API concealed NotFound result for
Identity's typed GUEST_SESSION_UNAVAILABLE and out-of-scope/unbound sessions.
Identity intentionally collapses current-session authorization failures, including
its store failures, into this type; do not claim the selector can distinguish
those causes. Unknown processing failures/backwards clock remain Unavailable.
Run focused selector/runtime tests plus API type/build and scoped lint/format/import
for this production correction, and re-run the failed two-mode database scenario.
Reuse unchanged dependency installation and unrelated owner suites.

### Unified runtime configured quote persistence result (2026-09-19)

d01d99: both Pickup and Dining actual PostgreSQL configured-quote scenarios pass
through createLocalCustomerRuntime.configuredCartQuote (45.298s test time).
Real persisted Identity sessions/current scope select the correct owner; actual
Catalog/Pricing rule reads, quote/request writes, Cart attachments and audit
remain in the scenario. Lost quote-commit and attachment-commit acknowledgements,
original-operation recovery, expiry, revocation, rollback, stale Catalog and
downstream Checkout/Order snapshot reads retain their existing assertions.
Store/QR admission, commercial values and downstream fulfillment/readiness remain
explicit synthetic fixtures. Unused Entry/Menu routes are not acceptance evidence.
This does not activate a candidate business process or prove a full order journey.

Production selector now preserves NotFound for typed current-session failure and
foreign Store/unbound Dining. Unexpected failures and backwards clock remain503.
Identity intentionally conceals current authorization failure causes; this is
existing quote response compatibility, not newly distinguished DB error types.
a9fc28/8a0e8a: API typecheck/build and55 focused selector/runtime tests passed.
bef097: scoped ESLint, actual import-boundary validator, four-file Prettier and
scoped diff-whitespace check passed. Failed initial DB run babe8a is superseded
only after the above source correction; no assertion weakened. No running checks.
Unchanged pinned installation/dependencies, migrations181 and unrelated owners'
earlier evidence retained; no repeated full regression or new install.

Reviewed selector/test sources and the scoped runtime-fixture change: no new route,
secret logging, domain persistence bypass, financial default or reservation write.
HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved existing WP2402 dirty
tree and these four source/fixture files; no commit/push/merge/deploy.
Candidate v3 remains schema-current database resources without activated owner
business configuration/API. Next assemble actual business process and complete
checkout-to-order path; do not treat another isolated fixture as pilot completion.
Goal active, unachieved.

### Dual-channel checkout details runtime selection (2026-09-19)

Previous turn made progress: real configured quote HTTP persistence passed with
the unified runtime after correcting concealed authorization responses.
Current runtime accepts only one checkout-details port although Pickup and Dining
owner compositions exist. Add explicit paired configuration using the same current
Guest/CSRF session binding as Cart/Quote to select read/policy/save. Preserve owner
authorization and quote version, reject mixed versions, missing read/policy methods,
ambiguous legacy configuration and missing Cart resources. No new Domain policy.
Acceptance: current session selects only its mode; foreign scope/unbound/revoked
session never invokes an owner; downstream results/errors preserved. Fresh API
type/build, focused selector/runtime tests, scoped lint/import/format/diff.
Actual owner DB suites remain unchanged; no full journey claim. Actual Store
configuration location requested asynchronously while independent integration proceeds.

561541:50 runtime tests and4 selector cases passed; rejected-session assertion
mistook GuestSessionError.message for its code. Assert the stable typed code
instead of changing production behavior. Re-run only the5 selector cases;
production build/type, runtime50 and import evidence remain valid. Format/lint
the changed test and check the added environment configuration documentation.

19801f reached the third denial assertion: its multiline formatting escaped the first edit. Correct the remaining assertion to typed code and rerun the same focused file; no production changes.

### Dual-channel checkout details runtime result (2026-09-19)

LocalCustomerRuntime.channelCheckoutDetails now mounts the existing checkout
details HTTP handler with a paired Pickup/Dining port. Its shared actual Identity
binding selects read/policy/save without browser-supplied channel authority.
Captured inputs survive asynchronous selection; current scope, lifetime and bound
Dining state are required. Owner return values/errors and Cart/quote/policy
authorization remain intact. Quote versions must match; missing methods, mixed
legacy configuration and absent Cart transaction resources fail construction.
Environment README documents concrete required ports without business defaults.

7959b7/cfd715: API typecheck/build passed.561541:50 runtime cases passed.
6c3aa9:5 selector cases passed after fixing error-code assertions; production code
unchanged by those fixes.9a55a5: scoped ESLint/import/format/diff passed;
6c3aa9: changed-test ESLint, documentation format and final scoped diff passed.
Tests establish actual parsed Guest selection with mocked authorize/owner ports;
this is composition evidence, not new persistence or browser journey acceptance.
Existing configured-quote DB d01d99 retained: its options do not enable the new
branch; no quote source/owner/schema/toolchain input changed. No broad recheck.

Reviewed scoped code for current scope/credential enforcement, no sensitive logs,
no owner table access or domain-rule changes. Existing dirty work preserved at
HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26. No running checks or external mutations.
Actual Store data location question pending; continue independent assembly.
Next exercise checkout-details with configured-quote persistence in unified
runtime, then route the existing checkout-session submission and payment paths.
The current candidate remains without activated business configuration; goal
active and full pilot unachieved. Do not substitute this routing result for it.

### Unified checkout details in actual submission journey selection (2026-09-19)

Found stronger existing consumers: pickup-checkout-composition and dining-order-
submission acceptance already persist checkout details and continue into real
Order/capacity/payment linkage. Move their shared details HTTP helper from its
standalone app to LocalCustomerRuntime.channelCheckoutDetails, retaining all
existing PWA client, policy, denied credential, lost-ack/retry and subsequent
submission assertions. Supply each existing scoped Identity runner and actual
Dining current binding. Other unused Entry/Menu routes stay explicit fixtures.
Run these two owning database configs (both legacy/configured variants), scoped
fixture format/diff only. Prior production build/type/lint remains unchanged.
No new claims about actual Store/Provider facts or active candidate process.

3a94dd and7e3408: each suite passed three variants (legacy/configured zero and
legacy positive). Each final configured=true,positive=true case failed with
ECONNREFUSED on its isolated database port after about8s, before business evidence.
No source/assertion change justified. Retain six passing cases and retry only the
two failed names using existing Vitest -t filter, sequentially to reduce Docker
startup overlap. Candidate databases remain healthy; no reset or deletion of
candidate state.5dc3c3 fixture format/scoped whitespace passed.

### Actual submission journeys with unified checkout details result (2026-09-19)

Shared customer-checkout-details-http now runs LocalCustomerRuntime with paired
channelCheckoutDetails instead of a standalone app/handler. Pickup and Dining
submission fixtures supply actual persisted Identity transaction runners; Dining
uses existing current session binding with owner repository/context. Unused
Entry/Menu fixtures are explicit and not presented as entry/publication evidence.
The wrong channel throws. Existing PWA read/policy/save, denied credentials,
lost-save-response recovery, idempotency and policy-change assertions remain.

All eight required variants now have passing evidence on the same unchanged
fixture/source inputs:3a94dd Pickup three,7e3408 Dining three;f1e392 filtered
configured-positive Pickup108.852s,2145b9 filtered configured-positive Dining72.537s.
Initial final-case ECONNREFUSED failures are recorded above; only those cases were
retried, sequentially. Each retry intentionally filtered three already-passing
cases; do not label either original four-case command as an all-pass run.
The owning suites continue into actual persisted Order/capacity/inventory/payment
linkage and Dining paid-cart continuation/additional batch checks. Provider/Store
and other declared synthetic dependencies remain synthetic, not live evidence.
Only checkout-details HTTP moved to unified runtime; later Order/Payment fixtures
still have their prior standalone compositions. No full same-process journey claim.

5dc3c3 format/scoped whitespace checks passed. Reviewed changed helper sources:
current credentials and Dining binding retained, no client-provided mode authority,
no new table bypass, no assertion removed, restore global fetch/CSRF and shutdown
in finally; each runner retains connection ownership. Tests clean their isolated
resources through existing teardown; candidate v2/v3 not reset. No running checks.
Prior production build/type/lint and pinned install are reusable: this turn only
changed four MJS acceptance/helper files and the WP. HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26
plus preserved dirty WP2402 tree. No commit/push/merge/deploy.

Next consolidate the existing Order HTTP and checkout-session/payment paths into
the same configured runtime and actual candidate business configuration. Store
data-location question remains pending; independent code work can continue.
Goal active/unachieved. Full browser/pilot acceptance and external facts outstanding.

### Dual-channel order submission selection (2026-09-19)

Previous turn progressed by proving unified details HTTP in eight real submission
variants. Runtime still accepts only one orderSubmission port. Add explicit paired
channelOrderSubmission with current shared Guest/CSRF selection and matched quote
version. Current scope/lifetime/bound Dining required before owner call; preserve
original command identity, owner errors/results and idempotent recovery. Reject
ambiguous legacy config and missing Cart resources. No new capacity/Inventory
logic. Fresh affected API type/build, selector/runtime tests, scoped lint/import/
format. Existing DB helper integration will use actual owner ports; no full pilot
claim or Store/Provider defaults.

Dual-channel order tests were created in an absent path using exclusive creation;
automatic approval initially rejected a source-copy script as possible existing
test coverage loss. No existing tests were truncated or removed. b45324/7d11cd
API typecheck/build and56 selector/runtime tests passed.
Now migrate the existing customer-order-http helper to actual LocalCustomerRuntime
with current Identity/Dining binding and paired owner ports. Preserve all PWA
controller/retry/body/authorization assertions. Run both owning DB configs
filtered to configured=true,positive=true, sequentially (earlier overlapping
temporary database startup failures justify this). These exercise current
configured-menu pilot orders and additional Dining batch/payment linkage.
Legacy unfiltered variants are not newly proven after this helper migration;
prior results remain historical evidence only. No broad full regression.

### Dual-channel actual Order HTTP runtime result (2026-09-19)

LocalCustomerRuntime.channelOrderSubmission selects a configured Pickup/Dining
CustomerOrderSubmissionPort from shared current Guest/CSRF, scoped Store and
current bound Dining state. Closed owner command intent is captured before await;
owners retain full Cart/quote/capacity/Inventory authority, commit and recovery.
Matched quote versions required; mixed legacy configuration/missing Cart resources
rejected. Existing HTTP error mapping and route unchanged. Environment README
documents required ports with no invented operational defaults.

b45324/7d11cd API typecheck/build and56 focused selector/runtime tests passed.
bf4d88 scoped ESLint, import validator, Prettier and diff-whitespace passed.
Actual customer-order-http now uses the unified runtime and persisted Identity/
Dining binding supplied by both existing submission scenarios. a68adf Pickup
configured-positive106.577s and db094e Dining configured-positive69.471s passed,
including PWA HTTP lost-response retry, same original Order and no repeated
Inventory reservation; existing downstream payment/additional Dining batch
assertions retained. Each filter omits three other variants intentionally; do
not claim fresh all-variant acceptance after this helper change. Prior eight-case
details results remain historical and the configured-positive cases are now fresh.

No failed checks after safe exclusive new-test creation. Initial automatic review
rejected a proposed copy-derived test-generation script as possible test coverage
loss; it never executed.9534f9 confirmed destination absent; dff386 created only
that absent file and appended runtime cases, preserving all existing tests.
Reviewed source/fixture scope: no secret logs, external calls, cross-owner private
reads, money/time policy change, migrations or generated/dependency changes.
HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty WP2402 tree and
this source/test/helper/documentation change. Existing pinned install unchanged.
No commit/push/merge/deploy; no running checks.

Details and Order HTTP now each use unified runtime instances in their existing
sequential fixtures, but are not yet one long-lived configured candidate process.
Payment HTTP still needs the corresponding actual runtime assembly. Store data
location question remains pending; actual Store/Provider/browser/pilot gates
remain outstanding. Continue runtime consolidation; goal active/unachieved.

### Single runtime Payment HTTP journey selection (2026-09-19)

Previous Order turn progressed actual paired routing and both configured-positive
DB journeys. Existing submission-inventory-payment helper starts separate intent
and handoff/result servers. Consolidate them into one LocalCustomerRuntime.payment
instance retained until all payment/terminal/downstream assertions finish.
Use existing real session access, history, inventory and creation ports. A retained
Provider/terminal delegate remains unavailable before that fixture stage is
initialized; later use actual existing synthetic Stripe adapter and terminal store.
No default successful Provider facts. All credentials remain synthetic and no
Provider network operations. Preserve existing claims, lost-ack recovery, current
admission denial, no-provider result reads and downstream receipt/refund assertions.
Fresh only both configured-positive owning DB cases sequentially and fixture
format/diff. Production source/build/type unchanged; reuse prior evidence.

### Single runtime Payment HTTP result (2026-09-19)

submission-inventory-payment now retains one LocalCustomerRuntime.payment for
intent creation, handoff and result queries through all subsequent assertions.
Existing real session access/history/Inventory/current admission are reused.
Provider and terminal delegates reject before fixture initialization; afterward
they use the existing synthetic Stripe adapter and actual terminal store.
Outer finally shuts down the one runtime on success or failure.

Fresh configured-positive acceptance:7c23e3 Pickup109.134s;416c1d Dining72.575s.
Existing lost-ack/replay, no-repeat Inventory admission, current handoff denial,
Provider-free terminal reads, downstream kitchen/receipt/refund and Dining
continuation assertions remain. Each run filters three variants; no fresh
all-variant or live Provider claim. a3e8bb format/whitespace passed; reviewed the
changed helper for resource cleanup, credential containment and preserved owner
checks. No production source/schema/dependency change, so prior API build/type/
lint and valid pinned installation remain reusable. No running checks.

Tested HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty WP2402
tree and this helper/WP change. No external mutation or commit/push/deploy.
Payment endpoints now share one instance; Entry/Cart/Quote/Details/Order and
merchant-side downstream fixtures are still not a single persistent candidate
application. Next consolidate those lifetimes/configurations and browser
acceptance. Actual Store/Provider configuration remains outstanding; goal active.

### Shared payment/status/receipt runtime selection (2026-09-19)

Retain the same LocalCustomerRuntime payment instance for subsequent actual
customer Order status and Pickup receipt retrieval. Configure existing receipt
and orderStatus reader options from the same current Identity transaction binding,
real owner runner and fixed test Provider account. Remove only extra standalone
HTTP servers; caller owns final shutdown. Preserve denied/foreign access,
kitchen/payment projection, original/refund receipt and no-read-side-write
assertions. Source issuance/legal facts remain explicitly synthetic fixtures.
Only configured-positive Pickup/Dining DB cases sequentially and two-helper
format/diff are fresh; production API unchanged and prior build/type/lint reusable.

### Shared status/receipt runtime result (2026-09-19)

Payment runtime now also mounts existing orderStatus and receipt readers using
the current scoped Identity binding and real owner transaction runner. Status
HTTP and Pickup receipt HTTP reuse paymentRuntime.server; receipt helper no longer
creates/closes a separate server. The payment helper's outer finally owns shutdown.
No production source changes or new successful defaults.

54bf6f Pickup configured-positive105.333s and edaff6 Dining configured-positive
66.098s passed. Same-instance payment/result/status and Pickup original/refund
receipt assertions include wrong-CSRF/foreign-order denial, kitchen/payment
projection fields and no receipt issuance on reads. Other three variants per
suite filtered, not newly claimed. Existing separate downstream Dining delivery
and merchant workflows remain separate where already declared.
43ed06 two-helper format/scoped whitespace passed. Reviewed actual helper sources
for retained assertions/current authority and connection ownership. No failed
runs, no running checks, candidate state untouched. Production build/type/lint,
schema181 and pinned installation unchanged and reusable from prior WP evidence.

HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing dirty WP2402 inputs and
these two MJS helpers/WP. No commit/push/merge/deploy. Full customer entry-to-payment
and merchant operations still need a persistent shared candidate configuration
and browser acceptance; actual Store/Provider inputs pending. Goal active.

### Current-schema persistent demonstration baseline selection (2026-09-19)

Candidate inspection confirms v3 has schema181/restricted database resources but
no api.mjs/business data; v2 has existing explicit demonstration Draft artifacts.
Move the already-scoped demonstration Brand/Store, Menu, Product/SKU and CAD5
PriceBook setup to the separate v3 database. Preserve source v2 files/database.
Copy existing JSON values and scripts exclusively to absent v3 paths with0600;
change only exact local env path/database assertion. Do not promote Draft facts
to published/current, invent tax classification or claim real Store activation.
This creates durable configuration inputs for real runtime assembly, not another
isolated test. Existing scripts parse owner aggregates, restrict exact target,
use transactions/advisory locks, append Audit and read back expected records.
Run once in dependency order: organization, menu, product, price using existing
workspace TypeScript loader; their scoped readback is the needed verification.
Do not re-run business suites, migrations181 or frozen install for this operation.

### Persistent demonstration baseline result (2026-09-19)

f66d7e: existing organization/menu/product/price scripts succeeded in exact local
v3 target with owner parsing and scoped readback. Persisted Brand/Store Draft,
Menu revision2 with one Product/SKU Draft placement and CAD500-minor PriceBook
Draft; six Audit rows. No published pointer, tax classification, real identity
or operating approval invented. Source v2 untouched. Eight ignored v3 files
created exclusively at0600, no credential bytes printed.
single-store-pilot runbook now states concrete current candidate status and next
owner-publication/long-lived runtime work. This is persistent candidate progress;
not an active customer application. No business suites/migration/install rerun.
Goal active; actual Store configuration question remains pending. No commit/deploy.

### Product Draft replacement persistence selection (2026-09-19)

Publishing inspection found actual missing code: ProductService.replaceDraft
already exists, but PostgreSQL lifecycle commit rejects every action other than
ChangeLifecycle and creation is separate. Implement owning Catalog draft store
on existing registered tables, preserving current root identity, exact expected
version, operation fence, immutable replay snapshot and atomic Audit. Replace
metadata, SKU graph and option binding children under one savepoint/current
Brand authorization; preserve SKU identity/code/creation provenance and reject
invalid lifecycle transitions. No direct activation of candidate facts.
Fresh Catalog build/type via build, actual product creation consumer extended
with draft replacement, stale/concurrent intent, replay-after-later-edit,
Audit rollback and authority denial; scoped lint/import/ownership/format.
Schema unchanged:181 migration and valid install evidence reusable. No broad
application regression until HTTP consumer is added. Current candidate stays Draft.

2661a7 found AuditActor narrowing lost inside async transaction callback; retain the already-validated actor reference before that callback. Fresh real-store test covers metadata/tax, option defaults/channel/SKU scope, variant swap, SKU add/remove, rollback, stale concurrent version, immutable replay and current denial.

ce8a73 correctly rejected a backwards fixture timestamp: existing lifecycle scenario had advanced root.updatedAt by60s. Base draft operation times on the loaded root update, and assert the rollback injection reached an actual Audit insert rather than accepting any earlier rejection. Production build and8dd0e1 lint/import/ownership pass retained; re-run only failed DB case after test correction.

195fa3: strengthened injection counter showed another pre-Audit rejection. Require the exact injected error in that assertion to surface the actual failing constraint; keep rollback/count assertions and rerun the same DB case.

1ef6ed exposed PostgreSQL SKU INSERT/UPDATE rules rejecting ON CONFLICT. Keep operation/Product/code locks and use explicit existing-SKU UPDATE with full identity/version predicate and rowcount, new-SKU INSERT otherwise. Rebuild changed owner source, rerun failed DB case and affected lint; ownership/import prior coverage unchanged but final source diff reviewed.

447064 exposed the governing SKU identity rule1100_001: unit_of_sale and
unit_quantity are immutable for an existing SKU. Preserve this higher-authority
constraint: service/store reject changed units, SQL only updates mutable fields,
and unit changes require a new SKU. Test metadata/variant swap with unchanged
existing units and add a new SKU with different units; add service-level unit
rejection before persistence. Rebuild Catalog, run its directly affected Product
tests and failed actual creation/draft DB case; lint affected source again.

b32361: variant swap encountered existing unique constraint because the explicit UPDATE rewrite omitted the temporary-digest staging loop. Restore scoped transaction-local staging for retained SKUs, keep uniqueness enforced; rerun only affected Catalog build and failed real DB case.

Product Draft persistence scoped checkpoint (2026-09-19):

- a2d6b8/b81e18: final Catalog build and actual PostgreSQL Product creation/Draft acceptance passed (12.281s). Includes complete options/default quantities/channel/SKU scope, variant swap, add/remove SKU, actual post-Audit failure rollback, one-winner concurrent CAS, immutable recovery after later edit and revoked current permission.
- cac3b9: eight affected Product service tests passed, including rejection of existing SKU unit changes. Subsequent change only restores the persistence staging loop, outside those service test inputs; evidence reused, not rerun.
- a4655f: fresh scoped ESLint and Prettier checks passed for six affected source/test files. 8dd0e1 import/ownership evidence reused: same imports, same owning source registration and same tables; no new migration/dependency/toolchain changes.
- efcb03 final scoped source review: Brand scoping, current authorization, operation/code/Product lock order, SKU immutable identity, guarded updates, transaction rollback, append-only operation snapshot/Audit maintained. Existing unrelated dirty work preserved. No schema rules disabled, no direct candidate activation.
  Remaining: Merchant ReplaceDraft command/HTTP adapter with current permission and authoritative OptionSet resolution; then use owner operations to prepare the explicit demonstration candidate. This is an adapter/service checkpoint, not HTTP Draft editing or a completed pilot. Candidate data and external services unchanged. Goal remains active; no full verify or unchanged broad integration rerun.

Next scoped implementation: Merchant Product ReplaceDraft HTTP/runtime wiring and Catalog current OptionSet version reader. Authority: existing catalog.product.manage Brand permission, Product replaceDraft contract and persisted OptionSet fields; no publication/activation. Fresh affected Catalog/API builds and scoped BFF/type checks, actual Product creation consumer extended through HTTP for draft save/replay/conflict/current denial and options validation. Same 181 migration/install inputs reusable; no full verify.

6d67fe: API build identified optional rowCount in the existing ProductLifecycleTransaction contract. Reader does not use rowCount; match that contract. Product Draft HTTP acceptance extends the current isolated DB fixture with actual option resolution, save/replay, changed intent, invalid version and revoked current authority. Server owns current time and SKU creation provenance.

387242: actual HTTP Draft save/option reader/replay/invalid option/current denial passed; Catalog/API production builds pass. dd40bd:32 BFF transport tests pass. Final source review identifies a specific remaining acceptance question: new SKU creation provenance is server-bound and remains stable on replay after later edits. Add this scenario to the same DB test; rerun only that case, not unchanged builds/BFF suite. a40c3c import and ownership pass; later edits confined to tests/type declaration.

Merchant Product Draft HTTP checkpoint (2026-09-19):

- Added /merchant/catalog/products/draft and optional merchant runtime productDraft configuration. Command binds current Brand catalog.product.manage authority, server clock and SKU creation provenance; real owner Draft/code stores and complete current OptionSet reader run in the same transaction. It does not publish or activate a Product.
- 6f9477/387242: Catalog and API production builds passed. dc9c1e was the earlier unmatched optional-rowCount type edit, resolved before these successful runs.
- dd40bd/5be5f2:32 merchant BFF tests, API typecheck and scoped ESLint passed. New Draft route covered same-origin/Host/CSRF/query guards, no-store, configured/unconfigured and sanitized errors.
- 735e3e: final actual PostgreSQL+HTTP Product acceptance passed12.274s, including complete option/default resolution, save, changed intent, absent version/no writes, current permission denial, new SKU server provenance and immutable retry after later edit. Final affected-file Prettier and latest helper lint passed.
- a40c3c import/database ownership pass reused at final state: later source changes only optional rowCount annotation; additional edits were tests, no new import or owning table.5f1fb9 scoped final review confirms same transaction, current authorization, no credentials/PII in error bodies; pre-existing unrelated dirty changes preserved.
- No dependency/migration change; reuse valid installation and181 migrations per earlier WP evidence. No full regression, no commit/push/deploy or external data mutation.
  Next: prepare the explicit .local/pilot-v3 demonstration Product/Menu/Price through owner commands and compose an actual persistent process. This checkpoint proves the HTTP Draft edit path with a synthetic authentication adapter; real workforce identity, configured process and full browser pilot remain unproven. Goal active.

Organization activation dependency (2026-09-19):
Inspection c75b98/7f1a2f confirms candidate Brand/Store remain Draft, and original ignored provisioning scripts use parsed synthetic aggregates plus direct SQL initialization, not owner activation commands.14c40e proves TenantContext and merchant organization reader reject Draft organizations. Existing BrandAdministration service defines ActivateBrand, but no PostgreSQL Brand admin repository exists. The operation table stores metadata only and cannot recover the original Brand artifact after later edits. Do not activate candidate via status SQL or invent workforce/approval facts.
Next bounded persistence increment: add optional immutable artifact_snapshot_json to existing owner brand_admin_operation (0200_019 expand, no new module/table/permission). Historical rows remain null, with no fabricated backfill; future reader must fail closed for absent recovery evidence. Brand-scoped JSON shape guard plus existing append-only triggers/RLS remain. Fresh existing brand-admin PostgreSQL acceptance covers migration, null legacy compatibility, snapshot identity and mutation prevention; existing migration inventory/validation scripts as applicable. This changes migration inputs, so earlier181-migration evidence is historical for current source; candidate is not migrated or activated by this change.

8b0bbe/d5f2ef: new migration filename used unsupported add verb; rename un-applied new file to closed-grammar alter.3f4af8 migration tests failed only on that catalog diagnostic (config11 pass reusable); run catalog tests/check and failed Brand DB case after rename. No migration validation bypass.

aec835:182-migration Brand DB acceptance passed11.333s, including null legacy rows and protected scoped snapshots.325b50:96 catalog tests pass, two explicit expected-inventory lists need the new0200_019 entry. Update only those inventories; run those two failed tests and scoped format/lint, reuse the96 unchanged cases and config11.

Brand operation snapshot storage checkpoint:
-55c9b9 migration catalog valid with182 entries; aec835 actual isolated database applies all182 and Brand/RLS/append-only/legacy snapshot tests pass11.333s.
-739799 two updated inventory tests pass; remaining96 catalog cases reused from325b50 unchanged inputs, config11 reused from10b48e/3f4af8. This resolves migration:check components without repeating passing cases. Final scoped lint/Prettier pass.
-Review: only nullable column plus Brand-bound JSON constraint, no history backfill, no new database privilege/module boundary, existing append-only trigger and RLS preserved. Old named-column inserts remain valid. .local/pilot-v3 still181 migrations and Draft organization; runbook now distinguishes candidate schema from source.
-Next implementation: PostgreSQL Brand lifecycle repository using brand_admin_operation.artifact_snapshot_json, current authorization, expected Brand version, stable operation replay and caller-owned Audit transaction; wire to existing BrandAdministration service before any candidate activation. Historical operation rows without snapshots must not be recovered from mutable current Brand.
Goal remains active; no actual Store/Provider/workforce facts inferred, no deployment/commit/push, no business state activation this turn.

Brand lifecycle owner implementation selection: create scoped PostgreSQL loadBrand/resolveOperation/commit adapter for CreateBrand/ActivateBrand/ArchiveBrand only. Existing service remains lifecycle authority; store rechecks transitions, expected version, current authorization before/after, operation lock then Brand lock, atomic Audit callback and immutable snapshot replay. No configuration/membership mutations added. Fresh Tenant build, real brand-admin service/store DB scenario (create/activate/archive/replay, denied authority, Audit rollback, legacy missing snapshot) and ownership/import/lint; unchanged182 migration evidence reused within same inputs.

33a269: ownership schema requires write/readPattern:null, fixed scoped records without broader allowance. a85967 disallows non-null assertions; replace with explicit row presence guard.2c9570 actual creation reached commit but failed dependency: align Audit fixture privileges with real append read/replay needs (SELECT+INSERT), retain underlying synthetic transaction cause in creation assertion. Rerun failed DB case and directly affected lint/build. Ownership validator changed to register exact owner source; run existing database-ownership tests once.

d643ae exposed exact missing test-role audit_chain_head privilege. Grant only SELECT/INSERT/UPDATE for actual Audit append chain, consistent with existing Product fixture. Production source/build/7d6b9b lint unchanged; rerun only failed Brand DB case.

Brand lifecycle repository checkpoint:
-e59602 Tenant build passed;3d3550 actual BrandAdministration service + PostgreSQL acceptance passed11.591s. Proves Draft creation, activation, archive, one-winner concurrent expected-version change, post-real-Audit rollback, original activation recovery after archive, changed intent, foreign Brand denial, legacy missing snapshot rejection and current permission denial. Synthetic authorization fixture only; real owner state/operation/Audit SQL and transaction.
-4a74ce database-ownership931 tests and validator passed, import boundaries valid. This suite was selected because the ownership validator itself gained an exact source registration; no general full regression.
-7d6b9b scoped source/test/tool lint passed before last test-only Audit-chain privilege addition. Latest helper formatting passed e64323; production source unchanged.182-migration evidence remains valid (migration files unchanged), no candidate DB upgrade.
-Final review: only Tenant-owned brand/brand_admin_operation access, operation then Brand locks, CAS plus actual transitionBrand comparison, same transaction Audit callback with savepoint rollback, explicit current permission before/after, Brand-bound immutable snapshot readback. No cross-owner direct Audit SQL; Audit supplied through public owner callback. No unrelated user edits overwritten.
-Remaining: connect Brand lifecycle commands to authentic current operator authority/bootstrap flow, then Store readiness/activation and sale publication. Candidate v3 remains Draft and181 migrations; do not fabricate Active Tenant context or authority from initialization JSON. Full pilot process/browser acceptance remains outstanding. Goal active.

Brand command integration selection:
a69fae/ec6d9b: merchant Brand scope requires Active Store/Brand and cannot bootstrap Draft; Permission evaluation revalidates active TenantContext. Handoff88 ORG-BRAND-LIST names Owner/Brand Admin, WP2191 requires exact Brand/current permission/purpose. Do not invent an Active context. Implement API composition command requiring an explicit current Brand-administration authority port (current session/CSRF, actor, Brand, command, purpose), no permissive default. Existing Brand service/store and public Audit append perform actual transaction. The authentic bootstrap authority implementation remains a separate dependency; no fake authorization supplied to candidate.
Fresh API build/type/lint and existing Brand DB consumer extended through composition command for server-bound actor/time, original-clock replay, changed target/intent and denied current authority. Reuse unchanged182 migrations/owner store tests where inputs unaffected; no full verify.

e17308: API typecheck caught branded reference/version types and Audit callback return. Parse operation reference, use already-validated current version after explicit expected-version guard, await Audit result without returning it. Extend actual Brand DB fixture through API command with explicit synthetic current authority; no candidate authority assumption.

02b41c actual command+HTTP replay/security DB case passes;519e61 existing32 BFF tests pass. Review identifies HTTP first-write path was only covered by direct composition before HTTP replay. Move first activation through real HTTP in the same fixture; rerun this DB case only, preserving unchanged production build/BFF evidence. Identity input request is pending (OIDC/config file path and named Owner/Brand Admin), no credentials requested.

Brand lifecycle command/HTTP checkpoint:
-Added createBrandLifecycleCommand and /merchant/organization/brands/lifecycle with explicit optional runtime command configuration. Requires current session/CSRF-bound Brand/action authority; no default allow or forged Active context. Server binds actor, purpose, Audit identity, expected version and original operation clock.
-ad3526/02b41c production API build passed.519e61/6d3e17 API typecheck,32 BFF tests, affected source/test ESLint and import boundary pass.
-956352 final real PostgreSQL service/store/HTTP test passed11.839s. First activation enters HTTP, audit/current state persist; subsequent archive preserves original activation replay; spoofed actor/changed intent, foreign Origin/Host/CSRF/query and revoked authority rejected. Scoped format/latest helper lint pass.
-41e1bb final source review: immutable prior used only for original clock/artifact; current authority still checked before/after; runtime passes explicit command only. Test authority is synthetic and labeled. This is not evidence of a working OIDC/Owner administration authority source or first-store activation.
-Remaining identity input request: existing local OIDC/workforce configuration path and named Owner/Brand Admin; no secrets requested. Continue independent Store/publication/runtime work while pending; no candidate writes/activation done this turn. Same182 migration and unchanged owner validation evidence reusable; v3 remains181. Goal active.

Candidate migration/journey increment:
c04d11 authoritative v3 migration status is drift/out-of-order:0200_019 below applied high-water mark. No apply attempted, no checksum/ordering bypass. Preserve v3 and defer a fresh complete-catalog candidate until remaining owner schemas are settled; avoid another disposable candidate every lower-namespace change.
Independent integration selection: retain one LocalCustomerRuntime across checkout-details save and order submission for both Pickup/Dining. Existing current Guest/CSRF, channel selectors and persisted owner compositions remain; outer case owns cleanup. Introduce explicit mutable test delegation for Order only until its existing owner composition is available, fail if invoked early. Fresh configured-positive Pickup and Dining composition acceptance, same real runtime across the two steps; do not rerun legacy/zero-total variants or unrelated API builds (production unchanged).

e498cb editing script completed shared helpers/Pickup then stopped on Dining different cleanup shape.37a84d verified actual state; preserve existing quoteHttp.close and insert shared-runtime shutdown before it. No test started against partially connected Dining.

Shared checkout/order runtime checkpoint:
-2553a9 configured-positive Pickup real composition passes105.053s; a27980 configured-positive Dining passes64.411s. Both now retain the exact LocalCustomerRuntime/server from checkout details through Order HTTP submission/PWA lost-response retry, with current Guest/channel/CSRF and owner persistence. Existing downstream Payment/Inventory/kitchen/receipt assertions remain.
-05833e scoped5-file ESLint and Prettier pass. Final review confirms outer case closes retained runtime, Dining quoteHttp cleanup preserved, wrong/unattached Order delegate fails, scope/mode/quoteVersion checked before reuse. No production sources or migration changes, no application build/unchanged unit suites rerun.
-This proves continuity across Details→Order, not whole Entry→Payment browser readiness. Next align the already-combined Payment/status/receipt runtime to this retained checkout runtime, then Entry/Cart/Quote and actual browser long-lived process. Do not claim multiple isolated lifetimes as one application.
-Candidate v3 remains intact; c04d11 migration status refused lower migration (no apply). Runbook updated20781d. Operator identity/config input still pending. Goal active; no deployment/commit/push or operational activation.

Shared post-Order runtime selection: connect existing Payment intent/handoff/result and order-status/receipt owner compositions into retained checkoutJourney runtime. Explicit deferred test ports throw until existing real owner configuration is attached, one server/origin and one outer cleanup. Production sources unchanged. Fresh configured-positive Pickup then Dining composition cases, scoped helper lint/format; no new builds or unchanged unit/ownership suites. Same182 migrations; no candidate mutations.

c7712d shared-runtime payment replay returned503 instead of202. Keep original assertions; record only deferred method path and error code/name (no payload/credentials) in synthetic failure assertion to locate the missing real dependency. Rerun only failed Pickup scenario.

3a8971 diagnostic paths showed all owner calls succeeding until preparation snapshot construction. f9c07b found Pickup tenantReference was assigned after checkout runtime startup, so immutable payment configuration captured undefined. Bind existing id(1) Tenant in journey before startup, assert agreement with later ownerScope; fail early for missing Tenant. No business rules changed. Rerun affected Pickup, then Dining once successful.

Shared customer checkout/payment runtime checkpoint:
-71e32d configured-positive Pickup passes104.587s;762795 configured-positive Dining passes64.800s. Same retained LocalCustomerRuntime/server handles Details, Order, Payment intent/handoff/result, Order status and original/refund receipt reads. Existing current Guest/CSRF, atomic Inventory/payment fencing, lost-ack recovery, terminal/kitchen/receipt and ordinary-refund assertions remain.
-e4e2bb final modified helper/case lint and format pass;5dcb1b unchanged checkout helper lint/format reused. Production sources/migrations/dependencies unchanged, no application build/full verification rerun. Zero-total/legacy variants not run this increment.
-Review: deferred test assembly exposes explicit real owner method delegates, throws before attachment, checks Tenant/Brand/Store/payment account, one request origin, current clock follows actual owner access, and outer case alone closes retained server. Failure diagnostics contain only method paths and error code/name, no payload or credential. Payment Provider remains explicit synthetic transport; no live action.
-Resolved shared-runtime defect: Pickup Tenant set after startup yielded undefined preparation scope; bind existing Tenant at startup, assert later agreement. Original failure503 was not accepted as success.
-Remaining: Entry/Cart/Quote continuity, additional-batch Payment using same production service configuration, usable Merchant/Worker/customer process and real browser acceptance. Existing additional-batch helper coverage does not by itself prove same API configuration. Current candidate/environment/identity external boundaries unchanged; goal active.

Payment submission selection:
f6f605/b557ea confirms current factory hardcodes Initial/Additional and Additional must select tip before submit. Late inference from committed order would violate that order; do not use a client flag. Add optional server-owned resolveSubmission(session) -> kind+orders+tips to existing payment intent composition; default fixed options preserved, simultaneous fixed Additional and resolver rejected. Resolve once only for new operations after immutable history recovery path; Additional allowed only for DineIn. Snapshot kind follows selected owner. Endpoint body unchanged. Fresh affected payment-intent unit tests (Initial/Additional ordering, missing tip, immutable replay), API build/type/lint; real additional-session/persisted owner resolver integration remains required before claiming full multi-batch runtime.

5f97f4 API build/type and12 payment orchestration tests pass. Extend retained runtime actual Pickup/Dining payment options with server resolver bound to the already-persisted original Order submission+scope/type. Assert new operation resolves once and lost-ack recovery does not resolve again. This proves resolver integration for initial branches; Additional session parent resolution/HTTP remains separate. Run both configured-positive DB consumers because shared payment composition changed, then stop.

Per-session Payment submission composition checkpoint:
-5f97f4 API production build/typecheck and12 affected payment orchestration tests pass: fixed Additional compatibility; dynamic Initial and Additional ordering; missing tip stops before additional submit; Pickup cannot choose Additional; historical recovery never invokes submission resolver; mixed fixed/dynamic config rejected.
-42d256 actual configured-positive Pickup passes108.086s; b5dcda Dining passes69.292s through retained HTTP runtime. New initial-operation resolver binds to actual persisted Order submission/scope/type and runs once; lost-ack replay recovers without re-resolving. Existing Payment/Inventory/kitchen/receipt/multi-batch assertions preserved.
-6bc024 scoped production/helper lint, formatting and import boundary pass. No schema/dependency changes;182 migration evidence and unchanged ownership evidence reused. No full verify or unused legacy/zero-total variants rerun.
-Final review: selection is trusted server-owned callback over current parsed session, never an HTTP mode flag; Additonal tip-before-submit semantics retained; legacy configuration unchanged; original history checked before selection. No live Provider or candidate mutation.
-Remaining: actual Additional checkout-session parent resolver and owner order/tip ports must be registered through this same configurable service, followed by full same-runtime Additional HTTP acceptance. Current real DB resolver covers Initial only; do not label full mixed-mode payment integration complete. Entry/Cart/Quote/runtime/browser/real operator prerequisites remain. Goal active.

Additional session submission integration selection: replace second-batch fixture direct runtime.submit with actual customer checkout-session submission bridge. Resolve original timestamp/version/next sequence through public persisted Dining parent source under owner transaction, then final writer revalidates. Pass existing real Catalog/Pricing/Cart source configuration; preserve current identity, Inventory, Audit and replay assertions. Fresh configured-positive Dining acceptance plus affected helper lint/format only; production/build/Pickup unchanged and prior evidence reused. This increment does not yet prove same HTTP Payment configuration for Additional.

034b37 real session bridge fails ORDER_ITEM_SNAPSHOT_INPUT_INVALID: source catalog capturedAt is validation.validatedAt, while bridge used later submission time for snapshotCapturedAt. Fix bridge to retain validation capture time and independent current submittedAt; add unequal-clock unit assertion. Expand fresh checks only to affected API unit/build/type/lint plus failed Dining scenario; no shared contract/schema change.

Additional checkout-session submission checkpoint:
-d31611 configured-positive Dining real PostgreSQL journey passes67.064s. Second batch now enters createCustomerAdditionalDiningSessionSubmission using actual current checkout session and original owner Catalog/Pricing/Cart sources. Public resolveAdditionalParent supplies persisted original timestamp/version/next sequence; actual final writer retains current Guest/Dining/Inventory and transaction fences. Session replay returns original record; Cart clears once and two distinct Inventory validations persist. Existing downstream additional payment/acceptance/kitchen/refund assertions pass.
-Real integration exposed production snapshot clock bug034b37: catalog capture belongs to validation.validatedAt, not later submittedAt. Bridge corrected, preserving independent actual submission clock. b84242 API build/type and4 session-submission tests pass, including deliberately later submission clock. f7f7a4 affected production lint/format/import pass; b0d560 helper/case lint/format pass. No unrelated Pickup/build/full verify reruns; prior Pickup evidence42d256 remains valid because only Additional bridge/consumer changed. Three unrelated Dining variants intentionally filtered, not claimed passed.
-Reviewed11fa73 under same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted tree. No new schema/dependency/candidate/external changes. Synthetic authorization callbacks remain fixture-only; actual submission current identity is real persisted owner composition. No live Provider evidence.
-Next: register real Additional session order/tip/clock/payment ports through existing per-session selector and retained customer HTTP runtime; current Additional payment helper still calls lower-level Payment service. Then Entry/Cart/Quote/full process/browser and authentic operator/store configuration. Goal active; pilot not complete.

Mixed customer Payment HTTP selection: configure retained runtime selector/history/inventory/payment factory to dispatch exact persisted Initial or Additional submission/operation, preserving original paths. Second-batch fixture exposes actual session submission, session tip and historical clock ports with current persisted history authorization. Additional Payment helper registers existing actual Payment owner ports and enters same HTTP server for first intent/replay. Provider remains explicit synthetic transport; no configuration/authority invention. Fresh configured-positive Dining and shared-helper Pickup consumers, scoped helper lint/format; production code unchanged so prior build/unit evidence reused. Check Additional replay cannot call Provider or re-resolve parent and initial replay still resolves original after Additional.

c6e65a current-history authorization initialization exposed incomplete fixture scope: use existing ownerScope including Tenant, not Brand/Store-only scope. No authority bypass; retry failed Dining only before planned shared Pickup consumer.

Documentation reconciliation: runbook still labels RF-D01–06 pending despite accepted ordinary-refund proposal2026-09-13. Correct that stale status and record bounded same-runtime Initial/Additional HTTP evidence, without claiming operational or complete browser readiness. Source/relative links read locally; documentation-only edit does not trigger business suites.

Mixed Initial/Additional customer Payment HTTP checkpoint:
-e8fee5 configured-positive Dining real PostgreSQL journey passes67.419s;61f6dd shared configured-positive Pickup consumer passes105.429s. Same retained server handles original Payment and Additional intent201/replay200; Additional resolver runs once, synthetic Provider called once, original Payment HTTP replay before/after Additional is identical. Additional owner record/operation/Audit/observation persistence and existing downstream terminal/acceptance/kitchen/ordinary-refund assertions remain.
-Actual second-session tip now enters createCustomerAdditionalDiningSessionTipSelection; session submission and clock use current createCustomerAdditionalDiningHistoryAuthorization over persisted Identity/Dining commitment. Full ownerScope (including Tenant) fixed after c6e65a initialization failure. No default-allow production source added.
-Shared test assembly dispatches history by exact persisted operation, orders/tips/inventory/payment by exact persisted submission+session, retaining initial fallback assertions. No client-controlled mode. Additional Payment factory verifies actual preparation equals owner-composed snapshot except fresh generated preparation identity. Original operation recovery bypasses resolver/admission/Provider as required.
-0d4f59 four affected helpers/case ESLint/Prettier pass;7d6725 final full-scope correction lint/format pass. Production sources/schema/dependencies unchanged this increment; b84242 API build/type/4 Additional bridge unit tests and f7f7a4 import evidence remain valid for unchanged inputs. No full verify/build/install repeated; three unrelated variants in each file filtered and not claimed passed. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted work.
-Runbook source reconciliation377a91/4eb17b/0b5930 removes stale RF-D01–06 pending label, links accepted proposal, states actual HTTP evidence and outstanding full application/browser scope. Candidate v3 unchanged; no live Provider, activation, commit/push/deploy.
-Remaining: Additional client handoff/result still uses first-payment configuration until explicitly composed; Additional helper terminal scope currently separate synthetic account id22 vs original id90, so do not assert unified account/status/receipt coverage. Bind correct shared configured Provider scope and current result clock, then Entry/Cart/Quote and full long-lived API/Worker/Merchant/browser. Real OIDC/Owner and Store configuration remain external inputs. Goal active and incomplete.

Additional client handoff/result selection: extract existing Additional Order->Dining capacity->Inventory admission factory for shared use by Payment claim and client handoff (same policies/fences, no new rules). Retained runtime dispatches admission by actual session and Provider retrieval by actual attempt. Combined fixture uses original configured synthetic Provider account for Additional terminal/history; advance existing fixture clock before result read. Assert handoff works only while currently admitted, denied Inventory never retrieves client credential, pending result becomes Succeeded only after durable terminal. Fresh API build/type/affected admission tests, scoped lint/import, configured-positive Dining then affected shared Pickup consumer. No migrations/full verify/installation.

Additional handoff/result checkpoint:
-Extracted createCustomerAdditionalDiningPaymentAdmission from existing store assembly; both real Payment claim and client handoff now use identical current Ordering -> Dining capacity -> Inventory/Workflow chain. No rule or persistence changes. API build/type and3 existing admission tests passed76e775/c70a81; import boundary b32397 passed. b8033c affected source/helpers/case ESLint and formatting passed.
-37cf6c configured-positive Dining real DB journey passes68.334s. Same retained HTTP runtime serves Additional intent, handoff and result. Handoff retrieves exactly once when admitted, returns422 without a second credential retrieval when current Inventory authority denies. Same configured synthetic account as initial Payment, distinct payment identities. Provider snapshot alone yields Pending; actual terminal persistence plus current fixture clock yields Succeeded through HTTP. Additional replay, initial recovery and existing downstream kitchen/refund remain covered. No live Provider evidence.
-71e641 affected shared configured-positive Pickup passes108.840s. Three unrelated variants each intentionally filtered; no full verify/install/unchanged migration suite. All selected checks complete, no live test handles remain. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted work; candidate v3 untouched.
-Review d72ada/c5e8a9: existing public owner admission logic reused verbatim, scoped history current authorization retained, ephemeral credentials only HTTP response with no-store/no-referrer and no credential comparison output. Original account used only in combined synthetic fixture; standalone additional test keeps original explicit account. No new permissions, tables, migrations or external changes. Runbook e39ec4 reflects completed client handoff/result and remaining application/browser scope.
-Next investigation31d1c9/2e84fd: existing exerciseDiningQuoteHttp explicitly uses a different no-option cart and isolated server, so it is not the source of current configured checkout. Do not merely retain that unrelated server and call it end-to-end. Connect actual configured Quote source for the same Cart into Entry/Cart/Quote -> retained Details/Order/Payment runtime, then whole customer/merchant browser and long-lived API/Worker. Authentic operator/store configuration remains pending; goal active, pilot incomplete.

Same-Cart configured Quote selection: Pickup currently manually appends Quote/attachment before capacity. Move existing Catalog seed/config before Quote, expose unchanged synthetic policy request from pricing seed, and use real configured Quote HTTP composition to create the actual attachment on the same Cart. Start retained LocalCustomerRuntime at Quote with explicit deferred future Details/Order/Payment ports; existing Details helper reuses it. Legacy path preserved. Fresh configured-positive Pickup and affected helper lint; Dining fallback unchanged but run configured-positive consumer once for shared Details reuse. No production/schema change or full verify. This covers Quote->Details->Order->Payment, not Entry or actual Cart editing/browser.

c359dd first real Quote HTTP returns503 before downstream work. Retain assertion and add bounded table/row-count/SQLSTATE plus candidate-stage diagnostics to test owner delegates (no values/credentials), rerun only failed Pickup to identify missing dependency.

2a34af proves missing cart_binding_record SELECT. Existing submission fixture also lacks any activated binding; prepare explicit initial binding history using the already-established configured-quote-entry fixture pattern, and grant SELECT only to real Quote reader. This is fixture starting state, not actual Entry/Cart-binding acceptance; that full owner workflow remains required. No permissive replacement binding reader. Retry failed Pickup.

15414c progresses through actual policy reads then rejects configured Quote422. Existing synthetic Catalog channel PILOT_CHANNEL and Pricing channel CUSTOMER_WEB are distinct inputs; factory requires pricingChannelCode to match actual Pricing context. Bind existing policy-request channel, not Catalog channel. No policy/price change; retry failed Pickup.

3ad8e8 now passes candidate channel validation but fails before request append. f5827f shows PriceQuoteRequestStore requires hashIntent/equals as well as generated IDs. Supply existing hash/equality tools to pricingReferences; keep current request digest protection. Retry failed Pickup only.

7c9ce7 actual Quote creation succeeds; new test incorrectly expected replay200. Existing CustomerQuoteHandler returns201 for successful quote/recovery alike. Match verified contract and require full identical safe response on replay, then continue same downstream case.

6d4511 Quote and recovery now pass and downstream reaches duplicate binding setup. 8cf404 shows original fixture binding existed later before Details, rather than absent entirely. Move that unchanged original setup immediately after Cart seed; remove newly added helper binding rows. Single preserved fixture history now serves Quote and Details, no duplicate/invented predecessor. Same-operation Quote recovery201 matches source; Current200 is a separate successful status. Retry failed full Pickup journey.

Same-Cart Pickup configured Quote checkpoint:
-7ecf3f configured-positive Pickup real DB journey passes109.850s. Actual createCustomerConfiguredQuoteHttpComposition now reads existing persisted Catalog/PriceBook/Tax/option-policy sources, writes pricing request and attachment through HTTP, and recovers identical safe response on same-operation retry. Downstream capacity, CheckoutSession, Details, Order, Payment, kitchen and refund use this actual same-Cart attachment. One retained LocalCustomerRuntime starts at Quote and survives Details/Order/Payment; no separate Quote server or substitute cart.
-f750a0 configured-positive Dining shared Details fallback consumer passes71.688s, including Additional intent/handoff/result. Dining Quote is not newly integrated by this result. c6caea final four-file ESLint and relevant Prettier pass; aa5699 earlier formatting covers unchanged pricing helper/Details code. No production sources/schema/dependency changes, so previous production build/type/admission/import evidence remains applicable; no build/full verify/install repeated. Three unrelated variants each filtered, not claimed passed.
-Integration fixes: move original existing binding history before Quote (remove duplicate newly introduced rows), supply exact reader SELECT; bind Pricing channel from Pricing policy context rather than separate Catalog channel; supply hashIntent/equals for PriceQuoteRequestStore; same-operation successful Quote recovery201 differs from Current200. Every failed run is retained above; none counted as success.
-6e37cc reviewed same branch/HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus uncommitted work. Same Cart/version checked on actual persisted attachment, current Guest/CSRF/binding remains real owner read, reuse requires scope/mode/origin/listening match, later ports fail if not attached, original outer cleanup retained. Diagnostics contain only table/row-count/SQLSTATE/stage. Legacy nonconfigured quote branch remains available. Candidate/environment untouched, no external mutation.
-Runbook6528a6 states bounded same-Cart Quote evidence. Existing synthetic Guest/Cart/activated-binding starting history, policy facts, Store safety and Provider transport remain fixtures, not Entry/Cart or operational acceptance. Do not treat configuration capture callback as live commercial authority.
-Next: generalize same-Cart configured Quote integration to Dining with current participation/identity, then replace Entry/Cart starting fixtures by actual owner workflows and full browser/long-lived process assembly. Authentic operator/Store/Provider configuration still pending. All selected checks terminal; goal active and pilot incomplete.

Dining same-Cart Quote selection: generalize prior Pickup journey Quote helper to mode-specific actual current Guest/binding and Dining participation, exact cart role and shared configured Pricing/Catalog source. Move unchanged Dining Catalog setup before Quote; configured branch replaces manual PriceQuote/attachment write with retained server HTTP operation, legacy branch preserved. Required new checks: configured-positive Dining full consumer, then shared Pickup; affected helper/case lint/format only. Production/schema/dependencies unchanged, no build/full verify. Original Entry/Cart fixtures remain explicitly outside this increment.

Both-mode same-Cart configured Quote checkpoint:
-c5dc77 configured-positive Dining real DB journey passes71.873s;792cba shared configured-positive Pickup passes106.013s. Both now start retained LocalCustomerRuntime at actual configured Quote HTTP, persist/recover Quote request and attachment for the same Cart, and continue through Details/Order/Payment. Dining additionally covers current participant/binding owner reads and existing Additional intent/handoff/result, kitchen/refund downstream assertions. Neither uses the separate legacy no-option Quote cart as its source.
-Generalized helper renamed customer-configured-journey-quote.mjs with mode-specific current Guest binding, actual Dining participation and correct cart owner role; original Pickup branch retained. Existing Catalog seed moved before actual Quote command in Dining, configured manual Quote/attachment writes replaced, legacy behavior remains. 4c2e48 affected helper/cases lint/format pass;416c20 stale-import search empty and current owner wiring reviewed. No production/schema/dependency changes, so prior production build/type/import evidence remains valid; no full verify/install/build repeated. Three unrelated variants each filtered, not claimed passed.
-Runbook f1fe69 reflects both configured Quote chains and excludes Entry/Cart/browser from claimed coverage. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted work. Scope/credentials remain request-authorized owner data; synthetic policy/safety/Provider inputs stay explicit. No candidate writes, activation, live Provider, commit/push/deploy. All selected checks terminal.
-Next sources6505e2/8b1e04: real Entry/Cart workflows exist in persistent-profile-entry, entry-pickup-cart and entry-dining-cart under public-store-profile acceptance, but their helpers currently revoke/end the guest and do not pass a live session/Cart to checkout. Extend normal-path handoff before revocation using actual owner-created identities/carts and retained runtime, preserving separate denial assertions. Avoid replacing those identities with seeded ones or calling isolated lifetimes a full journey. Then complete customer/merchant browser and long-lived candidate/Worker with authentic operator/Store/Provider inputs. Goal active; pilot incomplete.

Actual Entry/Cart -> Dining Quote selection: attach real configured Quote handler to existing Dining join/binding/Cart server using the same current GuestSessionService, participation, Catalog scope and safety sources. Quote request derives lines from actual owner-read Cart after both participants' HTTP mutations, with explicit synthetic persisted price/tax fixture; no replacement Guest/Cart seed. Add optional initial Product tax classification to existing Catalog fixture, default null unchanged; existing public-profile scenario exercises both its Pickup default and Dining configured consumer. Fresh smallest existing command: pnpm exec vitest run --config packages/database/vitest.public-store-profile.config.ts, then affected helper ESLint/Prettier. Previous c5dc77/792cba configured Quote->Payment journeys unchanged; production/schema/dependency checks reused from preceding checkpoint. Entry first runtime and Dining runtime remain separate; this increment does not claim full Entry->Payment or long-lived browser acceptance.

155360 initial Entry Quote seed rejected abbreviated UTC by existing price_entry IANA-zone constraint before Quote execution. Use canonical Etc/UTC with identical instant/offset; no schema bypass. 51725a scoped lint found existing unused warnings destructure in touched shared Cart helper; remove field from copied comparison item instead. Retry only failed profile scenario and affected lint.

0c3d3a Etc/UTC also rejected; source7ac566 confirms fixed America/Toronto constraint (not generic IANA validation as initially inferred). Retain existing constraint and synthetic January fixture uses Toronto midnight05:00Z/offset-300. No production change. Retry failed scenario; daaaac lint/format passed before this literal-only correction.

d8a6ea seed now succeeds; actual Quote HTTP returns503. Add bounded table/row-count/SQLSTATE plus candidate-stage diagnostics to this helper only; no bind values or credentials. Retry failed profile acceptance to locate actual missing dependency.

29252c/739d38 locate contract mismatch: configured-v2 Pricing explicitly requires at least one option, but actual Entry scenario contains ordinary no-option items. Use existing no-option Dining Quote v1 composition and persisted current PriceBook/Tax service, as established09e0c3; do not alter v2 rules or invent options. Policy reader must use repeatable-read/read-only transaction. Actual Cart already records owner Catalog validation; this increment does not add fresh configured Catalog capture or bridge v1 into prior v2 payment fixture. Preserve real Entry/cart identity, no replacement seed. Retry affected profile only.

651e5a v1 current Cart authorization proceeds but rejects fixture Audit before pricing. Sourcea4fc46 requires exact AUTHORIZED_CART_QUOTE reason; replace synthetic placeholder reason with existing command reason (expiry uses QUOTE_VALIDITY_ENDED). No permissive authority or production change. Retry same profile scenario only.

0588b1 real Quote creation/replay and persisted same-Cart/current-Guest/5650minor total assertions now pass before old-cookie assertion. Existing source6881b6 deliberately maps Cart permission denial to quote_not_found404, not401. Correct assertion and require exact safe error code, retaining no extra candidate/attachment changes. Retry failed scenario only.

Actual Dining Entry -> ordinary Quote checkpoint:
-4394b5 existing public-store-profile PostgreSQL acceptance passes37.478s. Actual signed Entry/Guest admission -> Dining join and rotated binding -> two participants' shared Cart item mutations/Inventory checks -> ordinary v1 Quote HTTP creation201 and identical replay201, actual owner attachment matches Cart/version and second Guest, synthetic CAD5650minor total. Prior rotated cookie denied404/quote_not_found with no candidate rerun or attachment mutation. Existing outer revocation/public-profile denial assertions remain and pass.
-No substitute Guest/Cart seeds added. Dining join/binding/Cart/Quote use same server and current owner Guest/participation; initial QR Entry remains a separate runtime. Catalog validation is actual item-command evidence. The earlier plan's configured-v2 source was inappropriate for no-option items; existing v1 contract used without changing Pricing rules or fabricating options. This does not claim fresh v2 Catalog capture, Entry->Payment continuity or browser readiness.
-Changes only four test-support helpers: initial synthetic Catalog Product may receive tax classification (default null preserved; same profile test covers Pickup default and Dining selection), Cart helper supplies real Quote handler/shared Cart view, join attaches same-server Quote, new helper seeds explicit commercial policy and reads persisted current policy under repeatable-read/read-only. No production, schema, dependency or candidate changes. Exact audit reason and existing denial status honored. All failed attempts and their causes retained above, not counted passed.
-daaaac all four helper ESLint/Prettier passed before subsequent new-helper-only corrections; f05ccf final new-helper ESLint/Prettier passes. Other three inputs unchanged since daaaac. Previous c5dc77/792cba configured Quote->Payment and production build/type/import evidence unaffected: none of their callers enable the new optional Product tax classification, default seed SQL still writes null as before; no rerun. No full verify/build/install/migration suite. Current same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted tree.
-Reviewed current helper scope/role grants, owner sources, actual Guest/Cart handoff, integer money, synthetic January Toronto effective period, safe bounded diagnostics and cleanup. Runbook now distinguishes actual Entry->ordinary Quote from existing configured Quote->Payment fixtures. All selected checks terminal, no test handles remain; no live Provider, activation, commit/push/deploy.
-Next: carry actual Entry/Cart/Quote outputs into current Dining CheckoutSession/Details/Order/Payment, respecting v1 ordinary vs v2 configured contracts, then unify long-lived Entry/API/Worker and customer/merchant browser. Real operator/Store/Provider inputs and candidate migration ordering remain recorded prerequisites. Goal active and pilot incomplete.

Actual Entry Quote -> Dining commitment selection: carry actual v1 attachment out of existing HTTP exercise into createCustomerDiningCheckoutComposition using the same real session/context/current Dining owner store. PrepareForOrdering must persist matching Guest/participant/Dining session/Cart/version/Quote; same request recovers original commitment/link, rotated old credential denied, no duplicate owner record. Generated submission/order/payment references are unexecuted intent identities, not fabricated orders/payments. Fresh existing public-store-profile acceptance and affected helper lint/format only; production/schema/dependencies and other Quote->Payment fixtures unchanged. Full CheckoutSession validation and payment continuation still required.

Actual Entry Quote -> Dining commitment checkpoint:
-d0cb3b public-store-profile real PostgreSQL acceptance passes36.918s on first run this increment. Real Entry/current rotated Guest/shared Cart/v1 HTTP Quote now feed createCustomerDiningCheckoutComposition.prepareForOrdering with actual current contexts and createPostgresDiningGuestBindingStore. Persisted commitment matches Guest, participant, Dining session, Cart/version and Quote. Replay returns identical record and public capacity link; owner loadSubmission returns same record. Rotated old credential denied and exactly one new commitment persists.
-58510e three affected helper ESLint/Prettier pass. No production/schema/dependency change, no full verify/build/install or unchanged cross-mode suite repeated; previous checkpoint production and configured Quote->Payment evidence remains applicable. Source changes: return actual quote from HTTP helper; call new bounded commitment helper in join flow before existing cleanup; add helper with exact existing Audit action/reason and scoped owner store. All test runtime/isolated-database cleanup completed. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted tree.
-Review: actual owner readers enforce current Guest/context and table participation, never substitute seeded identity or write Dining rows directly. Test-generated future submission/order/batch/payment identifiers remain intent allocations only; no actual orders/payment clocks claimed. Source validity bounded by quote expiry and owner authority; no Pickup capacity creation for Dining. No external/candidate mutation, credentials logged, commit/push/deploy. Runbook includes this bounded state.
-Next source1c0161: actual CustomerCheckoutSession allocation must own submission/payment operation identities and createCustomerDiningSessionValidation must consume this same commitment through real Cart/Quote/Catalog/Inventory readers. Refactor current generated intent creation around actual allocation before claiming complete checkout; do not fake a validation snapshot or seed a replacement Cart. Then Details/Order/Payment and full long-lived runtime/browser remain. Goal active and pilot incomplete; authentic operator/store/provider and candidate migration constraints still apply.

Current-clock Entry selection: allocation store d46a03 uses actual clock_timestamp for authority/cart expiry; historical January Entry is correctly ineligible. Preserve DB fences and historical scenario. Add a separate current-time Entry scenario with actual persisted Published profile/timing/organization fixtures, parameterize synthetic QR/policy/operating windows and proper Toronto effective boundary; no fake database clock or extension of historical durable sessions. Same existing public-store-profile config covers both scenarios; affected fixture/helpers lint/format. Existing API fixture default remains historical so existing unit behavior remains compatible. Current scenario must create fresh owner Guest/Cart/Quote/commitment before allocation integration.

a36eb2 historical scenario passes37.405s; current setup needs UPDATE privilege for existing timing-store FOR SHARE fence. Grant on scoped synthetic test role (no status mutation). 08e6e0 API typecheck passes; b19425 affected ESLint also completed before typecheck. Retry current-clock filter only. Attach new actual allocation before commitment only in current-clock path; authority uses real current timestamp and owner Guest/binding readers, replay must preserve original three allocated identities and one Audit. Historical commitment path unchanged.

1e3cbc current profile now publishes; Store owner correctly rejects equal-start/end 24h interval7fa06b. Use explicit synthetic 12-hour weekly window centered on current Toronto local hour (six hours either side), retaining existing interval validation and historical08:00 boundary. Retry current-clock only. dd642d API entry42 tests and affected helper lint pass; no rerun unless touched.

Current-clock Entry and allocation checkpoint:
-c4b131 current-clock PostgreSQL scenario passes38.070s. Actual Published profile/timing owner reads -> signed Entry/admission/current rotated Guest -> two-participant shared Cart/Inventory -> actual ordinary Quote -> real createPostgresCheckoutSessionAllocationStore authorization at database clock -> actual Dining commitment. Submission and payment operation IDs in the commitment come from the durable allocation. Retry with fresh proposed IDs returns original allocation, exactly one allocation and one allocation Audit. No historical clock injection/expired session extension.
-a36eb2 historical profile/Entry/closing-boundary scenario passes37.405s after shared fixture time parameterization; subsequent changes to its helpers retain the same false/default branch and time values. Final currentWindow false still00:00-08:00/endsNextDay false; allocation enabled only for currentClock true. Historical scenario intentionally filtered in c4b131, not counted as a fresh second pass. Default API fixture before/until remains exactly January original values.
-dd642d API customer-entry-composition42 tests pass;08e6e0 API typecheck passes. Affected lint from b19425/dd642d covers source fixture, new profile/time/allocation/commitment helpers and case;5f00ac final operating/persistent-entry lint passes.2767b9 final affected Prettier passes and case formatted only (no behavior change after c4b131). No production/schema/dependency/build/full verify/install or unchanged configured Quote->Payment reruns.
-Reviewed current profile helper uses actual Publishing/Timing/Profile append+authority; only business/organization/approver/QR keys remain explicit synthetic fixtures. Scoped test-role privileges, existing Tenant/Store/Guest binding, actual database clock fences and owner Audit remain; no private-table production access or credential logs. Toronto local boundaries use Intl IANA rules rather than hardcoded January offset. New current profile source initially failed missing timing FOR SHARE privilege, then equal-start/end synthetic24h schedule; both corrected without changing owners, and failure evidence retained.
-Same branch/HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted tree. All test/typecheck handles terminal; isolated databases/runtime cleanup complete. Candidate v3, external services and live Provider untouched, no commit/push/deploy. Runbook now distinguishes current-time allocation from full CheckoutSession creation.
-Next: current allocation helper exposes actual request/options/allocation. Wire createCustomerDiningSessionValidation with same Cart/Quote, captured Catalog and actual Inventory source, using existing commitment loadSubmission and original allocated paymentOperationReference. Then createCustomerCheckoutSessionComposition must persist the validated session and carry it into Details/Order/Payment. Existing callback result currently discarded after assertion; carry it forward rather than seed another lifecycle. Full retained runtime/customer+merchant browser and actual operator/Store/Provider prerequisites remain; goal active, pilot incomplete.

Actual Entry CheckoutSession selection: carry existing allocation and Dining preparation into createCustomerDiningSessionValidation and createCustomerCheckoutSessionComposition. Expose unchanged Cart Catalog/Inventory read configuration from preparation helper. Same-SKU/no-option fixture recomputes total current Cart quantity5, observes actual Recipe/Inventory through createCustomerCartSelectionInventory, authorizes observation via real current CheckoutSession authorization inside owner transaction; no fabricated validation or reservation. Assert persisted session uses actual allocation/submission/payment/quote/commitment, one validation/create Audit, replay unchanged and old credential denied. Fresh current-clock profile filter plus affected helpers lint/format only; no production/schema changes. Historical path remains unchanged/defaultfalse; prior historical and API fixture evidence retained.

Actual Entry CheckoutSession checkpoint:
-d01b34 current-clock PostgreSQL Entry scenario passes39.892s first run. Existing allocation/commitment now feed createCustomerDiningSessionValidation and createCustomerCheckoutSessionComposition. Real current Catalog+Recipe/Inventory observation checks total5 of the same ordinary SKU, with current CheckoutSession Guest/binding authorization inside read-only owner transaction. Actual persisted session retains allocation reference, original submission/payment operation, Cart/Quote and Dining commitment fulfillment reference. One validation, one session create Audit; replay AlreadyCreated identical session and no revalidation; old credential denied. One allocation/session each. This remains observation; Inventory reservation/finalization belong to Order submission.
-7bc216 four affected helpers ESLint pass; format from0f81f7 and7bc216 pass. Sources only test-support: expose existing read/Catalog/Inventory options, preserve and return Dining preparation config, new session helper, same join flow consumes returned commitment before cleanup. No production/schema/dependency/toolchain changes, no full verify/build/install or unchanged API/other-mode regression. Prior historical false branch remains unchanged; historical/API evidence from preceding checkpoint reused. All tests terminal and cleanup completed; same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus uncommitted tree.
-Review: no synthetic validation snapshot or replacement Guest/Cart, no permissive inventory authorization. New scenario deliberately ordinary one-SKU/no-options and asserts that scope before quantity aggregation; does not claim generic mixed-SKU allocation or new production stock policy. Actual owner access revalidates current session/cart before/after and in inventory transaction. Existing synthetic safety/approval/price/tax policies remain explicit; no live Provider/candidate writes, commit/push/deploy.
-Next sourcea712b2/3a1c24/99c1e3: same ApiServerRuntime accepts customerCheckoutSessions runtime options, which create real HTTP writer+reader automatically. Prepare those options before listen with current scope/credentials/binding/transactions, attach actual validate implementation when real Cart/Quote/commitment ready, fail closed before attach. Replace internal first service.create exercise with same-server POST /api/v1/carts/:cart_id/checkout-sessions (201 then200) and GET exact session; preserve actual owner record assertions and old-cookie404. Then Details/Order/Payment consumes actual session. Do not add a different server or label current internal call HTTP acceptance. Runbook updated; goal active/pilot incomplete.

Same-server Entry CheckoutSession HTTP selection: expose shared exact access-options builder from existing allocation helper, build real customerCheckoutSessions runtime options before Dining server listens, and attach real validation only after actual Quote/commitment exist. Replace first internal create with POST201/replay200 and GET200 same safe view on retained join/Cart/Quote server; old cookie POST/GET404, current original owner record preserved, one validation/allocation/create Audit. Fresh current-clock acceptance plus three affected helper lint/format; no production/schema/other consumer changes. No API build/full verify.

Same-server Entry CheckoutSession HTTP checkpoint:
-b3830e current-clock PostgreSQL scenario passes41.634s first run. Same retained Dining join/binding/Cart/Quote ApiServerRuntime now serves actual customerCheckoutSessions writer+reader. First POST201 creates session, replayPOST200 and GET200 return identical safe public view, no-store/no-referrer response headers checked. Rotated old credential POST and GET both404/checkout_session_not_found. Owner recovery returns original actual record; prior matching allocation, submission, payment operation, Cart/Quote/Dining commitment assertions and one validation/one session/Audit remain. No second server or replacement Guest/Cart.
-ec3150 three modified helper ESLint/Prettier pass. Shared access-options builder extracted unchanged from allocation helper and reused by runtime; no production/schema/dependencies/API changes or full verify/build/install/other-mode reruns. Previous scoped API/type/history evidence unchanged/default path applies. Explicit validation attachment occurs after actual owner inputs exist; unavailable-before-attach throws. All tests terminal; cleanup complete.
-Reviewed scope/credential/binding owner sources, runtime injection before listen, public projection equality, immutable internal recovery and denial paths. Audit factory retains exact action/reason and reference scope. No candidate/external/Provider changes, commit/push/deploy. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 with preserved dirty tree; runbook reflects actual HTTP scope.
-Next source951d86: customer-checkout-details.mjs currently creates separate example-origin server and synthetic required-policy source. Reuse its actual createCustomerDiningCheckoutDetailsComposition with current Entry identity/scope/Cart/Quote and retained invalid-origin Dining server; save InSession receipt preference and explicitly synthetic empty policy fixture through real owner stores/HTTP, retain immutable retry/current-identity denial. Do not reuse isolated helper's different server or infer real Store legal-policy approval. Then pass actual session/details to Order/Payment and full long-lived/browser assembly. Goal active/pilot incomplete.

Same-server Entry details selection: attach real Dining CheckoutDetails service to existing join/Cart/Quote/session runtime; use actual checkout session to assert same Cart/Quote and current real Identity. Explicit synthetic empty required-policy source and InSession receipt choice, no live legal approval. HTTP policy/current/save201/replay200/current plus old-cookie denial and owner snapshot/Audit checks. Fresh current-clock acceptance and affected two-helper lint/format only; no production/schema/API build/full verify or unchanged other-mode regression.

Same-server Entry checkout details checkpoint:
-d9bc89 current-clock real PostgreSQL scenario passes43.547s first run. Actual Entry/Cart/Quote/CheckoutSession now feed current Dining CheckoutDetails owner on same retained server. Policy/current views200, initial null details, InSession receipt save201, identical replay200, current version1 and old-cookie save404. Owner recovery AlreadySaved matches actual Guest/Cart/Quote/session; exactly one details record and one save Audit. Response no-store/no-referrer checked.
-37a092 affected details/join helpers ESLint/Prettier pass. No production/schema/dependency changes, no API build/full verify/install or unchanged scenario repetition. Prior current session/Catalog/Inventory checks included in same run; historical false branch unchanged and prior evidence remains. All tests terminal and runtime/database cleanup completed. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted work.
-Reviewed port attachment fail-closed before owner service exists, real current identity/Cart/Quote stores, exact Audit and one-record recovery, no plaintext email/contact in this InSession fixture. Required-policy source remains explicit synthetic empty set and does not accept real legal terms on anyone's behalf. No external/candidate mutation, live Provider, commit/push/deploy. Runbook updated.
-Next sources37a092/1cb60e: createCustomerSessionDiningOrderSubmission bridge reads actual CheckoutSession and binds original submission/payment references. Its underlying CustomerDiningOrderSubmissionOptions needs same preparation/checkout validators, current Catalog+Pricing order snapshot source, actual Ordering repository with Dining link, Details binding and Inventory finalizer. Preserve existing Recipe/stock site from Entry observation rather than creating a different stock setup; configure synthetic Workflow through actual Workflow owner and authorize finalization at locked Ordering boundary. Existing initial fixture example seeds separate stock/Recipe, so do not copy that replacement wholesale. Need return/preserve actual session/details/validation/source options from current helpers for downstream. Full Order/Payment, long-lived Worker/customer+merchant browser and authentic operator/Store/Provider prerequisites remain. Goal active/pilot incomplete.

Entry Order owner-source selection: read actual current Catalog order snapshot and original Pricing history via createCustomerOrderSourceComposition using real CheckoutSession evidence and same Cart; retain actual checkout details. Resolve actual StoreBusinessDate from existing published operating configuration with current publication proof in same owner transaction, not fixture date resolution. Pass existing operating options from Entry to Dining helper; no new order/stock seed or production change. Fresh current-clock acceptance and affected helper lint/format only; subsequent atomic Order/Inventory writing remains required.

20bb87 owner Order snapshots and actual Store business date pass44.474s;92ef90 lint/format passes. Extend current-clock selection to actual session Order submission with same Recipe/stock site, owner-persisted synthetic Workflow, locked current-authorized Inventory finalizer and atomic Ordering/Dining/Details/Event/Audit write. Existing query/write runners both support run (92ef90), no new connection layer. Reuse snapshot source and business-date port. Fresh current-clock case plus affected helper lint; no production/schema or unrelated full regression.

3ed3cf current-clock Order commit fails with ORDER_CREATE_DEPENDENCY_UNAVAILABLE after46.026s; preceding real snapshots/business date pass.63bfea affected helper lint/format passed. Add bounded table/row-count/SQLSTATE and Inventory stage diagnostics to test-only Order runner; no SQL/binds/error payloads. Retry same current-clock case to locate failed atomic dependency; no broader checks.

14b896 bounded diagnostics locate42501 immediately after Workflow publication proof, before final Inventory demand. Source d15e67 shows Recipe final-demand SHARE lock on recipe/recipe_scope_binding/recipe_modifier_version, unlike read-only availability. Existing Entry role has SELECT only; grant UPDATE on exactly these three synthetic fixture tables to permit required SHARE locking. Existing composed submission fixture grants broader Recipe writes; do not copy broad grant or remove lock. Extend diagnostic table matcher to TABLE. Retry failed current-clock scenario and affected helper lint/format only.

927c1d Recipe lock grant resolves42501; actual Inventory final validation and all Order/Event/Details writes now proceed until Cart cleanup. Source6dab40/1db733 identifies real defect: count() requires rowCount===1 but Dining DELETE legitimately removes both participant lines. Ordering-owned bounded fix lets count accept explicit expected count only for this DELETE; all other single-row writes retain default1. Same transaction, scoped WHERE, cleared Cart/version and history remain. Fresh current-clock two-line regression plus existing order-creation-store unit suite, Ordering typecheck and affected lint/format; no schema/dependency/public contract changes or unrelated full regression. aa07f6 helper lint/format passed; production change requires new scoped checks.

Actual Entry -> atomic Order/Inventory checkpoint:
-c98f5d current-clock real PostgreSQL scenario passes52.410s after fixing the genuine multiple-line cleanup bug. Same actual Entry/current Guest/shared Cart/v1 Quote/CheckoutSession/details and published Store business date create one Order containing both participant lines. Same Entry Recipe/stock site and owner-persisted synthetic Workflow drive real Inventory final validation/reservation in the same transaction. Original Dining Order/submission/session references match; replay AlreadyCreated returns identical record, finalizer called once, one Order/details link/final validation/reservation set. No replacement Cart/stock/Guest seed.
-579e00 existing order-creation-store unit suite20 passed;8fcb5b Ordering typecheck plus affected production ESLint/Prettier passed. aa07f6 helper ESLint/Prettier remains valid: helper unchanged afterward. Previous63bfea checkout-session/join helper checks unchanged. Historical profile case intentionally filtered; a36eb2 historical evidence retained because all new calls are currentClock-only and historical branch never submits Order. No install/schema/full verify/other Payment fixture reruns.
-Production diff for this increment is count(result, expected=1) and passing actual cleared line count only at scoped Dining DELETE. Existing writes retain exactly-one requirement; same owner, transaction, version fence, immutable Order/Event/Audit and current authority unchanged. Actual scenario is regression coverage for previously failing two-line submit. Prior dirty production changes preserved.
-Runbook now records service-level Entry->Order continuity and remaining same-server Order HTTP/Payment gap. All selected checks terminal and isolated DB/runtime cleanup completed. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved uncommitted work. No live Provider/configuration, candidate mutation, commit/push/deploy.
-Next verified source3da29c: LocalCustomerRuntime already accepts orderSubmission port (or channelOrderSubmission); attach actual session service to retained Dining runtime using deferred fail-closed port, then POST actual checkout-session reference for create/replay and current-credential denial without replacing any owner facts. Continue same Entry Order into Payment and long-lived process/browser assembly. Goal remains active and full pilot incomplete.

Entry Order -> payment preparation selection: previous turn made actual progress (c98f5d multi-line Order/Inventory regression and bounded production fix). Current sources8c6f74/d6bc95/649e1e show legacy orders HTTP takes Cart/submission IDs; existing session PaymentIntent owns Order/create -> tips -> clock and only accepts session identity. Do not invent a separate session-order HTTP route. Connect actual Entry Order to real session TipSelection and Dining clock store, explicit synthetic zero tip, original operation/submission binding, immutable tip retry/conflict and30-minute clock retry/no renewal, old credential denial. Fresh current-clock DB case and three helper lint/format only; production/type/schema unchanged since8fcb5b. Full same-server Payment HTTP remains next.

7644a0 current-clock reaches real tip save/replay/conflict and actual clock seal; test fails because newly written assertion names nonexistent paymentExpiresAt. Source add120 confirms capacityExpiresAt is canonical30-minute deadline. Correct assertion and explicitly check PaymentPending; retain actual owner behavior. Retry only same failed case;105cb4 all three helper lint/format passed before this one-file assertion correction.

Actual Entry payment preparation checkpoint:
-48d2c3 current-clock PostgreSQL scenario passes61.656s. Real Entry-created Order feeds actual session TipSelection owner: explicit synthetic zero tip Created/retry Existing, exact same record/session and original payment/submission IDs; changed value for same selection rejects. Actual Dining clock owner seals PaymentPending, capacityExpiresAt exactly original paymentRequestedAt+30min; retry returns identical clock, no renewal. Prior rotated cookie rejects both clock and tip. One tip row and two append-only commitment versions. Existing Order/Inventory assertions still pass.
-105cb4 three helper ESLint/Prettier passes;bd8d30 final changed payment-preparation helper lint/format passes after assertion correction. Production unchanged this turn, previous8fcb5b Ordering typecheck and579e00 unit evidence retained. No install/schema/build/full verify or unchanged historical scenario rerun. No live Provider, candidate database mutation, commit/push/deploy.
-Reviewed scope and source: actual session/Order, credentials kept request-local, zero-tip fixture explicitly synthetic, exact Audit action/reason, owner repository and original-clock contract. Runbook updated. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 with preserved dirty tree. All processes terminal and isolated scenario cleaned.
-Next evidence92e637: createCustomerSessionPaymentIntent accepts actual access/orders/tips, current-authorized Inventory final reader, shared Payment repository history, and payment factory with authorization/kill-switch/admitted repository/Provider. Server customerPaymentIntent option already builds safe handler. Need return/preserve entry payment-preparation result and assemble these actual ports on retained Dining server, with explicit synthetic Test Provider only until authentic external inputs exist. Existing submission-inventory-payment helper contains broad denial/fault-injection and alternate fixture server; extract/reuse only appropriate assembly without repeating whole independent journey or replacing Entry identity/stock. Full Entry->Payment, long-lived customer/merchant/Worker and real Store/Provider prerequisites remain; goal active, pilot incomplete.

Entry same-server PaymentIntent selection: actual current-authorized Order/Capacity/Inventory/Workflow admission, existing session Order/tip/clock and Payment persistence on retained Dining server. Synthetic Test Provider normalizes requires_payment_method response; synthetic explicit kill-switch policy, no network/live credentials. POST201/replay200 same durable intent, old credential404, one Provider call/intent/attempt/operation. Fresh current-clock DB scenario plus affected two-helper lint/format; no production/schema/dependency changes, reuse previous type/unit evidence.

7285e5 Entry Payment HTTP returns503 after66.065s; preceding actual Entry/Order/tip/clock assertions pass.323ca7 lint found unqualified fetch, corrected to globalThis.fetch. Add bounded stage/error-code and table/row-count/SQLSTATE diagnostics only, no SQL/values or credentials. Retry failed current-clock case to locate missing assembly dependency.

5db9a2 confirms real session Order/tip/clock and Inventory read succeed; payment service performs second empty history read then503 before claim. No SQL failure recorded. f2b37a affected lint/format passed. Extend bounded diagnostics to actual authorization/kill-switch/audit/repository async ports to locate pre-claim failure; keep clock/references synchronous. Retry same current-clock case only.

36ea7e narrows failure to kill-switch evidence validation. Source fdf78c requires exactFrozenObject for evaluation/control/scope; new fixture scope adaptation had spread into mutable objects, unlike existing submission-inventory-payment adapter. Restore Object.freeze at those three levels, retaining same explicit synthetic policy and strict production validator. Retry current-clock HTTP case; no authority bypass.

1d3271 frozen evidence fix reaches actual claim; current Inventory authorization then denies after Guest read. Sources8ff6db/fb32a9 show configured Dining context uses separate run and table FOR SHARE, while capacity admission already holds FOR UPDATE on same table: nested connection waits on own transaction. Lend the same transaction via existing configured context factory, preserve original registration/policy/current Guest + Dining participation. Add contextsForTransaction from actual Entry configuration through join to Payment-only authorization. No production bypass; original historical context behavior unchanged. Expand helper lint/format to persistent-profile-entry. Retry current-clock case;52315a prior payment helper lint/format passed before this change.

Actual Entry -> same-server PaymentIntent checkpoint:
-e7442d current-clock PostgreSQL case passes68.556s. Actual Entry-created shared Cart/two-line Order/Inventory/Details/CheckoutSession/tip/clock now feed existing session PaymentIntent handler on retained Dining server. HTTP201 created,200 replay with original intent/Order/CAD5650minor total and AlreadyCreated, old cookie404/payment_not_found. Exactly one simulated Test Provider call and one persisted intent/attempt/operation; no duplicate Order/stock. Actual current Order/Capacity/Inventory/published Workflow admission executes before Payment write.
-Provider normalizer receives explicit synthetic Stripe Test requires_payment_method response, no network/real credentials, no captured payment claim. Kill-switch evidence remains explicit synthetic fixture and now correctly frozen. Current Entry configured Dining context is reused inside payment transaction, resolving nested-connection self-lock while retaining actual Guest/current table/participation/registration authorization. No default permissive production policy.
-3cf5fb affected payment/join/persistent-entry helpers ESLint/Prettier pass; no edits after these runs other than docs. Production/schema/dependencies unchanged this turn;8fcb5b/579e00 previous production type/unit evidence retained. Historical false path only refactors original identical context options and adds unused transaction factory; original scenario behavior unchanged, prior historical evidence retained. No install/build/full verify/unchanged Payment suite reruns.
-Reviewed same actual owner references and scope, shared transaction, current authorization, integer amount, original clock, bounded diagnostic metadata, safe HTTP projection and isolated cleanup. All processes terminal. Runbook now records Entry->PaymentIntent, not Entry->captured payment or runnable long-lived pilot. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree; no commit/push/deploy/external/candidate changes.
-Next source2e15a0: existing customerPaymentHandoff runtime requires same checkout access/history, Payment transaction runner, per-session actual admission, explicit allowConfirmation, actual client-handoff Provider adapter. Preserve/return current payment admission/store/options and attach same-server handoff plus result using synthetic Provider transport until real external facts supplied. Then consume actual durable outcomes into acceptance/kitchen/receipt/refund and complete long-lived assembly/browser. Full pilot remains incomplete; goal active.

Entry same-server payment handoff selection: previous turn e7442d made actual progress through PaymentIntent HTTP. Use actual persisted Entry operation/history and same current Order/Capacity/Inventory/Workflow admission/transaction for existing handoff runtime. Explicit synthetic Test Stripe transport and confirmation policy only; no network/real credentials. Require safe no-store/no-referrer200 with synthetic client secret only, rotated cookie404 and current confirmation denial422 without another Provider credential retrieval, unchanged durable Payment history and no client secret persistence. Fresh current-clock case plus affected3-helper lint/format; no production/schema/dependency changes or unrelated regression.

f5a297 current-clock Entry handoff passes71.454s first run;6217d2 affected helper lint/format passes. Extend same-server selection to actual Payment result reader and terminal owner: Pending initially and after normalized synthetic capture observation, Succeeded only after actual terminal/Event/Audit commit, replay AlreadyCommitted/no duplicate terminal, old cookie404. Existing actual Payment intent and observed Provider reference reused; synthetic Test Provider account/capture explicitly fixture-only, no live capture. Fresh current-clock case and new result/join lint/format; unchanged handoff/payment helpers reuse6217d2.

5351ba actual synthetic capture observation persists and result correctly remains Pending; terminal service commits successfully but new assertion incorrectly expected Committed instead of returned Created. Correct assertion to observed contract, retain AlreadyCommitted retry contract verified existing8aaba5. Retry failed current-clock case to finish result/denial checks.36a800 affected result/join lint/format passed before one assertion correction.

Actual Entry -> handoff and committed Payment result checkpoint:
-afca8c current-clock PostgreSQL journey passes79.103s. Same retained Dining server serves actual Entry PaymentIntent handoff with real current owner admission; synthetic Test Stripe retrieval returns safe secret-only response, no-store/no-referrer. Old credential404 and synthetic current confirmation policy denial422 prevent extra Provider fetch; actual Payment record unchanged, no secret persisted. f5a297 independently established handoff before result extension.
-Actual Entry intent's normalized synthetic capture is recorded through ProviderObservation owner; result remains Pending until actual PaymentTerminal source/service/repository commits fact, Event and Audit. First terminal Created, retry AlreadyCommitted, same-server result Succeeded matches original Order and CAD5650minor total, old cookie404, one terminal fact. No live capture/Provider network/real payment account claim.
-6217d2 handoff/payment/join helpers lint/format passed;36a800 result/join lint/format passed and03c8bd final result helper lint/format passed after correcting assertion. Unchanged prior production type/unit, installation and schema evidence retained. Historical scenario filtered because only currentClock branch invokes new helpers; no full verify/build/unchanged suites. All handles terminal and runtime/isolated DB cleaned.
-Reviewed exact stored operation/attempt/order bindings, real current admission, explicit fixture confirmation/Provider boundaries, no client-secret assertion payload or durable retention, original deadline and terminal idempotence. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 with preserved dirty tree; no candidate/external/commit/push/deploy.
-Next source03c8bd: captured-order-kitchen helper consumes actual order/payment event/context and published payment workflow, but its isolated merchant authorization/session are synthetic and must stay labeled. Carry exerciseEntryDiningResult's committed fact/event and terminalScope into actual Order paid context/outcome and merchant acceptance/kitchen on the same Entry order; preserve both participant lines. Then receipts/refunds, Pickup continuity, long-lived Customer/Merchant/Worker and actual browser acceptance; external operator/Store/Provider prerequisites remain. Runbook updated; full pilot incomplete and goal active.

Entry captured Order -> acceptance/kitchen selection: previous afca8c verified actual terminalEvent from same Entry order. Compose actual OrderPaidContextSource with exact scoped synthetic internal event/resource authority, original Payment terminalScope, real capacity/current Inventory; assert both original participant item snapshots and Submitted phase. Feed existing captured-order-kitchen owner chain with same Order/Event/published Workflow, preserving its explicit synthetic merchant session/permissions. No replacement Order/Inventory seeds. Fresh current-clock journey is named cross-domain milestone Entry->terminal->acceptance->kitchen, plus new helper/join lint/format. Existing old-fixture complete tests not rerun; production/schema unchanged. Adapt only concrete fixture assumptions revealed by real multi-line source.

527a57 current paid context assertions pass with both real item snapshots; merchant queue fails through Dining item-state reader.3953ea source explicitly LEFT JOINs additional_dining_batch_record, which Entry role lacks (old composed fixture grants it). Add that scoped SELECT and bounded SQLSTATE/table/row diagnostics for any later chain failure, without query/bind/error text.2f0237 initial helper/join lint/format passed. Retry same cross-domain current-clock milestone.

2efc74 merchant queue/acceptance/payment outcome confirmation progress past prior permission issue, fail at RecipePreparationContent publication.436316 proves Entry's original cart Recipe seeded versions directly with no Publish operation/evidence; kitchen store correctly requires parseRecipePublicationEvidence from actual operation history. Replace Dining Entry initialization with actual Recipe CreateDraft/Publish over original Recipe/version/ingredients and same stock, using explicit synthetic review/ingredient/Brand authority. Shared cart recipe helper accepts optional publisher; default Pickup/direct fixture unchanged. New Entry publisher writes actual owner Audit/Event/history, not fabricated success or replacement kitchen Recipe. Fresh current-clock full journey plus affected4 helper lint/format. Historical Dining Entry also uses real publisher (historical recipe inputs unchanged except valid Publish version2); historical check required once current integration stabilized because this changes its initialization path.

Actual Entry -> merchant acceptance -> Kitchen Ready checkpoint:
-d54374 current-clock cross-domain PostgreSQL journey passes79.376s. Same Entry two-participant Order/terminal event/current Inventory/Dining capacity resolve through actual paid context; both immutable item snapshots preserved. Existing merchant queue and authenticated acceptance service runs with explicit synthetic merchant fixture, original workflow resolves acceptance, Order confirmation/event recovery proceeds and Kitchen routing/recipe intake generates actual work items. All items Accept/Start/Complete to Ready; per-item readiness publication and duplicate/race assertions pass. This is owner/service/DB composition, not a long-lived merchant/browser acceptance.
-Entry Cart Recipe initialization now uses actual owner CreateDraft/Publish with original ingredients/version identity and synthetic reviewed authority. Original raw seed lacked Publish operation evidence and Kitchen correctly rejected it. New optional publisher on shared seed preserves default raw setup for other callers; only Dining Entry opts in. Actual stock and Recipe are reused from Cart through Inventory finalization and Kitchen. No retroactive history insertion or permissive kitchen validation.
-d344f3 affected historical profile/timing scenario passes38.539s after shared Dining initialization change; current-clock case filtered, not rerun. ce18d0 new Recipe publisher/shared seed/Dining cart/kitchen wrapper ESLint/Prettier pass; prior2f0237 join lint/format unchanged after last run. No production/schema/dependency changes; previous production type/unit and valid installation evidence retained, no full verify/build/unchanged other-mode suites.
-Reviewed default seed control flow, original Recipe and stock identity, explicit external review/merchant fixtures, narrowly added additional-batch SELECT for current merchant queue, integer quantities, preserved scopes, bounded diagnostics, all runtime/isolated DB cleanup. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 with preserved uncommitted work. No candidate/external/commit/push/deploy. Runbook updated.
-Next source7957a1: dining-customer-status existing helper needs persistent Worker connections.acquire (current Entry runner exposes run only), actual Order-created projection and registered consumer services. Add proper retained connection/transaction capability rather than replacing durable outbox delivery with direct fabricated projection. Need same Entry Order through worker/customer status, serving/receipt/refund, Pickup continuity and actual long-lived Customer/Merchant/Worker/browser. Keep synthetic transport/policies distinct from authentic Store/Provider inputs; full pilot incomplete, goal active.

Entry durable Worker selection: previous d54374/d344f3 made actual progress through same Order acceptance/Kitchen Ready and historical regression. Add restricted-role retained connection acquire to current-clock test only, retain finite timeouts/idempotent release and assert zero remaining worker connections. Pass capability through Entry/join and invoke existing persistent Dining Worker with real OrderCreated projection and actual PaymentSucceeded status consumer for this Entry event. Verify status absent before delivery, persisted afterward and one Payment status inbox. Actual outbox delivery, no direct synthetic projection writes. Fresh current-clock journey plus affected4-file lint/format; historical acquire remains unused, no production/schema/install/build or unrelated repeat.

c93d14 actual Worker starts/stops but targeted source events do not publish within bounded dispatch; no healthy completion claim.701657 affected4-file lint/format passed. Add safe acquire SQLSTATE/table failure diagnostics and targeted event-type/published/count/error-code snapshot on failure, no bind values/IDs/credentials. Retry same failed current-clock scenario to distinguish permission, consumer failure or scheduling; do not lengthen wait or restart a live Worker blindly.

d050f3 shows PaymentSucceeded published once, OrderCreated attempted4 times but unpublished; no SQLSTATE failures. Narrow diagnostic to optional OrderCreated consumer failure observer (safe code and source basename/line only, no message/values). Existing shared helper behavior unchanged when absent. Retry affected milestone to locate source/projection rejection; d3334e current helper lint/format passed before change.

383c04 observer locates source.loadExact failure at order-created-event-consumer-service:92 before freshness/write, not delivery infrastructure. Add explicit pure OrderStatusCreationSource check against actual owner-loaded OrderCreated envelope and original Order; failure emits only binding equality booleans/error code/source lines. This narrows invalid source vs persisted read and fails before Worker retry loop. c4e78c observer helpers lint/format pass. Retry affected current-clock only.

9aac19 newly added diagnostic omitted explicit transaction scope before loadOutboxEnvelope (source148eea requires current Brand/Store); scoped owner query returnednull. Correct diagnostic transaction set_config and assert event exists. No production or Worker behavior change; original source failure still unresolved. Retry same case; this diagnostic failure is not business evidence.

ba8840 pure original OrderCreated source check passes; Worker persisted source still rejects. Source9b9262/3b333b identifies exact Brand/Store scope contract in OrderCreationQueryStore, while new Entry wrapper passed an extra Tenant field. Existing successful caller narrows scope. Correct only wrapper scope; preserve production exact-shape validation. Fresh current-clock milestone plus final affected helper lint/format; no unrelated regression.

Entry durable Worker checkpoint:659d35 current-clock PostgreSQL journey passes83.423s. Real Entry two-participant Order flows through terminal payment, merchant acceptance/Kitchen Ready and retained-connection Worker. Original OrderCreated and PaymentSucceeded outbox events publish; actual Payment status is absent before delivery, persisted afterward with exactly one status consumer inbox. Runtime stops and retained connections reach zero. This does not prove customer status HTTP freshness or a long-lived runtime. OrderCreated consumption may mark original creation stale after later Order transitions; do not claim current Order projection from publication alone.
938563 affected entry-dining-worker ESLint/Prettier passes. Scope fix only narrows new wrapper to exact Brand/Store public contract; production validation unchanged. Reviewed synthetic authority labels, original event bindings, bounded no-value diagnostics and cleanup. Reused701657 pass-through/test harness and c4e78c optional observer checks; those inputs unchanged. No full verify/install/build, schema/dependency change or candidate/external/commit/push/deploy. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree.
Next: compose current customer status HTTP on same Entry server using current Order execution and Payment status; original OrderCreated projection alone is insufficient after confirmation/Kitchen transitions. Then same-order serving/receipt/refund, Pickup Entry continuity and long-lived Customer/Merchant/Worker/browser acceptance. Owner multi-batch/refund/Docker authorizations remain accepted. Goal active, full pilot incomplete.

Same Entry customer status HTTP selection: previous659d35 Worker checkpoint is progress. Add existing production customerOrderStatus port to retained Dining server using same Guest access and actual Payment terminal scope attached before read. Verify original two item identities, real Kitchen Ready and Payment Succeeded amount5650, no-store/no-referrer, old rotated cookie and invalid CSRF denied. No synthetic projection writes. Fresh current-clock journey and affected2 helper lint/format; production/schema unchanged, historical route omitted. Current canonical phase/freshness must be assessed separately, not inferred from event publication.

4862b4 status route returns200 with correct original Order/type and no-store/no-referrer; new assertion incorrectly used nested orderItem instead of owner item.orderItemReference. Fix test member access using sourcecc3bb4; qualify globalThis.fetch for existing ESLint environment. No production change. Retry failed current-clock case and affected lint/format only.

Same-server Entry customer status checkpoint:6a3cc8 current-clock journey passes79.492s. Existing production customerOrderStatus route on retained Dining server reads original Order and both original participant items, actual persisted Kitchen Ready and Payment Succeeded5650minor via original current Guest credentials. no-store/no-referrer and rotated old cookie/invalid CSRF404 assertions pass. Payment scope attached from actual terminal result; no replacement projection seeded. Historical case filtered because status setup is currentClock-only.
37472b ESLint passed, formatting initially failed;6d4989 applied formatting;45ddd5 final new helper lint/format pass. Join unchanged since37472b lint and initial formatting. Reviewed exact Order/item identity, scope binding, safe serialized assertions, credentials only in headers, runtime cleanup. Reuse previous unchanged production/schema/install checks; no full verify/build. Prior4862b4 failure was a test field-access error, not a route failure.
Sourcec03895 confirms original OrderCreated source fixes canonicalPhase Submitted and consumer separately marks freshness from current execution. New status assertions intentionally do not claim current aggregate phase/freshness or served quantities. Next must connect current order execution/delivery evolution instead of relying on original creation snapshot; receipt/refund and long-lived app/browser gates remain. Goal active, no external/commit/push/deploy.

Entry serving selection: prior6a3cc8 is progress. Enable existing customer status diningScope and actual Dining item-service reader; persist serving through existing merchant composition using original Order items, commitment table/session versions and real Kitchen preparation. Explicit synthetic merchant capability only; no fabricated readiness/service rows. Verify zero->per-item quantities->derived Fulfilled, replay and overserving rejection, same HTTP read after each write. Fresh current-clock milestone plus affected3 helper lint/format; production/schema unchanged, historical scope omitted. Real observedAt must follow Kitchen timestamps; do not advance or bypass production clock checks.

49dcee new Dining status source returns503 before serving. Existing pass did not enable Dining source. Add direct actual delivery-owner preflight with bounded source frames/table SQLSTATE only to identify source failure; no raw errors/SQL/values.04001d affected3 helpers ESLint passed after formatting. Retry current-clock only; retain production time/scope/permission checks.

4e7bb3 preflight pinpoints dining-order-preparation-progress:36 future Kitchen updatedAt rejection, no SQL failures. Sourcea61fe4/e8c898 shows shared Kitchen test advanced ticket.createdAt+seconds per operation. Pass optional kitchenNow from current Entry wrapper through existing helpers; current scenario uses wall clock, defaults preserve historical simulated timestamps. Do not wait artificially or alter production observedAt. Fresh current-clock and seven affected helper lint/format; unchanged other-mode defaults reviewed, no unrelated rerun.

Entry serving checkpoint:d8cf64 current-clock PostgreSQL journey passes83.562s. Same original two-participant Order now reads zero served quantities through customer HTTP, commits each item's full ordered quantity through actual merchant Dining service composition and Audit, replays as AlreadyCommitted, and rejects one extra quantity. After each write same-server customer status returns exact served quantity for that item while unserved sibling remains0. Final actual Ordering/Kitchen/Dining delivery composition derives Fulfilled with all remaining quantities0. This is service/DB composition with explicit synthetic merchant authority, not actual Merchant HTTP/browser or formal Order/session closure.
Future-time failure corrected only in current Entry Kitchen fixture: optional kitchenNow wall clock passes through captured-order-kitchen/kitchen-ticket-creation/kitchen-paid-lifecycle; historical defaults still use prior simulated timeline. Production future-fact rejection unchanged.8ee0a2 reviewed parameter scope/defaults and call order. e80884 seven affected helpers ESLint passes and six touched helpers format pass; status helper formatting unchanged from45ddd5. No production/schema/dependency changes, reinstall/full verify/build or unrelated historical test repeats. Existing source initialization/historical evidence remains valid because new serving and kitchenNow entry are currentClock-only. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 with preserved dirty tree. Runtime and isolated DB cleanup completed; no candidate/external/commit/push/deploy.
Next: same Entry receipt/refund, current status phase presentation sourced from derived progress (original canonical creation snapshot is not an updated closure claim), authentic Merchant route and long-lived runtime/browser. Existing paid/served does not itself close shared Dining session or release table. Pickup Entry continuity and external operator/Store/Provider gates remain; goal active and pilot incomplete.

Entry original receipt selection: previousd8cf64 serving milestone is progress. Add existing customerReceipt port to same retained Dining server and reuse actual receipt issuance/template/HTTP helper on original Order, terminal payment and selected tip. Grant only actual compensation/ordinary-request read coverage. Issuer legal facts/template approver remain explicit synthetic fixtures. Verify concurrent original issuance/replay, actual payment/refund coverage, immutable history and current Guest read/denials using existing helper. Fresh current-clock scenario plus new wrapper/join lint/format; production/schema unchanged, other-mode helpers unchanged. No genuine issuer/Provider readiness claim.

Entry original receipt checkpoint:9d4ec7 current-clock PostgreSQL journey passes84.263s. Same retained Dining server exposes existing customerReceipt with original Guest access. After original Order/payment/Kitchen/serving, actual OriginalReceiptIssuance resolves real Order items, terminal payment amount/tip, ordinary-refund empty history and compensation history, actual template Publication/owner proof and issuer assignments. Existing helper proves invalid sources/revoked authority reject, concurrent issuance one Created/one Existing, exactly one identity/Audit allocation, FK/item fences, replay after changed template, customer read original amount/tip, private-field omission, wrong CSRF/Order denial and no rewrite on retrieval. Issuer legal facts/template approver remain explicit synthetic fixtures; no real external issuer approval. Receipt freshness is Stale and delivery Unavailable as existing reader declares, not hidden as fresh/sent.
fe0376 affected wrapper/join ESLint and Prettier pass. Sourcebb8f01 confirms fact.amount (not event payload representation) used for exact BigInt comparison; selected tip remains original. Reviewed currentClock-only route/call, actual terminal scope, minimal added refund SELECT, bounded errors, same-runtime cleanup. No changes to shared receipt helper, production/schema/dependencies or full verify/install/build. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus dirty tree. No candidate/external/commit/push/deploy.
Next: same Entry ordinary refund request/actual Provider test dispatch/recovery and append-only refund receipt. Existing exerciseCustomerReceiptRead accepts ordinaryRefundFixture but current call has none; do not claim refunded receipt evidence for this Entry Order yet. Then authentic Merchant routes, current phase presentation, Pickup Entry continuity and long-lived Customer/Merchant/Worker/browser. Goal active, complete pilot not achieved.

Same Entry ordinary refund selection: prior9d4ec7 is progress. Retain actual PaymentIntent record and normalized captured observation from existing result helper; feed existing ordinary refund capture/pricing/authority/dispatch/recovery helper into existing original/refund receipt journey. Actual original Order/two items/quote allocation5650 and terminal identity; provider adapter transport remains injected synthetic Test response, no network refund. Existing helper verifies pending->completed append-only receipts and original preservation. New affected result/receipt helper lint/format plus current-clock journey; no production/schema/dependency or other-mode change. Full merchant/runtime/browser remains separate.

2cc2f6 real refund request commits, pending receipt fails with SQLSTATE42501 on ordinary_refund_operation: new Entry role lacks read permission before later dispatch grants. Add specific SELECT. Existing concurrent pending receipt Promise.all lets losing transaction outlive first rejection and DB cleanup produced unhandled connection termination; replace receipt helper concurrent groups with settled drain (same pattern as ordinary-refund-capture), preserving rejection and success assertions. Fresh current-clock plus shared receipt/wrapper lint/format.7f5fc7 previous result/wrapper checks passed; no production changes.

0c867c pending receipt still42501, but no unhandled cleanup error after drain fix. Source1b6ed8 confirms operation query JOINs ordinary_refund_dispatch; diagnostic names first table only. Add dispatch SELECT required by actual joined query.60eefa shared helper/wrapper lint/format passes. Retry same failed current-clock milestone; no expanded business scope.

b06ba0 passes pending refund receipt, then old refund helper seed collides with existing Entry Store configuration at ordinary-refund-store-publication:94. Sourcea0163b/2058e0 shows original Entry already uses published operating config. Add optional existing storePublication to shared refund helper, preserving old default initialization; Entry passes actual operating options and production createMerchantOrdinaryRefundBusinessDate over same published records. No duplicate/replacement config. b421f4 last wrapper lint/format passes. Fresh current-clock plus affected3 helper lint/format; other fixtures retain default path.

Same Entry ordinary refund checkpoint:633469 current-clock PostgreSQL journey passes89.794s with no unhandled errors. Original Entry two-line Order/ordinary quote/payment feed actual full refund allocation5650minor and request persistence. Existing original/refund receipt helper reads pending claim then executes actual permission/session/approval/dispatch/observation/reconciliation services under explicit synthetic workforce and injected Stripe Test transport. It exercises send outcome commit failure and recovery without an additional refund send. Same customer server returns3 immutable receipt records: Original, RefundPending (refunded0), Refunded (refunded original total); prior records preserved, repeated issuance Existing, retrieval no write. Original Store business date/publication is reused, no second config inserted. This is not real Provider network payment/refund or full browser/long-lived runtime.
7113a7 affected3 helper ESLint and formatted output pass;60eefa shared customer-receipt-read drain helper lint/format and7f5fc7 result-return lint/format reused unchanged. b421f4 superseded wrapper check retained as earlier evidence. Shared storePublication option defaults to original seed for other callers; Entry supplies actual existing source. Reviewed Promise.allSettled drain preserves first failure and all success assertions, joined operation/dispatch SELECT permissions, synthetic labels and safe diagnostics. Runtime/isolated DB cleanup completes. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree, no production/schema/dependency change, full verify/install/build or external/commit/push/deploy.
Next move these owner compositions toward real long-lived process wiring and browser journeys, preserving the current Entry same-order evidence rather than recreating seed-only orders. Remaining: initial QR Entry currently separate server; current aggregate status presentation, authenticated merchant serving, additional batches under actual Entry, Pickup Entry continuity, executable Customer/Merchant/Worker composition and pilot operator/Store/Provider inputs. Receipt freshness/delivery still Stale/Unavailable. Goal active, no full pilot claim.

Single-server Entry assembly selection: previous633469 refund checkpoint is progress. Source6daf54/d96eea confirms actual process configuration remains health-only;003390 merchant runtime already exposes serve/refund ports, so do not add duplicate API abstractions. Concrete gap in current composed journey: paying second Guest QR Entry uses separate initial server. Retain actual persistent Entry options and install same owner composition on Dining server; second Guest must POST QR Entry to that server before binding/Cart/Quote/Order/payment/Kitchen/serve/receipt/refund. Historical scenario retains separate server path; first Guest/initial administration stays existing setup. Fresh current-clock integration plus affected2 helper lint/format. No production/schema/dependency change, no claim of configured long-lived pilot process.

Single-server paying Guest checkpoint:c8ec22 current-clock PostgreSQL journey passes89.547s. Paying second Guest now posts signed QR Entry to the same retained Dining API server that handles join/binding/Cart/Quote/checkout/payment/handoff/result/status/receipt; original Entry persistent QR/Store/session/admission composition reused, no fallback to separate first server. Existing original Order kitchen/serve/refund path still passes with actual owner persistence and explicit external fixtures. First participant/bootstrap and initial Pickup setup still use first runtime; this is bounded process composition, not a long-lived candidate/browser acceptance.
863f3c affected2 helper ESLint/Prettier pass. Reviewed runtimeOptions extraction preserves initial runtime inputs, new route only currentClock, request explicit target defaults historical path unchanged, shared references/session policies and both runtimes cleanup. No production/schema/dependency change, no unrelated suites/build/install. Existing historical evidence valid because optional customerEntry absent and request uses unchanged default. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus dirty tree. No candidate/external/commit/push/deploy.
Actual startup investigation: process loader accepts trusted configuration modules, local supervisor already forwards API/Worker paths. Merchant runtime already supports queue/acceptance/serving/refund; avoid redundant adapter interfaces. Ignored pilot-v2/api.mjs still health-only; pilot-v3 has connection/provision modules but no api.mjs. Production owner compositions exist but concrete business configuration and fresh candidate catalog/initialization are unresolved. Next consolidate runtime configuration inputs from real owners; cannot call health-only process a pilot. Keep Pickup continuity, current status phase, additional batches and browser/operator/Provider gates in scope. Goal active.

Customer progress presentation selection: previousc8ec22 is progress. CUST-ORDER-STATUS registry3097, Section88.6/source21592 and source20164 require exact authorized Guest status/Batch/Kitchen/Fulfillment, refresh/receipt/support, no reference-only access. Existing heading incorrectly stays Order submitted after actual Ready/served sources. Behavior-only correction within existing section/layout; no Figma visual redesign, route, action, permission, field or API change. Use already parsed complete Dining item membership to show partial/all listed items served; use complete Kitchen batch coverage for preparation-ready; never infer Pickup collection, financial closure or table/session closure. Preserve stale/offline/error/recovery/accessibility markup and individual payment caveats. Fresh PWA status page/controller tests, directly affected lint/format, PWA typecheck/build; no database/business suites because no source/contract/persistence change.

Presentation evidence:d9d27a status page24+controller32 tests pass;5e33a4 PWA typecheck/build passes (existing Vite inlineDynamicImports deprecation warning).81d6ed caught forbidden test non-null assertion, corrected to explicit guard;8d01df final2file lint/format pass. Existing production order-status HTTP browser scenario already covers stale response crossing navigation and partial Dining serving. Add two heading assertions there and run only this existing spec/project for real rendered App behavior; transport remains explicit synthetic. This is justified consumer rendering coverage, not complete database/browser pilot. No business suite repeated.

Customer progress presentation checkpoint: CUST-ORDER-STATUS now uses validated current Kitchen/Dining sources for Preparing your order, Kitchen preparation complete, Serving your order and Items served. Every listed item must match batch/item and full served quantity before all-served text; an unserved added batch prevents it. Explicit cancelled/rejected projection facts supersede normal progress. Pickup collection still requires Completed fulfillment; kitchen readiness alone retains pickup proof action and never claims collection. Existing stale/offline warnings and payment/refund caveats remain; no financial/table/session closure inference.
Fresh d9d27a status page24/controller32 tests pass;5e33a4 PWA typecheck/build pass. Guard-only test correction resolved lint81d6ed with8d01df; no runtime change after unit/build.1b5864 existing production App HTTP browser scenario passes1/1 in6s, including new Preparing/Serving heading assertions, multi-batch partial delivery, navigation stale-response isolation, revoked access clearing and no private storage. Transport synthetic; not full DB/browser pilot.5616c6 final browser spec lint/format and focused summary review pass. Test harness rebuilt its own preview as required; no manual repeat/build loop. Existing Vite inlineDynamicImports deprecation warning unchanged.
Final review: behavior-only existing semantic section/heading and text, no CSS/layout/Figma/API/schema/auth changes or new action. Derived displayed progress never writes owner lifecycle. Preserved existing unrelated edits. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus dirty tree. No database/business suites, dependency installation, full regression, external/commit/push/deploy. Accepted shared install/toolchain evidence unchanged. Goal active: same-server persisted Dining evidence plus bounded browser UI proof still require actual long-lived assembly, Pickup continuation, merchant/operator/Provider configuration and full browser journey.

Persistent customer browser selection: previous UI checkpoint is progress. Add opt-in BOP_ENTRY_BROWSER=1 to current-clock journey after actual serve/refund. Use ephemeral HTTPS Vite production App entry, original API proxy and actual already-issued Guest cookie/CSRF restored in memory; no route interception or fabricated status/receipt response. Prove browser Items served, both quantities, original payment and3 actual receipts, no private web storage and access-clearing after cookie removal. This is resumed session read continuity, not browser-originated checkout or real Provider. Fresh command BOP_ENTRY_BROWSER=1 pnpm exec vitest run --config packages/database/vitest.public-store-profile.config.ts -t current-clock; affected helper lint/format. No UI production/source change or rebuild/typecheck rerun. All ephemeral browser/TLS/server resources close in finally.

cc7240 browser startup reaches real App, but Vitest rewrites dynamic import inside serialized page.evaluate callback to server-only helper. Move browser module import into an explicit browser expression; restore CSRF through one transient setter then delete it before navigation, no business response interception. Source18bda7 receipt page has no Refresh receipt button; use existing Back to order status and browser Back after replacing cookie with syntactically valid unauthorized value, then assert both routes deny/clear. da3f29 helper lint passes after browser globals fix. Retry same opt-in milestone; no production change.

b8e3df actual browser remains Loading;93e8bd shows React development StrictMode cleanup calls controller.dispose (permanent stopped=true), then same controller load cannot restart. Fix explicit load to reactivate and fence old async load/subscription callbacks with lifecycle generation; refresh alone remains stopped. Add focused remount/late-response/old-callback tests. Production PWA behavior affected: fresh controller/page units, typecheck/build, lint/format plus retry opt-in real DB/browser milestone. No disabling StrictMode or faking browser data.

381a6e opt-in browser retry failed before browser at tip selection replay: CheckoutSession PERMISSION_DENIED after51.317s. No browser pass. Prior2ac2bc58unit,85f24e typecheck and23f64c lint/format/build cover unchanged controller fix. Investigate application/DB strict clock authority boundary: test-only transaction wrapper records numeric clock deltas only on permission failure, no SQL/binds/credentials or production bypass. Fresh same current-clock opt-in milestone after diagnostic addition; affected helper lint/format. Docker read-only info924336 reports29.1.3; no restart needed. Multi-batch/refund approvals retained.

fdddf5 actual DB/browser reaches Items served, payment56.50, both item quantities and all3 receipts; fails only unauthorized heading expectation. Actual API404 intentionally maps to Order not found, confirmed2fcafc client/page sources; Receipt404 similarly maps Receipt not found. Correct helper expectations, preserve production privacy semantics and assert private receipt cleared. StrictMode fix now evidenced in real App. Clock failure381a6e not reproduced; diagnostic retains bounded deltas for recurrence, no clock/authority bypass. b24206 diagnostic helper format/lint passed. Fresh same opt-in milestone after assertion correction; helper lint/format only, reuse unchanged production unit/type/build.

Persistent resumed-browser checkpoint:993c1e BOP_ENTRY_BROWSER=1 pnpm exec vitest run --config packages/database/vitest.public-store-profile.config.ts -t current-clock passes93.859s,1 current-clock passed/1 historical intentionally filtered. Actual persistent Entry/Cart/Quote/Order/payment/Kitchen/serve/refund chain feeds real HTTPS App through same API, no browser response mocks. Browser shows Items served,2of2/3of3, paymentCAD56.50 and3 immutable original/pending/refunded receipts; unauthorized cookie renders Order not found and Receipt not found and clears original receipt. No local/session storage. Ephemeral browser/server/TLS and isolated DB cleanup complete. Session restored in memory; checkout not performed through browser and provider/workforce/issuer inputs remain explicit fixtures.
Controller StrictMode remount fix reviewed: explicit load restarts lifecycle, disposed refresh stays stopped, old request/subscription callbacks fenced; 2ac2bc58tests,85f24e typecheck,23f64c build/lint/format reused with unchanged inputs.311188 browser helper lint passed; formatter complained after shorter heading strings,ca1ef9 applied formatting before successful run. b24206 diagnostic helper lint/format pass. 381a6e intermittent clock permission failure remains unexplained/not reproduced in next2 runs; bounded test-only numeric diagnostic retained for recurrence, no production clock or permission relaxation. Do not claim that intermittent issue resolved.
Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree; no schema/dependency/install/full verification/commit/push/deploy. Goal remains active: complete long-lived configured app, browser-originated checkout, actual merchant/operator actions, additional batch and Pickup continuity, and explicit real Store/Provider gates remain. This checkpoint is progress, not pilot completion.

Long-lived candidate continuation: prior993c1e is progress, not assembled pilot. Current ff0314 confirms v2 API only health; v3 has no API module and recorded out-of-order catalog prevents correct incremental migration. Preserve v2/v3; create isolated local-only pilot-v4 Compose project/volume on55435 with newly generated protected local credential, no copied business/approval facts. Use existing db:migrate apply confirmed local target, then verify exact catalog. This is initialization, not migration behavior change or workaround baseline/repair. Selection: fresh candidate must have full182 migration catalog including earlier Brand artifact; actual apply/verify only, no unchanged migration unit suites, reinstall or whole verify. Store/operator/Provider inputs requested asynchronously; continue technical assembly without inventing them.

Fresh persistent candidate checkpoint:1149c5 existing pnpm db:migrate apply reports state=current applied182 pending0 for local:bop_rms_wp2402_pilot_v4;0d1bc1 db:migrate verify confirms exact catalog. Docker isolated project bop-rms-wp2402-pilot-v4 remains healthy on loopback55435 with its own preserved volume; v2/v3 unmodified. Newly generated ignored mode0600 credentials; API/Worker roles verified login with superuser/bypassRLS/createDB/createRole/replication/inherit disabled and no ungranted Order access. Reused v3 connection/role script implementation with explicit v4 target/port/path replacement; actual role execution passed, no arbitrary broad business grants.
Runtime files are ignored .local/pilot-v4/{environment.env,connections.mjs,provision-application-roles.mjs}; no business facts/registrations/QR/Store/Provider authorities copied or invented. Candidate currently schema and restricted connections only, no api.mjs/worker.mjs or operating configuration; cannot call it usable app. User asked asynchronously for actual Store/menu/tax/table/operator/Provider sources; technical composition can continue. Old candidate migration conflict not repaired/bypassed. No migration source/package/toolchain changes or unnecessary unchanged suites. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing dirty work. Goal active.

Persistent QR verifier selection:26e658/aa7b70/baee9c show real ES256 verification exists only inside API test fixture; Dining exports a verifier port but no production infrastructure adapter. Implement Node crypto public-key resolver adapter under Dining infrastructure, pin ES256/EC prime256v1 and64-byte IEEE-P1363 signature, bounded compact signing input, snapshot request before async key lookup, fail closed on missing/wrong/private/error keys. Existing service remains authority for key registry validity/compromise/revocation, QR context/Store lifecycle and lifetime. No hardcoded key/approval/abuse policy. Adopt actual adapter in existing fixture so existing Entry integration uses reusable production crypto. Fresh targeted crypto+QR service tests, API composition test, Dining type/build/API type, affected lint/format/import boundary; then single current-clock persisted Entry/browser milestone because authentication dependency changed. No unrelated suites or migrations.

QR validation inventory:1ffa3d root invocation found no files because Dining config expects workspace-relative src; corrected to pnpm --filter @rms/dining exec vitest ... .689698 crypto6+QR54 tests pass.740286 build identified only implicit input type at Object.freeze contextual boundary; add explicit existing-port parameter type, no runtime change. API composition test handle28510 continues, not restarted. Repeat failed build then outstanding API type/lint/import checks, then actual persisted current-clock/browser once.

Production QR crypto checkpoint: createQrSignatureVerifier exported from Dining infrastructure accepts only server-resolved public EC P-256 keys, ES256 and64-byte IEEE-P1363 signatures. Input cap1961 follows2048 compact token minus dot/86-character signature; framing bounded before key lookup. Copy signature before await, no cached key across requests, no logging/network/private-key conversion. Existing QR service remains sole registry validity/compromise/registration/context authority. API Entry fixture now uses this actual implementation with explicit ephemeral synthetic public-key resolver rather than fixture-only crypto.
Fresh6896986crypto+54QR tests,45584642API composition tests,dbd2d0/7dcb13 Dining build/API type/affected lint/import check22tests+validator pass;9c11d0 final4file format and source review pass. af3e4a current-clock actual persisted Entry-to-order/payment/serve/refund/HTTPSbrowser milestone passes107.032s; one historical test intentionally filtered. This proves compatibility through actual signature verification and owner data/browser, not live QR registry/Provider or long-lived candidate activation. Existing PWA tests/build unchanged and reused; no full regression, migration, reinstall or external actions. Earlier intermittent clock failure not reproduced, retained diagnostic not proof of resolution.
Security review: no secrets or raw tokens added to logging, fixtures use ephemeral keys only; wrong/private/symmetric/non-EC/other curve keys fail closed; key load errors sanitized; tampered payload/signature and different matching-curve key reject; asynchronous input mutation cannot alter copied signature. No new permission/schema/business rule or lower authority acceptance. Actual configured key resolver/registry and Guest admission abuse policy still require composition, not default true. Next inspect existing security.consume_abuse_budget integration rather than inventing a successful policy. Candidate v4 remains database-only. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree; goal active.

Guest abuse infrastructure selection:06aade/7e446d/fe2f43 confirm Section87.4 Guest Session20/600s/IP and300/600s/Store, fixed atomic PostgreSQL security.abuse_bucket/consume_abuse_budget shared infrastructure; no TS adapter exists. Add bounded shared database adapter over existing function with trusted server clock, fixed epoch bucket, closed class/policy, copied32-byte keyed hash only, strict output validation and sanitized failure. No raw IP/key material, domain policy, migrations or counter in memory. Caller must use independently committing connection outside transaction that may roll back after denial. Route/Guest policy wiring remains separate. Fresh focused adapter unit tests and existing abuse-bucket actual DB scenario updated to call adapter, database type/build, affected lint/format. No whole Entry/browser rerun until this new component becomes its dependency.

Abuse adapter evidence:55586d6unit tests/database typecheck/build/affected4file lint and format pass. f3a1c8 actual PostgreSQL acceptance passes11.345s, now using adapter for8 concurrent attempts/exactly5 admissions, independent key scopes, denied table access and expiry behavior. e6475b final diff review caught public index extension must use native .ts like existing database exports;1ab9a1 confirms rewriteRelativeImportExtensions. Correct export only, rerun build/native source import (not unchanged behavior tests). No SQL/migration/domain policy changes.

Shared abuse adapter checkpoint: final f398d5 build passes,5507d2 public export resolves with actual configured process workspace loader on Node24.18.0.851191 direct WSL node accidentally selected system18 and was rejected;69e01e plain pinned Node index import exposed existing transaction-runner .js source import requiring documented workspace loader. No behavior/source workaround or unrelated loader change; runtime-compatible loader resolves. Standalone unconfigured native source index import is not claimed.
Security/scope review: adapter persists only caller-supplied32-byte hash with existing closed class/fixed UTC window and authorized limit; no raw IP/token/credential or database cause. Strict output validation, one SQL call, no retry/fallback/in-memory counter, denial returned normally so standalone autocommit consumes attempt. Caller contract explicitly requires independent commit, finite connection timeouts and expiry ownership. Actual DB scenario preserves execute-only rights/no direct table access and8-way concurrency5 admissions. No migration/threshold/Guest policy or HTTP change, no Entry/browser rerun as it does not yet consume this adapter. Next install trusted request key derivation, exact Guest limits, independent committed consumption and HTTP429 behavior before claiming production entry protection. Store/Provider/operator input request remains pending; candidate v4 still database-only. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree. Goal active.

Entry transport admission selection:861e07/d8f13b shows Handler creates Guest without request-level limiter. Add explicit requestAdmission port: trusted direct socket address and server instant only (never client forwarded headers/token), Allowed/RateLimited/Unavailable decision; unconfigured/failed/malformed port ->503 before QR/Guest creation. Valid bounded denial ->429+Retry-After with generic hidden-store error. Local runtime forwards explicit option, existing successful fixtures mark synthetic admission explicitly. Client currently falls back to ServiceUnavailable for429; no dedicated cooldown UI claimed yet. Fresh Entry handler/runtime/server/composition tests, API type/build and affected lint/format. Existing database adapter evidence reused; its actual route composition remains next, no claim of enforced20/300 policy from this transport alone.

Entry request-admission checkpoint:8cad84 actual HTTP/Entry/runtime/composition117tests pass,82109c API typecheck/build and affected7file lint pass;8cad84 formatted all changed files. Handler now requires an actual Allowed response before allocating references/calling QR/Guest composition; absent/unavailable/throwing/malformed decisions fail503. RateLimited returns429 and bounded1..86400 Retry-After, no Cookie, no-store, uniform hidden-store error. Input contains only direct socket peer and trusted server time; spoofed X-Forwarded-For/Forwarded ignored. Local runtime forwards optional explicit admission; successful test fixtures explicitly label synthetic Allowed instead of silently bypassing default. No raw token/IP/exception detail enters logs/error output. Missing request policy makes Entry unavailable even if DB health is ready.
Review6f7e65 found no matching entry route/error in searched contract/OpenAPI sources; no existing generated schema edited. Current PWA safely maps new429 to ServiceUnavailable; dedicated RateLimited/cooldown UI remains outstanding, not claimed. Actual20/600s/IP and300/600s/Store hash/budget policy and binding to independently committing DB remain next; no claim that synthetic Allowed fixture provides protection. Existing full DB/browseraf3e4a evidence remains for underlying owner path, not new production policy;117test realHTTP covers new transport behavior and unchanged persistence code not rerun this turn. No schema/dependency/credential/external/commit/push changes. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty work. Goal active, candidatev4 still requires configured business runtime.

Guest limit policy wiring selection: Section87.4/source21025–21043 fixes Guest20/IP and300/Store per600s, canonical IPv4/IPv6-/64 purpose-keyed hashes, independent PostgreSQL counter and24h expiry. Identity owns Guest policy through a public application port; crypto/network normalization belongs its infrastructure. No private cross-domain tables, approval fabrication or new migration. Add versioned fixed policy with explicit keyed-hash provider and independently committed budget port; reject absent/invalid peer, stale future request clock, malformed budget/unavailable dependencies. IP rejection stops before Store budget; Store rejection retains consumed IP attempt. Real current-clock Entry fixture uses existing restricted acquire/autocommit adapter, retains synthetic approvals but removes synthetic request-level Allowed. Historical fixture stays explicitly synthetic. Fresh Identity policy/crypto cases, Identity/API types, affected lint/format/import and current-clock actual DB/browser with rollback counter evidence. No default proxy-header trust or live key/Provider changes.

Actual Guest dual-budget checkpoint:3cdaed current-clock real Entry/Order/payment/Kitchen/serve/refund/HTTPSbrowser passes102.574s with production Guest request policy and actual independently autocommitted PostgreSQL budget calls. Forced business commit failure leaves each budget attempts2; Guest/admission/audit business rows roll back. At end revoked-table requests consume remaining budget without Guest creation:21st IP attempt returns429/Retry-After/noCookie and counters are IP21(limit20), Store20(limit300); denied IP request does not consume Store bucket. Full actual serving/payment/3receipt/browser route privacy path remains passing. Historical scenario filtered and retains explicit synthetic admission; no historical fresh pass claimed.
1fe69f/e28b4e7policy/crypto tests,Identity build/API typecheck/affected lint pass;2c3f84 import boundary22tests+validator and6file format pass. Tests cover IPv4-mapped normalization, IPv6-/64 grouping, scoped Store hashes, separate peppers/copy, accepted fixed limits, Store denial/failure preserving IP consume, malformed/future request fail closed. Code review: Identity policy through public port; shared security SQL remains database infrastructure; direct socket only, no forwarded header trust; public results bounded and raw IP/pepper never persisted/logged. Ephemeral test pepper explicitly synthetic; no real key rotation/Store approval. No policy relaxation, schema/install/full regression/commit/push.
Remaining abuse items: caller-managed stable pepper/rotation and independently committing production connection, production trusted-proxy/WAF/burst/load evidence, progressive delay behavior, scheduled24h cleanup and dedicated PWA429 cooldown state. Existing atomic cleanupDB acceptancef3a1c8 covers function, not running worker schedule. Store300 threshold is code/unit-policy validated and actual configured budget present; full300 concurrent route saturation not claimed. Candidatev4 still needs real business configuration/runtime, Pickup continuity and full browser-originated ordering; goal active. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree.

CUST-ENTRY-CONTEXT cooldown selection: registry2894 route/hidden Store source remains Section88.6; Section88 universal Rate Limited plus accepted Guest endpoint429/Retry-After applies. Behavior-only existing card/heading/button, no visual redesign or Figma change. Parse only exact generic429 contract with bounded integer Retry-After, retain monotonic in-memory cooldown (no storage/replay); client retry cannot issue network call early. Render remaining wait with disabled existing action; no automatic retry when timer expires, no Store/token data. Existing focus/heading/offline/privacy behavior retained, countdown avoids repeated live announcements. Fresh entry client/page tests and existing Entry lifecycle test if mounted component affected, PWA type/build, affected lint/format. No backend DB/whole journey rerun for display/client-only change.

Entry cooldown checkpoint: client accepts only exact generic429/body with integer Retry-After1..86400; malformed/missing/date/overflow header falls back unavailable. Uses performance.now monotonic in-memory deadline, no storage/background replay; repeated start during/after cooldown never auto-posts, early manual retry returns remaining wait without network. Page adds existing-style RateLimited heading/help/countdown and disabled Try again until elapsed. Countdown aria-live off avoids continuous announcements; heading focus and explicit user retry retained. No QR/Store/private identifier rendered.
63909458client/page tests and96e847PWA type/lint pass;d05fa6 single production App browser scenario passes7.3s with explicit synthetic429/422 transport: focused heading, disabled then enabled retry, no automatic second request, explicit click sends once, fragment cleared/storage empty.959c13 ordinary production build/final6fileformat passes; existing Vite inlineDynamicImports deprecation unchanged. Browser runner's demo-proof build is separate; normal build explicitly completed. Backend/persistence unchanged; previous3cdaed owner journey not rerun. New browser test is UI evidence, not real Provider or long-lived server acceptance.
Review preserves existing card/layout/routes and section accessibility, no Figma visual redesign, new CSS, transaction caching, secrets or external activity. Timers dispose on unmount; client enforces wait independently of disabled button. Remaining: stable configured runtime/pepper/proxy/expiry worker, real Store/operator/Provider inputs, Pickup and browser-originated full journey. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree; goal active.

Persistent security assembly selection: priora2efeb cooldown is progress. Candidatev4 still lacks API business config; install explicit local Guest admission module with current-user regular mode0600 stable pepper, no per-start random replacement, existing independently-autocommitting API connection and accepted Identity policy. Generate new local-only pepper once, never print/copy it. Scope comes from caller, no real Store fact fabricated. Provision exact execute-only security functions separately for API consume and Worker expiry; no raw table privileges. Next reuse existing real-work createOutboxWorkload scheduler for bounded nonoverlapping actual expiry cleanup adapter, not a heartbeat/fake keepalive; combine with business Worker later. Fresh candidate privilege metadata/restart-hash smoke, targeted cleanup adapter lifecycle tests/Worker type/build/lint; reuse unchanged DB function tests and Guest policy/browser evidence. No schema/Provider/production actions.

Persistent security configuration checkpoint: candidatev4 now has ignored customer-admission.mjs reading a one-time generated dedicated local guest-abuse-pepper (regular file, current owner,0600, no symlink/escaping realpath; development/test only). Reloading factory reuses secret, Identity hashes and existing database adapter. Caller supplies actual scope/ownsAPI pool; each budget uses independent autocommit connection and releases. No real Store/key registry approval supplied by this module. Local file creation is not managed production rotation.
564939 candidate metadata verifies API only consume and Worker only delete-expired function EXECUTE, neither SELECT/INSERT/UPDATE/DELETE on raw table. Same run5cleanup lifecycle tests/Worker type/build/affected lint and formatter pass. createAbuseCleanupWorkload reuses existing nonoverlap/bounded-drain real-work scheduler; count output validated/sanitized, closes after drain once. No independent timer/fake job/new retention policy.46f4a4 candidate smoke confirms4released synthetic query connections/two separately loaded factories produce equal IP/Store hashes without printing them; actual restricted Worker DB executes delete_expired_abuse_buckets(clock_timestamp()) then drains/closes. Reload test does not claim full process restart or real traffic; cleanup smoke does not claim deleted rows/continuous schedule. Known TTL correctness reused from f3a1c8 actual DB acceptance.
Ignored candidate abuse-cleanup.mjs provides60s child/dedicatedpool ownership for future composite business Worker. No daemon left running; no root worker configuration set to cleanup-only; original objective not reduced to housekeeping. Candidate remains no operating Store/menu/QR/operator/Provider/runtime assembly. Old candidates intact, no schema/install/full regression/commit/push/deploy. Source HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree. Goal active; proceed with actual business composition and Pickup continuity while Store/operator inputs are pending.

Pickup Entry continuation selection:6978a7 actual Pickup currently stops at empty Cart after rotated Guest binding. Create independent current-clock Pickup case using same existing isolated profile/Entry setup, branch before Dining seeds (avoids duplicate menu/price namespace). Preserve original Guest/Cart/cookie/CSRF and same API runtime; install existing catalogCartItems option with actual persisted Catalog projection/selection plus published Recipe/Inventory availability. Explicit synthetic commercial/publication/kill-switch approvals remain labeled. No new production adapter needed. Prove shortage no writes, qty2 normal add/read/replay, old credential denied, no stock reservation at Cart stage. Fresh only current-clock Pickup integration and affected helper format/lint; no unchanged Dining full journey or production build/type rerun because only test composition changes.

Original Pickup Cart checkpoint:c10779 pnpm exec vitest run --config packages/database/vitest.public-store-profile.config.ts -t "current-clock Pickup" passes15.101s; historical/Dining2tests intentionally filtered. Same current-clock QR Entry, actual Guest/Cart binding rotation and runtime now supply catalogCartItems built from existing production composition. Actual seeded Catalog selection/display, owner-published Recipe and Inventory availability validate Cart add; shortage100 returns422/no operation/audit/reservation writes; qty2 returns original Cart/version2/Latte; replay keeps sameversion and facts; old rotated cookie returns401/no writes. Cart mutation records one operation+audit and does not reserve stock. Entry real IP/Store policy and forced transaction rollback count persistence remain exercised. Original Cart/credential returned from binding helper; no alternate seeded Order/Guest.
875168 affected4file lint/format and source field check pass; after this no source mutation. Review: pickupOnly defaultfalse preserves original Dining/historical branch; new isolated parameterized case uses separate DB and existing shared setup rather than copying credentials/fixture orders. New test names "current-clock Dining" and "current-clock Pickup"; select explicit channel for future scoped runs. Synthetic commercial/publication/kill-switch/regulatory approvals remain labeled; no candidateStore/Provider authority claim. No production/schema/dependency changes, no unchanged code suites/type/build/browser repeats. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree. Goal active; next keep original Pickup Cart through pricing quote/checkout/capacity/payment/fulfillment rather than seed-only journey. Complete long-lived candidate still pending real business configuration.

Pickup quote continuation selection: previousc10779 is progress. Reuse ordinary quote helper's persisted PriceBook/TaxConfiguration/current Pricing service, add explicit Pickup branch (one original qty2 line) while default Dining remains existing qty2+3. Return common quote configuration for actual local Customer runtime; Pricing creates immutable quote/request and Ordering attachment through original Guest/Cart. No fabricated quote amount/Guest/Order. Synthetic regulatory/commercial approvals remain fixtures. Acceptance original Cart/Guest/version, calculated2260minor, repeated operation samequote/no secondpricing, oldcookie404, no extra reservation. Fresh affected helper lint/format and both current-clock Pickup/Dining cases because shared quote helper changed; no production or unrelated code suites/build.

Edit e4dbc0 stopped at exact-text assertion before writing runtime wrapper; quote helper changed but88c99f run still covers prior Pickup Cart only, not quotation. Correct wrapper target from observed06b062; do not treat previous green result as new quote acceptance. Fresh Pickup after actual wiring, then shared Dining default branch.

Original Pickup quote checkpoint:0e851c actual current-clock Pickup passes15.201s after actual wiring (88c99f preceding pass did not include quotation). Original Guest authorizes with rotated cookie/CSRF; same API composes existing Pickup quote service using common configured Pricing inputs. Original qty2 Cart/version2 produces owner-persisted Pricing request/quote and Ordering attachment, total2260minor CAD, one Pricing candidate invocation; HTTP replay returns identical response/attachment, oldcookie404 and no new Pricing invocation. Scope/Guest/Cart/version binding verified against actual Identity and attachment store. Synthetic tax/legal/commercial approvals remain explicit; no new fabricated Guest/Order.
bbd6f9 current-clock Dining owner journey passes88.693s with shared helper's unchanged default DineIn qty2+3/5650minor. Browser opt-in intentionally absent because no UI/transport behavior changed; prior3cdaed browser evidence retained for unchanged UI path. d3cfaa wrapper lint/format and1cfa77 shared quote lint/format pass; no further source changes. Shared configuration extraction preserves existing authority/participation/transactions/audits and added Pickup mode uses actual local runtime composition. No production/schema/dependency/candidate mutation or unrelated fullverify/build/install. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree. Goal active: continue same Pickup quote into capacity/CheckoutSession/Order/payment and actual fulfillment rather than starting seeded Order. Long-lived candidate remains incomplete pending business composition/inputs.

Pickup checkout selection: continue original current-clock Guest/Cart/Quote through actual HTTP CheckoutSession, existing Pickup capacity source/store and owner validation. Synthetic current capacity configuration (America/Toronto, PerFulfillment v1) only; actual selected Inventory/Catalog and exact Guest authorization reused. Prove one persisted session/allocation/ASAP commitment on replay, original reference linkage, old credential denial, no Order or Inventory reservation before submission. Fresh current-clock Pickup integration plus changed helper lint/format; no production/shared Dining change or unrelated regression/build/install.

First Pickup checkout run b9fe1c failed HTTP404 before session creation. Source04c4a5 shows local runtime intentionally supplies its own clock, overriding checkout options; Entry fixture still used its controlled earlier observation. Switch only Pickup checkout phase to live clock before first request, preserving earlier controlled closure tests and original Dining default. Retry affected Pickup after this test assembly correction, no production authorization relaxation.

9eec73 now passes initial authorization but fails503 in downstream session dependency. Add only bounded test diagnostics (SQLSTATE/domain code and stage, no SQL/binds/raw errors) to distinguish missing grants from validation; rerun same failed path, no broader checks.

9f554a bounded diagnostic identifies ASAP_CAPACITY_INVALID without SQL failure. Source81f93f requires capacity audit reason AUTHORIZED_CHECKOUT_CAPACITY; new helper incorrectly reused session CREATE reason. Correct helper audit mapping, retain strict owner audit validation. Retry same Pickup acceptance and affected lint/format.

1b8c3d capacity audit correction advances to CHECKOUT_DEPENDENCY_UNAVAILABLE. Add bounded Catalog stage/code and numeric observation count to isolate downstream owner failure; no successful acceptance claimed. Retry only same affected case after diagnostics.

dfce80 isolates Inventory observation authorization failure before observations. Source142117 shows actual Pickup Tenant binding uses FOR SHARE, prohibited by Inventory Repeatable Read READ ONLY transaction. Retain a separate authorization transaction around the complete Inventory observation; both pre/post Guest checks run there and retain Tenant locks, while Inventory snapshot stays read-only. No permission bypass/no production changes. Retry same affected case and helper lint/format.

Original Pickup checkout checkpoint:2a00d9 pnpm exec vitest run --config packages/database/vitest.public-store-profile.config.ts -t "current-clock Pickup" passes17.232s;2 unrelated cases intentionally filtered. Same original QR Entry Guest/Cart/version2/Quote now uses actual HTTP CheckoutSession POST201, retry200/read200, old rotated cookie404. Existing production Pickup capacity source derives1 PerFulfillment unit from original Cart/Quote and actual current capacity slot; one ASAP commitment/audit, one session/allocation; original Guest/Cart/Quote/Submission/PaymentOperation and fulfillment evidence references match. No Order or Inventory reservation before submission. Synthetic slot capacity1 and America/Toronto business date are fixture inputs, not real Store configuration.
389a90 affected helper lint/format passed; prior b54c2b wrapper lint remains valid (wrapper unchanged thereafter).3a023e lint caught wrong local variable before integration ran;47cd68 corrected. Final source review: joined Guest/Tenant authorization holds real FOR SHARE locks in retained separate transaction through Inventory observation, Inventory snapshot remains Repeatable Read READ ONLY, both pre/post authorization checks pass. No production permission/clock rules weakened. Diagnostic captures bounded stage/error codes only. Current Pickup phase switches runtime clock from controlled Entry scenarios to live time before checkout; default Dining/historical paths unchanged, no extra regression needed. All isolated resources cleaned by existing harness.
Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus preserved dirty tree. No production/schema/install/build/full verification/commit/push/deploy. Goal remains active: next preserve returned session/capacity/preparation into CheckoutDetails and Inventory-finalized original Pickup Order, then payment and fulfillment. This checkpoint is not pilot completion or long-lived candidate assembly.

Pickup details continuation selection: previous turn is progress (2a00d9 original Pickup CheckoutSession). Extend existing retained-server Entry details helper with explicit Pickup mode, preserving Dining default. Existing Pickup details owner composition uses original session binding/Cart/Quote, synthetic contact and no-required-policy fixture; HTTP save/read/replay/old-cookie denial and exact persisted snapshot. Expose existing forwarding port for local runtime before listen, attach actual service after original checkout. Fresh affected helper lint/format and current-clock Pickup/Dining because common helper changes; no production/schema/build/fullverify.

Original Pickup details checkpoint:06c893 current-clock Pickup passes20.842s. Original Guest/Cart/Quote/CheckoutSession on same local Customer HTTP runtime now saves actual owner CheckoutDetails: policy/current read200, initial save201, replay200 identical, current version1, old rotated cookie404. Service recovery is AlreadySaved; persisted snapshot retains exact Guest/Cart/Quote, Pickup contact and InSession receipt choice; exactly one details row and one save audit. Contact is reserved synthetic test data and no-required-policy input remains explicit fixture, not real Store legal approval.
Shared details helper now exposes its existing port as well as handler and selects explicit Pickup composition/session only when mode=Pickup; default Dining identity/behavior preserved. af2964 current-clock Dining owner journey passes98.956s.377955 affected helper/wrapper lint/format pass; final source review43b392 confirms bounded optional wiring, original references, no production changes. Browser not rerun: no UI changes, prior3cdaed evidence remains for unchanged path. No further source mutation after successful runs. No schema/dependency/install/fullverify/commit/push/deploy or candidate business configuration.
Goal active, previous turn classified progress. Next original Pickup Order needs createCustomerPickupSessionOrderSubmission with same access/preparation, existing CheckoutDetails policies, actual Catalog/Pricing snapshots and Store BusinessDate from operating publication, Inventory-finalized Order repository. Existing entry-dining-order-sources.mjs and entry-dining-order.mjs show owner assembly; do not substitute seeded Order or fabricate Dining commitment. Pickup checkout helper currently constructs checkout ports inside attached validation: retain/export reusable ports for submit while keeping per-request authorization. Complete long-lived app and browser-originated journey remain required.

Pickup Order continuation selection: previous turn progress06c893. Reuse real Entry order source/finalized repository helpers with explicit Pickup mode; preserve original capacity allocation/session/payment references, reuse current-authorized Catalog/Inventory checkout ports. Actual Catalog/Pricing snapshots and published Store BusinessDate; actual Inventory final validation/reservation atomic with Order/details link/outbox. Synthetic Workflow/publication approvals remain fixtures. Fresh current-clock Pickup and shared Dining regression plus changed helper lint/format; no production/schema/install/fullverify.

4b7da4 original Pickup owner submission passes21.966s, one Order/details link/final validation/reservation, replay stable. Extend this same checkpoint to existing /api/v1/orders HTTP transport via its actual Pickup composition before session bridge recovery; no new public route/adapter. Original server-generated submission reference used as existing transport idempotency key. Check POST201/replay200/old-cookie404 and no extra order/inventory rows. Retry affected Pickup, then shared Dining once final changes settle.

Original Pickup Order checkpoint:c606c1 current-clock Pickup passes22.051s after actual /api/v1/orders wiring. Same original Entry Guest/Cart/Quote/CheckoutSession/ASAP capacity drives actual Catalog/Pricing snapshots and published Store BusinessDate; actual Inventory-finalized owner repository creates Order, details link, final validation and stock reservation atomically. HTTP initial201/retry200 identical and old-cookie404; original session bridge recovers AlreadyCreated and same record, exact capacity Order reference and original submission retained. One Order/details link/final validation/reservation and one finalizer call across HTTP and bridge retries. No fixture Order substituted; Workflow and business approvals remain synthetic. Earlier4b7da4 covers owner-only submission; c606c1 adds real transport.
Shared owner helpers gain explicit mode=Pickup and access/current capacity input; default Dining keeps its commitment/clock path. 0a07b7 current-clock Dining passes91.808s; no browser rerun because no UI changes.6addd0 source/checkout helper lint/format and b24aa5 final HTTP/order/wrapper lint/format pass; unchanged files' results reused. Final scope reviewfaac32/67c9cb: exact Identity Brand/Store projection, Inventory tenant scope retained, no fabricated Dining commitment, original references preserved, no secret/PII diagnostic changes. All isolated resources cleaned; no production/schema/dependency/install/fullverify/commit/push/deploy.
Goal active; previous turn progress. Next retain order result in Pickup branch and extend existing payment preparation helper with createCustomerPickupSessionTipSelection plus original service.preparePaymentClock; existing Pickup acceptance1180–1250 shows real persisted tip and immutable30min capacity clock. Then PaymentIntent/Provider handoff/result, merchant/Kitchen/Pickup fulfillment, receipt/refund and actual long-lived app/browser journey remain. Candidate is not yet usable pilot and real Store/Provider inputs still external conditions.

Pickup payment preparation selection: previous turn progressc606c1. Add isolated Pickup-only helper using existing session tip service and ASAP original-clock service over same created Order/session. Prove one persisted explicit zero-tip selection/audit, conflicting tip rejected, old cookie rejected, one PaymentPending append/audit with immutable original30min deadline and no duplicate reservation. Fresh current-clock Pickup plus changed helper/wrapper lint/format; Dining helper remains untouched so reuse0a07b7. No Provider call or live funds.

024ea0 Pickup payment preparation passes27.791s: one tip, one PaymentPending append/audit, original30min deadline and capacity/order references, replay unchanged, old credential and conflicting tip denied. Continue same original order into HTTP PaymentIntent using actual Order/ASAP/Inventory/Workflow claim admission and persisted payment store; synthetic Test Provider response only. Wire existing deferred payment/handoff/result ports into local runtime, actual handoff/result exercised in subsequent continuation. Fresh affected Pickup helper lint/format/integration, no Dining code change.

113f78 Pickup HTTP PaymentIntent passes30.979s: original2260minorCAD, one Test Provider create call and one persisted intent/attempt/operation, replay200samepayment, oldcookie404. Continue same runtime through actual client handoff and terminal result services. Parameterize only synthetic Provider response amount in existing handoff/result helpers (default5650 unchanged; Pickup2260); real current admission/persistence remains. Because these shared fixture functions change, run one final shared Dining regression after Pickup continuation, plus affected lint/format. No real Provider credentials/network.

Original Pickup payment checkpoint:06f24a current-clock Pickup passes34.302s through original QR Guest/Cart/Quote/CheckoutSession/Order/reservation, persisted zero-tip/original30min clock, HTTP PaymentIntent/handoff/result. Actual Order/ASAP capacity/Inventory/Workflow claim admission and Payment store are used; synthetic Test Provider create called once for2260minorCAD, one intent/attempt/operation, original reference bindings preserved. Handoff rechecks actual admission, returns only transient synthetic secret, denies oldcookie404 and confirmation-withdrawn422 without extra Provider read; secret absent from persisted outcome. Actual captured observation alone still returns Pending; actual terminal service appends one terminal/Event/Audit and customer result then Succeeded2260CAD, idempotent terminal replay/oldcookie404.
Pickup-only payment preparation/intent helpers preserve Dining helpers. Shared handoff/result only gain positive safe-integer synthetic response amount parameter default5650; ca929b current-clock Dining passes98.795s.2aa184 preparation lint/format, d07f2a intent/checkout lint/format,6a1db3 final wrapper/handoff/result lint/format pass; no source mutation after final runs. Review b13d24 confirms terminal evidence and no retained synthetic secret, no stale Dining amount/commitment in Pickup intent. All isolated resources cleaned; no production/schema/dependency/install/fullverify/commit/push/deploy/live Provider. Earlier024ea0/113f78 were intermediate passes, final06f24a covers additions.
Goal active; prior turn progress. Next retain result returned by exerciseEntryDiningResult in Pickup branch and consume original OrderCreated/PaymentSucceeded via actual Worker, then merchant acceptance/Kitchen/Pickup fulfillment/status/receipt/refund. entry-dining-worker.mjs already uses original events and terminal but downstream dining-customer-status may need explicit Pickup channel handling. Long-lived candidate and browser-originated complete flow, actual Store/Provider configuration and external gates remain; not pilot complete.

Pickup fulfillment continuation selection: prior turn progress06f24a. Reuse original captured-order merchant/Kitchen/Fulfillment services; Entry already owns real Recipe/Inventory so explicitly reuse it rather than re-seed. Parameterize expected channel in existing Worker/status helpers (defaultDining preserved), consume original OrderCreated/PaymentSucceeded through persistent Worker, same API current-authorized status. Configure synthetic test Provider account scope before runtime start (real configured account is also startup input), pass same ref to actual terminal helper. Fresh current-clock Pickup then shared Dining once, affected helper lint/format only; no production/schema/build/fullverify.

03fdb5 Pickup continuation fails within captured-order Kitchen helper after actual acceptance/workflow queries; existing catch obscures cause. Add bounded domain/error code and source frames only (no raw messages/binds). Source81d95a also reveals downstream generic Pickup proof helper deliberately simulates future20/61minute times, unsuitable as current-clock Entry proof. Resolve current failure first and supply dedicated live-time handoff continuation before claiming real current fulfillment. Retry same affected case for bounded diagnosis.

75bc94 source frames identify missing acquire passed to legacy Pickup completion Worker (fcda7e), while old proof/handoff intentionally advances future clock. For actual Entry continuation expose existing all-items-Ready owner state via optional onPickupReady callback; do not execute unrelated simulated-time proof regression on this live path. Preserve legacy default unchanged. Original current-time merchant acceptance/Kitchen/readiness and source objects are retained for next dedicated live proof/handoff. This checkpoint will claim Ready only, not fulfilled/picked-up. Fresh same Pickup then shared Dining; no production clock/permission bypass.

Original Pickup Ready checkpoint:e13a78 current-clock Pickup passes36.246s. Original captured Order enters actual merchant authenticated acceptance, published payment Workflow/resource admission, Order confirmation, Kitchen ticket/item progress and Fulfillment readiness; existing Recipe/Inventory retained. All original Pickup items Ready with actual source objects retained. Actual persistent Worker then consumes original OrderCreated/PaymentSucceeded, one payment projection inbox; same original API/Guest reads original Pickup items, KitchenReady and Succeeded2260CAD, oldcookie/wrongCSRF404. This proves Ready, not completed handoff or fulfilled Order.
03fdb5/75bc94 earlier attempts hit legacy completion Worker missing acquire. Legacy proof helper also deliberately shifts clock20/61minutes. New optional onPickupReady returns actual readiness/source/creation/query before those legacy simulated proof scenarios; default legacy behavior remains. No clock/authority weakening, no claim that old simulated path passed here. Next dedicated current-clock proof/handoff must use retained pickupReady and actual owner services, not re-enter future-time proof fixture.
63f1b4 current-clock Dining passes91.783s.7dab5c initial affected file lint/format, c2a46a final changed Kitchen/Fulfillment/wrapper lint/format pass; unchanged Worker/result/status checks reused. Source reviewe996d3 confirms optional branch defaults, exact original references and configured synthetic Provider account97000 shared by terminal/status from startup. No source changes after runs; all resources cleaned. No production/schema/dependency/install/fullverify/commit/push/deploy/live Provider. Goal active, previous turn progress.
Next live Pickup handoff: createPostgresPickupProofStore + planPickupProofIssue + validatePickupProof then createPostgresPickupHandoffStore.complete using actual Date.now, all current item quantities, original fulfillment and actual source validator. Existing pickup-proof-store.mjs/pickup-handoff-store.mjs show shapes but use future proofAt tests; do not reuse simulated clock. loadOutboxEnvelope/parseFulfillmentCompletedEnvelope for actual completion publication. Subsequent real Ordering completion consumer/Worker must account for OrderCreated already projected by entry Worker; legacy order-fulfillment-completion.mjs assumes its own fixed generation and cannot be blindly reused. Receipt/refund/browser and long-lived configured application remain outstanding.

Live Pickup handoff selection: previous turn progress e13a78. New Pickup-only continuation over retained original Ready source: actual proof issue/verify and handoff stores with live clock, one full handoff plus exact replay, original completion outbox publication. Synthetic capability selector/staff/device/location approval remain fixture inputs; no future clock. Fresh affected helper/wrapper lint/format and current-clock Pickup only; unchanged Dining reused63f1b4. Ordering completion consumer/receipt remain separate next steps.

cd586c live handoff passes39.161s: actual current proof/verification/full quantities, one handoff and completion outbox, denied authority/replay covered. Continue actual original completion event through existing Ordering Workflow/event composition and persistent ConsumerWorker, reuse already-created projection as baseline rather than fixed fixture generation. Verify Fulfilled/Open, one completion/audit and one projection generation/inbox, replay no changes, same Customer HTTP canonical phase. Fresh Pickup only after this added behavior, affected lint/format.

eeb48a actual completion Worker reaches Fulfilled, assertion used closureStatus on execution summary instead of authoritative completion record. Source00a011 records closureStatus on completion; correct assertion to after.completion.closureStatus and retry affected Pickup only. No production change or relaxed expected state.

Original live Pickup completion checkpoint:502d14 current-clock Pickup passes38.043s. Same original Ready fulfillment issues/verifies one proof using live Date clock, completes full original quantities through actual handoff store, rejects denied authority and replays AlreadyApplied without duplicate effect. One proof/verification/handoff/completion publication; original FulfillmentCompleted event timestamp equals actual handover time and is not in future. Capability selector/public reference and staff/device/location approvals are explicit synthetic fixtures; this is owner-service handoff, not Merchant browser/HTTP handoff.
Actual persistent ConsumerWorker consumes that original event using existing Ordering completion Workflow composition and original already-persisted status projection as baseline. Execution becomes Fulfilled with completion.closureStatus Open; projection becomes Fulfilled/Completed, original completion event bound, duplicate_completed delivery preserves projection. Exactly one completion record/audit/inbox. Same original Customer HTTP read now returns canonicalPhase Fulfilled. Both Worker workloads and isolated DB resources close normally. No old future-time proof scenarios or fabricated Order/projection.
7fb002 handoff/wrapper lint/format,69b25d completion/wrapper lint/format,3d2ab5 corrected completion lint/format pass. eeb48a failed only wrong assertion field level; corrected06cc47, final502d14 covers full addition. Source reviewbf6d86 confirms closure remains Open, original event/replay/count evidence. Pickup-only helper/wrapper branch changed; no Dining production/shared helper change, reuse63f1b4 unchanged Dining evidence, no extra rerun/build/install/fullverify. Same HEAD a0f35440cacff1ab55be78edfb08cb4de90c1a26 with preserved dirty tree; no commit/push/deploy/live Provider.
Goal active; prior turn progress. Next original Pickup receipt issuance/read and necessary refund can reuse entry-dining-receipt.mjs (no hardcoded Dining/5650 found), then real browser and long-lived runtime assembly. Receipt runtime option must be wired before listen. Keep full pilot objective including actual Store/Provider inputs and Merchant/customer browser operation; current owner/database/HTTP journey is progress, not completed pilot.

Pickup receipt/refund selection: prior turn progress502d14. Wire existing receipt read port into same Pickup runtime before listen and reuse original issuance/refund recovery helper with actual completed original Order/capture/tip/published Store business date. No new seeded Order/Payment; issuer/template/staff/Provider approvals remain synthetic. Helper already checks immutable Original/RefundPending/Refunded snapshots, replay and recovery. Fresh current-clock Pickup plus changed wrapper lint/format; helper/default Dining unchanged, reuse63f1b4. No production/schema/install/build/fullverify.

19caf4 original Pickup receipt/refund passes44.764s through same runtime and actual original Order/capture. Continue opt-in HTTPS App browser over same persisted API, resume original Guest/CSRF in memory, no response interception. Add Pickup-specific expected Order collected/22.60 branch to existing browser helper; retain unchanged default Dining assertions/framework. Fresh BOP_ENTRY_BROWSER=1 current-clock Pickup and changed wrapper/browser lint/format; no unrelated production/build or default Dining repeat (branch implementation unchanged, prior browser proof retained). This is resumed read continuity, not browser-originated checkout or Merchant handoff.

Original Pickup receipt/refund/browser checkpoint:e77558 BOP_ENTRY_BROWSER=1 pnpm exec vitest run --config packages/database/vitest.public-store-profile.config.ts -t "current-clock Pickup" passes46.574s. Same original completed Pickup Order now issues/reads actual original receipt and ordinary RefundPending/Refunded snapshots through existing immutable issuance/refund recovery owner services. Actual HTTPS PWA -> same API -> persisted DB shows Order collected, paymentCAD22.60, Original plus2Refund versions, RefundPending/Refunded; no response interception or local/session storage; unauthorized cookie clears Order/Receipt and original receipt disappears. Guest/CSRF restored in memory, so this is resumed read continuity, not browser-originated checkout or Merchant browser operation.
19caf4 preceding nonbrowser receipt/refund pass44.764s; final e77558 covers additions. bbb3f9 wrapper/browser lint/format pass; e922d2 stopped at lint before integration because missing explicit node:process import, fixedb7a27c. Original receipt helper unchanged. Browser scaffold/default Dining assertions unchanged; only explicit Pickup expected-heading/amount branch, default Dining evidence retained, no repeated unrelated regression/build/install. Final review retains synthetic issuer/template/legal/staff/Provider approvals, actual current-clock owner persistence and immutable receipt facts; no production/schema/dependency/commit/push/deploy/live Provider. Goal active, previous turn progress.
Next priority is long-lived configured application assembly and browser-originated full journey. 5f70a4 confirms pilot-v4 contains DB connections, application credentials and abuse/cleanup configuration but no api.mjs/worker.mjs business entry. Existing local runtime already supports required owner ports; do not count ephemeral acceptance helpers as running pilot or start health-only/cleanup-only process as completion. Real Store/menu/tax/operator/Provider inputs remain external conditions; continue technical configuration in authorized local scope with clearly labeled synthetic data where needed, never invent actual operating approvals.

Long-lived assembly inventory (current goal active): e5a79e/ea8c3e/4b1a40 confirm existing trusted API/Worker configuration loaders, LocalCustomerRuntime.merchantRuntime, and createCompositeWorkerWorkload already provide process composition. Reuse these; no new launcher or composite framework required. Candidate v4 still lacks business grants and business configuration; abuse cleanup alone is not a pilot Worker. b97be5 identifies a concrete additional integration gap: MerchantBffRouterOptions has order acceptance, Dining item service and refund, but no Kitchen queue/action or Pickup queue/handoff port; the two navigation entries do not establish executable operations. Merchant frontend kitchen-board.ts and pickup.ts exist and must be inspected against canonical screen contracts before wiring authenticated HTTP owner ports. Owner-service acceptance e77558 does not cover those Merchant operations.
Next bounded implementation: resolve existing Kitchen/Pickup frontend transport and owner query/command contracts, add the missing authenticated Merchant composition within WP-2402, then wire long-lived configuration. Keep actual Store/workforce/Provider inputs explicit; prior authorization approves Docker restoration and accepted multi-batch/refund policies, not fabricated operational facts. No business checks rerun in this read-only assembly inventory; no production source changed, existing journey evidence remains unchanged.

Merchant Kitchen selection: previous turn yielded concrete missing BFF evidence b97be5. KIT-KITCHEN-QUEUE Section88.10 requires kitchen.operate and named operator, conflicts/offline read-only; existing lifecycle owner supports Accept/Start/Complete/MarkReady with string versions and atomic append/event persistence. Add authenticated application adapter with current selected Workforce scope, actual owner PostgreSQL repository, explicit admission/expo/tenant-context/fence inputs and repeated permission checks. No synthetic approvals or schema changes. Fresh targeted adapter permission/revocation tests, API typecheck and affected lint/format; persisted owner evidence reused only for unchanged internals, new HTTP/browser/persistence composition still requires subsequent integration.

aedab5 adapter tests correctly reject denied authority but four assertions incorrectly inspect sanitized Error.message; domain exposes code separately. Correct assertions to code, preserving generic message; rerun affected tests/type/lint. Type/lint did not run after initial failed test.

8d2675 six adapter tests and API typecheck pass;225008 lint rejects test non-null assertions, replaced with optional access. Extend actual MerchantRuntime option and same-origin POST /kitchen/work BFF route, preserving typed400/403/404/409/422/503 recovery states and no raw failures. Fresh changed HTTP suite plus API typecheck/build and affected lint/format; unchanged domain/database not rerun yet.

Final targeted selection adds HTTP success/string-version/projectionPending and unconfigured503 assertions, plus existing import-boundary check for new public-domain imports. No new DB claim until actual authenticated persistent composition is exercised.

eb631d latest HTTP success fixture lacked branded Kitchen references; use public result parser with distinct synthetic references instead of type assertion. Prior04d9a1 production build/lint pass still valid; rerun updated test/type and pending import check.

Merchant Kitchen HTTP checkpoint: new merchant-kitchen-command.ts binds actual current Workforce/OIDC selected scope through createMerchantStoreScope, checks body actor/Brand/Store, and composes real Kitchen lifecycle service/PostgreSQL repository inside merchant transaction. Current permission is rechecked for service execution and repository recovery/write; admission/Expo/current-source/tenant-context/fence remain explicit configured ports, never default Allowed. MerchantRuntime now wires this adapter; BFF POST /kitchen/work applies existing same-origin/Host/cookie/CSRF/no-query/no-store controls. Domain public result preserves decimal version strings and projectionPending; typed400/403/404/409/422/503 distinguish recovery conditions, unknown exceptions are generic.
c580f3 six adapter tests +33 Merchant HTTP tests pass;04d9a1 API typecheck/build and all five affected files lint pass. Final abcad433 HTTP tests pass after adding success/unconfigured assertions;50820b API typecheck, final test lint and import-boundary22tests+validator all pass. Formatting applied only changed files. Initial assertion-message failure aedab5 and branded-fixture type failure eb631d were test construction errors, corrected with code assertions and public result parser; no production weakening. Existing source/lock/toolchain unchanged after successful production build, no repeated build/install/fullverify. Review73897c confirms actual runtime and route wiring; a6c954 verifies no private cross-domain SQL/business rule added. Existing dirty files preserved; no commit/push/deploy.
This is new authenticated application/HTTP composition evidence with unit doubles, not actual database/browser proof for the new adapter. Next integrate the original paid Kitchen lifecycle in packages/database/test-support/kitchen-paid-lifecycle.mjs via actual Merchant session and HTTP (ed24c9), using existing persisted Workforce fixture and original ticket. Then queue reads/frontend actions, Pickup merchant handoff and long-lived runtime configuration remain. Goal active; this turn makes concrete source progress, not pilot completion.

Merchant Kitchen persistence selection: previous turn source progress2df551. Reuse original paid Kitchen ticket and existing actual encrypted Workforce session/membership/policy selection in captured-order-kitchen. Add explicit optional kitchen permission to isolated session seed; current-clock Entry only routes Accept/Start/Complete/replay via real API HTTP and new adapter. No new Order/Payment seed. Existing recipe/source/Audit/Outbox/readiness assertions retained, add forged actor/CSRF and actual grant withdrawal. Legacy helper default remains direct owner path. Fresh current-clock Pickup then affected Dining once because both enter shared branch, changed helper lint/format only; production build/type/import evidence unchanged. No new fullverify/install.

d30b26 lint stopped before integration: new helper needs explicit globalThis fetch/AbortSignal and documented silent test logger. Correct fixture-only lint, then run pending Pickup.

a41db3 reaches original Kitchen but new HTTP path fails an obscured assertion before lifecycle queries. Add bounded HTTP status/error-code diagnostics for cache policy and first command race, no response payload/credentials/raw SQL. Retry same affected Pickup to identify boundary failure.

af2d3f first race rejected;1b5c04 identifies missing Sec-Fetch-Site same-origin in test HTTP client. Keep production middleware strict; add browser-equivalent header to fixture, normalize bounded diagnostic codes for existing sanitizer, retry Pickup.

6fe84b both requests403 before owner queries. Minimal no-credential transport probe d6be3e proves Node fetch overwrites supplied Host with loopback authority. Replace test transport with node:http request (same as existing BFF tests) preserving explicit accepted Host and same-origin header; production host validation remains unchanged.01e65f shell quoting probe never executed, corrected with literal stdin. Retry affected Pickup only.

367c58 new transport lint requires explicit node:buffer import; integration not started. Added import, rerun remaining selection.

Pickup eefe6f/f0d32f passes46.902s via real Merchant HTTP, actual scope and Kitchen persistence, original subsequent completion/receipt/refund. Dining9f4f32 fails on concurrent same-command replay after real lifecycle record read. Adapter sampled authority observedAt before execution but clock.now again at mutation; concurrent waiter can observe earlier than winning operation occurredAt, rejected by owner temporal validation. Bind one request execution instant after current scope authorization for both trusted authority and lifecycle clock; retain actual current permission checks. Add unit equality assertion, run API targeted tests/type/build/lint then Dining and affected Pickup for changed production time binding. No owner rule weakened or historical time introduced.

Merchant Kitchen persisted HTTP checkpoint:1766af current-clock Dining passes93.074s and0e306e current-clock Pickup passes44.515s after request-instant fix. Same original paid Order/ticket now goes through actual API POST /merchant/kitchen/work with persisted encrypted Workforce session, selected Tenant/Brand/Store, membership and permission grants. Actual Kitchen service/repository handles Accept/Start/Complete, duplicate/competing requests and response replay; existing original ticket versions, ready records/publications and downstream Customer status/fulfillment/receipt/refund assertions remain. Invalid CSRF and forged actor reject before mutation; actual kitchen grant withdrawal rejects old replay. No new Order/Payment seed or fake HTTP responses.
Production adapter now binds one observedAt for trusted authority and lifecycle execution clock after current scope authorization; fixes observed authority preceding mutation time during concurrent identical command recovery. Domain temporal/version/replay rules unchanged.159362 six adapter tests, API typecheck/build and affected lint pass before final integrations. Previous Merchant HTTP suite/import boundaries unchanged from50820b and reused.9f8ea1 helper lint passes;6fdc3b five helper formatting pass before only node:buffer import/header transport correction, final source conforms to applied formatter. Intermediate Pickup eefe6f passed before production time fix; final0e306e supersedes it.
Failure resolution: a41db3/af2d3f/6fe84b exposed test HTTP transport requirements; missing same-origin fetch metadata corrected, minimal d6be3e proved Node fetch rewrites Host, node:http now preserves trusted-host test input. No production security check relaxed.9f4f32 Dining concurrency failure motivated real API request-instant fix1d48c1, final1766af confirms it. Test API shuts down in finally, unique DB cleanup succeeds; no live helper processes retained. Staff/OIDC association/admission/Expo policies remain explicit synthetic test authority. Not actual Merchant browser or long-lived candidate evidence.
Next:871de0/b61767 confirm KitchenBoardPage still defaults to unavailableKitchenBoardClient, buttons disabled and view lacks actionable versions. Resolve owner kitchen_work_queue_v1 persistent query/worker source and expose authenticated bounded queue/detail with current versions, then connect real frontend actions. Existing public createKitchenQueueProjectionService/ports exist, but no Kitchen queue persistence adapter found under owner infrastructure or database test-support; inspect platform projection facilities before implementing. Pickup Merchant HTTP/UI, long-lived configured API/Worker and actual Store/Provider inputs remain. Goal active; source and real integration progress this turn, no pilot-complete claim, no commit/push/deploy/live Provider.

Kitchen queue query selection: previous turn5115d9 production/persisted HTTP progress. Existing1500_002/003 owner projection tables and immutable generation/row contracts available; no persistence reader found. Add Kitchen-owned public PostgreSQL queries for existing service ports, exact scoped active generation, decimal bigint decoding, bounded limit+1 keyset pagination and get, before/after authorization, NoActive distinct from empty/notfound; caller owns consistent bounded RepeatableRead read-only snapshot. No migration or fabricated projection writer. Unit adapter authorization/scope/cursor/bigint/malformed dependency coverage, owning domain types/lint, existing queue domain tests and import/database ownership checks as affected. Actual projection build/storage and Merchant HTTP/browser still separate remaining work.

68285a/a63c10 new8 query tests, existing Kitchen tests310total, domain type/lint pass. pnpm test -- forwarding unexpectedly ran whole owning Kitchen suite rather than two intended files; reuse result, subsequent filtered tests use pnpm exec vitest. Import boundary22+validator pass65f11d; database ownership tests931pass but validator1bdb91 rejects new exact persistence asset (legacy foundation guard). Register only Kitchen owner/schema/two declared projection tables/exact path, retain driver prohibition; add6positive/negative asset checks, fresh focused ownership tests+validator and pending domain-layer check, affected lint/format. This is authorized existing-schema persistence registration, not gate removal. cc4a37 reveals old database kitchen-queue acceptance exists but hardcodes49 migrations and legacy inventory; do not alter unrelated historical assertions merely to get green. Next adapt scoped current-schema acceptance for actual reader/writer.

Add separately named current-schema adapter case to existing kitchen queue PostgreSQL test/config; retain old49-migration test unchanged and explicitly filter it out. Reuse its synthetic ticket/row seed to prove actual SQL decode, NoActive vs initialized generation, read-only restricted role, list/detail/filter and RLS sibling isolation. This validates the reader only; synthetic prebuilt generation/digests are not production projection source/worker evidence. Run existing config -t current-schema, no whole legacy acceptance command.

02f0d4 new case stopped before DB provisioning: caseId exceeded isolated helper limit. Shorten to wp2402_queue, preserving unique run ownership, rerun pending case.

Kitchen queue reader checkpoint:09dc64 current-schema PostgreSQL adapter case passes11.075s on fresh full migration isolated DB. Actual restricted role/read-only RepeatableRead transaction reads NoActive before activation, then actual activated synthetic projection list/detail/filter, preserves bigint/timestamps, hides sibling Store via RLS and rejects withdrawn authorization. Isolated role DROP OWNED/DROP ROLE and DB resources cleaned. Synthetic prebuilt ticket/generation is adapter SQL evidence only, not actual producer checkpoint/digest/worker activation proof. Historical49-migration inventory case intentionally filtered and unchanged.
New public createPostgresKitchenQueueQueries reads only declared Kitchen tables with exact configured Brand/Store and current authorization before/after, limit+1 keyset pagination, stable generation binding and strict bigint string decoding. NoActive/NotFound/empty remain separate; caller must own bounded consistent snapshot.68285a/a63c10 eight new query tests plus existing domain suite310total/type/lint pass; no rerun after success.65f11d import22tests+validator,7f26d2 exact asset registration6tests+validator,37efa5 domain-layer57tests+validator and tooling lint pass.931 preexisting ownership tests passed before precise six-case addition, reused; no broad check restart.02f0d4 only initial overlong caseId failed before provision, fixed92a1fe. Source review confirms parameterized scope/filter values, no private foreign table/read/write, no schema/dependency/Provider change.
Current goal remains active. Next implement/reuse actual Kitchen projection generation store/source and ConsumerWorker activation from original ticket/lifecycle events, then authenticated Merchant queue/detail -> frontend. Existing kitchen-queue-projection-acceptance.test.mjs contains SQL generation activation/locking fixtures (discovered cc4a37); use them as schema examples, not running production adapter. Current reader alone is not a usable board. Keep remaining Pickup Merchant UI, full browser-originated journey, long-lived API/Worker and real Store/Provider configuration in pilot scope. No commit/push/deploy, no fullverify or duplicate business journeys this turn.

Kitchen queue generation store selection: previous turn78fe1e read adapter/actualSQL progress. Add exact owner projections port implementation against existing1500 tables, complete digest reconciliation, explicit bounded rows/current-source/authorization, store lock, immutable Building->Active->Retired within caller transaction/savepoint, exact replay and expected-active conflicts, rebuild lookup. Share existing column/decode helpers with query adapter internally; no new schema. Fresh reader+store tests/type/lint and actual current-schema query case extended through writer activation/replacement/rollback/replay, exact asset registration tests+validator. Source/ConsumerWorker and Merchant UI remain required next.

bd5108 real writer first activation fails sanitized dependency; add bounded SQLSTATE/table diagnostic in isolated test transaction only, retaining production sanitization. No raw SQL/binds/errors.94db55 ownership12cases+validator/import/domain checks pass; d0d1b2 type/76targeted tests/lint pass. Retry affected DB case for failure cause.

326908 diagnostic edit matched read callback rather than write. Correct exact scoped edit3efbcd and preserve original read authorization assertions; retry writer case with bounded SQLSTATE/table/constraint only.

486cdc identifies SQLSTATE42501. New writer extends prior read-only role; existing original writer fixture explicitly grants platform_helpers.is_uuid_v7(uuid), required by UUID domain insertion. Add that exact helper EXECUTE grant, not elevated role or relaxed RLS. Retry same affected case.

8f96fa actual writer/read case passes11.221s: first activation/replay, expected-active conflict, current-source refusal, injected post-generation row failure rollback preserving prior active, subsequent generation activation with retained Retired history. Add outstanding rebuild-reference port acceptance (successful lookup/digest conflict/notfound) to same isolated case; production source unchanged, reuse type/lint/boundary results, run only final affected DB case and fixture format/lint.

Kitchen queue generation persistence checkpoint:aede16 current-schema DB case passes11.179s with actual owner writer and reader. Complete snapshots reconcile source-event/snapshot digests before persistence; scoped advisory lock and expected-active comparison serialize swaps; Building rows are written under savepoint, previous Active becomes Retired and new generation becomes Active atomically. Actual first activation, exact retry, stale expected generation conflict, source-validator refusal, forced row-write failure after generation insert (no partial generation and prior still active), successful replacement/retained history, and rebuild lookup/exact digest/conflicting digest/notfound pass. Existing restricted read-only list/detail/filter/RLS tests remain passing. Rebuild fixture uses explicit synthetic producer evidence; this is storage evidence, not original event/Worker activation.
Shared internal column/decode functions avoid mismatched reader/writer fields; bigint versions serialize exactly, explicit maxRows fails closed rather than truncating a generation. Authorization rechecked, no external private tables or schema changes. d0d1b2 Kitchen typecheck/76targeted reader+domain tests/affected lint pass;94db55 exact ownership12tests+current validator/import/domain-layer validators pass, unchanged validator tests reused from earlier documented runs. Final DB fixture format/lint pass d5c87a. No production source changed after these checks; no repeat fullsuite/install/build required (owning typecheck emits package as configured).
Initial bd5108/326908/486cdc diagnosed missing helper EXECUTE on the previously read-only isolated role; add only platform_helpers.is_uuid_v7(uuid), which existing writer fixture already requires. Production RLS/role checks untouched. Intermediate8f96fa passed before remaining rebuild tests; finalaede16 covers all additions. Unique role/DB cleanups succeeded, no live tools or services retained. Reviewed scope: new Kitchen owner store, reused reader codec exports, public index, exact ownership registration, scoped acceptance case; historical49-migration test unchanged and filtered.
Goal active, concrete source and actual DB progress. Next supply actual Kitchen queue source/checkpoint/proof adapters from original ticket/creation/lifecycle records and wire existing createKitchenQueueProjectionService + persistent ConsumerWorker; then authenticated Merchant queue/detail and frontend action flow. Long-lived candidate assembly, Pickup Merchant flow, full browser-originated ordering and actual Store/Provider operational inputs still required; no completion claim or commit/push/deploy.

Kitchen source proof selection: previous cf4d68 writer/SQL progress. Existing creation and lifecycle records preserve validated effect/event/audit evidence; queue lifecycle source requires complete contiguous per-ticket operation proofs plus automatic/manual readiness causality. Add application conversion from parsed immutable lifecycle effects into existing domain proof bundle validation; no fabricated digests/actor/operation, no SQL or new schema. Domain parser exported internally for reuse, not relaxed. Verify with actual original persisted Kitchen history and existing owner test harness, including missing/duplicate history rejection; affected types/lint/domain tests and current-clock Pickup then shared Dining if helper applies. This supplies source-proof conversion; full feed/checkpoint/ConsumerWorker assembly remains next.

Kitchen lifecycle source-proof checkpoint: createKitchenQueueLifecycleProofBundle converts validated immutable owner effects into existing Event/ManualReady/AutomaticReady projection proofs, retaining original operation/audit/event/effect references and digests. It computes canonical proof/causal/set digests and delegates contiguous-version, uniqueness and causal validation to the unchanged domain parser. No SQL/schema/permission changes. Current source version remains the feed validator responsibility; proof conversion alone cannot establish snapshot/checkpoint completeness.
Fresh3800b2/64c3ab: targeted kitchen-work-lifecycle49 and kitchen-queue-projection68 tests (117total), Kitchen typecheck and five affected-file ESLint pass. Initial3582fa manual test used observedAt before captured completion; corrected only fixture observedAt/clock to existing manual scenario, preserving production temporal validation.762a0c affected five-file Prettier check passes. Real persisted original histories are resolved through owner idempotency repository after actual authenticated Merchant HTTP commands; missing history is rejected. e5257b/f31ec4 fresh current-clock Dining94.231s and Pickup45.041s pass (two selected cases, unrelated third case filtered), including original downstream completion/receipt/refund. Auto-ready persisted path proven; manual-ready conversion proven by owner-service unit effects, not claimed as actual manual PostgreSQL/browser journey.
Reviewed af914c/122631 scoped conversion, public export, internal parser export and helper/test additions: no fabricated owner evidence, private foreign tables, secrets or external changes. Baseline remains a0f35440cacff1ab55be78edfb08cb4de90c1a26 with existing uncommitted WP-2402 changes preserved. No manifests/lock/pins/installation/schema or import-layer edges changed; prior recorded valid installation and94db55 boundary validators reused for unchanged covered inputs. No repeat install/fullverify/build beyond owning typecheck. All commands completed, no live test handle.
Goal stays active. Next implement actual bounded Kitchen source snapshot/checkpoint adapter from creation and lifecycle records, integrate existing projection service/ConsumerWorker, then authenticated Merchant queue/detail and frontend actions. Conversion and storage are not an assembled queue or pilot. Long-lived API/Worker configuration, Pickup Merchant UI and browser-originated full flow plus real operational inputs remain; no commit/push/deploy.

Kitchen bounded snapshot selection: prior8008ff proves persisted history conversion. Implement owner-only single-statement snapshot reader of Open tickets plus original creation records, current work items, primary lifecycle records and ready results. Use bounded lateral subqueries (limit+1, reject overflow), exact Store scope/current authorization and existing creation/effect/feed parsers to reconcile immutable catalog snapshots and current versions; sanitize failures. A fresh snapshot reference identifies this read, not a fabricated durable consumer checkpoint. Return validated rebuild input for subsequent checkpoint/service/Worker composition. Fresh owning type/lint, exact ownership asset tests+validator and current-clock Pickup/Dining shared helper cases, including real source reconciliation and denial; unit empty/overflow/authorization/query-failure cases. No schema/manifest/install/fullverify change.

Snapshot activation binding selection: same source scope now adds application adapter for rebuild-only source/checkpoint ports and projection-store source validation. Capture validated complete snapshot in a transaction-keyed WeakMap; compare only that captured source, reject other transactions/scope/changed content/regressed time, and bind activated rows to original source/snapshot digests. This is complete snapshot rebuild coverage, not event offset or incremental implementation. Test empty snapshot initialization, altered checkpoint/source, foreign transaction and candidate row binding using existing domain builders; no new SQL. Original source reader production unchanged after15f429/d8492d unit/type/lint and17f1d7/0a4fe5 Pickup, e69ece/56ee03 Dining passes. Pending3de9fa adds actual operation-overflow assertion only, no need to rerun Dining for that isolated negative case.

Kitchen bounded source checkpoint: createPostgresKitchenQueueSourceReader now reads Open tickets plus original creation records, current item versions, complete primary lifecycle records and normalized ready results in ONE Store-scoped PostgreSQL statement. Each ticket/item/history collection uses explicit limit+1 and rejects overflow. Validated original creation effects supply catalog snapshots; normalized item identity/quantity/version/status/timestamps and ready results reconcile with validated immutable effects; existing complete lifecycle-feed parser validates proof completeness/causality. Before/after current authorization and generic errors prevent unauthorized reads/error disclosure. Snapshot reference identifies one complete MVCC read, not a durable event-consumer offset.
Fresh15f429/d8492d Kitchen typecheck,8new reader tests and affected lint pass. 7d96e6 nine exact source-asset ownership tests and ownership validator pass;770f03 actual import/domain-layer validators pass. Initial7d96e6 mistyped import-boundaries path did not execute that validator; corrected to existing package.json import-boundary/domain-layer-boundary paths, no missing result counted as success. Initial9c3a73/8295da test-mock generic typing failures corrected within fixture; production type passed final. Existing validator-test evidence reused for unchanged validators except exact added asset cases.
Original current-clock paid Kitchen records now actually read through source adapter:17f1d7/0a4fe5 Pickup46.247s and e69ece/56ee03 Dining93.720s pass, including multi-item completed/ready reconciliation and denied current authorization. Additional operation-bound overflow assertion was absent from451be3 edit (marker unmatched); corrected1d321f and freshly verified3de9fa/e876a4 Pickup44.423s. No claim that the earlier Dining run included this later negative assertion. Production reader unchanged between passing runs. No repeat Dining needed solely for shared negative assertion. Helper format/lint passes; source reader format/lint already passed and unchanged.
createKitchenQueueRebuildSource adds rebuild-only adapter: captured validated source bound to transaction identity, exact captured candidate comparison, Initial/Exact/Successor with regression/changed-asOf refusal, and complete activation-bundle reconciliation with source-derived snapshot/event digests. Fresh e12bca owning typecheck/four focused binding tests pass; initial043c05 branded test reference and b68289 unused destructured field corrected without relaxing rules. Final explicit base-feed mapping reviewed. This adapter is not yet composed with real projection store/service in PostgreSQL; tests cover empty initialization, scope, transaction substitution, altered source and candidate, temporal comparisons. Do not promote it to actual nonempty activation or Worker evidence.
Reviewed scope: two new owner implementations/two tests/public exports, exact database asset registration and original paid-lifecycle helper. No schema, dependency, permissions-policy, external services, commit/push/deploy change. Baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 with existing WP-2402 uncommitted work preserved. Existing valid installation unchanged; no reinstall/fullverify. Next compose actual source->createKitchenQueueProjectionService.rebuild->Postgres generation store->queue reader under scoped transaction, including actual nonempty source binding and retained generation, then persistent Worker and authenticated Merchant browser UI. Full pilot goal remains active.

Final f58293 confirms e12bca composite command exit0 including rebuild-source/test/index lint. All test handles terminal; isolated database suites completed cleanup. Goal active, no live check restarted.

Kitchen actual read-model composition selection: previous bced59 source+binding progress. Compose existing owner source reader, transaction snapshot binding, generation store, query adapter and projection service behind rebuild/list/get only; require explicit scoped transaction/locks/trusted query authority/current authorization, never expose unconfigured event-consumer handlers. Use original paid current-clock ticket to rebuild initial generation, exact replay, replace retaining history and read list/detail; refuse revoked permission. Integration fixture uses existing isolated role and exact projection table/helper grants. Small owning type/lint/import/domain checks; current-clock Pickup then Dining for shared multi-item composition. No fullverify/install/migration; existing source/binding/storage tests reused unchanged. Worker/event incrementals and browser still outstanding.

Kitchen actual read-model checkpoint: createPostgresKitchenQueueReadModel composes the real owner snapshot reader, transaction-bound rebuild source, existing projection service, PostgreSQL generation store and list/detail adapters. It exposes rebuild/list/get only; unconfigured incremental consumers are not exposed. Current source/projection/query authorization, trusted Actor/scope/time, bounded transactions and Store locks remain explicit configured ports; no default Allowed in production.
95b0aa/ea496d owning Kitchen typecheck, four changed-file lint and existing import/domain-layer validators pass; formatting applied. No changed SQL asset/schema/dependencies or boundary edges requiring ownership re-registration. Existing unchanged source/binding/store unit suites and installation evidence from prior recorded runs reused; no fullverify/build/install restart.
Original paid-ticket actual PostgreSQL composition:95b0aa/03913c current-clock Pickup47.807s passes;6ec67a/896339 current-clock Dining96.894s passes. Each uses original creation and lifecycle records to initialize a nonempty generation, recover exact rebuild replay, replace active generation with retained Retired history, then read through owner list/detail service. Exact isolated role grants for generation SELECT/INSERT/UPDATE, row SELECT/INSERT and existing UUID helper; no admin connection used by owner runtime. Fixture serializes projection reads using the same Store advisory lock as all owner writers, preserving generation/row consistency without attempting late SET TRANSACTION after Tenant context installation. Database assertions require one Active and one Retired generation, original work-item counts and completed status. Final Dining also checks detail original ticket/workitem, quantity, accepted/ready timestamps, equality with list item, no private source digest in public result, and revoked list/detail/rebuild refusal. Pickup predates only these strengthened shared detail assertions; original production composition unchanged, no repeat justified. Synthetic policy authority remains explicit in this helper; this is actual owner service/persistence evidence, not authenticated Merchant HTTP query/browser or operating Store authorization proof.
Reviewed d90e8d/bdbf68: new infrastructure composition contains no direct SQL or foreign private access; existing owner components remain authority. Query service owns public result redaction. Original dirty WP-2402 files preserved at baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26; no commit/push/deploy. All checks terminal and isolated suites completed cleanup.
Next required work: actual ongoing Kitchen queue refresh/consumer Worker recovery from original operations (avoid unnecessary new generations when source unchanged), authenticated Merchant list/detail and action UI, then original browser-originated ordering/merchant journey and long-lived scoped candidate process assembly. Existing outbox-workload supports nonoverlap/drain/failure propagation and may schedule real bounded owner work; apps/worker/AGENTS.md forbids fake activity. Current read-model only supports complete rebuilds; incremental event offset proof is not implemented or claimed. Goal remains active; no pilot completion claim.

Kitchen background refresh selection: priorb437e2 actual rebuild/read progress. Extend owner read-model with bounded refresh under existing scoped transaction/Store lock: read complete current source, compare content digests with active generation, skip unchanged source, otherwise call existing rebuild service in SAME transaction using captured source. Require a separate rebuild reference generator; no invented event offsets. Add Worker wrapper around existing nonoverlap/drain lifecycle invoking actual owner refresh, strict0/1 result and sanitized failure. Tests: owner content-match binding guards; Worker start/poll/no-overlap/stop/failure; original paid PostgreSQL flow starts actual workload, waits a second real cycle, confirms one initialization and no duplicate generation, then preserves existing rebuild/list/detail acceptance. Fresh owning types/affected lint/build for Worker, targeted tests and shared Pickup/Dining integration. No fullverify/install/dependency/schema change.

Refresh review found unchanged-content comparison must still reject a source snapshot older than active asOf; add temporal guard and direct clock-regression case before shared Dining. Preserve existing checkpoint comparator rejection. cce567/5a1c29 Pickup45.072s already proves ordinary init/changed/unchanged path; no repeat required for isolated regression guard once directly tested. a3ad91 Kitchen+Worker typecheck/Worker build passed before targeted tests failed to match root config; ea1399 correct workspace tests5+3 pass, lint found interface-style only, corrected64193a and cce567 lint/import/domain pass.

Kitchen background refresh checkpoint: owner read-model refresh acquires existing Store projection lock within configured scoped transaction, validates complete source and current stored projection, and compares source-derived content/event digests. A Fresh unchanged generation returns0 without insertion; changed/missing/stale generation calls existing rebuild service in the SAME transaction using captured source and expected active generation. New rebuild reference generation is explicit. Current authorization remains required before work and through existing source/store checks; older source asOf cannot be treated as unchanged. No event checkpoint/Inbox progress is fabricated.
createKitchenQueueWorkload schedules actual owner refresh through existing nonoverlap/drain workload, accepts only0/1, closes resources once and propagates sanitized failure. a3ad91 Kitchen+Worker typechecks/Worker build passed; root Vitest command selected no package tests (recorded failure, corrected). ea1399 correct Kitchen5 and Worker3 tests pass; existing outbox lifecycle implementation/tests unchanged. Interface-style lint correction64193a has no runtime effect; cce567 remaining lint and import/domain boundary validators pass. Final9e48a5 Kitchen typecheck/five binding tests (including snapshot-time regression)/affected lint pass after guard addition. Worker source unchanged since its successful type/build/unit checks, no repeats.
Actual original paid-ticket PostgreSQL Worker evidence:cce567/5a1c29 Pickup45.072s and9e48a5/58bcd8 Dining94.878s pass. Helper starts real timed workload before Kitchen commands, awaits at least two real cycles (1 then0), drains/stops once. Actual authenticated original Accept/Start/Complete commands then change source. A new workload instance recovers existing projection to Completed/Ready (1), repeated real cycles return0. Subsequent explicit rebuild replay/replacement and list/detail assertions still pass, retaining one Active and three Retired generations; repeated unchanged scans did not create generations. Final Dining includes revoked refresh/list/detail/rebuild denial. Tests exercise restart recovery and actual periodic unchanged checks; not yet a continuously running operational process across user activity or configured pilot Worker. No raw SQL/data logged, fixture deadline/timer cleared and workload stopped in finally.
Scope reviewed: source binding/content comparison, owner composition refresh, Worker wrapper/three tests, original isolated-database helper integration. No new schema, dependency, external service, commit/push/deploy. Existing installation and unchanged SQL asset/validator evidence reused; no fullverify. All tool handles terminal and integration cleanup completed. Goal remains active. Next authenticated Merchant Kitchen list/detail adapter/HTTP response serialization -> real frontend command/read flow, then long-lived API/Worker configured together with actual operational inputs and browser-originated pilot journeys. Incremental event consumers remain unavailable in this rebuild-based runtime and are not claimed as delivered.

Merchant Kitchen query selection: priord48adf Worker progress. Add current Workforce session/selected Store kitchen.operate adapter for bounded List/Get; body contains only query fields, authority/time derived server-side. Compose existing owner query service/SQL reader; owner shared Store projection lock guarantees generation/row consistency against existing exclusive writer lock in same transaction. POST /merchant/kitchen/query keeps identifiers out of URLs, existing Host/same-origin/cookie/CSRF/no-store guards, exact version strings in public results and typed errors. Fresh affected API type/build/lint, adapter/HTTP targeted tests and existing query tests for unchanged reader behavior; actual authenticated query integration next. No fullverify/install/schema.

Merchant Kitchen query checkpoint: new createMerchantKitchenQuery authenticates cookie/CSRF before business transaction, resolves current Workforce/OIDC session and selected Tenant/Brand/Store through existing createMerchantStoreScope for kitchen.operate, and derives Actor/scope/observedAt server-side. Closed List/Get inputs reject caller authority fields. Existing domain query service owns validation/public results; owner PostgreSQL query adapter rechecks permission. New owner lockPostgresKitchenQueueRead installs already-authorized Brand/Store RLS context and acquires shared Store projection lock paired with generation writer's exclusive lock, keeping generation and rows consistent. API exposes no recovery/consumer operation on this query path. Exact bigint item versions become decimal strings; all other fields are existing domain public view. MerchantRuntime optionally wires query, BFF POST /merchant/kitchen/query retains Host/same-origin/cookie/CSRF/no-query/no-store rules, typed400/403/404/409/503 and sanitized unknown failures.
18ab82/3cd08e API typecheck/build, eight adapter tests +34 BFF tests and all nine affected-file lint pass. Initialbf10e1/d91cff stopped at test mock call possibly undefined, corrected; no production checks claimed from stopped command. bf10e1 owning Kitchen typecheck passed; subsequent RLS installation uses existing typed query API, actual SQL verified below. cddcca eight existing query tests + ownership/import/domain-layer validators pass. Existing unchanged validator-test and installation evidence reused, no fullverify/install/schema change.
a916be/8d6efd current-clock Dining94.270s and Pickup44.522s pass on original actual paid Kitchen tickets. Existing HTTP test server now also composes real query adapter with actual encrypted Merchant session/selected scope/membership/policy. Lists return original completed work-item count and string versions; detail matches the same list item; actual kitchen permission grant withdrawal makes query return403. Existing command, Worker source change/recovery, projection activation/history, downstream fulfillment/receipt/refund assertions remain passing. One unrelated test filtered, no browser-originated query claim. Test server/Worker/isolated DB cleanup completed, all handles terminal.
Final scope review: no private cross-domain SQL or business rule in API, owner context/lock within registered SQL asset, current scope resolved before owner access, no unrestricted error/data logging, no stored browser credentials. Existing dirty WP-2402 work preserved at baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26; no commit/push/deploy. Next real merchant-web KitchenBoard client/read+command wiring. Read bop-screen-contract and merchant-web AGENTS; current client defaults Unavailable, App only wires demo client, current view lacks command versions. Resolve full KIT-KITCHEN-QUEUE/item Screen contract and actual metadata fields before editing UI; do not fabricate station labels/allergen/exception/operator facts absent from queue source. Persistent pilot config and original browser-originated journeys remain required. Goal active.

Kitchen browser read wiring selection: previous8524a4 real authenticated query evidence. KIT-KITCHEN-QUEUE /operations/kitchen and KIT-WORK-ITEM /operations/kitchen/work-items/:id are Phase1 standalone operations_web, kitchen.operate, registry Section88.10; retain existing layout/routes/accessibility. Existing public queue explicitly declares structuredAllergenAssistance/exception/claim NotAvailable, lacks operator lock and station names: display unavailable, never infer None/claimed/unlocked. Add bounded same-origin no-store query client, consistent-generation paging up to existing200item view bound, selected-store/CSRF keyed App wiring and manual refresh/retry; retain exact version/ready/acceptance fields in optional execution snapshot for next command wiring. No storage/replay, no visual redesign or new Figma needed. Fresh affected merchant type/lint/build and client/contract/render behavior tests; real browser proof remains next. Current action buttons stay disabled until real immutable-intent command wiring. No backend/DB changes, reuse prior query HTTP integration.

Browser selection added scoped production-project Playwright UI test with synthetic HTTP responses; this is frontend behavior proof only. b902e0/532d75 exposed an actual accessibility bug: aria-disabled on read-only card also disables its detail link. Restrict disabled semantics to command buttons; card records read-only state without disabling navigation. Rerun affected browser case only, no DB/business suites. Existing Playwright webServer rebuild is required by its config and includes this changed UI. 7870e2 merchant type passed, initial client test failure reused a consumed Response fixture; corrected fresh responses,169bf0 sixteen tests/lint/build pass before final hook/focus change. b902e0 final hook/focus type and lint pass.

Kitchen browser read checkpoint: createKitchenBoardClient uses authenticated same-origin POST /merchant/kitchen/query with CSRF/no-store/redirect rejection/15s timeout/1MiB response bound. It reads up to four50-item pages only within one generation, rejects duplicates/mixed generations/incomplete or over200-item coverage instead of silently truncating, and maps typed permission/notfound/conflict/offline states. No storage or automatic replay. Item execution snapshot retains exact ticket/work-item version strings, item/station refs and accepted/ready timestamps for upcoming command wiring. Existing projection future fields are unavailable, not None or acknowledged; absent station names/operator lock facts also remain unavailable.
App now supplies current in-memory CSRF/selected Store label for real Kitchen queue/detail routes, remounts on Store/CSRF change and hides old route during switching; explicit demo client remains supported. Manual refresh/retry is wired. Loader binds returned state to current key/function so route/refresh changes cannot render an old response while waiting. Refresh restores keyboard focus. No new layout/visual redesign. Commands remain disabled pending actual immutable-intent handler; accepted-source safety/claim/operator metadata must not be invented to enable them.
169bf0 client10+contract2+screen4 tests (16) and affected lint/production build pass;7870e2 initial owning typecheck pass. b902e0 final route-key/focus type and lint pass. Final93cd05 single production-fail-closed Playwright test passes4.4s: actual browser built application -> synthetic same-origin queue/detail responses, keyboard refresh, forbidden refresh clears old data, keyboard recovery, disabled commands, no local/session storage and expected5requests. Browser initially532d75 failed because read-only aria-disabled card disabled child link; replaced with data-read-only and retained actual disabled buttons, retested successfully. Existing Playwright webServer mandatory build reran for changed UI; large-chunk warning remains existing app build warning, not a build failure. No claim of browser-to-real-DB or command acceptance from this mocked browser test. Prior8524a4 backend actual PostgreSQL/HTTP evidence unchanged and reused; no unnecessary business regression.
Scoped review: current Screen routes/permissions retained, values rendered as text, authority facts not inferred, no credentials persisted/logged, no dependency/schema/API changes this turn. Existing dirty WP-2402 work preserved; no commit/push/deploy. All check handles complete and Playwright servers cleaned. Next immutable user-intent Kitchen command client/actions with truthful current operator/preparation authority, version-conflict and lost-response recovery; then actual database-backed merchant browser journey with ongoing configured Worker. Queue bound beyond200 needs explicit usable paging/filter behavior before declaring operational pilot coverage; current client fails closed rather than hides remaining work. Goal remains active.

Kitchen browser command selection: prior7ac7ad read-page progress. Current accepted WP-1804 requires Fresh+Named for actionable board; existing current Workforce/OIDC session composition now supplies named Actor/selected Store authority. Query reports Named only after current session/permission checks, with selected Store reference; does not assert device/KDS lock, claim, safety acknowledgement or station names. Add closed CurrentMerchantSession transport form for existing lifecycle endpoint: server derives Actor/Brand, keeps client expected Store/versions/intent key immutable and checks actual current Store, then delegates unchanged owner parser/service. Existing full-domain transport retained. Add browser immutable command prepare/execute supporting accepted lifecycle actions, exact versions, same-key retry/abort/unknown outcomes without storage/auto-replay. UI action hookup remains after this foundation passes. Fresh adapter/query tests/type/build/lint and original HTTP Pickup/Dining once for changed authentication/composition; client exact body/retry/malformed-response tests. No business rule/schema/dependency/fullverify.

Kitchen command integration correction: f53017/42211d API and merchant types plus50API/10client tests pass;6adf17 API build and affected lint pass. ac6385 original Dining/Pickup fail at Start admission: synthetic admission adapter captured raw HTTP command.actorReference, now intentionally absent in browser intent. Owner service already supplies canonical authorized command to admission.resolve; change fixture to use that command for Actor/item/versions. No production authority relaxation. Rerun the two affected actual HTTP journeys after fixture correction; no repetition of unchanged unit/build checks.

Kitchen browser command foundation checkpoint: API now accepts exact closed CurrentMerchantSession intent, derives Actor/Brand from current authenticated Workforce scope, preserves expected Store and versions, rejects body Actor injection and changed Store, and delegates existing owner service. Query exposes current Named operator and selected Store only after current permission checks; it does not prove device unlock, claim or safety acknowledgement.
Browser prepare/execute freezes one command body and idempotency key per explicit user intent. It supports Accept/Start/Complete/Ready, exact decimal versions, remaining completion quantity, bounded timeout, explicit same-key retry after unknown response, and typed permission/conflict/precondition errors. No automatic retry or browser storage. UI is not yet wired to commands and remains read-only.
Fresh f53017/42211d API and merchant typechecks,50 API adapter/BFF tests and10 browser command tests pass.6adf17 API build and affected lint pass. Original HTTP integration initially failed ac6385 because synthetic admission captured raw browser Actor;78a0e3 fixes fixture to use canonical authorized command supplied by domain service, without changing production authorization. d0da07/1897dd final original paid Dining94.276s and Pickup44.671s pass through actual HTTP CurrentMerchantSession transport, persistent lifecycle and existing Worker/read-model/downstream assertions; one unrelated case filtered. Changed fixture format/lint pass. Prior successful unit/build evidence reused as production unchanged after those runs.
Scope review: production changes limited to command/query transport and new browser client; exact current scope remains server-enforced, source/business logic unchanged, no private cross-domain SQL, migration, dependencies, credentials or external operations. Baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 plus existing uncommitted WP work preserved. All check handles terminal, isolated cleanup completed. No fullverify/install/commit/push/deploy. Goal remains active.
Next: pass selected Store to browser read client and compare response scope, consume actual current operator status; connect immutable intents to existing Kitchen buttons with Fresh+Named gating, immediate duplicate-submit guard, preserved same-key unknown-result recovery, authoritative refresh and no action until refreshed projection reaches returned versions. Detail remains read-only unless its freshness/operator authority is carried explicitly. Then actual browser-to-database original flow with continuously configured Worker, large-queue paging and remaining pilot runtime/fulfillment work. This checkpoint is not pilot completion.

Kitchen button wiring selection: previous8a34cf foundation passed. Wire existing board actions only with actual selected Store match, Fresh projection and Named current session. Keep detail read-only pending explicit detail freshness. One in-memory prepared intent at a time; synchronous duplicate guard, cancel on unmount, explicit identical-key unknown retry, block subsequent actions until authoritative refreshed versions catch up; conflict/denial requires refresh. No automatic mutation retry, storage or fabricated safety facts. Fresh affected merchant type/lint plus client/screen tests and production-project browser scenarios for unknown recovery/stale projection/conflict; prior unchanged API/DB evidence reused.

Kitchen UI verification correction: aca71c/4ae8b0 merchant typecheck and17client/screen/contract tests pass. Lint required interface declaration, corrected without runtime change;7f182d affected lint and configured production browser build pass. New command browser scenario passes including identical-key lost-response recovery, stale-projection block, conflict refresh, Start and Complete. Existing read-navigation test raced the transition and matched two headings on old detail page; wait for queue URL and queue heading before card assertion. Rerun only this read-navigation case; command scenario and unchanged API/DB checks remain reusable.

Kitchen board actions checkpoint: real App routes now pass selected Store into Kitchen client. Every query response must match that Store and carry recognized current operator state; Named is consumed from authenticated API, missing/foreign scope fails closed. Existing cards expose Accept, Start, remaining-quantity Complete and Mark ready according to current item status/acceptance/ready facts, only with Fresh+Named and actual command wiring. Server remains the business/permission authority. Detail retains read-only behavior.
useKitchenActions keeps one immutable in-memory prepared intent, synchronously guards duplicate submissions, aborts on unmount, offers explicit same-key retry for outcome unknown, and blocks all new actions until confirmed ticket/work versions appear in refreshed queue. Rejected operations require a later successful authorized refresh. No auto retry, browser storage, guessed claim/allergy/station facts or optimistic lifecycle transitions.
Fresh aca71c/4ae8b0 merchant typecheck and17 affected read-client/screen/contract tests pass; initial2b2032 strict optional and union typing failures corrected. Final7f182d affected lint and configured production build pass after interface-only style correction. New production-project browser command scenario passes: actual built UI with synthetic HTTP, lost response + identical request replay, old projection still blocks, refreshed versions enable Start, conflict blocks until refresh, Complete submits remaining2 and final ready state disables further lifecycle buttons; no local/session storage. Existing read case initially raced old detail DOM; explicit route+queue-heading wait fixed57ed27. Final21c64a read browser case passes4.6s (keyboard refresh, permission-denial clearing, retry, detail navigation); configured mandatory browser server build passes with existing large-chunk warning. Both scenarios have passing evidence, all processes terminal/servers cleaned. This is mocked browser behavior, not browser-to-real-DB proof.
Review: only merchant UI/client/tests and WP changed; no backend/domain/persistence/dependency changes. Prior d0da07/1897dd actual Dining/Pickup CurrentMerchantSession HTTP evidence and unchanged command-client10tests reused, no DB rerun/fullverify/install. Existing dirty work preserved, no commit/push/deploy. Next compose actual merchant browser against original paid persistent ticket and continuing Worker, then bounded usable queue paging and persistent pilot runtime/remaining fulfillment; full goal active and not complete.

Actual Kitchen browser milestone selection: prior16c50e UI evidence. Opt-in BOP_KITCHEN_BROWSER runs built App over ephemeral HTTPS with actual persisted Merchant bootstrap/session/selected scope and existing Store published operating evidence, original paid ticket, real lifecycle/query adapters and continuously running snapshot Worker. Preserve baseline HTTP race/replay scenarios when opt-in off; browser path uses actual generated intent IDs and retains replay/proof/downstream assertions. No route interception or fabricated session response. Fresh affected helper lint and original current-clock Pickup then Dining with browser enabled; existing unchanged frontend build21c64a reused for first run. Fixture identity options are exposed locally for existing full BFF composition, not logged or persisted.

Actual Kitchen browser intermediate: ea4ba3/8361db original current-clock Pickup passes48.607s with BOP_KITCHEN_BROWSER=1. Built App uses actual persisted bootstrap/Store published status, actual HTTPS owner commands, current session/query and continuous Worker; browser-generated keys retained in replay/proof/downstream checks. No route interception. Affected helper lint passed; initialc41f6d lint stopped before test for missing explicit process import, corrected2641e9. Add cleanup for early continuous-worker handoff validation failure; no success-path behavior change, cover next Dining run rather than repeat Pickup.

Actual Kitchen browser milestone checkpoint: BOP_KITCHEN_BROWSER=1 now runs the original paid current-clock ticket through the built merchant App over local ephemeral HTTPS. createPersistentMerchantBffService bootstraps the actual encrypted database session, current selected scope/membership/permissions, existing published Store operating evidence and owner labels; no mocked session/query/command response or route interception. Explicit isolated synthetic identity/provider and Live Gate/business policies remain test inputs. Browser cookie restores an already-issued session; this is not live OIDC/provider onboarding.
Browser clicks Accept, Start and Complete for every original item; commands use actual browser-generated immutable IDs. Their exact bodies feed retained idempotent replay, persisted lifecycle proof and downstream ready-event assertions. Continuous Kitchen Worker runs from before first browser query through all transitions; UI refresh waits for actual activated versions before further actions. Actual kitchen permission withdrawal clears browser cards and shows denial. No browser storage. HTTPS server/browser/temporary certificate/Worker/isolated DB resources close in finally paths.
Fresh ea4ba3/8361db Pickup48.607s and c5a0be/5ee47f Dining99.761s pass with opt-in browser. Dining covers two original items and validates continuous generation history; Pickup covers one original item. Existing downstream fulfillment/customer state/receipt/refund assertions remain included. Affected helper lint passes; initialc41f6d lint failure corrected before tests. cbf880 adds cleanup for early Worker handoff validation failure, covered in final helper lint/Dining success path (no separate injected-failure claim). Non-browser races remain in existing default path and earlier1897dd evidence; browser mode executes user commands sequentially, never claims concurrent browser race coverage.
Production frontend/backend/domain unchanged since prior passing builds; reuse21c64a actual built artifact and prior unit/type checks. No reinstallation/fullverify/schema/external service changes/commit/push/deploy. Scope review: only isolated integration helper wiring and WP; identity options remain local, credentials never logged, actual least-privilege owner composition and source verification retained. All handles terminal.
1235bf current local candidate-v4 inventory confirms182 migrated tableset history, API/Worker roles and admission/abuse factories exist, but business grants and usable long-lived API/Worker composition remain missing; no Store/legal/Provider/menu/workforce fact invented. Next productive work is usable queue paging plus remaining merchant Pickup UI/HTTP and long-lived runtime assembly/browser-originated checkout. This milestone proves actual merchant Kitchen browser-to-database flow in both original test journeys, not a complete operational single-store pilot. Goal active.

Merchant Pickup handoff adapter selection: WP1805 identifies FUL-PICKUP-QUEUE/contextualHANDOFF and requires proof plus exact-target explicit confirmation. WP2402 authorized persistent pilot supersedes old presentation-only scope for this new composition. Fulfillment public store remains sole writer; API derives current Actor/Brand/permission, expected Store remains intent, retrieves persisted verification through owner lock, generates server references/time for new request and retains original references/time on idempotent recovery. Device/location admission remains configured required port, never default Allowed. No UI enablement yet, no proof issuance/verification invented. Fresh adapter tests/API type/build/lint/import boundaries; actual HTTP/DB milestone follows route composition. Prior unchanged owner persistence evidence retained.

Pickup composition verification: b21d87/9ff0dc production type passed;f803b8/68230a nine adapter tests/lint/build/import boundary pass. Final review identified concurrent same-key recovery ordering: lock owner fulfillment before reading prior idempotent result, so concurrent intent recovery sees original server-generated refs/time after lock serialization. Adjust ordering and add contract assertion; fresh affected test/type/build/lint required for this production change, no unchanged Kitchen/DB rerun. Actual concurrent database/HTTP evidence remains upcoming, unit order assertion is not that evidence.

Merchant Pickup handoff composition checkpoint: new createMerchantPickupHandoff authenticates before transaction, accepts a closed intent without Actor/permissions/proof record/server time, checks expected selected Store against current Workforce scope and fulfillment.pickup.complete, installs explicit context through configured port and uses existing Fulfillment public store only. Locks current fulfillment before recovering original intent, resolves submitted verification reference against stored verification history, and delegates all business/source/device/location admission and append-only completion to owner. New server refs/time are generated only absent prior; recovery preserves originals while retaining submitted target/quantity/recipient/version/correlation, so owner detects altered reuse. Response includes only completion status/reference/phase/exact version, no proof or contact data.
Fresh1310e6/446826 API type and9adapter tests pass on final production ordering;769f45/82305e final lint/build pass. Initial lint non-null assertion in test corrected0bb983 without production change; behavior evidence reused for unchanged assertions except equivalent fail-closed missing-order fallback. Earlier68230a import boundary pass remains valid: same imports/exports/dependencies unchanged. No API route/runtime/browser wiring or real DB claim yet. No fullverify/install/owner regression. Existing default current-clock fulfillment proof/handoff evidence remains previous real owner evidence, not new adapter integration.
Tests cover pre-transaction authentication, body authority rejection, changed Store/revoked permission, persisted verification requirement, exact bigint transport, current permission recheck and original server-reference/time recovery without replacing altered user intent. Mocked owner tests do not prove concurrent database serialization; next HTTP integration must verify same-key concurrent/replay behavior against actual owner locks.
Scope review: two API files plus WP; no business rules/private SQL/schema/dependency/external changes. Baseline a0f35440cacff1ab55be78edfb08cb4de90c1a26 and pre-existing work preserved. No commit/push/deploy. All handles terminal. Next add BFF route/runtime and original Pickup HTTP adapter acceptance, then owner queue/proof verification and explicit UI handoff. Never enable UI with synthetic device/location/proof assumptions; actual pilot operational configuration remains outstanding. Goal active.

Pickup HTTP milestone selection: extend BFF/runtime with optional POST /pickup/handoff, same-origin cookie/CSRF/query rejection/no-store and typed error mapping. Reuse adaptercf2cda unchanged unless actual evidence requires correction. Original current-clock Pickup must execute real authenticated HTTP with current persisted staff/scope/permission, exact persisted proof, configured synthetic device/location admission, concurrent same-key request and altered intent rejection, one completion publication and existing downstream Order/receipt/refund. Fresh BFF targeted suite/API type/build/lint and one original Pickup DB milestone; unchanged Dining/Kitchen/browser tests reused.

Pickup HTTP verification correction:1b1e1f/cc61e5 API type and35BFF tests pass;da5d82 affected lint/build pass after fixture logger comments. a06591 actual Pickup reached successful concurrent Applied/AlreadyApplied HTTP replies with same handoff ID, then fixture's independent recovery assertion returned null because it omitted RLS Brand/Store context. API already installs it. Add context to that assertion transaction; rerun affected Pickup only, no production change or repeated BFF/build tests.

Pickup HTTP handoff milestone checkpoint: BFF/runtime expose optional POST /merchant/pickup/handoff using existing same-origin/Host/cookie/CSRF/no-query/no-store protections. Unconfigured returns503; owner input400/permission403/precondition422/conflict409 errors are public typed codes, unknown failures remain generic without payload/SQL. Runtime uses current persistent Merchant service with previously verified adapter. No UI enabled by this endpoint alone.
Original current-clock Pickup now seeds explicit isolated persisted Merchant membership/permission/session and submits actual HTTP intents through API. Invalid CSRF, injected Actor, mismatched Store, missing stored verification and denied configured device/location admission reject. Concurrent identical intents return one Applied and one AlreadyApplied with same handoff reference; recovery reads actual stored effect under scoped RLS, subsequent same intent replays, changed recipient conflicts, revoked permission blocks recovery. Exactly one proof, verification, handoff and completion publication remains asserted; original downstream FulfillmentCompleted/Order/receipt/refund assertions pass. Proof creation/verification and device/location admission remain explicit synthetic fixture inputs, not completed browser proof entry or real Store registration.
Fresh1b1e1f/cc61e5 API type and35BFF tests pass. da5d82 affected lint/API build pass after logger-only style fix. Initiala06591 HTTP integration succeeded through concurrent results but failed independent fixture recovery due omitted RLS context;061490 corrects assertion transaction, not production. Finalbf9a3f/0d2fce actual current-clock Pickup46.747s passes, two unrelated cases filtered; changed fixture lint/format passes. No repeat unchanged types/BFF/build or Dining/Kitchen/browser suites. Prior cf2cda adapter nine tests and import-boundary evidence reused; same imports/owner contracts remain. All handles terminal/server and isolated database cleaned.
Scope review: BFF/runtime/route tests, isolated merchant permission/HTTP/handoff helper and original Pickup call; no Domain rule/private foreign SQL/schema/dependency changes. Current permission and server proof lookup preserved, credentials never logged. Existing uncommitted WP work preserved; no commit/push/deploy. Next real owner Pickup queue and proof verification transport/client plus explicit browser handoff; long-lived API/Worker assembly, browser-originated checkout and operational inputs remain outstanding. Full goal active.

Pickup proof verification selection: WP1602/1005 keep raw code at boundary, hashed selectors in Fulfillment, proof verification grants no completion authority. Add authenticated current-scope proof adapter with closed target/generation/kind/credential intent, mandatory independently committed attempt-budget port and purpose-scoped hash port. Current owner lock/source/capability plus validatePickupProof/store.verify remain authority. Saved verification refs/time retained on identical-key recovery; new response contains verification reference/current version only, never raw/hash/proof record. Explicit current expiry/generation still checked on retries. Fresh adapter/type/lint/build and actual original Pickup HTTP milestone after route hookup, reusing unrelated prior suites.

Pickup proof HTTP milestone checkpoint: new createMerchantPickupProof accepts closed exact-target/generation/kind/credential intent after current Merchant authentication, rechecks fulfillment.pickup.complete and selected Store, requires independently committed attempt-budget and purpose/kind/scope/pepper-version hash ports, then locks owner Ready source and delegates current capability/generation/expiry/selector validation to Fulfillment. Owner history retains successful verification only. Same-key recovery retains original verification/operation refs/time but still checks current validity and secret; altered correlation conflicts. Mandatory audit hook receives actual current Actor. Response omits raw code/hash/full proof record and explicitly states grantsCompletionAuthority:false. Raw code is boundary-local only.
POST /merchant/pickup/proof and optional runtime composition retain same-origin/Host/CSRF/no-query/no-store protection and bounded public errors, no fallback authorization/attempt-budget implementation. Existing handoff remains a separately authorized exact-target command. Proof issuance/customer delivery, real Device/location policy and durable configured Merchant attempt-budget remain outstanding; isolated test uses in-memory denial/count port and ephemeral purpose-separated HMAC, not production abuse-budget evidence.
Fresh5d119d/050239 API type passes;54485c/7a23a7 BFF36tests, affected lint, API build and import boundary pass. Actual current-clock Pickup48.277s passes with new raw HumanCode->HTTP->stored verification->HTTP handoff path: wrong code/wrong generation denied, concurrent same-key verification gives one Applied/one AlreadyApplied and same reference, wrong secret on retry denied, changed correlation conflicts, budget refusal denied, no hash/code in response, saved verification authorizes separately gated actual handoff. Existing one-proof/one-verification/one-handoff/one-completion publication and downstream Order/receipt/refund assertions remain passing. Two unrelated cases filtered. Actual integration covers adapter behavior instead of duplicating mock tests. Opaque grammar implemented but no claim of new actual Opaque end-to-end evidence; existing domain policy evidence reused unchanged. No new expiry-clock test claim.
Scope review: API composition/routes/runtime and isolated original Pickup helper only; no Domain business rule/private foreign SQL/schema/dependency changes. Credentials never output; audit receives Actor, no raw code persisted. Prior unrelated Kitchen/Dining/browser suites/builds reused with unchanged inputs. No fullverify/install/commit/push/deploy. All handles terminal and cleanup completed. Next owner Pickup queue plus UI proof input/explicit handoff, customer proof delivery, durable configured attempt budgets and long-lived pilot assembly remain. Full goal active.

Pickup current queue selection: add owner list query to existing registered Fulfillment readiness store, not a new materialized projection or API private SQL. Candidate keyset query uses Ready history and excludes recorded Completed by default; current state must be reconstructed/validated by existing source+proof+handoff readers under owner locks. Explicit queue permission before/after plus each order authorization, bounded1..50page with next cursor. Return versions/quantities/readyAt and nonsecret proof metadata; no hashes, records, recipient data, fabricated package/claim/allergen/Order number. Fresh owning type and focused query-boundary tests, original Pickup actual before-proof/verified/completed reads, applicable lint/ownership/import/domain boundaries. Unchanged domain rules/builds reused.

Pickup owner queue checkpoint: existing registered Fulfillment readiness store now exposes listPickupQueue with explicit authorizeQueue before/after reads and existing per-order current/source checks. Candidate query is scoped to Brand/Store/Pickup, uses actual Ready append-only history, excludes Completed handoff history by default and keyset-pages by fulfillment reference with limit1..50 plus one lookahead. Every scanned result is reconstructed under existing owner advisory/row locks through validated creation/readiness/proof/handoff history. Completed races are omitted from active page; cursor advances over scanned candidates. No phase inferred from immutable creation header.
Public owner contract exposes current source/observation time, order/fulfillment refs, exact aggregate version, readyAt, item quantities, nullable public display reference and nonsecret proof kind/generation/expiry. It returns no raw code/hash, verification record, recipient/device history, guessed package/claim/allergen/station facts. This is a current owner query, not a newly persisted asynchronous projection. Existing callers without authorizeQueue cannot list.
Fresh7680ca/143c62 owning type and5boundary tests pass. Initial5cd4e0 branded-reference/test-mock typing fixedc9ab8d; final28fd23 affected lint and database-ownership/import/domain-layer validators pass after test-only unused-parameter correction80f6bc. No new SQL asset path/table/schema or widened validator allowlist. Existing exact ownership tests unchanged and reusable. Root original Pickup28fd23/15c95347.796s passes: one original Ready order before proof has null proof/display reference; after actual HTTP verification queue exposes current version/kind/generation/zero handed quantity without secret fields; after actual HTTP handoff active page empty, completed-inclusive page returns Completed with handed quantities; keyset-after-original returns empty; revoked queue authorization denies. Existing proof/handoff concurrent/replay/downstream assertions remain passing. This verifies real one-order pagination boundary, not a multi-page load/performance claim.
No API/HTTP/UI queue wiring claimed yet; next compose current Merchant scope and decimal version transport, then browser page/proof/explicit handoff. New shared API is additive with unchanged prior methods and optional queue policy; prior consumer/Kitchen/Dining/browser evidence reused, no unrelated fullverify/install/build repetition. Scope reviewed, prior dirty work preserved, no secrets/external changes/commit/push/deploy. All handles terminal and isolated cleanup complete. Long-lived pilot/runtime/customer proof delivery and full-browser checkout remain outstanding; goal active.

Pickup queue transport selection: priorf3832a owner evidence. Add closed same-origin POST queue request (cursor/limit/includeCompleted only), resolve actual Merchant session/current Store and fulfillment.pickup.complete before owner list, install explicit scope and serialize bigint versions as decimal strings. Include actual selected Store in response; no browser authority accepted. Fresh API type/BFF route protection/lint/build and original Pickup HTTP queue assertions (current Ready, completed exclusion/history, revoked permission). Reuse unchanged owner query tests/validators, Kitchen/Dining/browser evidence. Operational Store/menu/tax/Provider input requested asynchronously; continue independent code.

Queue permission reconciliation before closeout: screen-registry FUL-PICKUP-QUEUE line4291 explicitly requires fulfillment.operate, while WP1602/1603 proof/handoff require fulfillment.pickup.complete. f927bd/f6c030 type/BFF37/lint/build and b2662e original HTTP Pickup49.245s passed initial overly restrictive query permission, but do not constitute canonical permission coverage. Correct query to fulfillment.operate; fixture grants both independently, verifies complete revocation still allows queue, then queue revocation denies. Fresh affected API type/build/lint and Pickup for changed authorization; unchanged BFF route suite reused. No accepted decision reopened.

9ff436 caught denied initial queue after permission edit: removal of obsolete imported constant also removed the same argument token at its call site, shifting sessionReference into action. Source inspectione3f20d proves issue; explicitly restore four arguments with fulfillment.operate and expectedSession. No permission bypass; failed closed. Final affected type/build and actual Pickup rerun required; previously unchanged BFF37 suite stays valid.

Pickup queue HTTP checkpoint: createMerchantPickupQuery resolves current Workforce/OIDC session and selected Store using canonical fulfillment.operate, accepts only cursor/limit/includeCompleted, installs caller-owned scope and delegates existing owner current list. Public versions are decimal strings and response carries actual Store reference. BFF POST /merchant/pickup/query is optional/unavailable503 until configured, uses existing same-origin/Host/cookie/CSRF/no-query/no-store controls and typed bounded failures. Runtime composition added. Proof/handoff remain independently protected by fulfillment.pickup.complete.
Freshf927bd/f6c030 API type/BFF37tests/lint/build passed initial transport. Canonical Screen permission reconciliation18997a required auth change;9ff436 caught accidental call-argument removal from text replacement, fixed15551e to explicit action + expected session. Final803358/ba07f8/95de8e type/lint/build and original current-clock Pickup51.604s pass. Actual HTTP verifies target Store/exact decimal version, injected Actor rejection, completed exclusion and completed-inclusive history; revoking complete permission leaves queue readable, revoking fulfillment.operate then rejects queue. Proof/handoff concurrency/replay/downstream Order/receipt/refund assertions remain included. Earlierb2662e is superseded for permission semantics. No repeated unchanged BFF37 suite, owner validators, Kitchen/Dining/browser checks or installation.
Scope review: API query/routes/runtime, route test, isolated queue transport and distinct synthetic permission grants/revocation only. No Domain/schema/private foreign SQL/dependency/external changes. All handles terminal and cleanup complete. No commit/push/deploy. Next merchant Pickup client/page with cursor navigation and explicit proof/handoff controls, plus real configured workstation/location admission; never derive missing facts. Store/menu/tax/Provider setup question sent asynchronously this turn; no answer yet, not assumed or blocking independent code. Long-lived runtime and customer proof delivery/full browser checkout remain; goal active.

Pickup browser read selection: FUL-PICKUP-QUEUE /operations/pickup, fulfillment.operate from registry4291. Wire existing layout to real same-origin queue with current Store match and in-memory CSRF, one bounded50-item page plus explicit previous/next and completed toggle. Extend strict DTO only for nullable/unavailable facts and optional execution metadata/next cursor; reuse original100line Fulfillment bound/exact versions, no fabricated Order number/package/allergy/claim. Prevent old-client/old-key flashes, clear denied data, keyboard refresh focus. Commands remain disabled until explicit proof/handoff flow wired. Fresh merchant type/lint/client/contract/render tests and production-project browser paging/scope/denial scenario; no unchanged API/DB/Kitchen regression.

Pickup browser read checkpoint: App now supplies current Store/label/in-memory CSRF to /operations/pickup, keyed by Store+CSRF and hidden during Store switching. createPickupClient uses same-origin POST, no-store/redirect rejection,15s timeout/1MiB response ceiling and50-row pages, rejects mismatched Store/unsafe versions/duplicates/nonadvancing cursors, and allows empty advancing pages after concurrent completions. No automatic replay/storage. Current owner source maps to existing Screen view with explicit current observation time.
Strict optional execution DTO retains exact version, public display reference, nonsecret proof metadata and up to owning100 bounded quantity lines. Missing Order number/package/claim/allergy/exception/staging facts are null/unavailable, never zero/None guesses. Old fixtures remain accepted. Ready proof cue requires Ready phase and unexpired metadata at server observation time; it is not proof verification or completion authority.
Page now has previous/next, completed inclusion, current-page filtering, manual refresh/retry and keyboard focus recovery. Stored result is tied to current load/key so changing page/filter/client never flashes old data; denied/wrong-Store responses clear cards. Existing proof/claim/handoff actions remain explicitly disabled until their real interaction handlers are wired; no inert enabled action. Functional extension of existing Section88 layout, no redesign.
Fresh9029a3/93fce6 merchant typecheck,13 client/DTO/render tests, affected lint and production-project Playwright pass on first complete run. Browser4.4s verifies two synthetic HTTP pages, previous/next/focus, completed toggle resetting cursor, permission denial clearing, keyboard recovery and foreign Store rejection, no storage. Configured browser production build passes with existing large-chunk warning. This is built UI/mock-transport evidence, not new actual Pickup browser-to-database proof. Prior803358/95de8e real queue/proof/handoff HTTP and owner evidence reused unchanged, no DB/business-suite/install/fullverify repetition.
Scope review: frontend contract/client/page/App/tests only plus WP, no backend/schema/dependency changes. All handles terminal and servers cleaned; prior dirty work preserved; no commit/push/deploy. Next Pickup proof input and immutable-intent recovery, explicit handoff and configured current workstation/location context, followed by actual original browser journey. Customer proof issuance/delivery, durable runtime policies and long-lived pilot remain; Store setup question remains unanswered, no facts inferred. Goal active.

Pickup proof browser command selection: immutable same-key intent transport, strict target/generation/version response validation, no automatic retry or credential storage; explicit disposal clears retained request on success or abandonment. Fresh merchant typecheck, affected lint and command unit tests cover lost response/retry, malformed response, disposal, aborted input and terminal denial. Queue/API/DB inputs unchanged, reuse their prior evidence. UI wiring and configured workstation admission remain subsequent scoped work.

Proof client da64d1/e45bf0: merchant typecheck,12 focused tests and lint pass. UI selection: existing Pickup cards expose explicit credential form only for fresh Ready source with execution; no storage, focused password input, same-intent explicit unknown retry, terminal refresh requirement, dispose/abort on unmount. Handoff stays disabled pending trusted workstation composition. Add lost-response recovery to existing production browser paging test; fresh affected type/render tests/lint/configured production browser build; unchanged proof-client unit evidence reused.

Pickup proof browser checkpoint: new disposable pickup-proof-client snapshots exact Store/order/Fulfillment/proof generation and immutable idempotency/correlation references; HumanCode six digits and canonical16-byte Opaque encoding checked locally. Sends only same-origin/no-store bounded-time POST; no automatic retry/storage. Concurrent execute denied; unknown outcome retains same body for explicit retry. Exact response target/generation/decimal version/non-authority validation; success or terminal denial disposes retained request. Explicit dispose plus abort used on form unmount; no credential/selector exposed in errors or result.
Existing Pickup card now opens focused password input when source Fresh/Ready and actual execution/session context are available. Submission clears input, unknown reply offers same verification retry, terminal rejection requires queue refresh. Success explicitly states handoff incomplete. No fabricated workstation/device/location or enabled inert handoff. Verification reference is currently consumed only by validation, not retained for handoff; next composition must retain it in scoped flow state and require explicit order/quantity confirmation plus actual configured admission. Navigating/refreshing unmounts and abandons proof form without automatic replay.
Fresh da64d1/e45bf0 merchant typecheck,12 immutable intent unit cases and client lint pass. After form wiring,917a8a/3137b4/d87a36 merchant typecheck,2 existing page render cases, affected lint and configured production build/browser pass. Browser6.5s synthetic transport now covers focused credential input, lost response, identical explicit retry, cleared input and handoff staying disabled, plus existing paging/Store/denial recovery/storage checks. Existing large build-chunk warning unchanged. No actual browser-to-DB Pickup verification claim; prior authenticated original HTTP/DB evidence reused, backend unchanged. No redundant fullverify/install/DB runs.
Final2ee322 scope/lifecycle review: three new frontend files, existing Pickup page and browser test, WP notes only; prior dirty work preserved. All handles terminal and browser servers cleaned. No commit/push/deploy/external-service changes. Goal active: next retain verified result for real explicit handoff with configured workstation admission, original actual Pickup browser journey, customer proof delivery and durable long-lived runtime. Operational Store/menu/tax/Provider input still pending, not inferred.

Pickup workstation selection: optional server-configured resolver receives current authenticated Actor/session and selected Brand/Store after queue authorization. Return only validated device/location references or null; never accept workstation from query or equate configured context with completion authority. Queue rechecks authorization after resolver. Add strict optional frontend view field; old fixtures keep null/unavailable behavior. Fresh API/merchant types, scoped resolver/client tests, affected lint and API build. Existing actual queue/proof/handoff SQL and admission paths unchanged; reuse previous original HTTP/DB evidence for those inputs. Actual configured-workstation browser handoff remains next.

Handoff browser command selection: snapshot current verified target/generation/exact version, configured workstation, operator-selected recipient type/masked descriptor and remaining ready quantities. Reject mismatched verification before network, retain immutable same-key request only for unknown retry, no automatic replay. Fresh command tests/type/lint; frontend confirmation wiring and full browser integration remain next, no unchanged DB rerun.

Pickup configured workstation checkpoint: createMerchantPickupQuery optional resolveWorkstation receives current authenticated session/Actor and selected Brand/Store within scoped transaction, after queue permission and owner read. Unconfigured returns null; configured device/location references validated before response; queue permission rechecked after resolution. Query still closed against caller authority/workstation injection. Configured identifiers do not authorize completion: existing handoff owner admit/current permission remains unchanged. Runtime factory inherits optional resolver through existing options, actual pilot resolver not yet installed.
Frontend strict PickupWorkstation parses exactly two UUIDv7 references, optional queue field preserves old fixtures; real queue client maps absent field to null and rejects extra authority fields. Fresh fdf457/c5aa73/418c39 API+merchant types,4 API auth/configuration cases,10 queue client +2 DTO tests, affected lint and API build pass. SQL/owner implementation unchanged; no DB/fullverify/install rerun. Previous original authenticated queue/handoff evidence remains valid for unchanged owner/admission inputs, does not prove new real workstation resolution.
New pickup-handoff-client snapshots verified Fulfillment/generation/exact source version, configured device/location, recipient type/masked descriptor and remaining ready quantities, requiring nonempty quantity list. Browser supplies no Actor/permissions. Explicit same-key retry on unknown response, no auto retry/storage; parallel request blocked, success/terminal denial disposes intent; response requires matched target, increasing exact version and valid phase. Fresh224168/894255 merchant typecheck,12 focused handoff tests and lint pass. 9f13e7 inspected immutable body/target/version/quantity implementation. This client is not yet wired to a confirmation form; proof result still needs retained scoped UI state. No browser or production frontend build rerun for not-yet-wired command; next UI milestone will include affected built browser checks.
All current check handles terminal. Scope limited to queue workstation transport, frontend contract/client, new handoff client/tests and WP; no schema/dependencies or external operations, existing dirty work preserved. Next: retain verification result, display exact order/remaining quantity confirmation and recipient selection, execute configured handoff with unknown-outcome recovery that cannot be silently discarded by in-page refresh/navigation, then original actual Pickup browser/DB journey. Customer proof delivery, durable runtime composition and operational inputs remain outstanding; goal active.

Pickup confirmation UI selection: retain proof result in scoped form memory; configured workstation enables native modal exact order/remaining quantity confirmation, explicit recipient type plus masked descriptor, no auto handoff. Native modal blocks background refresh/paging; Escape/close blocked while command pending/unknown, beforeunload warning, same intent retry. Success terminal in modal until operator closes and refreshes; no duplicate submission. Fresh merchant type/render/lint plus production browser confirmation/lost-response/locking checks; reuse unchanged command/API/DB tests. Actual original DB browser journey still separate required milestone.

Pickup handoff confirmation checkpoint: scoped proof form now retains successful verification in memory and exposes Review pickup handoff only with current queue workstation. New native dialog shows public order reference and each remaining ready quantity, requires explicit recipient selection, masked descriptor and matching-order/recipient/quantity checkbox. Submit prepares existing immutable handoff once. Modal blocks background actions; Pending/Unknown prevents Escape and close, adds beforeunload warning and exposes only explicit same-operation retry after unknown response. Success/terminal rejection cannot resubmit; operator closes and refreshes. Unmount aborts/disposes; forced app/process destruction still loses in-memory recovery and requires authoritative queue reconciliation, no storage introduced.
Fresh130eb2/1ef175 merchant type and affected component lint pass.774e8d/811be1 affected browser-test lint,2 existing page render cases, configured production build and synthetic transport browser5.1s pass. Browser covers focused proof entry, unknown proof same-key recovery, actual confirmation gating/remaining quantity, configured station/verification/exact version in submitted handoff, unknown handoff Esc/close protection, byte-identical explicit retry, terminal disabled resubmit, existing paging/scope/denial recovery/storage behavior. Unchanged large build-chunk warning persists. No duplicate proof/handoff unit/API/DB checks; their previously recorded evidence reused for unchanged inputs.
Scope review: new PickupHandoffForm, proof-state retention and workstation prop plumbing in existing Pickup page, production browser scenario and WP only. No backend/Domain/schema/dependency or external action; prior dirty work preserved, no commit/push/deploy. All check handles terminal, browser servers cleaned. This is frontend/mock-transport proof; not actual Pickup browser-to-DB acceptance.31c04b located existing real HTTPS Kitchen browser helper and original Pickup HTTP journey for next integration: reuse actual persisted Merchant service/bootstrap, configure synthetic fixture workstation explicitly, perform original proof/handoff via built browser while preserving owner persisted counts/replay/downstream evidence. Live pilot workstation/Store/Provider configuration and customer proof delivery still outstanding. Goal active; previous turn classified progress.

Original Pickup browser milestone selection: optional BOP_PICKUP_BROWSER=1 uses existing built merchant App with actual HTTPS/persisted Merchant bootstrap, queue/proof/handoff API and original paid Ready Fulfillment. Synthetic staff/workstation/proof issuer policies explicit; no route mocking. Retain browser intent for existing same-key replay/current-source/one-verification/one-handoff/downstream assertions. Fresh helper lint plus existing current-clock Pickup isolated DB filter with browser switch. Unchanged frontend build811be1 reused; no fullverify/install/Dining rerun for isolated optional helper.

Original Pickup browser checkpoint: optional BOP_PICKUP_BROWSER=1 now launches built merchant App over real ephemeral HTTPS with actual persistent Merchant BFF bootstrap/current Store, queue resolver with explicit synthetic device/location, existing owner proof/handoff adapters and actual encrypted session cookie. No route interception or fabricated successful response. Browser enters ephemeral synthetic-issued HumanCode, retains successful verification, explicitly confirms original order quantities/recipient and submits handoff. Exact browser intent IDs copied into existing persisted replay checks without logging credential/cookie/body. Actual queue refresh removes completed pickup; revoked queue permission clears browser cards.
Fresh411583/30b932 affected helper formatting/lint and original current-clock Pickup55.522s pass first complete run. Actual browser proof/handoff return Applied, concurrent HTTP retries of captured browser intents return AlreadyApplied; persisted record resolution, altered replay rejection, current device policy denial, separate completion/queue permission withdrawal, append-only counts exactly one proof generation/verification/handoff/completion publication and downstream Order/receipt/ordinary-refund assertions all pass. Default HTTP concurrency path remains unchanged when switch absent; prior default path evidence reused, not rerun. Two unrelated scenarios filtered. Built frontend811be1 unchanged and reused; no additional build/install/fullverify/Dining checks.
Scope review: new pickup-merchant-browser helper and opt-in original entry helper composition/cleanup only, plus WP. Runtime closes browser/HTTPS/temp certificate directory in all paths and HTTP server in nested finally; isolated DB cleanup completed, all handles terminal. Test staff/session/device/location/live-gate marker/proof issuer and attempt budget are explicit synthetic fixture policy, not deployed operational configuration or real onboarding/customer proof issuance. No schema/Domain/API/frontend change in this milestone, no commit/push/deploy/external services. Goal remains active: assemble durable runtime ports and customer proof issuance/display, original browser-originated checkout, operational Store/menu/tax/Provider/workstation facts, then full pilot readiness. Previous turn progress, current turn completes actual browser/database evidence.

Customer proof lifecycle selection: existing WP1706 controller exposes raw proof but has no session-context invalidation; refresh retains old credential. Before real issuance/read composition, add optional client context subscription, clear on context change/unsubscription, reject late response, clear old proof immediately on refresh and enforce canonical16-byte Opaque encoding. Fresh affected Customer controller/render tests, type and lint; no unchanged merchant/API/DB runs. Existing refresh is Query-only: do not silently regenerate on refresh. Issuance/recoverable secret delivery must be composed separately.

Customer proof lifecycle checkpoint: controller optional subscribeContextChange follows existing Customer receipt ownership pattern; first listener subscribes, last listener/unmount clears raw proof, invalidates pending request and releases subscription. Context change clears visible credential immediately and late responses cannot restore it. Refresh now hides old proof and cancels old expiry timer before query. Opaque grammar enforces canonical16-byte base64url trailing bits. Fresh46a7cf/312832 Customer application+service-worker typecheck,14 controller+11 panel tests and affected lint pass. No backend/merchant/DB/build reruns for this controller-only change.
Authority853254: WP1706 explicitly requires refresh as side-effect-free query; default runtime intentionally has no transport. WP1602 forbids raw credential records and provides append-only selector-hash/generation history, requiring fresh generation/capability/hash for regeneration. Thus do not implement reveal/refresh by reissuing a proof or persist plaintext credential. Remaining concrete composition needs purpose-separated server secret generation/recovery without raw-proof persistence, owner-authorized issuance at Ready, current Guest exact-order ownership for read, then HTTP/client wiring. Possible implementation to evaluate: configured secret-key derivation of opaque128-bit value bound to immutable capability reference/generation/scope, independently purpose-separated selector pepper; compare derived selector with stored hash before read. Key policy must be explicit configuration, no invented operational key or implicit issuance on query. Current change adds subscription capability only; actual HTTP client/context source still not configured. Previous turn progress; goal active, no completion claim.
Scope reviewed: two Customer controller/test files and WP only. Existing dirty work preserved, no schema/dependencies/external service/commit/push/deploy. All handles terminal. Operational inputs remain pending; independent implementation remains available, not blocked.

Pickup credential infrastructure selection: versioned independent32-byte HMAC keys, opaque128-bit output derived with explicit version/purpose/Brand/Store/Fulfillment/capability/generation tuple; independent selector HMAC bound to purpose/kind/scope/version. Pure recovery compares derived selector constant-time and checks capability Active/time, does not issue/regenerate/write or authorize caller. Configured immutable keyring supports old generation reads during rotation; no key/raw credential persistence/logging. Fresh Fulfillment type/targeted codec tests/lint and import/domain boundary validators. Current Store/Guest authorization and readiness must remain owning service responsibility in next composition.

fc53ac/20b133 first codec typecheck passed but2/8 tests failed: new selector mistakenly used event-digest sha256 prefix instead of PublicCapability64hex grammar; test also expected error code as message. b36f93 confirms canonical grammar. Correct output to64hex and bounded message assertion; rerun affected type/tests and remaining lint/boundaries, no unrelated checks.

Pickup credential provider checkpoint: Fulfillment infrastructure exports createPickupCredentialProvider with explicit versioned independent32-byte derivation/selector keys, copied into Node KeyObjects (temporary copies zeroed). Opaque16-byte secret uses HMAC-SHA256 over canonical purpose/version/Brand/Store/Fulfillment/capability/generation tuple; selector uses distinct HMAC key/purpose bound to kind/scope/version/credential and canonical64hex output. Recovery is read-only, parses capability, requires Opaque/Active/current valid lifetime, regenerates exact secret then constant-time compares selector. No SQL/state/issuance, raw secret persistence, logging, API, or claimed caller authorization. Existing HumanCode verification can use hash port but only Opaque recovery implemented; no HumanCode recovery claim.
Initialfc53ac/20b133 detected selector prefix mismatch and error-message assertion, corrected05e3a9. Final60ede7/51dbd7 owning typecheck and8 scoped tests pass: restart recovery, four scope/capability separations and generation, expiry/revocation/hash/key denial, copied key/explicit rotation continuity, duplicate/shared key and noncanonical input rejection. Lint then found two test-only non-null assertions; bc65f3 replaces with safe optional access to same known fixture entries.028fc5 affected lint and import/domain boundaries pass; type/behavior evidence reused as production source unchanged by test-style edit. No schema/SQL/dependency changed, no install/DB/fullverify run.
Security review scope: raw credential Restricted, configured keys Secret, selector Restricted derived evidence, scope/capability references internal. Raw output only returned to future authorized caller; bounded errors contain no inputs. No storage/log/export/event path introduced. No unaccepted Blocker/High in adapter scope; production composition is still missing and cannot be activated until current Guest exact-order/Ready validation, purpose-separated configured keys and durable attempt policy supplied. Key compromise impacts recoverable generations under that version; explicit keyring retirement makes unavailable versions fail closed. This is low-level generation/recovery capability, not completed issuance/display flow. No actual operational keys read or created. All handles terminal, prior dirty work preserved, no commit/push/deploy. Next owner issuance application composition, current Guest read/API and customer client; goal active.

Pickup issuer selection: infrastructure composition uses existing scoped store/lock/plan/append-only issue and configured credential provider. Requires Issue authority before owner access, same-key prior verification/conflicting correlation fails, existing current valid credential yields AlreadyAvailable without regeneration. Initial issuance one-hour-from-original-Ready maximum, explicit generator/key version, no raw return/persistence. Fresh owning types/issuer tests/lint/boundaries; actual DB composition follows, no claim from mocks.

Issuer original DB selection: replace fixture-only HumanCode generation/plan with actual configured issuer using ephemeral synthetic32-byte keys and opaque credential. Issue + AlreadyAvailable retry, restart-style recovery from persisted capability, then existing real browser verification/handoff and original downstream assertions. Prior HumanCode HTTP evidence remains historical path coverage; fresh BOP_PICKUP_BROWSER=1 current-clock Pickup proves new Opaque/issuer integration. No source frontend change/rebuild.
