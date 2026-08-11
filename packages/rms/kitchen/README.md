# `kitchen`

Kitchen-owned, runtime-inactive confirmed-order intake, minimum Ticket / Work Item aggregate,
deterministic Station plan, lifecycle execution, Store queue projection and minimal realtime hint.

## Identity and responsibility

- Module Name: `kitchen`
- Package Name: `@rms/kitchen`
- Layer / Domain: `RMS / Kitchen`
- Phase / owning Work Package: `Phase 1 / WP-1400–1405`
- Owner role: `Kitchen Engineering Owner`
- Status: `active contract surface and persistence boundary; runtime inactive`
- Responsibility: consume Ordering-owned `OrderConfirmed.v1`, resolve exact public Ordering source
  evidence, deterministically compose the Phase-1 single-Station work plan from strict injected
  Kitchen-routing and Recipe-preparation evidence, create one Store-scoped Ticket and one initial
  Work Item per exact source item; execute exact Accept, Start, quantity-completion and OrderItem
  Ready commands; and consume Kitchen lifecycle Events into a safe Store queue read model.
  After a queue generation transaction commits, the runtime-inactive realtime service may emit one
  minimal lossy Store-scoped generation hint that requires a canonical authorized queue requery.
- Explicit non-goals: live Worker wiring, Station/Rule persistence or authoring, Recipe business
  logic/persistence, multi-Station routing, Hold/Resume/Cancel/Rework, Ticket or Work Item Ready,
  partial Ready, API/UI/SSE/live Worker wiring, distributed fan-out, Provider calls and production
  activation.

## Public contract

`createConfirmedOrderConsumerService` retains registration `kitchen.confirmed-order:v1`.
`createKitchenTicketIntakeAdapter` implements its existing `intakes.resolveByIdentity` / `accept`
port through `createKitchenTicketCreationService`, without changing the WP-1400 consumer.

The source query receives only the exact parsed receipt scope and independently authorizes
`ResolveConfirmedOrderKitchenSource / CreateKitchenWork`. Kitchen projects the validated source to
a strict, deeply frozen planning DTO containing references, quantities and opaque line/evidence
digests only; Customer notes, localized names and other narrative never cross the plan port. The
injected `KitchenWorkPlan` must bind the exact source-evidence digest and item set, with one
ordinal-1 item per source item, one opaque Station/routing snapshot and one Recipe/Preparation
snapshot. Kitchen alone computes the final execution digest from the complete source plus plan.
Missing, placeholder, extra, stale or changed data fails before any effect.

`createKitchenWorkPlanService` implements that existing internal plan port. It resolves evidence at
the exact confirmed instant, accepts only one active `AllPreparedItems` Station/rule candidate,
requires every Recipe-owned preparation capability to be covered, and returns `null` for any
missing, ambiguous, malformed, cross-scope or incapable evidence. Station and Recipe owner adapters
receive distinct least-privilege System authorization intents and remain final authorization
authorities before reading their sources. The planner never receives Customer notes or localized
display narrative, reads a clock, generates random identity or mutates state. Its stable plan
reference binds Brand、Store、Order、Batch and confirmation; version is `1` and `generatedAt` is the
confirmed instant, so identical evidence is byte-stable across retry and concurrency.

`createKitchenWorkLifecycleService` exposes one frozen runtime-inactive `execute` command boundary.
It accepts only the four strict command shapes, returns one bounded durable result contract and uses
injected authority, transaction, owner-repository, Audit, Eventing, clock, digest and opaque evidence
ports. No HTTP, Session, CSRF, offline-command or live safety adapter is included.

`createKitchenQueueProjectionService` exposes one frozen runtime-inactive coordinator with
`registration`, `lifecycleRegistrations`, `consume`, `consumeLifecycle`, `rebuild`, `list` and
`get`. The original registration consumes strict `KitchenWorkCreated.v1`; the four lifecycle
registrations consume the accepted, started, progress-recorded and completed Events. Incremental
and rebuild paths validate authoritative Kitchen checkpoint coverage before a complete generation
switch. List/Get independently final-authorize trusted Session/Tenant context with
`kitchen.operate`, bind cursors to one generation and filter/sort digest, and return deeply frozen
safe rows with checkpoint/as-of/projected-at freshness metadata. Course, priority, SLA/overdue, hold
reason, exception, claim, ETA and structured allergen assistance are all explicitly `NotAvailable`;
none is represented as absent, false or safe. Operational projection health is separately
`NotAvailable` because this bounded runtime-inactive slice does not claim `Rebuilding` or `Failed`.
The public error contract is bounded and never reveals existence, source dependencies or
identifiers.

`createKitchenRealtimeService` exposes one post-commit, runtime-inactive publisher boundary. It
strict-parses an already active `kitchen_work_queue_v1` generation and emits only
`kitchen.work-queue.updated.v1` with Brand/Store scope, the generation reference and static
projection version. It carries no row snapshot or `data` bag. Delivery, no subscribers and loss do
not mutate or retry Kitchen state; every hint requires the client to run the canonical queue Query.
WP-0036 remains owner of SSE authorization, transport, reconnect and fan-out.

## Dependencies

- Allowed synchronous dependencies: public `@bop/audit`, `@bop/eventing` and `@rms/ordering`
  exports only.
- Allowed asynchronous dependencies: consumes `rms.ordering.order-confirmed.v1` plus
  `rms.kitchen.kitchen-work-created.v1`, `rms.kitchen.kitchen-work-accepted.v1`,
  `rms.kitchen.kitchen-work-started.v1`, `rms.kitchen.kitchen-item-progress-recorded.v1` and
  `rms.kitchen.kitchen-item-completed.v1`; publishes the same five Kitchen Events.
- Forbidden dependencies: Ordering private paths/repository/tables, current Catalog/Recipe lookup,
  HTTP/ORM/Provider SDK, cross-domain transaction and inferred routing.
- Failure behavior: closed safe codes distinguish invalid input, permission denial, conflict and
  temporary dependency failure without object or dependency detail.

## Data ownership and lifecycle

- Aggregate Root: `KitchenTicket`, positive bigint aggregate version and status `Open`; WP-1404
  increments the version without inventing a Ticket lifecycle state.
- Child Entity: one `KitchenWorkItem`, split ordinal `1`, closed status vocabulary `Queued | Held |
In Progress | Completed | Cancelled`, immutable required quantity and bounded cumulative completed
  quantity.
- Append-only record: one `KITCHEN_TICKET_CREATED` action per stable Ticket creation effect,
  explicitly attributed to the System actor, Event Consumer channel and Restricted classification.
- Append-only lifecycle evidence: `kitchen_work_lifecycle_operation` owns explicit command replay,
  action, named User Actor, version/result and Audit/Event bindings; automatic Ready is a System
  child of the final Complete operation.
- Append-only readiness evidence: `kitchen_order_item_ready_result` owns one full-quantity
  OrderItem-grained Ready fact. Ready is never a Ticket or Work Item status.
- Immutable execution snapshot: display names, selected Options, bounded Customer note, source-line
  digest, Station/routing evidence, preparation evidence/instructions and execution digest.
- Ticket identity derives from Brand + Store + Batch; Work Item, action, Audit and Event references
  derive from the stable Ticket effect, never a run ID or wall-clock bucket.
- The Ticket retains every WP-1400 receipt anchor, including consumer/version, source Event,
  aggregate version/snapshot digest, confirmation, correlation, confirmed time and semantic digest,
  so durable replay can reconstruct and exact-compare the original receipt.
- Rebuildable projection: per-generation Store headers plus one safe row per Work Item provide one
  database-enforced Active `kitchen_work_queue_v1` generation, an explicit initialized-empty state,
  checkpoint freshness, safe acceptance/readiness timestamps and Station-lane/exact-reference reads
  without becoming Kitchen truth. A null `orderItemReadyAt` is unknown/not-yet-projected rather than
  authoritative Not Ready.

## Persistence, atomicity and eventing

The repository port resolves the scoped source Event, confirmation and Batch semantic keys. All
keys must be missing or converge on the same complete stored effect. New creation atomically
persists the intake binding, Ticket, all Work Items, append-only action, Restricted System Audit and
one `KitchenWorkCreated.v1` Outbox Event in the caller-owned Consumer transaction. Commit-unknown
recovery rereads permanent semantic keys; a changed or split effect is never adopted.

Lifecycle commands strictly parse the public command, resolve the trusted Workforce Actor / Brand /
Store and server Correlation Context, final-authorize exact `kitchen.operate`, install the same
transaction-local Tenant context and acquire a Brand+Store+idempotency-key transaction fence before
lookup. A new command locks and re-reads Kitchen source, validates exact Ticket / Work Item versions
and state, then atomically commits source CAS, append-only lifecycle operation, optional Ready result,
Confidential Audit and the applicable lifecycle Outbox Event. Command/operation reference,
idempotency key, Event ID and correlation ID remain independent. Same-intent replay returns the
original durable result and lineage; changed intent conflicts, and commit uncertainty never adopts a
malformed bundle.

The public Event is minimal: `kitchenTicketReference`, Order, Batch, confirmation, item count,
aggregate version and created UTC instant. Its envelope is Store scoped, correlated to the original
intake and caused by `OrderConfirmed`. It contains no item snapshot, Customer note, Station,
preparation narrative, Money, Payment, Provider or health data.

Accept and Start publish `KitchenWorkAccepted.v1` and `KitchenWorkStarted.v1`. A partial positive
completion publishes only `KitchenItemProgressRecorded.v1`; the exact final quantity publishes
`KitchenItemCompleted.v1`. A committed manual or automatic Ready result also publishes one minimal
System-envelope `KitchenItemReady.v1`; `KitchenOrderReady.v1` is added only when the locked, exact
Ticket readiness vector is complete after that transition. Order Ready means Kitchen preparation
only, never Ordering or Fulfillment completion. The Ready result, append-only publication binding,
Audit, lifecycle operation and one or two Outbox Events share the repository transaction. Named
operator accountability stays in the personal-classified Audit and is not copied to either public
Ready payload or queue row.

The queue keeps `kitchen.queue-projection:v1` for Created and adds four distinct `ordering: "none"`
lifecycle registrations. Generic Inbox short-circuits a completed Event before parsing; a first
delivery is strict-parsed and independently System-authorized before a dedicated Kitchen-owned safe
one-Ticket source read. Complete-through checkpoint comparison, transient lifecycle proofs and the
Store/projection advisory transaction lock converge duplicate and out-of-order delivery without
overwriting original Created provenance. Generic Inbox completion and a complete
shadow-generation switch share the caller transaction; `result_hash` remains `NULL`. Version-2
snapshot binding adds `acceptedAt` and `orderItemReadyAt`; lifecycle incrementals reconcile
acceptance but preserve the prior Ready value, while only a complete authorized rebuild may project
Ready until WP-1406.

## Security and privacy

Module classification is `indirect_identifier,personal,health` because the immutable Work Item may
contain a Customer note that is possible-health data. Notes are NFC plain text, at most 240 Unicode
code points and four lines, with control and bidirectional-override characters rejected. A note is
never interpreted as allergy accommodation, ingredient deletion or safety approval, and never
enters Event, Audit summary, error, log, URL, metric label, analytic payload, screenshot or
non-synthetic fixture. WP-1407 now supplies the runtime-inactive structured review, named
BeforeStart / BeforeHandoff acknowledgement, persistent non-color cue and immutable Incident link
contract. Professional policy, Store training, full Payment / Pickup / Compliance orchestration and
non-synthetic evidence remain mandatory before any live food-safety claim.
The queue projection itself is `indirect_identifier` only: its dedicated source DTO and rows exclude
Customer note, health/allergen values, preparation instructions, note-derived digests and all
Payment/Provider data. Public queue results also exclude internal Event references and integrity
digests.

Start remains fail-closed behind a strict opaque named-operator admission decision. Kitchen binds
only its reference/version/digest, exact Actor/scope/target/source versions and validity window; it
never reads or persists the underlying allergen, condition, acknowledgement or health narrative.
Synthetic `Allowed` evidence exercises only the provider-neutral core. A live adapter remains absent
until WP-1407/WP-2027 and the required external safety evidence are complete. Expo mode is likewise
an injected, scoped, time-bounded opaque decision; Kitchen never queries Store private configuration.

## Operations

- Configuration: strict injected, owner-authorized Station/routing, Recipe-preparation, Start
  admission and Expo decisions only. No configuration table, authoring command or runtime adapter is
  included.
- Health/readiness: runtime inactive; no Worker or infrastructure readiness is claimed.
- Queue freshness: only the projection builder sets canonical checkpoint freshness (`Fresh` at
  non-negative activation lag up to two seconds, otherwise `Stale`). Query does not age an
  unchanged Store by wall clock, and stale results remain read-only.
- Telemetry: no implementation in this increment. Future metrics may use bounded outcome/reason
  labels only; all Tenant and object references, notes and digests are prohibited labels.
- Disable/recovery: Eventing owns retry/dead-letter; replay and commit-unknown converge through the
  three permanent semantic keys.

## Development and verification

```bash
pnpm kitchen-ticket:acceptance
pnpm kitchen-station-routing:acceptance
pnpm kitchen-queue:acceptance
pnpm kitchen-work-lifecycle:acceptance
pnpm kitchen-ready-event:acceptance
pnpm --filter @rms/kitchen format:check
pnpm --filter @rms/kitchen lint
pnpm --filter @rms/kitchen typecheck
pnpm --filter @rms/kitchen test
pnpm --filter @rms/kitchen build
```

Synthetic tests cover strict/accessor-safe/deep-frozen contracts, exact source/plan binding,
Customer-note safety, no-placeholder creation, stable identities, same/different-Event replay,
multi-key conflict, concurrency, commit-unknown recovery, mandatory Audit/Outbox rollback and
minimal Event privacy. Queue coverage adds initialized-empty and shadow rebuild, complete
checkpoint/digest reconciliation, Consumer Inbox outcomes, cursor generation binding,
`kitchen.operate` authorization-before-read and exact Store RLS scope. Lifecycle coverage adds
independent Command/idempotency/Event/correlation identities, scoped transaction fencing, exact
version/state/quantity transitions, opaque admission/Expo gates, automatic/manual Ready, truthful
Progress/Completed Events and atomic rollback.

## Decisions and follow-up

- Authority: WP-0023, WP-0030, WP-0032, WP-0034, WP-0035, WP-0042, WP-1310 and
  WP-1400–WP-1406.
- External Evidence: real Ordering persistence/source adapter, real Kitchen Station/routing and
  Recipe-preparation adapters/facts, WP-2045 live Payment gate, WP-1407 allergen acknowledgement,
  runtime roles/RLS, real Store/Order facts, load/replay/restore evidence and deployment remain
  gated and unclaimed.
- Revisit triggers: live Worker composition, Station/Rule authoring or persistence, Recipe module,
  multi-Station routing, Hold/Resume/Cancel/Rework, partial Ready, Ticket lifecycle, Ready Event /
  realtime activation, export or a new Customer/health field.
