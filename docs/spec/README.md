# BOP-RMS Specification Index

## Authority

- Source document ID: `BOP-RMS-HANDOFF`
- Owner-confirmed available Library file: `BOP-RMS Complete Handoff Package.md`
- Available source document version: `0.5.3`
- Composite architecture baseline: Handoff Sections `0–91` plus repository-accepted Sections `92–97`
- Current discussion node: `WP-1803 — Order Queue on codex/wp-1803`

The complete Handoff Package remains outside this repository and is not duplicated here. On `2026-07-23` the Owner confirmed that no newer Library file is available and explicitly accepted a composite authority baseline: the available `0.5.3` Handoff supplies Sections 0–91；the accepted ADR and Work Package records already integrated into this repository supply later Sections 92–97. This index no longer claims an unavailable `0.5.9` file. Never store Library credentials、signed URLs、account identities、private access metadata or the complete Handoff Package in Git.

Decision precedence follows Section 0: later numbered accepted sections supersede conflicting older text. Section 80 is the remediation baseline; Sections 86 and 87 close delegated and hardening decisions; Section 88 is authoritative for pages and functions; Sections 89–91 govern repository execution、Codex / Figma operation and GitHub Free solo governance; Sections 92–94 govern database ownership、Domain dependency enforcement and Migration Runner behavior; Section 95 is authoritative for WP-0021 foundation schema behavior；Section 96 is authoritative for WP-0022 helper objects、ownership、ACL、Tenant Context and verifier behavior；Section 97 is authoritative for WP-0024 reusable seed、fixture and parallel isolated-test-database behavior.

## Latest Work Package Status

Entries are newest-first；the WP-1104 closeout and WP-1021 readiness / WP-1020–1000 closeout entries below supersede
older historical snapshots retained later in this index.

- `WP-1805 — Pickup Completion Screen` is locally implemented and verified on top of WP-1804 head
  `0df9ee5`. It adds the canonical Pickup Queue, strict browser DTO, deterministic wait/overdue and
  explicit proof-plus-target handoff gating described in `docs/spec/work-packages/WP-1805.md`.
  Merchant HTTP/Command/proof/device composition remains unavailable and unclaimed; GitHub
  publication/integration is deferred by explicit Owner direction.

- `WP-1804 — Kitchen Board` is locally implemented and verified on top of WP-1803 head `3836365`.
  It adds the canonical Kitchen queue/work-item routes, strict closed browser DTOs, deterministic
  projection-time age and explicit Fresh + named-operator action gating described in
  `docs/spec/work-packages/WP-1804.md`. Merchant HTTP/realtime/Command/Session composition and real
  device/UAT evidence remain unavailable and unclaimed; GitHub publication/integration is deferred
  by explicit Owner direction.

- `WP-1803 — Order Queue` is locally implemented and verified on top of WP-1802 head `f2e94ae`.
  It adds the canonical Order Queue/detail routes, strict Store/Business-Date browser DTOs,
  deterministic projection-time age, explicit dependent-source gaps and stale read-only behavior
  described in `docs/spec/work-packages/WP-1803.md`. WP-1225 supplies no Merchant HTTP/realtime or
  claim/accept/reject Commands and WP-1900 still owns cross-Domain operational facts, so those
  actions remain unavailable rather than fabricated. GitHub publication/integration is deferred
  by explicit Owner direction.

- `WP-1802 — Catalog Authoring / Publish Screen` is locally implemented and verified on top of
  WP-1801 head `e6645c1`. It adds the canonical Menu list and builder routes, strict closed browser
  DTOs, safe projection-gap labels, keyboard-visible section controls and a contextual publish
  rail described in `docs/spec/work-packages/WP-1802.md`. The existing WP-1027 summary lacks the
  authoritative digest, effective period, evidence and browser scope envelope required for safe
  lifecycle mutations, so authoring/publish actions remain unavailable rather than fabricated.
  GitHub publication/integration is deferred by explicit Owner direction.

- `WP-1801 — Store Setup Minimum Screen` is locally implemented and verified on top of WP-1800
  head `29d20cb`. It adds the canonical Store list/detail/setup routes, strict closed browser DTOs,
  permission-safe state handling and the fixed eight-step evidence-gated setup presentation
  described in `docs/spec/work-packages/WP-1801.md`. Real Store projections, persistence and
  authoring Commands remain owned by WP-2192 and are unavailable rather than fabricated; external
  Store evidence remains gated and unclaimed. GitHub publication/integration is deferred by
  explicit Owner direction.

- `WP-1800 — Merchant Sign-in and Store Switch` is locally implemented and verified on top of
  WP-1724 head `c510b4f`. It connects the accepted same-origin Merchant BFF and Session-rotating
  Store-switch contract to the canonical `HOME-OVERVIEW /app` screen, with a closed
  permission-trimmed workspace DTO and explicit WP-1905 dashboard unavailability described in
  `docs/spec/work-packages/WP-1800.md`. Real Cognito, workforce/Store facts and dashboard
  projection evidence remain externally gated and unclaimed; GitHub publication/integration is
  deferred by explicit Owner direction.

- `WP-1724 — SES Event Authentication, Recipient Privacy, Retention and Deliverability Runbook` is
  locally implemented and verified on top of WP-1723 head `bdc6ccf`. It owns the strict SNS
  Signature Version 2 envelope admission, exact `ca-central-1` Topic/certificate allowlist,
  privacy-minimized SES event normalization, atomic Inbox/suppression intent and scoped
  subscription-confirmation contract described in `docs/spec/work-packages/WP-1724.md`. AWS SDK,
  persistence/IaC and real Provider/deliverability evidence remain externally gated and unclaimed;
  GitHub publication/integration is deferred by explicit Owner direction.

- `WP-1723 — Worker-minted Resume Token, Fragment-link Delivery and Clean Recovery E2E` is locally
  implemented and verified on top of WP-1722 head `0ed8eaf`. It owns the bounded hash-only token
  lifecycle and clean Customer fragment handoff described in `docs/spec/work-packages/WP-1723.md`;
  production crypto/persistence/API composition remains gated. GitHub publication/integration is
  deferred by explicit Owner direction.

- `WP-1722 — Idempotent Delivery, Suppression, Retry / Dead-letter and Delivery Observability` is
  locally implemented and verified on top of WP-1721 head `3c04058`. It owns the bounded resend
  authorization, retry/backoff/exhaustion and privacy-safe operational summary described in
  `docs/spec/work-packages/WP-1722.md`; GitHub publication/integration is deferred by explicit Owner
  direction.

- `WP-1721 — Localized Escaped Transactional Template, Minimal Receipt Body and No-tracking
Contract` is locally implemented and verified on top of WP-1720 head `714c2da`. It owns the
  strict React DOM Server transactional-receipt renderer described in
  `docs/spec/work-packages/WP-1721.md`; send orchestration and resume links remain WP-1722–1723.
  GitHub publication/integration is deferred by explicit Owner direction.

- `WP-1720 — SES Domain Identity, Authentication, Sandbox Exit and Regional Evidence` is locally
  implemented and verified on top of WP-1709 head `9afea90`. It owns Notification's strict
  `ca-central-1` readiness-evidence admission described in `docs/spec/work-packages/WP-1720.md`.
  Real SES, DNS, DMARC, account and Production Access evidence remains externally gated and
  unclaimed; GitHub publication/integration is deferred by explicit Owner direction.

- `WP-1709 — Accessible Immutable Digital Receipt, Correction / Reissue and Guest-authorized
Retrieval` is locally implemented and verified on top of WP-1708 head `e7328ea`. It owns the
  bounded Ordering receipt-chain contract and `CUST-RECEIPT-SUPPORT` runtime-inactive Customer
  screen described in `docs/spec/work-packages/WP-1709.md`. SES delivery and resume-token minting
  remain WP-1720–1724; GitHub publication/integration is deferred by explicit Owner direction.

- `WP-1708 — Workbox Cache Allowlist / NetworkOnly / Safe Update` is locally implemented and
  verified on a sequential local stack from WP-1707 head `3a39269`. It owns only the bounded
  Customer PWA cache routing and safe-update contract described in
  `docs/spec/work-packages/WP-1708.md`. GitHub publication/integration is deferred by explicit Owner
  direction.

- `WP-1707 — PWA Offline Shell / Retry UX Baseline` is locally implemented and verified at
  `3a39269` on top of WP-1706. It owns only the bounded Customer PWA connectivity and explicit
  foreground-recovery contract described in `docs/spec/work-packages/WP-1707.md`; GitHub
  publication/integration is deferred by Owner direction.

- `WP-1706 — Pickup Ready / Confirmation Screen` is locally implemented and verified at
  `185633f` on top of WP-1705. It owns only the bounded contextual `CUST-PICKUP-CODE` browser
  contract described in `docs/spec/work-packages/WP-1706.md`; GitHub publication/integration is
  deferred by Owner direction.

- `WP-1705 — Customer Order Status / Realtime Refresh` is locally implemented and verified at
  `669256d` on top of locally verified WP-1704 head
  `520c212a52594ff9e9aeb033e3b1b72a11c6d3fc`. It owns only the bounded
  `CUST-ORDER-STATUS` browser contract described in `docs/spec/work-packages/WP-1705.md`; GitHub
  publication/integration is deferred by Owner direction.

- `WP-1704 — Payment Redirect / Result Handling` is locally implemented and verified at
  `520c212a52594ff9e9aeb033e3b1b72a11c6d3fc`; PR #167 remains open and all GitHub follow-up is
  deferred by Owner direction. It began from exact integrated and exact-main verified
  `main@3ce5966960dd860acc8f41fb804b01f468d992c0` (`31553442340 / 93980838403`) and owns only the
  Provider-gated `CUST-PAYMENT` and clean `CUST-CHECKOUT-RESULT` browser contract described in
  `docs/spec/work-packages/WP-1704.md`.

- `WP-1703 — Checkout / Quote Review` is implemented and integrated at squash
  `3ce5966960dd860acc8f41fb804b01f468d992c0` via PR #166. Exact implementation head
  `ad0431b468999cea45c86b23860b3f88065d5ec1` passed run/job
  `31552575689 / 93978219025`; exact-main run/job `31553442340 / 93980838403` passed.

- `WP-1702 — Cart UI` is implemented and integrated at squash
  `2bacc889105e131616f113cefdd211cae548c2cd` via PR #165. Exact implementation head
  `9a6c8bea18a6e73a2c03bc0976c6ae7fa2eb4ab3` passed run/job
  `31549618049 / 93969261349`; exact-main run/job `31550601942 / 93972290641` passed.

- `WP-1701 — Menu Browse / Product Detail` is implemented and integrated at squash
  `20ec3ba759b9c74a4a4822491c4d01c817965bcd` via PR #164. Exact implementation head
  `0cf3bbd341f5459fd2f76f6659b0891370045d4d` passed run/job
  `31546428666 / 93959825617`; exact-main run/job `31547487467 / 93962977526` passed. It owns only
  the Customer PWA rendering of the existing Published Menu DTO for `CUST-MENU`,
  `CUST-MENU-SEARCH` and `CUST-SELLABLE-DETAIL` described in
  `docs/spec/work-packages/WP-1701.md`.

- `WP-1700 — QR Entry and Store Context Screen` is implemented and integrated at squash
  `9f02df243534a7be8926a1244ae192f5af404f62` via PR #163. Exact implementation head
  `d2fb316da61e25061077c21b48c8cbf0b77be529` passed run/job
  `31543193187 / 93949965114`; exact-main run/job `31544372393 / 93953594626` passed. It owns only the contextual
  `CUST-ENTRY-CONTEXT` browser fragment handoff, strict public Store context rendering and bounded
  Customer-entry success-contract extension described in `docs/spec/work-packages/WP-1700.md`.

- `WP-1605 — Order Completion Projection` is implemented and integrated at squash
  `5af7e926e0315cb508e9fafb6e04fed6b3d8cc1c` via PR #162. Exact implementation head
  `1a51ae720de1cfa6e9ac8881eb040f93be147e7e` passed run/job
  `31539866969 / 93939591779`; exact-main run/job `31540989791 / 93943079444` passed.
  It owns Ordering's strict Store-scoped `FulfillmentCompleted.v1` consumer and bounded
  `Fulfilled + Open` projection advance.

- `WP-1604 — FulfillmentCompleted Event` is implemented and integrated at squash
  `bcfdba72122b34318ddafddb44c71944c6cb2131` via PR #161. It began from exact integrated and exact-main verified
  `main@e7a03a312674ca83cea9dc8f25e0d9f718038dcb`. It owns only the stable minimal
  `FulfillmentCompleted.v1` fact, Event Catalog contract and append-only publication described in
  `docs/spec/work-packages/WP-1604.md`; the Ordering consumer/projection remains WP-1605.

- `WP-1603 — Complete Pickup Handoff` is implemented and integrated at squash
  `e7a03a312674ca83cea9dc8f25e0d9f718038dcb` via PR #160. Exact implementation head
  `9fa7c6e0fce91f455adadb7ecb361162859fa5e3` passed run/job
  `31531849582 / 93913528455`; exact-main run/job `31533351896 / 93918465257` passed. It began from
  exact integrated and exact-main verified
  `main@3466e32e4f6391b3da920777701a8a2454b14044`. It owns only the authorized, append-only
  Handoff Record, exact cumulative handed-over quantity and partial/Completed derivation described
  in `docs/spec/work-packages/WP-1603.md`; public Events remain reserved to WP-1604.

- `WP-1602 — Pickup Proof` is implemented and integrated at squash
  `3466e32e4f6391b3da920777701a8a2454b14044` via PR #159. Exact implementation head
  `4e75c4c0637118f04c10534a013c72d2b6c54dcf` passed run/job
  `31527917267 / 93900655037`; exact-main run/job `31529393368 / 93905487273` passed. It began from
  exact integrated and
  exact-main verified `main@2ce33ded7c90b90466236d53121dbbecc4af2765` on
  `codex/wp-1602`. It composes WP-1005's strict 60-minute Pickup Proof capability with an exact
  Fulfillment-owned Ready source, append-only generation/regeneration/invalidation and successful
  verification evidence. Raw proofs, handoff, completion, Manager Override, UI/runtime activation
  and External Evidence remain excluded. Exact boundaries are in
  `docs/spec/work-packages/WP-1602.md`.

- `WP-1601 — Kitchen Ready Intake and Pickup Ready Transition` is implemented and integrated at
  squash `2ce33ded7c90b90466236d53121dbbecc4af2765` via PR #158. Exact implementation head
  `e3485a24bb7e146ca782db3ad6ede9c51771f06d` passed run/job
  `31523361280 / 93885631865`; exact-main run/job `31524817125 / 93890428853` passed. It owns the
  append-only Fulfillment Item Ready result, exact Kitchen Item Ready intake and backend aggregate
  Ready derivation without treating Kitchen Order Ready as completion. Exact boundaries are in
  `docs/spec/work-packages/WP-1601.md`.

- `WP-1600 — Pickup Fulfillment Aggregate` is active for bounded implementation from exact
  integrated at squash `145971060fc68221e31f0b1f176a012dff09bc10` via PR #157. Exact
  implementation head `5593ad7d9915a3ec8140b79b66af31760b22a003` passed run/job
  `31518869081 / 93870704041`; exact-main run/job `31520324604 / 93875501493` passed. It owns the
  new Fulfillment Module, idempotent one-per-Order Pending Pickup Aggregate and strict
  Ordering-owned public source Query. Exact boundaries are in
  `docs/spec/work-packages/WP-1600.md`.

- `WP-1408 — KDS Stale / Read-only Continuity、Operator Lock / Handover 与 Recovery
Reconciliation` is implemented and integrated at squash
  `c0177d9e2d75efcd6d03fa75113dc2494b5a1d66` via PR #156. Exact implementation head
  `9b99fbaffdcfe58787364e2227eb7b4f3fe7158d` passed run/job
  `31513705556 / 93853526510`; exact-main run/job `31515105116 / 93858178095` passed. It owns the
  runtime-inactive named-operator KDS continuity state, explicit stale/reconnecting/offline
  read-only behavior without a browser Command queue, lock-before-handover evidence and fresh
  Source recovery reconciliation. External device, network, power, runbook and UAT evidence remain
  gated and unclaimed. Exact boundaries and verification evidence are in
  `docs/spec/work-packages/WP-1408.md`.

- `WP-1407 — Structured Allergen-assistance Review、KDS Cue / Acknowledgement 与 Incident Link`
  is implemented and integrated at squash `77e0e629f33e4e0b51babd1b58db8a215770b26f`
  via PR #155. Exact implementation head `0aa58adbe815e3128a72789284edef612f40518b`
  passed run/job `31509580304 / 93839700256`; exact-main run/job
  `31511103924 / 93844831219` passed. It owns Kitchen's
  Restricted configuration-specific review, two-stage named-operator acknowledgement, existing
  WP-1404 Start-admission composition, persistent non-color cue and immutable Compliance Case +
  availability Kill Switch incident link. Exact boundaries and verification evidence are in
  `docs/spec/work-packages/WP-1407.md`.

- `WP-1406 — ItemReady / OrderReady Event` is implemented and integrated at squash
  `fc0fea2f70c0912b2132cf82f7a691430d5b4738` via PR #154. Exact implementation head
  `0bf958f6cef3cc5c40aa583fdcf00de1224eaee6` passed run/job
  `31504821343 / 93823604190`; exact-main run/job `31506296583 / 93828608769` passed. It owns the
  atomic, minimal `KitchenItemReady.v1` and conditional `KitchenOrderReady.v1` public facts over an
  immutable WP-1404 Ready result. Exact source-vector, persistence, privacy, verification and
  later-runtime gates are in `docs/spec/work-packages/WP-1406.md`.

- `WP-1405 — Kitchen Realtime Message` is implemented and integrated at squash
  `6c39c00dd6c6b27198c45cdf7b1d04407f3d57a5` via PR #153. Exact implementation head
  `92577e761bf2b3090bae315c4ae3fc551a6b19b5` passed run/job
  `31497911551 / 93800157977`; exact-main run/job `31499382695 / 93805098353` passed. It owns only
  the strict Store-scoped
  `kitchen.work-queue.updated.v1` lossy hint over a successfully committed
  `kitchen_work_queue_v1` generation. The hint identifies the complete active generation and
  contains no row snapshot or open data bag; every connect/reconnect/message requires a canonical
  authorized queue Query and never replays a Command. WP-0036 retains SSE transport, Session/scope
  authorization, fan-out and reconnect ownership. Its Section 91 self-review records zero findings,
  reviews, review requests and unresolved threads without claiming independent approval or
  server-side Branch Protection / Rulesets. Exact evidence is in
  `docs/spec/work-packages/WP-1405.md`.

- `WP-1404 — Accept / Start / Ready Command` is implemented and integrated at squash
  `c071587b5a6c3d3ed1842caaf90a19d3105c1d14` via PR #152. Exact implementation head
  `0ef49f00cac9b3b3c0aeeb93fbd1da6323302340` passed run/job
  `31493420612 / 93785137658`; exact-main run/job `31494903047 / 93790057647` passed. The Section 91
  Process-enforced / GitHub Free self-review records zero findings, reviews, review requests and
  unresolved threads without claiming independent approval or server-side Branch Protection /
  Rulesets. Exact scope and evidence are in `docs/spec/work-packages/WP-1404.md`.

- `WP-1403 — Kitchen Queue Projection` is implemented and integrated at squash
  `2cbc0be35980e8245eeda486d60730004bc5ce8f` via PR #151. Exact implementation head
  `2b8fa27a9491e65df76fd65a7b06eb5b3410a042` passed run/job
  `31301418393 / 93214703808`; exact-main run/job `31302055359 / 93216317282` passed. Its Section 91
  Process-enforced / GitHub Free self-review is recorded in the PR process comment without claiming
  independent approval or server-side Branch Protection / Rulesets. Its closed F14.1 contract is a
  runtime-inactive, Kitchen-owned and Store-scoped `kitchen_work_queue_v1` read model over the
  already registered `kitchen.queue-projection:v1` consumer and strict Kitchen Ticket / Work Item
  source snapshots. Per-generation Store headers plus Work Item rows preserve initialized-empty,
  a database-enforced single Active generation, checkpoint/as-of/freshness, atomic shadow
  switching, two independent aggregate anchors and a row Event-semantic digest that never reuse
  Customer-note-derived evidence. Authorized reads use the canonical
  `kitchen.operate` permission and never turn stale projection data into Command authority. No
  lifecycle/Ready Command or Event、Customer/health field、API/UI/SSE/Worker、dependency/lockfile or
  runtime composition is included. The implementation is confined to the exact twenty-file
  allowlist in `docs/spec/work-packages/WP-1403.md`, including one migration with the two projection
  tables. Frozen install, Kitchen `141/141`, affected package and architecture gates, root format /
  lint / typecheck / build and the production audit pass locally. The dedicated projection body
  also passed against a disposable PostgreSQL 15 instance as supplemental local evidence; the
  authoritative exact-head and exact-main pinned-Linux runs above are complete. Runtime activation
  and External Evidence remain gated and unclaimed.

- `WP-1402 — Station Routing Minimum Rule` is implemented and integrated at squash
  `0075813084cf2d0a2cb0e459ea05704838816e85` via PR #150. Exact implementation head
  `a33fb9cf36c708ce3eed270010243dabe42fcb99` passed run/job
  `31294969596 / 93198467590`; exact-main run/job `31295607069 / 93200094777` passed. Section 91
  Process-enforced / GitHub Free self-review is recorded in the PR process comment；GitHub reported
  zero reviews、zero review requests、zero unresolved threads/comments and `CLEAN / MERGEABLE`,
  without claiming independent approval or server-side Branch Protection / Rulesets. Its closed
  F14.1 increment is a deterministic, runtime-inactive Kitchen planner over strict injected Recipe
  preparation and Kitchen Station/routing evidence. Phase 1 uses exactly one active Store Station
  and the closed `AllPreparedItems` selector；the exact twelve-file scope、local platform boundaries
  and final evidence are in `docs/spec/work-packages/WP-1402.md`.

- `WP-1401 — Kitchen Ticket / Item Minimum Aggregate` is implemented and integrated at squash
  `a77ab41058a068adaea02b00393aab7a78a50660` via PR #149. Exact implementation head
  `03e6713cbe9036e388f436a12f32dadb676276d0` passed run/job
  `31291094184 / 93188289437`; exact-main run/job `31291717492 / 93189944923` passed. Section 91
  self-review is recorded in the PR process comment；GitHub reports zero reviews and zero unresolved
  threads. The closed increment adds the first Kitchen-owned Ticket / Work Item Aggregate, strict
  public Ordering source evidence, an injected and gated Kitchen work plan, atomic
  action/Audit/Outbox persistence and the first forced-RLS `rms_kitchen` migration. It remains
  runtime inactive. Exact scope、36-file allowlist、Customer Note ruling、local platform boundaries
  and final evidence are in `docs/spec/work-packages/WP-1401.md`.

- `WP-1400 — Confirmed Order Consumer` is implemented and integrated at squash
  `ce12ddb86a9abe28c9b22f6d314cb829d4414115` via PR #148. Exact implementation head
  `4243eb692e8ea06edcfe4c4feb89c894d36ea7d1` passed run/job
  `31283177403 / 93167634148`; exact-main run/job `31283818250 / 93169247484` passed. Section 91
  self-review found zero review comments and zero unresolved threads. The increment owns only the
  contract-first, runtime-inactive `@rms/kitchen` consumer and immutable confirmed-order intake
  boundary over Ordering-owned `OrderConfirmed.v1`; Ticket / Work Item creation、Station routing、
  migration、Worker registration and live activation remain outside WP-1400. Exact scope and
  evidence are in `docs/spec/work-packages/WP-1400.md`.

- `WP-1310 — PaidWithoutFulfillableOrder Compensation、Refund Reconciliation 与 Exception
Projection Source` is implemented and integrated at squash
  `7683b8a39b0d7d65e2e550d02e945e1120a7e744` via PR #147. Exact implementation head
  `92fb7270952cbd7b423faa9dd343f978199d0503` passed run/job
  `31279425814 / 93158240437`; exact-main run/job `31280120046 / 93159958955` passed. It closes the
  contract-first Ordering payment-outcome / `OrderConfirmed.v1` and Payment
  paid-without-fulfillable compensation、Provider-confirmed refund and two-evidence Case boundary
  without inventing absent runtime producers、persistence adapters or Provider evidence. Exact
  scope and evidence are in `docs/spec/work-packages/WP-1310.md`.

- `WP-1309 — Terminal Authorization Capture Watchdog` is implemented and integrated at squash
  `d0acdd1ffbeb7dd47cad7c5a3f0acab605448a36` via PR #146. It defines the contract-first per-Attempt
  non-Interac capture, ten/fifteen/twenty-minute timing, verified shorter Provider deadline,
  Critical Task and reconciliation-exception boundaries without inventing the currently absent
  Terminal or Order-acceptance producers. Exact implementation head
  `b56564b5d84d233a952a9d67a54b71e7d34057ed` passed run/job
  `31272908318 / 93141781832`; exact-main run/job `31273588905 / 93143478712` passed. Exact scope
  and evidence are in `docs/spec/work-packages/WP-1309.md`.

- `WP-1308 — Payment Kill Switch` is implemented and integrated at squash
  `e1c043bfebfc05b027d513c013094290d5f2fabb` via PR #145. It applies WP-0120's exact
  `payment.provider.admission` Kill Switch decision to new Payment Intent admission while retaining
  exact idempotent replay and all authoritative webhook, terminal and reconciliation recovery paths.
  Exact implementation head `44ec863cdfab03fe85ec89e6400261c0c914ed91` passed run/job
  `31267763955 / 93128581280`; exact-main run/job `31268495066 / 93130384219` passed. Exact scope
  and evidence are in `docs/spec/work-packages/WP-1308.md`.

- `WP-1307 — Payment Reconciliation Job Baseline` is implemented and integrated at squash
  `7e1a27e0aaa259bbb444805757ffa81c52d8c965` via PR #144. It owns the bounded operational and
  daily-settlement reconciliation job/check/exception baseline described in
  `docs/spec/work-packages/WP-1307.md`. Exact implementation head
  `d7782636b69521b3dd176832d1ece019bb8ebf9a` passed run/job
  `30855342589 / 91824930149`; exact-main run/job `30857572070 / 91832047607` passed.

- `WP-1306 — Payment Status Projection` is implemented and integrated at squash
  `a18584c93595ea3b51608e3c56c78f1d92cad79c` via PR #143. Final head
  `6fc0fb7abda98148a7e485cdc9595b869f21691f` passed run/job
  `30850388200 / 91808685897`; exact-main run/job `30851543840 / 91812488627` passed. It owns the
  Payment terminal-status read model, event consumer and bounded authorized queries described in
  `docs/spec/work-packages/WP-1306.md`.

- `WP-1305 — PaymentSucceeded / Failed Event` is implemented and integrated at squash
  `89bab93d6c9ca8d88d0ebb83240f94a2aa3d1103` via PR #142. Final head
  `ad15d263aa442de30c6b335d1e6329f5785debb4` passed run/job
  `30845667979 / 91793219150`; exact-main run/job `30846767764 / 91796876010` passed. It owns the
  authoritative, append-only Payment success/failure fact mapping and atomic public Outbox events
  described in `docs/spec/work-packages/WP-1305.md`.

- `WP-1304 — Payment Webhook Idempotency` is implemented and integrated at squash
  `8f9db4355efff6b0935df1507ab786d09c811966` via PR #141. Final head
  `6f414830a40b3e7fc7691dd7ace0a68fc2b61188` passed run/job
  `30839915019 / 91774162017`; exact-main run/job `30841156112 / 91778238167` passed. It owns
  durable webhook acceptance, Provider Account + Event ID dedupe, bounded raw-evidence retention
  and transactional replay coordination described in `docs/spec/work-packages/WP-1304.md`.

- `WP-1303 — Provider Webhook Verification` is implemented and integrated at squash
  `8b4d330c9abe6a0809041c999b000cc419183225` via PR #140. Final head
  `52c2bbda649d81d7a95ce25f4cf811acc1db3711` passed run/job
  `30833204624 / 91751942336`; exact-main run/job `30834393051 / 91755894978` passed. It owns the
  raw-byte Stripe signature, timestamp and bounded secret-rotation verification contract described
  in `docs/spec/work-packages/WP-1303.md`.

- `WP-1302 — Payment Intent Creation` is implemented and integrated at squash
  `30c2bf1ffa8f57cd440f945a360cc42599ad0660` via PR #139. Final head
  `f7a4dd7e4f6f36fb4d3c6635738dc91a25af7be5` passed run/job
  `30828682054 / 91736810091`; exact-main run/job `30829884741 / 91740891272` passed. It owns the
  Payment Intent/Attempt creation contract described in `docs/spec/work-packages/WP-1302.md`.

- `WP-1301 — Payment Adapter Interface` is active from exact integrated and exact-main verified
  squash `9f67ed006b8cff4aa2f317905f90025a9ee1195c`. It owns the Payment Provider
  anti-corruption contract described in `docs/spec/work-packages/WP-1301.md`. Final PR #138 head
  `80641eb884de92d1ed02d2ee149bebb9ba536039` passed run/job
  `30822420723 / 91715406699`; exact-main run/job `30823598089 / 91719413132` passed.

- `SPIKE-1300 — Payment Provider Capability / Cost / Region` is implemented and integrated at
  squash `70cb012ed0bd30a87408cf5197dc7f5cf4a24218`. It resolves the public
  Stripe Canada capability, dated list-price and regional feasibility baseline while retaining
  account, contract, privacy, PCI and real-reader External Evidence gates in
  `docs/spec/work-packages/SPIKE-1300.md`. Final PR #137 head
  `263072580e8d8a64fba20eff026e5179f76c79df` passed run/job
  `30817709426 / 91699469986`; exact-main run/job `30818902520 / 91703502013` passed.

- `WP-1226 — OrderCreated Event` is implemented and integrated at squash
  `f31b086ad46d6a347e3a08c7a9f1a358007b11c6`. It owns the stable Store-scoped
  `OrderCreated.v1` fact, atomic CreateOrder Outbox composition and idempotent Ordering status
  projection intake described in `docs/spec/work-packages/WP-1226.md`. Final PR #136 head
  `08422a7b5caae8a78dd6da040c1378c0f490755a` passed run/job
  `30813792159 / 91686515055`; exact-main run/job `30814882933 / 91690050281` passed.

- `WP-1225 — Order Status Projection` is implemented and integrated at squash
  `6c54effc6b9338340d75713fecb51a5cfb4a81d1`. Final PR #135 head
  `63e4068c0e14e36928b4bbeed685db08ecabbffb` passed run/job
  `30809113871 / 91671347110`; exact-main run/job `30810137798 / 91674678101` passed. It owns the
  bounded Ordering projection and customer/merchant public query contracts described in
  `docs/spec/work-packages/WP-1225.md`.

- `WP-1224 — Create Order API` is implemented and integrated at squash
  `9deb14fff9603c729a77275f13844a7d6738d4bc`. It composes authorized permanent Submission
  idempotency, current Checkout evidence, immutable Order/Batch/Item snapshots and Store Business
  Date allocation behind one atomic Ordering repository contract. Section 87 reserves public
  Payment transport for later Payment WPs, so no conflicting standalone HTTP route or Provider call
  is introduced. Exact scope and current evidence are in `docs/spec/work-packages/WP-1224.md`.

- `WP-1223 — Store Business Date Resolution and Order Number Generation` is implemented, verified
  and integrated at squash `17580ba9f8c02d57869aa4573f86543670d428a9`. PR #133 exact-head CI
  passed run/job `30772978057 / 91563248163`; exact-main CI passed
  `30773532804 / 91564731709`. Store owns deterministic version-pinned IANA-zone plus local Business
  Day Start resolution, including `04:00` default and explicit DST gap/overlap rules. Ordering owns
  forced-RLS concurrent Store + Business Date decimal allocation and append-only evidence. Exact
  results are in `docs/spec/work-packages/WP-1223.md`.

- `WP-1222 — Order Item Immutable Snapshot` is implemented, verified and integrated at squash
  `225392e931d01408c0d1ceafbf43632db3ae7ef1`. PR #132 exact-head and exact-main CI passed. It
  copies exact Catalog names/versions、selected Option configuration、final bigint Money、
  Price resolution and Tax rule/rate/amount evidence into closed deeply frozen line snapshots；it
  never recalculates amounts or reads current Catalog/Pricing configuration. Ordering tests are
  `75/75`; retained isolated PostgreSQL passed `1/1`. Exact boundaries and
  evidence are recorded in `docs/spec/work-packages/WP-1222.md`.

- `WP-1221 — Order Aggregate Minimum Model` is implemented and locally verified on its candidate
  branch. It consumes only a current, exact-scope WP-1220 Checkout validation to create one deeply
  frozen `Order → Order Batch → Order Item identity` aggregate at `Submitted + Open`, preserving
  Brand、Store、Order Type、Source Channel、Cart / Version、Quote、Submission and separate Created /
  Submitted Actor references. Item payloads intentionally contain no transaction snapshot；WP-1222
  remains owner of immutable Catalog、Option、Price and Tax facts. Ordering tests are `63/63` and
  retained isolated PostgreSQL acceptance is `1/1`. Exact-head and exact-main CI remain pending；
  local platform-bound fixture details are recorded in `docs/spec/work-packages/WP-1221.md`.

- `WP-1104 — Quote Expiration and Requote` is implemented, verified, integrated and locally
  cleaned at squash `4e4644e2b1c51ecb99a78ea43cb9bda0edbddecb`. PR #121 exact head
  `1df34247ee4ca7c9a0bb2e1fc1315b1f7ba75bb1` passed run/job
  `30749169839 / 91499994605`; exact-main run/job `30749636056 / 91501249920` passed. Server UTC
  time before expiry reuses the immutable Quote; the exact expiry instant requires a new Quote for
  the same Brand, Store, Cart and Cart Version. Decreased or unchanged totals need no
  reconfirmation, while an increase returns the exact signed bigint minor-unit delta and
  `ReconfirmationRequired`. Pricing tests are `67/67`, Quote HTTP acceptance is `8/8`, complete API
  regression is `120/120` and retained isolated PostgreSQL acceptance is `1/1`. Checkout
  confirmation, Promotion/Fee behavior, Cart mutation, UI, scheduler, Provider behavior and
  External Evidence remain absent. Exact results are in `docs/spec/work-packages/WP-1104.md`.

- `WP-1103 — Quote Creation API` is implemented, verified, integrated and cleaned at squash
  `5e0cde3c23e111a62d6261d6dd9a18c83cb785df`. PR #119 exact head
  `1d78043d2cbf5b8113251dfe938a4886cd66ec3b` passed run/job
  `30742316735 / 91481792209`; exact-main run/job `30742751626 / 91482977766` passed. It composes exact Price and exclusive-tax
  resolution into immutable, single-Currency Cart Quote snapshots with Catalog/Price/Tax/input
  replay evidence. The public POST accepts only Cart version, Customer Session and Idempotency
  context; client amount fields fail before the Pricing port. Responses include required totals,
  line breakdown, evidence, expiry, promotions, warnings and blockers. Pricing tests are `60/60`,
  Quote HTTP acceptance `6/6` and isolated PostgreSQL acceptance `1/1`. Expiration/requote,
  Promotion/Fee behavior, Cart implementation, inclusive Pilot quoting and External Evidence remain
  absent. Exact results are in `docs/spec/work-packages/WP-1103.md`.

- `WP-1102 — Price Resolution` is implemented, verified, integrated and cleaned at squash
  `757c48568335da5ebcf18ed4fe131cdaa52423d1`. PR #118 exact head
  `493fb4b9c27e4a10e50875dec575fdc86bd0e0f5` passed run/job
  `30740828380 / 91477839747`; exact-main run/job `30741320452 / 91479174923` passed. It adds
  single-Currency versioned Price Books,
  Sellable Price Entries and the canonical eight-level Store/Store Group/Region/Brand resolution
  order. Effective periods are eligibility only; same-priority ambiguity, missing coverage,
  unpublished books and Brand/Currency mismatch fail closed. Pricing tests are `52/52 PASS` and
  isolated PostgreSQL acceptance is `1/1 PASS`. FX, Promotion, Quote/API, UI and External Evidence
  remain absent. Exact results are in `docs/spec/work-packages/WP-1102.md`.

- `WP-1101 — Store Tax Configuration` is implemented, verified, integrated and cleaned at squash
  `61f20b46463cab02b99df8307c6a1e04e81c47a1`. PR #117 exact head
  `c6c43c2e034771bc1e596fbe606569c1d8860180` passed run/job
  `30739647570 / 91474624538`; exact-main run/job `30740044027 / 91475700769` passed. It adds
  versioned Store-scoped `CA-ON/CAD`
  configuration snapshots, exact effective periods, classification/order/charge rule resolution,
  compound order, receipt presentation, exception evidence, publish evidence gates and the first
  forced-RLS `rms_pricing` persistence. Domain tests are `37/37 PASS` and isolated PostgreSQL
  acceptance is `1/1 PASS`. All rules are synthetic; real rates, legal conclusions, professional
  evidence, UI and External Evidence remain absent. Exact results are in
  `docs/spec/work-packages/WP-1101.md`.

- `WP-1100 — Money / Tax Calculation Domain Contract` is implemented, verified, integrated and
  cleaned at squash `5a19f44837c5496770301e7033a02b6b2958ceac`. PR #116 passed exact head
  `70f72a29dd2cf85ba73acbb0332c0c75efec1448` in run/job
  `30737685473 / 91469364024`; post-merge exact-main run/job
  `30738085193 / 91471537512` passed on same-SHA attempt 2 after a WP-0024 Compose-start transient.
  It adds the provider-neutral
  `@rms/pricing` contract for signed bigint minor-unit Money、version-pinned Currency metadata、
  canonical decimal Tax rates、deterministic signed rounding、exclusive/inclusive Tax calculation
  and exact stable-key allocation. Results retain replayable rule/Currency version evidence；raw
  numbers、cross-Currency arithmetic、overflow and non-canonical rates fail closed. Package
  acceptance is `22/22 PASS`. Store Tax Configuration、Price resolution、Quote/API、real Ontario
  rates and professional evidence remain absent. Exact results are in
  `docs/spec/work-packages/WP-1100.md`.

- `WP-1028 — Pilot Ingredient / Allergen Provenance、Menu Disclosure and Publish-blocking
Validation` is implemented、verified、integrated and cleaned at squash
  `6cbfae5a63a9295ba8b2496b2bdc7d2d47bb9d64`. PR #115 passed exact head
  `003679ecaf7ba38909b19d568baa126371c08c39` in run/job
  `30735983438 / 91464762196`；post-merge exact-main run/job
  `30736396556 / 91466597731` passed on same-SHA attempt 2 after attempt 1 encountered an isolated
  PostgreSQL container-start transient. It adds version-pinned allergen registry and
  source evidence contracts、base plus Option union validation、exact Menu snapshot publication
  evidence、append-only Brand-RLS persistence and safe Customer Menu disclosure. `Unverified`、
  expired、invalidated or unresolved paths fail closed；public DTOs never claim allergen absence
  and always expose the controlled assistance code. Catalog tests are `44/44 PASS`、Customer HTTP
  acceptance is `5/5 PASS` and isolated PostgreSQL acceptance is `1/1 PASS`. Professional policy、
  supplier/Recipe facts、UI and External Evidence remain gated and unclaimed. Exact results are in
  `docs/spec/work-packages/WP-1028.md`.

- `WP-1027 — Merchant Catalog Management API` is implemented、verified、integrated and cleaned at
  squash `61fccc8b887781705512793f29a39e0727e40569`. PR #114 passed exact head
  `36035bffe5ffafaa0e21ce952ad8fbe4d18b6012` in run/job
  `30734163467 / 91459687321`；post-merge exact-main run/job
  `30734545647 / 91460844495` passed. The canonical backlog title
  supersedes the older shorthand that called this a UI/publish-screen boundary. The bounded API
  adds one Brand-scoped Menu list route and explicit Submit Review、Approve、Publish and Archive
  actions behind an injected Merchant authorization chain. Mutations require a single UUIDv7
  Idempotency Key、quoted `If-Match` version and closed action-specific body；Catalog remains final
  authority for permission、Audit and lifecycle rules. Dedicated HTTP acceptance is `6/6 PASS`；
  full API regression is `112/112 PASS`. UI、bulk import、private-table access and External Evidence
  remain absent. Exact results are recorded in `docs/spec/work-packages/WP-1027.md`.

- `WP-1026 — Customer Menu Query API` is implemented、verified、integrated and cleaned at squash
  `d7ab0c2931af7d4f98c5720ce88ccdea116f5076`. PR #113 passed exact head
  `7039e330bf177fb293413a1fbaa0a14280527286` in run/job
  `30733066503 / 91456680510`；post-merge exact-main run/job
  `30733452236 / 91457682585` passed. It adds the canonical public Store Menu REST
  resource over a Catalog-owned public Application Query contract；requires exact Store、Channel、
  Order Type、locale and server-current effective scope；accepts only one `Fresh` projection；and
  excludes Hidden or configured-unavailable Sellables. The response declares projection version、
  checkpoint、as-of、5-second freshness target、scope and partial state. Display Price and Tax
  Display Context are explicitly unavailable pending WP-1100–1103 and never represented as zero.
  Catalog tests are `40/40 PASS`; complete API regression is `106/106 PASS`; dedicated HTTP
  acceptance is `5/5 PASS`; WP-1025 projection PostgreSQL regression is `1/1 PASS`. Price/tax
  calculation、allergen disclosure、UI and External Evidence remain absent. Exact results are
  recorded in `docs/spec/work-packages/WP-1026.md`.

- `WP-1025 — Published Menu Projection` is implemented、verified、integrated and cleaned at squash
  `990ebeb8010c8c5cc5616d49cdc1d0aea3105874`. PR #112 passed exact head
  `ec2bf55aa52b34ddf284923899ae60d46982b6d7` in run/job
  `30731871019 / 91453548551`；post-merge exact-main run/job
  `30732239306 / 91454562557` passed. It registers the
  authoritative `MenuPublished.v1` fact、composes its atomic Outbox envelope with Menu publish and
  builds a Catalog-owned idempotent、version-monotonic、generation-switched projection from an
  injected public exact-snapshot contract. Projection content includes exact Menu/release/effective
  scope、Sections、Sellable snapshots and Option rules, with explicit checkpoint and freshness.
  Catalog tests are `36/36 PASS`; Event Catalog tests are `13/13 PASS`; WP-1025 and each
  WP-1020–1024 isolated PostgreSQL matrix are `1/1 PASS`; the complete 29-migration isolated
  lifecycle passes. Customer API、price/tax、allergen disclosure、UI and External Evidence remain
  absent. Exact results are recorded in `docs/spec/work-packages/WP-1025.md`.

- `WP-1024 — Menu Draft / Publish / Archive` is implemented、verified、integrated and cleaned at
  squash `92800dd59735da76d108fb2d16f7b70308afe8a5`. PR #111 passed final exact head
  `228d5429da14e85af57d51e3bdba30e1dd30f651` in run/job
  `30730513146 / 91449949118`; post-merge exact-main run/job
  `30730913183 / 91451077151` passed. The first exact head exposed missing accepted Domain
  dependency classifications; the next exposed the stale 27-migration WP-0024 inventory. Both
  deterministic hard stops were corrected and the final exact head passed. The implementation
  composes the accepted Publishing and Effective Period contracts behind Catalog-owned
  `catalog.menu.*` authorization. Exact-snapshot validation and independent approval evidence
  guard immutable Menu Version releases; effective overlap fails closed; releases、lifecycle
  revisions and operations are append-only under forced Brand RLS. Catalog tests are `32/32 PASS`;
  WP-1024 and each WP-1020–1023 isolated PostgreSQL matrix are `1/1 PASS`. WP-1025 projection、
  WP-1026 API、WP-1027 UI、Events、scheduler、real facts and External Evidence remain absent.
  Exact results are recorded in `docs/spec/work-packages/WP-1024.md`.

- `WP-1023 — Store Availability Overlay` is implemented、verified、integrated and cleaned at
  squash `70cce26bdc6d12f7c8f5970435f538f01c188f39`. PR #110 passed exact-head run/job
  `30728308811 / 91443965986`; post-merge exact-main run/job
  `30728687971 / 91444943080` passed. The bounded
  candidate adds Catalog-owned Brand defaults and exact Store overlays for SKU、channel、order
  type and UTC effective scope. Resolution selects Store specificity before priority, fails closed
  on conflicting equal-priority rules, and applies fresh exact-scope Kill Switch/Inventory safety
  evidence without owning Inventory facts. Authoring enforces Permission、Audit、idempotency、fact
  validation and optimistic concurrency; persistence adds forced Brand RLS and append-only
  operation history. Local Catalog acceptance is `27/27 PASS`; WP-1023 and each WP-1020–1022
  isolated PostgreSQL matrix are `1/1 PASS`. Publishing、customer projection/API、UI、Event、real
  facts and External Evidence remain absent. Exact results are recorded in
  `docs/spec/work-packages/WP-1023.md`.

- `WP-1022 — Option Set / Option / Binding Minimum Model` is implemented、verified、integrated and
  cleaned at squash `949b4218ce64409e7318df17c5846ddb8febec35`. PR
  [#109](https://github.com/gangzhao2021/bop-rms/pull/109) passed final exact head
  `133a88519141bdd74d30a7ea9ae4964108ab63b3` in run/job
  `30727479920 / 91441744388` in `11m46s`; exact-main post-merge run/job
  `30727836566 / 91442716867` passed in `12m02s`. The bounded implementation adds one
  Brand-scoped Draft Option Set Aggregate、stable Option Entities and Product Version-owned
  Bindings with strict selection、conflict、trigger、default、override、SKU-scope、idempotency、
  optimistic concurrency、forced-RLS and append-only persistence rules. Availability、Publishing、
  Pricing、Inventory/Recipe behavior、HTTP/UI/Projection/Event、real facts and External Evidence
  remain absent. Local Catalog acceptance is `19/19 PASS`; WP-1022、WP-1020 and WP-1021 isolated
  PostgreSQL matrices are each `1/1 PASS`. A stale tenant-context whole-registry assertion found by
  the first CI attempt was narrowed to its required forced-RLS entries and passed locally and on
  both exact-head and exact-main CI. Exact results and macOS platform boundaries are recorded in
  `docs/spec/work-packages/WP-1022.md`.

- `WP-1021 — Category and Menu Structure` readiness PR
  [#106](https://github.com/gangzhao2021/bop-rms/pull/106) passed exact head
  `b63704485791a32bc4aa057ee954f2a3dfadf286` in run/job
  `30537473095 / 90854111215` in `10m04s`；Section 91 findings were `0/0/0/0`；it
  squash-merged as `4607e6bae495ddd0e2456a12e45d9b752bdc8800` and exact-main post-merge
  run/job `30538162626 / 90856356984` passed in `11m10s`. Implementation PR
  [#107](https://github.com/gangzhao2021/bop-rms/pull/107) passed final exact head
  `823b10dce6b7164a952714e476d30e818d271fa4` in run/job
  `30541291458 / 90866428347` in `11m02s` with Section 91 findings `0/0/0/0`；it
  squash-merged as `6fcc0dec66f921d347dd9a758a17adf6ad666eb5` and exact-main post-merge
  run/job `30542123259 / 90869161412` passed in `11m23s`. Both implementation and readiness
  branches are removed. The implementation adds a Brand-scoped Category tree and a
  Draft-only Menu structure with Menu-owned Sections and SKU Sellable Placements. Category remains
  Master Data and never becomes a Menu Section. Publishing、effective Availability、Option、
  Pricing、Customer projection/API、UI and External Evidence remain absent.
- `WP-1020 — Product / Sellable / SKU Minimum Aggregate` is implemented、verified、integrated and
  cleaned at squash `ce4e9bf3095b024121796286ffbc2cd2ee753e10`. Readiness PR
  [#104](https://github.com/gangzhao2021/bop-rms/pull/104) passed exact head
  `38d65544de4a7c7ffc5483dfcc4661b56dea8140` in run/job
  `30531384052 / 90834292723` in `10m26s`；Section 91 findings were `0/0/0/0` and
  post-merge exact-main run/job `30532146161 / 90836723763` passed in `11m08s`. The bounded
  implementation adds one Brand-scoped Product Aggregate、
  complete Draft snapshot、Product-owned stable SKU Entities、non-authorizing SKU Sellable
  values and the first Catalog-owned forced-RLS migration. Local Catalog acceptance is `8/8`；
  implementation PR [#105](https://github.com/gangzhao2021/bop-rms/pull/105) passed exact head
  `3d8ef0856b581344b9e574fbf8679418750b0039` in run/job
  `30535628389 / 90848135190` in `11m04s`；Section 91 findings were `0/0/0/0`. It
  squash-merged as `ce4e9bf3095b024121796286ffbc2cd2ee753e10`, and exact-main post-merge
  run/job `30536420197 / 90850710615` passed in `11m37s`. SKU never becomes an independent
  Aggregate. Category/Menu/Option/Availability/Publishing/API/UI/Projection、price、inventory、
  Recipe、allergen/legal content、real Catalog fact、external resource and External Evidence
  remain absent.
- `WP-1007 — Dine-in Session Closing、Unpaid Batch Exception Task 与 Authorized Write-off
Boundary` is implemented、verified、integrated and cleaned at squash
  `614062e949a0d14d8c9b1d4fd9a4041f7bd964e7`. Readiness PR
  [#102](https://github.com/gangzhao2021/bop-rms/pull/102) passed exact head
  `6c5459ad9a3f5b0cbba2ca79bad819355b51840a` in run/job
  `30527265371 / 90820994024` in `9m17s`；Section 91 findings were `0/0/0/0` and
  post-merge exact-main run/job `30527925422 / 90823114446` passed in `10m30s`.
  Implementation PR [#103](https://github.com/gangzhao2021/bop-rms/pull/103) passed exact head
  `fb864f716dd7513624d8c6234b5487a3a2e10685` in run/job
  `30529607075 / 90828541797` in `10m16s`；Section 91 findings were `0/0/0/0` and
  post-merge exact-main run/job `30530384234 / 90831061463` passed in `9m53s`.
  The bounded implementation adds only Dining phase close policy、
  Active-only Batch admission、fresh owner-evidence finality and idempotent Store-scoped Task
  composition. Dining never executes/approves a Write-off or mutates Order、Payment or Task
  private facts. Unpaid/indeterminate Order remains Open after Dining closes. No Ordering/Payment
  aggregate、Task database、HTTP/UI/Projection、real financial/Provider fact、external resource or
  External Evidence is added.
- `WP-1006 — Pilot Staff-started Dining Session、short-lived Join Credential 与
copied-Table-QR Abuse Contract` is implemented、verified、integrated and cleaned at squash
  `5a56328aa90c9c63291b926bc8a746dd8f1f6b31`. Implementation PR
  [#101](https://github.com/gangzhao2021/bop-rms/pull/101) passed exact head
  `182b6f2f650659bd124e3a01f7e3ec714e5c0a90` in run/job
  `30525392728 / 90815000907` in `11m06s`；Section 91 findings were `0/0/0/0` and
  post-merge exact-main run/job `30526236474 / 90817679296` passed in `10m11s`.
  The bounded implementation extends Dining with Staff-authorized idempotent Session start and
  single-use Participant join, extends Public Capability with 128-bit/six-digit 15-minute
  purpose-separated Join proof, and extends Identity with rotated `DiningBound` Guest Session
  state. A fixed Table QR remains context-only. WP-2048 retains atomic abuse-bucket ownership；
  this WP accepts only injected admission/cooldown evidence and exports the accepted budgets. No
  Guest Self-Start、Convenience Mode、Ordering、Closing、Payment、database-backed Dining adapter、
  HTTP/UI、real Staff/Guest/Table、Provider、external resource or External Evidence is added.
- `WP-1005 — Order Resume、Public Reference 与 Pickup Proof Capability Contract`
  is implemented、verified、integrated and cleaned at squash
  `66dbbd835084e4d14bfff21e87eff65adc2b9c3c`. Implementation PR
  [#99](https://github.com/gangzhao2021/bop-rms/pull/99) passed exact head
  `7d3594f1b9c4a3bdc7262c6cabf8049cf7100572` in run/job
  `30520134755 / 90798448803` in `10m45s`；Section 91 findings were `0/0/0/0` and
  post-merge exact-main run/job `30520767677 / 90800408366` passed in `10m05s`.
  Implementation started from readiness squash
  `main@50d271f45cc11d8cc89028c5a72307db75de6a25` on branch
  `codex/wp-1005-implementation`. Readiness PR
  [#98](https://github.com/gangzhao2021/bop-rms/pull/98) passed exact head
  `be0ecb524b2bf8fc14f31305eced8d7044922275` in run/job
  `30518130402 / 90792415948` in `10m43s` and post-merge exact-main run/job
  `30518713922 / 90794186985` in `10m15s`, with Section 91 findings `0/0/0/0`.
  The bounded implementation adds a dependency-free `@bop/public-capability` contract module for
  unguessable non-authorizing Order references、single-use 30-minute Order Resume credentials and
  Ready-bound 60-minute Pickup Proof policy. Raw credentials remain trusted-memory-only and only
  purpose-separated keyed hashes may persist in future owner Domains. No Order/Fulfillment fact、
  database、HTTP/UI/email、Guest Session mutation、abuse limiter、Manager Override、Provider、
  external resource or External Evidence is added. Focused synthetic acceptance is `47/47`；
  Customer-entry `14/14`、Identity focused `14/14`、Tenant `9/9`、Store `73/73` and Dining
  `32/32` regressions pass. Both exact-head and post-merge pinned-Linux isolated PostgreSQL
  matrices passed；the implementation branch was removed.
- `WP-1004 — Invalid / Expired QR Error Contract` implementation is locally verified from exact
  readiness squash `main@a0433ae09c8c6ecab16bc4dd277106ae769dc059` on branch
  `codex/wp-1004-implementation`. Readiness PR
  [#96](https://github.com/gangzhao2021/bop-rms/pull/96) passed exact head
  `94b44d9f631c06848020b1f9c86344d11ca64526` in run/job
  `30514812330 / 90782165829` in `10m33s`、Section 91 Blocker/High/Medium/Low `0/0/0/0` and
  post-merge exact-main run/job `30515315918 / 90783715236` in `11m14s`. The bounded
  implementation adds a same-origin
  `POST /bff/customer/entry` transport over one injected server composition port. Signed QR input
  is body-only；all valid-shaped unusable causes remain one non-oracular `entry_unavailable`
  response with Store selection hidden. Success may emit only the fixed Guest Cookie、page-memory
  CSRF and customer-safe public context. No QR URL、cause detail、Store guessing、CORS、cache、
  Service Worker、Customer screen、Menu/Cart/Order/Dining capability、production adapter、
  Provider/resource or External Evidence is added. Focused acceptance is `14/14` and API total is
  `101/101`；Identity `73/73`、Tenant `9/9`、Store `73/73` and Dining `32/32` regressions pass,
  together with all `23` package format/lint/typecheck/build gates and the production audit.
- `WP-1003 — Customer Guest Session Context` implementation is locally verified from verified
  readiness squash `main@9c1f1ee0826d16870edee51cdce98e367d37057a` on branch
  `codex/wp-1003-implementation`. Readiness PR
  [#94](https://github.com/gangzhao2021/bop-rms/pull/94) passed exact head
  `17d47faf9291b5c11eccf94a8b87da9ac634b8f9` in run/job
  `30511243794 / 90771635568` in `10m34s`、Section 91 Blocker/High/Medium/Low `0/0/0/0` and
  post-merge exact-main run/job `30511742816 / 90773099131` in `10m27s`. The bounded implementation
  extends Identity with one provider-neutral
  server-side Guest Session aggregate and constrained `bop_identity.guest_session` table. Only
  injected current Store/QR/abuse admission evidence may create it；the browser receives fresh
  256-bit opaque Session/CSRF credentials while persistence stores purpose-separated keyed hashes.
  Sessions are bound to one Brand/Store/public Store/Table/channel context, expire after four hours
  idle or 24 hours absolute, rotate on every binding change and remain `ContextOnly` for Dine-in
  until WP-1006 supplies a separate active credential. Customer Profile、Merchant authority、
  Dine-in join/Host/Order capability、raw IP/device、production API/UI、Provider/resource and
  External Evidence remain gated and unclaimed. Focused acceptance is `14/14`；Identity total is
  `73/73`、Tenant `9/9`、Store `73/73` and Dining `32/32`；all `23` package
  format/lint/typecheck/build gates pass. Exact-head pinned-Linux CI owns the isolated PostgreSQL
  and macOS filesystem-boundary matrix.
- `WP-1002 — QR Token / Table Context Resolution` implementation is locally verified from exact
  readiness squash `main@5cf0dae86bca56456bb89c732d04419f0663be98` on branch
  `codex/wp-1002-implementation`. Readiness PR
  [#92](https://github.com/gangzhao2021/bop-rms/pull/92) passed exact head
  `8ebce79730a1bb1636c4eeff5d69fb366f7bc8bc` in run/job
  `30508164239 / 90762314547` in `10m19s`、Section 91 Blocker/High/Medium/Low `0/0/0/0` and
  post-merge exact-main run/job `30508694236 / 90763907668` in `9m0s`. The provider-neutral
  `@rms/dining` Phase-1 stub verifies a bounded canonical ES256 fixed QR against exact immutable
  key-registry and active Store/Table/revocation evidence, then returns only immutable public
  context. A fixed QR grants no Guest Session、Dining join、Host、Order or Merchant authority.
  Focused acceptance is `32/32`；Tenant is `9/9`、Store is `73/73`、all `23` package
  format/lint/typecheck/build gates、architecture runtimes and production audit pass locally.
  Guest Session creation、invalid/expired UX mapping、copied-QR abuse、short-lived Dining join
  credential、rate limiting/WAF、KMS/signing、database/migration、API/UI、real QR/Store/Table facts
  and External Evidence remain gated and unclaimed.
- `WP-1001 — Store Operating Status Query` implementation is locally verified from exact integrated
  readiness `main@89964340482639cb5a2e5f0ee94099da44f935cf` on branch
  `codex/wp-1001-implementation`. Readiness PR
  [#90](https://github.com/gangzhao2021/bop-rms/pull/90) passed exact head
  `355070f6f7eec65400d87f2e43c1f7c5b9a7d774` in run/job
  `30505314830 / 90753684163` in `10m44s`、Section 91 Blocker/High/Medium/Low `0/0/0/0` and
  post-merge exact-main run/job `30505885330 / 90755422963` in `9m13s`. The bounded
  `@rms/store` extension resolves one active Tenant-owned Store and one published、currently
  effective immutable operating-hours configuration at an explicit UTC instant. It maps through
  the configured IANA zone、evaluates weekly and exact-date replacement schedules、handles
  overnight intervals and DST gap/overlap instants、applies all/partial temporary closures and
  returns only `Open`、`Closed` or `TemporarilyClosed` with canonical `DineIn`、`Pickup` and
  `Delivery` availability. Malformed/ambiguous evidence fails closed and telemetry is bounded.
  WP-1001 focused acceptance is `42/42`；Store total is `73/73`、all `22` package quality/build
  gates、dependency regressions、architecture runtimes and production audit pass locally. One
  Domain hard stop was resolved without an exception by keeping the evaluator dependency-free and
  cross-Domain validation in Application composition. Business Date / Business Day Start、cutoffs /
  lead time、capacity、catalog / inventory、Feature Control、QR / Session、Merchant authoring、
  event、database/migration、API/UI、real Store hours and External Evidence remain gated and
  unclaimed.
- `WP-1000 — Store Public Profile Query` is implemented、verified、integrated and cleaned at squash
  merge `5b68af440c5ee5afb53e232d501af73e9a85e891`.
  Readiness PR [#88](https://github.com/gangzhao2021/bop-rms/pull/88) passed exact-head run/job
  `30501916664 / 90743212987` in `10m12s`、Section 91 Blocker/High/Medium/Low `0/0/0/0` and
  post-merge exact-main run/job `30502503415 / 90745020369` in `9m57s`. Implementation PR
  [#89](https://github.com/gangzhao2021/bop-rms/pull/89) passed exact head
  `0e4af5dd123056276edbab053b63ad5224c1737d` in run/job
  `30503865349 / 90749271893` in `8m51s`、Section 91 Blocker/High/Medium/Low `0/0/0/0` and
  post-merge exact-main run/job `30504350058 / 90750744423` in `10m05s`. The bounded
  provider-neutral `@rms/store` Public Query validates exact injected Tenant、Publishing、
  Effective Period and Media evidence、selects one published currently effective profile and
  returns only a closed Public allowlist with deterministic locale fallback. A valid-shaped
  internal Store ID remains unavailable and never becomes authorization；all lifecycle、scope、
  publication、timing、Media、shape and dependency failures are externally uniform. Focused
  acceptance is `31/31`；all `22` package format/lint/typecheck/build gates、architecture runtime、
  dependency-Domain regressions and production audit pass locally. Operating status/hours、QR、
  Customer Session、database/migration、Merchant authoring、API/UI、real Store facts、Provider、
  credential、external resource and deployment remain gated. Both WP-owned branches were removed；
  External Evidence is unavailable and unclaimed.
- `WP-0125 — Task Minimum Contract` is implemented、verified、integrated and cleaned at squash
  merge `0d9a57afc90e348de685d6cce1fca8577aa68c87`. PR
  [#85](https://github.com/gangzhao2021/bop-rms/pull/85) passed exact head
  `5efcffc298877c445fbd9ac39b981dfd141c41b1` in run/job
  `30494011976 / 90718492705` in `10m04s`; Section 91 recorded
  Blocker/High/Medium/Low `0/0/0/0`. Post-merge exact-main run/job
  `30494706604 / 90720705163` passed in `9m48s`. A deterministic pre-existing WP-0006 cold-start
  timeout was isolated from Task code、fixed through PR
  [#86](https://github.com/gangzhao2021/bop-rms/pull/86), and independently passed exact-head and
  exact-main CI before WP-0125 was rerun；no failed run was used as acceptance evidence. The
  allowlisted `@bop/task` package validates exact-scope opaque Tasks、User/Role/Position/Queue
  assignment、append-only assignment/claim history、Membership-backed claim eligibility、
  Permission、expected version、sha256 idempotency、atomic Audit、terminal finality and explicit
  overdue escalation. Task completion records only an opaque reference；Notification failure
  cannot roll back escalation or change the source business result. Focused acceptance is `25/25`.
  No PII/free-form body、database/migration、scheduler/worker、production API/UI、real
  assignment/Notification or external resource exists.
- `WP-0125` documentation-only readiness is integrated at squash merge
  `eefde15a2a92f48ec5b68750302bc84530ba8861`. PR
  [#84](https://github.com/gangzhao2021/bop-rms/pull/84) passed exact-head run/job
  `30489488170 / 90703494416` in `8m52s`; post-merge exact-main run/job
  `30490091853 / 90705521390` passed in `9m49s`. Section 91 recorded
  Blocker/High/Medium/Low `0/0/0/0`.
- `WP-0125 — Task Minimum Contract` documentation-only readiness was opened from exact verified
  `main@bf672b512c6872a661300bc68b579f8129061e83` on branch `codex/wp-0125-readiness`. The bounded
  candidate locks exact-scope opaque Tasks、User/Role/Position/Queue assignment、append-only
  assignment and escalation history、Membership claim eligibility、Permission、expected version、
  idempotency、atomic Audit、terminal finality and source-business isolation. It gates PII/free-form
  payload、business-result ownership、worker/scheduler、real Notification、persistence、production
  API/UI、external resources and External Evidence.
- `WP-0124 — Notification Stub and Delivery Adapter Contract` is implemented、verified、integrated
  and cleaned at squash merge `bf672b512c6872a661300bc68b579f8129061e83`. PR
  [#83](https://github.com/gangzhao2021/bop-rms/pull/83) passed exact-head run/job
  `30487691046 / 90697383204` in `9m47s`; Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`.
  Post-merge run `30488366739` passed every gate in unchanged-SHA rerun job `90700441380` in
  `9m41s` after the first runner-local startup attempt stopped before repository checks. Readiness
  and implementation branches were removed.
- `WP-0124 — Notification Stub and Delivery Adapter Contract` implementation was locally verified
  from exact readiness integration `main@dd79b2922e49edc0741342b59a006e18fc5adae3` on branch
  `codex/wp-0124-implementation`. The allowlisted `@bop/notification` package validates Event-only
  opaque requests、exact Tenant scope、immutable Publishing template/content references、
  transactional/marketing preference separation、suppression、Pilot channel routing、deduplication
  and append-only delivery attempts. First-Pilot routing enables only transactional Email；
  adapter error or malformed/raw response records `Unknown`, and explicit resend creates a new
  sequence. Focused acceptance is `18/18`. No recipient PII、body、Provider payload、Event Consumer、
  persistence、real delivery or external resource exists. Exact-head CI、Section 91 review、merge
  and post-merge verification remain pending.
- `WP-0124` documentation-only readiness is integrated at squash merge
  `dd79b2922e49edc0741342b59a006e18fc5adae3`. PR
  [#82](https://github.com/gangzhao2021/bop-rms/pull/82) passed exact-head run/job
  `30485489192 / 90689984092` in `9m33s`; post-merge exact-main run/job
  `30486219834 / 90692441445` passed in `9m37s`. Section 91 recorded
  Blocker/High/Medium/Low `0/0/0/0`.
- `WP-0124 — Notification Stub and Delivery Adapter Contract` documentation-only readiness was
  opened from exact verified `main@814f53e4baad28a8e0dd82ef6f1a8cd06ba06cdf` on branch
  `codex/wp-0124-readiness`. The bounded candidate locked Event-sourced opaque Notification
  Requests、immutable Template/recipient references、exact Tenant scope、transactional/marketing
  preference separation、deduplication、suppression、Email/SMS/Push routing contracts and
  append-only delivery attempts. It gated recipient PII、template body、Provider payload、
  SES/resource/credential、actual send、Event consumer、retry worker、bounce/complaint processing、
  database/migration、production API/UI and External Evidence.
- `WP-0123 — Configuration Version / Effective Period Contract` is implemented、verified、
  integrated and cleaned at squash merge `814f53e4baad28a8e0dd82ef6f1a8cd06ba06cdf`.
  PR [#81](https://github.com/gangzhao2021/bop-rms/pull/81) passed exact-head run/job
  `30483562112 / 90683510810` in `9m9s`; Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`.
  Post-merge exact-main run/job `30484388223 / 90686281937` passed in `9m43s`; readiness and
  implementation branches and WP-owned temporary resources were removed.
- `WP-0123 — Configuration Version / Effective Period Contract` implementation is locally verified
  from exact readiness integration `main@f053544c308438b8c4ffce34dda80259798d4711` on branch
  `codex/wp-0123-implementation`. The allowlisted provider-neutral `@bop/effective-period` package
  validates immutable opaque timing metadata、explicit UTC + IANA/local-offset round trips、
  half-open/open-ended periods、exact family/scope overlap and reproducible zero/one/conflict
  resolution. Schedule/Renew requires exact Tenant、Permission、accepted approval、expected version、
  idempotency and atomic Audit while recording only deterministic activation/optional expiry
  intents. It owns no configuration payload、overlay priority、persistence、clock/worker、
  Task/Notification delivery、Event、production API/UI、Provider/resource or real schedule.
  Focused acceptance is `15/15`; exact-head CI、Section 91 review、merge and post-merge verification
  remain pending.
- `WP-0123` documentation-only readiness is integrated at squash merge
  `f053544c308438b8c4ffce34dda80259798d4711`. PR
  [#80](https://github.com/gangzhao2021/bop-rms/pull/80) passed exact-head run/job
  `30480840077 / 90674233584` in `7m59s`; post-merge exact-main run/job
  `30481505444 / 90676471757` passed in `9m26s`. Section 91 recorded
  Blocker/High/Medium/Low `0/0/0/0`.
- `WP-0122 — Publishing Lifecycle Minimum Contract` is implemented、verified、integrated and
  cleaned at squash merge `02516889ec494c78e4913560d1112cf82c953aa1`. PR
  [#79](https://github.com/gangzhao2021/bop-rms/pull/79) passed exact-head run/job
  `30478972766 / 90667724076` in `10m17s`; Section 91 recorded Blocker/High/Medium/Low
  `0/0/0/0`. Post-merge run/job `30479824170 / 90670675737` passed in `8m56s`.
- `WP-0122 — Publishing Lifecycle Minimum Contract` implementation is active from exact verified
  `origin/main@036a24727be52279270153547b557c98fd9f92bb` on branch
  `codex/wp-0122-implementation`. The allowlisted `@bop/publishing` package owns strict opaque
  metadata、sequential Draft/Review/Approval/Publish/Archive/Rollback transitions、immutable
  Release Records、exact Brand/Store Permission and atomic Audit composition. Schedule and
  effective resolution remain WP-0123；there is no payload ownership、database/migration、event、
  production API/UI、Provider/resource or real configuration.
- `WP-0122` readiness is integrated at squash merge
  `036a24727be52279270153547b557c98fd9f92bb`. PR
  [#78](https://github.com/gangzhao2021/bop-rms/pull/78) passed exact-head run/job
  `30476251480 / 90658580674` after a bounded per-test timeout stabilized the existing official
  AsyncAPI parser gate；post-merge run/job `30477042301 / 90661245627` passed in `8m53s`.
  Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`.
- `WP-0121 — Media Asset Metadata and Upload Reference` is implemented、verified、integrated and
  cleaned at squash merge `dfd638e408adff3a32524176c55da40e78c51969`. PR
  [#77](https://github.com/gangzhao2021/bop-rms/pull/77) passed same-SHA exact-head CI attempt 2
  after one unchanged Event Catalog timeout；Section 91 recorded Blocker/High/Medium/Low
  `0/0/0/0`. Post-merge run/job `30473117534 / 90648012366` passed in `8m57s`.
- `WP-0121 — Media Asset Metadata and Upload Reference` implementation is active from exact
  verified `origin/main@86140374b8c2b90c2072528b8699d6f114d85ec2` on branch `codex/wp-0121`.
  It adds the provider-neutral `@bop/media` owner for strict private metadata、one-time bounded
  Upload Sessions、server-evidence finalization、quarantined immutable versions、exact
  Brand/Store/Permission access、atomic Audit composition and Dynamic/Pinned reference evaluation.
  No business-facing binary、URL、storage locator or credential exists；only unique Clean + Ready
  versions resolve and formal uses require Pinned. No database/migration、Provider/scanner、
  Privacy lifecycle、publishing、production API/UI、real media、external resource or deployment is
  included. External Evidence remains gated and unclaimed.
- `WP-0121 — Media Asset Metadata and Upload Reference` implementation is locally verified at
  exact behavior commit `f4f7c576945c0338400670c34de8a228a0543de1`. Focused Media `12/12`、
  Tenant `9/9`、Permission `17/17`、Audit `41/41`、Event `13/13`、format、lint、typecheck、all
  `17` builds、architecture runtimes and production audit pass. The lockfile adds only the local
  workspace importer. Root `184/191` retains exactly the seven known macOS fixture boundaries；
  exact-head pinned-Linux CI owns the full matrix. Security/privacy/Domain review records open
  Blocker/High/Medium/Low `0/0/0/0`.
- `WP-0121 — Media Asset Metadata and Upload Reference` documentation-only readiness is
  integrated and cleaned at squash merge `86140374b8c2b90c2072528b8699d6f114d85ec2`. PR
  [#76](https://github.com/gangzhao2021/bop-rms/pull/76) passed exact-head run/job
  `30469452318 / 90635584487` in `9m0s`; Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`,
  reviews `0` and unresolved threads `0`. Post-merge exact-main run/job
  `30470231890 / 90638258184` passed in `8m49s`. Local/remote readiness branches were removed；
  External Evidence remains gated and unclaimed.
- `WP-0121 — Media Asset Metadata and Upload Reference` documentation-only readiness is active from
  exact verified `origin/main@71146b9754fccde5a1ab38847f8d0c15c077be03` on branch
  `codex/wp-0121-readiness`. The bounded candidate adds a provider-neutral `@bop/media` contract for
  private Asset metadata、one-time expiring Upload Sessions、quarantine and bounded check/processing
  states、immutable Asset Versions、exact Brand/Store access scope and Dynamic/Pinned references.
  Business Domains receive references only；they never receive binary data、temporary URLs、
  credentials、storage locators or upload authority. The package creates no database/migration、
  S3/GuardDuty/KMS/scanner integration、signed URL、production route/UI、real media fact、Provider、
  credential、external resource or deployment. External Evidence remains gated and unclaimed.
- `WP-0120 — Feature Flag / Kill Switch Minimum Contract` is implemented、verified、integrated and
  cleaned at squash merge `71146b9754fccde5a1ab38847f8d0c15c077be03`. Readiness PR
  [#74](https://github.com/gangzhao2021/bop-rms/pull/74) passed exact-head and post-merge exact-main
  CI. Implementation PR [#75](https://github.com/gangzhao2021/bop-rms/pull/75) passed exact-head
  run/job `30466097198 / 90626020711` on its unchanged-SHA rerun after one Event Catalog timeout；
  Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`、reviews `0` and unresolved threads `0`.
  Post-merge exact-main run/job `30467541371 / 90631161796` passed on the same-SHA rerun after one
  registry-download-only failure. Local/remote branches were removed；External Evidence remains
  gated and unclaimed.
- `WP-0120 — Feature Flag / Kill Switch Minimum Contract` implementation is locally verified from exact `origin/main@d319e144589e277bc3d335b1a0521e6f1e51e4de` on branch `codex/wp-0120`; exact behavior head is `294bacd5adfc501db3fc7684cdfa8a108a47d3e8`. It adds the provider-neutral `@bop/feature-control` owner with strict Release Flag / Kill Switch definitions、exact Brand/Store precedence、opaque deterministic basis-point rollout、one frontend-hint/backend-authority evaluation、explicit in-flight policy、exact Permission-gated mutation、atomic Audit composition and validated sequential recovery. Focused Feature Control `15/15`、Tenant `9/9`、Permission `17/17`、Audit `41/41`、Event Catalog `13/13`、format、lint、typecheck、all 16 builds、architecture runtimes and production audit pass locally. The unchanged macOS fixture boundaries remain recorded at Domain `55/56`、Migration `28/32` and root `184/191`; exact-head pinned-Linux CI owns those cases. No database/migration、generic Policy Engine、production route/UI、raw identity hashing、real control、Provider、credential、external resource or deployment is included.
- `WP-0120 — Feature Flag / Kill Switch Minimum Contract` documentation-only readiness is active from exact verified `origin/main@9763aadf914e2aa90592f6f7e1c85b0ede13c5a2` on branch `codex/wp-0120-readiness`. The bounded candidate adds a provider-neutral `@bop/feature-control` contract for strict Release Flag / Kill Switch metadata、exact Brand/Store scope and Store precedence、opaque deterministic basis-point rollout、one frontend-hint/backend-authority evaluation、explicit in-flight shutdown policy、Permission-gated state changes、Audit-before-success and validated bounded recovery. It creates no generic Policy Engine、database/migration/RLS/role、production route/UI、raw rollout identity、real Tenant/operational control、Provider、credential、external resource or deployment. External Evidence remains gated and unclaimed.
- `WP-0109 — Object-level Authorization、Store Switch and Cross-Tenant Negative Test` is implemented、verified、integrated and cleaned at squash merge `9763aadf914e2aa90592f6f7e1c85b0ede13c5a2`. Readiness PR [#72](https://github.com/gangzhao2021/bop-rms/pull/72) passed exact-head CI and its same-SHA post-merge rerun after one unchanged Event Catalog timeout. Implementation PR [#73](https://github.com/gangzhao2021/bop-rms/pull/73) passed exact-head run/job `30460276496 / 90604237768` in `8m58s`; Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`、reviews `0` and unresolved threads `0`. Post-merge exact-main run/job `30461222043 / 90607481259` passed in `8m48s`. Local/remote branches were removed；the Owner Handoff remains untracked and unchanged；External Evidence remains gated and unclaimed.
- `WP-0109 — Object-level Authorization、Store Switch and Cross-Tenant Negative Test` implementation is locally verified from exact `origin/main@82d7501fb16fb3d4fa2e8d5e7e5888e6a5969a9e` on branch `codex/wp-0109`; exact behavior head is `d6e38ac379a22ebcf3ee0814bf9e70f9760340b8`. It adds only provider-neutral API composition: strict owning-Domain object-scope evidence after accepted action Permission, and a same-origin/CSRF-authorized Store-switch service that derives Brand from Tenant-owned Store、revalidates active Membership/exact Store Assignment、rotates Session/CSRF authority and returns only the new Cookie mutation plus minimum canonical Tenant Context. Focused object/switch tests `20/20`、complete API `87/87`、Identity `59/59`、Tenant `9/9`、Membership `9/9`、Permission `17/17`、format、lint、typecheck、all 15 builds、architecture runtime and production audit pass locally. No new Domain/repository、private query、database/migration、dependency/lockfile、production route/UI、real fact、Provider、credential、external resource or deployment exists.
- `WP-0109 — Object-level Authorization、Store Switch and Cross-Tenant Negative Test` documentation-only readiness is active from exact verified `origin/main@05b1b87308f26b23bfd2efbbdea81cce0198d328` on branch `codex/wp-0109-readiness`. The bounded candidate adds only API composition over existing public Identity、Tenant、Membership and Permission contracts: an owning-Domain-injected exact object-scope evidence resolver, and a same-origin/CSRF-authorized Store-switch service that revalidates the target Brand/Store/Membership/Store Assignment before rotating Session and CSRF authority. It adds no generic object repository、cross-Domain private query、new Domain、database/migration、Permission seed、production route/UI、real Tenant/workforce fact、Provider、credential、external resource or deployment. External Evidence remains gated and unclaimed.
- `WP-0108 — Workforce Invite、TOTP MFA、Recovery and Session Revocation Policy` is implemented、verified、integrated and cleaned at squash merge `05b1b87308f26b23bfd2efbbdea81cce0198d328`. PR [#71](https://github.com/gangzhao2021/bop-rms/pull/71) first failed exact-head run/job `30454446563 / 90584311790` because the existing Identity session-store acceptance retained a stale two-table inventory；the brief allowlist was explicitly refreshed before the six-table expectation was corrected. Replacement exact head `5476b235c7a8867796866eaeefe7bd4145c7b669` passed run/job `30455197348 / 90586874988` in `8m52s`; Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`、reviews `0` and unresolved threads `0`. Post-merge exact-main run/job `30456015568 / 90589649266` passed in `8m30s`. Local/remote branches and temporary Docker/Compose resources were removed；External Evidence remains gated and unclaimed.
- `WP-0108 — Workforce Invite、TOTP MFA、Recovery and Session Revocation Policy` implementation is locally verified from exact `origin/main@c4b90c64e28f96ef4b988eaa595e98a41e97daad` on branch `codex/wp-0108`; exact behavior head is `d2c7acd9f45e4aa55c58ac77f2affaa441caec5f`. It adds provider-neutral hash-only/single-use workforce invitation、TOTP evidence/status without verifier material、controlled recovery、idempotent actor-wide Session revocation、strict API composition over existing public Membership/Role evidence and four Identity-owned Stage DB-1 tables. Focused Identity `8/8`、complete Identity `59/59`、API composition `5/5`、complete API `67/67`、dedicated PostgreSQL `1/1`、complete 21-migration lifecycle、format、lint、typecheck、build and architecture runtime checks pass locally. Identity does not reverse-depend on Membership/Permission; real Provider/email/credential/workforce/external-resource evidence remains gated and unclaimed.
- `WP-0108 — Workforce Invite、TOTP MFA、Recovery and Session Revocation Policy` documentation-only readiness is active from exact `origin/main@9d650da42834ad4f757b0ddc2242330cf3c7f242` on branch `codex/wp-0108-readiness`. The candidate composes only provider-neutral、synthetic invitation、TOTP status、controlled recovery and actor-wide idempotent Session-revocation contracts over accepted Membership、Role and Session evidence. It proposes four Identity-owned Stage DB-1 tables and strict public cross-Domain evidence, but creates no real workforce fact、Cognito/SES/KMS/Secrets Manager/WAF resource、TOTP seed、email delivery、temporary credential、production route or deployment. External Evidence remains gated and unclaimed.
- `WP-0107 — Cognito same-origin BFF、PostgreSQL Session Store and CSRF Contract` is implemented、verified、integrated and cleaned at squash merge `9d650da42834ad4f757b0ddc2242330cf3c7f242`. Readiness PR [#68](https://github.com/gangzhao2021/bop-rms/pull/68) preserved one unchanged Event Catalog timeout、passed its same-SHA rerun、merged at `10b799373873a169b37b7a00dd85eb3f9db5560b` and passed post-merge CI. Implementation PR [#69](https://github.com/gangzhao2021/bop-rms/pull/69) passed exact behavior-head run/job `30449015398 / 90566300157` and final-head run/job `30449651205 / 90568389088`; Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`、reviews `0` and unresolved threads `0`. Post-merge exact-main run/job `30450340968 / 90570619491` passed. Local/remote branches and temporary Docker/Compose resources were removed; External Evidence remains gated and unclaimed.
- `WP-0107 — Cognito same-origin BFF、PostgreSQL Session Store and CSRF Contract` implementation is verified from exact `origin/main@10b799373873a169b37b7a00dd85eb3f9db5560b` on branch `codex/wp-0107`. Readiness exact head `af8f2abf8d78d506b792e7c4b753abf36e1baea0` preserved the unchanged Event Catalog timeout in job `90554157938`、passed the same-SHA rerun job `90555439418`、merged through PR [#68](https://github.com/gangzhao2021/bop-rms/pull/68) at `10b799373873a169b37b7a00dd85eb3f9db5560b` and passed post-merge run/job `30446344085 / 90557546510`. Exact implementation behavior head `7a9be5858454f0b85613e5afb1b51fd4cb7230be` passed complete pinned-Linux run/job `30449015398 / 90566300157` in `8m27s`, including the dedicated PostgreSQL suite through root `test` and the independent WP-0024 lifecycle. Implementation adds provider-independent OIDC/PKCE and keyed-selector Session orchestration、strict `__Host-` Cookie / same-origin / Fetch Metadata / Session-bound CSRF transport、Identity-owned `authentication_session` and one-time `oidc_authorization_transaction` tables、synthetic authenticated-envelope/rotation/replay evidence and no production route registration. The ownership hard stop was resolved explicitly by adding the required Identity database-access manifest and finite migration-catalog registration. Local focused Identity `10/10`、complete Identity `50/50`、BFF `8/8`、complete API `62/62`、dedicated PostgreSQL `1/1`、complete 20-migration isolated lifecycle、format、lint、typecheck、build、architecture catalog and production audit pass. The missing local `docker compose` plugin was bridged only by an untracked temporary command adapter to installed `docker-compose 5.3.1`, then removed with zero owned resource residue. Four existing APFS/realpath migration fixtures remain exactly recorded；Linux CI supplies their direct owning evidence. Real Cognito / `openid-client` adapter、KMS、Secrets Manager、User Pool / app client、credential、WAF、AWS resource、deployment and production login remain WP-2040 / External Evidence and are neither created nor claimed.
- `WP-0106 — Merchant Authentication Integration Scenario` is implemented、verified、integrated and cleaned at squash merge `a2978963d0328a27fb4a807572e44f41218b384b`. Its exact implementation baseline was `origin/main@0edf45b220534a0fe46beced6b7a6e17251ffdc6` and final exact head was `b51ca3e12e1b7dfa9157208737c84a4b668227eb`. PR [#67](https://github.com/gangzhao2021/bop-rms/pull/67) preserved two unchanged Event Catalog parser timeouts、then passed same-implementation-SHA run/job `30416408249 / 90546054355` and final exact-head run/job `30443588485 / 90548403297`. Section 91 recorded Blocker/High/Medium/Low `0/0/0/0`、reviews `0` and unresolved threads `0`; post-merge exact-main run/job `30444204745 / 90550452539` passed. Local/remote branches and generated pnpm cache were removed；the Owner Handoff file remains untracked and unchanged. External Evidence remains gated and unclaimed.
- `WP-0106 — Merchant Authentication Integration Scenario` implementation is verified from exact `origin/main@0edf45b220534a0fe46beced6b7a6e17251ffdc6` on branch `codex/wp-0106`. Exact implementation head `4df83fd1bd64dd200e597a571a6fb1f915a693e6` first recorded two unchanged Event Catalog official-parser `5000ms` timeouts in jobs `90463779105` and `90464639439`; the same exact SHA passed the complete pinned-Linux gate without code change in rerun job `90546054355` / run `30416408249`, including the isolated PostgreSQL lifecycle. It adds only an injected provider-independent current-Session resolver and API composition through the accepted route-derived Tenant Context、active Membership / Store Assignment、Permission-owned policy materialization and unchanged deny-first evaluator. Seven new synthetic scenarios plus six WP-0103 regressions pass `13/13`, including same-Actor different-Store authority、unscoped write denial、Identity self-grant resistance、explicit-deny precedence and concurrency. Section 91 review records Blocker/High/Medium/Low `0/0/0/0` and unresolved threads `0`. No Cognito/OIDC endpoint、Cookie、Token、CSRF、Session Store、migration、real route/action、workforce/Tenant fact or external resource is introduced.
- `WP-0106 — Merchant Authentication Integration Scenario` documentation-only readiness is active from exact `origin/main@84bba88e0d91f378b4591332ac968f7879d7db05` on branch `codex/wp-0106-readiness`. The candidate increment composes only the accepted provider-independent Identity Session、route-derived Tenant Context、active Membership / Store Assignment and Permission-owned deny-first policy contracts in a synthetic API scenario. It creates no Cognito/OIDC endpoint、Cookie、Token、CSRF、Session Store、migration、real business route/action、workforce/Tenant fact、Provider、credential or external resource. WP-0107–0109 retain those later responsibilities.
- `WP-0105 — Role、Permission Grant and Explicit Deny / Allow` is implemented、verified、integrated and cleaned at squash merge `84bba88e0d91f378b4591332ac968f7879d7db05`. Its implementation baseline was exact `origin/main@8766cd6a358d902cb74011c1ba78434d4b66fc80` and final exact head was `0d15256cfe7f3767effa0df02449d03fe50b0a80`. PR [#65](https://github.com/gangzhao2021/bop-rms/pull/65) passed exact-head pinned-Linux run `30412615959` / job `90451998829` and Section 91 with Blocker/High `0` and unresolved threads `0`. Post-merge exact-main run `30413544125` first recorded the unchanged AsyncAPI official-parser `5000ms` timeout; the same exact main SHA passed all gates without code change in rerun job `90455825124`. Local/remote branches and temporary Docker/network/volume/lease/cache resources were removed. External Evidence remains gated and unclaimed.
- `WP-0105 — Role、Permission Grant and Explicit Deny / Allow` implementation is verified from exact `origin/main@8766cd6a358d902cb74011c1ba78434d4b66fc80` on branch `codex/wp-0105`. It adds strict Workforce Brand/Store policy facts、deterministic materialization into the unchanged WP-0104 evaluator and six permission-owned Stage DB-2 tables under the corrected `0300-bop-governance` namespace. Initial head `c342349…` failed run/job `30411879177 / 90449621922` on the stale complete forced-RLS registry；intermediate head `a1a0fca…` failed run/job `30412230721 / 90450778484` on the stale complete migration count. Both gates were corrected without weakening. Head `8b6216507a2970a8e08ca724d8055794ee441a9f` passed exact-head pinned-Linux run/job `30412615959 / 90451998829`, including `17/17` package tests、complete isolated PostgreSQL lifecycle and dedicated Permission constraints/versioning/RLS/ACL acceptance. Four existing macOS APFS/realpath migration fixtures remain recorded local failures, and local Docker lacks Compose. No action seed、API/frontend、real workforce fact、Provider、credential、staging or production action is included.
- `WP-0105 — Role、Permission Grant and Explicit Deny / Allow` documentation-only readiness is active from exact `origin/main@461a0e67e5d02e102d194b2dd0340badd74d0b21` on branch `codex/wp-0105-readiness`. The candidate increment extends only the existing `@bop/permission` owner with an empty exact-action Permission Catalog、Workforce Brand/Store Role and Role Assignment、Role Permission Grant、Actor Explicit Deny/Allow、optimistically versioned policy state and trusted server-side materialization into the accepted WP-0104 evidence contract. It adds bounded Stage DB-2 persistence and synthetic PostgreSQL evidence, but no concrete business action seed、Platform Admin authority、API/frontend、Workflow/Approval rule、real workforce fact、Provider、credential、external resource or production action.
- `WP-0104 — Permission Evaluation Contract` is implemented、verified、integrated and cleaned at squash merge `461a0e67e5d02e102d194b2dd0340badd74d0b21`. Its implementation baseline was exact `origin/main@4106e91efc4b7cc2112cbfbd3c5841820a65ca57` and exact head was `4054024260d18e29445f42531f6f20e066b0af4b`. PR [#63](https://github.com/gangzhao2021/bop-rms/pull/63) first recorded the unchanged AsyncAPI official-parser `5000ms` timeout at `5847ms` in job `90437661382`; the same exact head passed complete pinned-Linux CI without code change in job `90438691156`. Section 91 recorded open Blocker/High `0` and unresolved threads `0`. Post-merge exact-main run/job `30408829083` / `90440259983` passed all gates. Local/remote branches、temporary stores、Docker/network/volume and cache resources were removed. External Evidence remains gated and unclaimed.

- `WP-0104 — Permission Evaluation Contract` implementation is locally verified from exact `origin/main@4106e91efc4b7cc2112cbfbd3c5841820a65ca57` on branch `codex/wp-0104`. It adds only the accepted evaluation-only `@bop/permission` boundary、strict exact-action/scope/policy evidence validation、deterministic deny-first decision/explanation and 7 focused synthetic tests. Format、lint、typecheck、build、architecture runtime、14 non-database package suites and production audit pass. The existing macOS APFS/realpath/unreadable-mode fixture limitations remain recorded；exact-head pinned-Linux CI is pending. No Role/Grant persistence、database/migration、API/frontend、real workforce fact、Provider、credential or external resource is included.
- `WP-0104 — Permission Evaluation Contract` documentation-only readiness is active from exact `origin/main@08c16197228fc659e66524c7ffa666fe27b70c02` on branch `codex/wp-0104-readiness`. The candidate increment defines one fail-closed server-side authorization decision/explanation contract over an already resolved immutable Tenant Context and normalized synthetic policy evidence. It creates no Role、Permission Catalog entry、Grant/Override persistence、migration、API route、frontend authority、real workforce fact、Provider、credential or external resource.
- `WP-0103 — Tenant Context Middleware` is implemented、verified、integrated and cleaned at squash merge `08c16197228fc659e66524c7ffa666fe27b70c02`. Its implementation baseline was exact `origin/main@b74ba70f269953e5c8958a97cbf9a85672a569ed` and exact head was `fbf87e699ee05ed89494132b9e18de28ae9a8cc3`. PR [#61](https://github.com/gangzhao2021/bop-rms/pull/61) passed exact-head run/job `30404440234` / `90426595435` and Section 91 with Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`. Post-merge exact-main run `30404973883` first failed when the unchanged AsyncAPI parser test took `5307ms` against its `5000ms` timeout；the same exact main SHA reran without code change and passed all gates in job `90429420214`. Local/remote branches、temporary Compose、Docker/lease/cache resources were removed. External Evidence remains gated and unclaimed.
- `WP-0103 — Tenant Context Middleware` implementation is locally verified from exact `origin/main@b74ba70f269953e5c8958a97cbf9a85672a569ed` on branch `codex/wp-0103`. It adds the strict permission-free Tenant Context contract、route-resource-only API resolver using active Identity/Tenant/Membership facts、closed `401/403` behavior、private request cleanup and a generic parameterized transaction-local PostgreSQL scope helper. Dedicated unit、middleware、pool reuse/parallel/prepared/failure、exact 15-table forced-RLS registry and all owning positive/negative suites pass with synthetic data. No Permission/Role/Grant、real authentication/Session、migration/grant/runtime role、Provider、real Tenant/workforce fact or external resource is included.
- `WP-0103 — Tenant Context Middleware` readiness is integrated and cleaned at squash merge `b74ba70f269953e5c8958a97cbf9a85672a569ed`. Its baseline was exact `origin/main@bf6e2053a1ea47ef85b23649890cad0b1d78075f` and exact head was `3aecd0fd11d5e24317d331892857b04b00f529fe`. PR [#60](https://github.com/gangzhao2021/bop-rms/pull/60) passed exact-head run/job `30401907846` / `90418476266` and post-merge exact-main run/job `30402435262` / `90420186082`. Section 91 recorded Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`; local/remote readiness branches、temporary Compose plugin、Docker/lease/cache resources were removed. External Evidence remains gated and unclaimed.
- `WP-0103 — Tenant Context Middleware` documentation-only readiness is active from exact `origin/main@bf6e2053a1ea47ef85b23649890cad0b1d78075f` on branch `codex/wp-0103-readiness`. The candidate increment resolves an active Workforce Actor against route-derived Brand/Store resources and active Membership/Store Assignment evidence、creates a strict permission-free Tenant Context、and applies it only through transaction-local PostgreSQL settings with pool-leak tests. It creates no Role、Permission、authentication Provider、Session/Cookie、runtime database role、migration、real Tenant/Employee data or production resource.
- `WP-0102 — Membership and Store Assignment` is implemented、verified、integrated and cleaned at squash merge `bf6e2053a1ea47ef85b23649890cad0b1d78075f`. Its implementation baseline was exact `origin/main@87bb8434a403f228d84dcc5bb150a7869ae0a421` and final exact head was `702f30dff06e23751f42704ec1b5432fd9e6dcb7`. Initial head `47ee74e188f65de8f11a1f8d1228bb68adb2b1fb` failed run/job `30399764352` / `90411447032` at Manifest discovery and remains recorded；the in-scope correction passed exact-head run/job `30400126339` / `90412626948`. PR [#59](https://github.com/gangzhao2021/bop-rms/pull/59) passed Section 91 with Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`; post-merge exact-main run/job `30400748254` / `90414674699` passed including frozen-install and isolated PostgreSQL lifecycle. Local/remote branches、Docker、lease、temporary Compose and Membership cache resources were removed. Real workforce、Provider、credential、staging and production evidence remains gated and unclaimed.
- `WP-0102 — Membership and Store Assignment` implementation is locally verified from exact `origin/main@87bb8434a403f228d84dcc5bb150a7869ae0a421` on branch `codex/wp-0102`. It adds the accepted public-contract-only `@bop/membership` boundary、strict Workforce Membership and Store Assignment lifecycles、exact fail-closed resolvers、bounded suspension invalidation、forced-RLS persistence and synthetic PostgreSQL evidence. Dedicated aggregate and database acceptance、all affected format/lint/typecheck/build/architecture gates and the complete isolated 18-migration lifecycle pass locally. The existing macOS APFS/realpath/unreadable-mode fixture limitations remain recorded and exact-head pinned-Linux CI is pending. No Role、Permission、Tenant Context middleware、real workforce fact、Provider、credential、staging or production resource is included.
- `WP-0102 — Membership and Store Assignment` documentation-only readiness is active from exact `origin/main@6201cde0022455ab44d28b545fe54fbbe3464f8f` on branch `codex/wp-0102-readiness`. The candidate increment creates one `@bop/membership` owner for immutable Actor+Brand Membership and independent effective Store Assignments、forced-RLS persistence and synthetic evidence. It owns no Role、Permission、Tenant Context、authentication Provider、real workforce fact or production resource.
- `WP-0101 — Brand、Store and Operating Entity Aggregate` is implemented、verified、integrated and cleaned at squash merge `6201cde0022455ab44d28b545fe54fbbe3464f8f`. Its implementation baseline was exact `origin/main@88f0edaabf6bd82844e0fee332a75b1f000758f1` and exact head was `3c1e17cdd0d1105646b30fd9a020cb9d78b775c3`. PR [#57](https://github.com/gangzhao2021/bop-rms/pull/57) exact-head run/job `30394943621` / `90395417011` and post-merge exact-main run/job `30395610878` / `90397617712` passed, including frozen-install and isolated PostgreSQL lifecycle. Section 91 recorded Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`; local/remote branch、generated/runtime、Docker、lease and temporary Compose resources were removed. Real corporation、tax、bank、Store、workforce、Provider、credential、staging and production evidence remains gated and unclaimed.
- `WP-0100 — Identity Actor and Authentication Session Contract` is implemented、verified、integrated and cleaned at squash merge `194faa5e481ec3a722966a3baf2311816466e01d`. Its implementation baseline was exact `origin/main@7ed86c4ca4372f480376e4bfd4de2e20331386fd` and exact head was `f83bdb5aacbf5c1f9fbdf40e45f70fe0223dc34f`. PR [#55](https://github.com/gangzhao2021/bop-rms/pull/55) exact-head run/job `30376033950` / `90331850507` and post-merge exact-main run/job `30376768233` / `90334327686` passed, including frozen-install idempotence and the pinned-Linux isolated PostgreSQL lifecycle. Section 91 recorded open Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`; local/remote branch、generated/runtime and Docker resources were removed. Real Cognito/BFF/Session Store/KMS/credential/staging/production evidence remains gated and unclaimed.
- `WP-0100 — Identity Actor and Authentication Session Contract` implementation is locally verified from exact `origin/main@7ed86c4ca4372f480376e4bfd4de2e20331386fd` on branch `codex/wp-0100`. It adds only the accepted dependency-free `@bop/identity` Phase 0 contract、strict privacy-safe validation、current Session ports、minimal events and 41 focused synthetic tests. It contains no Brand、Store、Membership、Role、Permission、Tenant Context、database migration、Provider/BFF/Cookie/Token/credential or cloud resource. Draft PR、exact-head pinned-Linux CI、Section 91、merge、post-merge exact-main CI and cleanup remain pending; real External Evidence remains gated and unclaimed.
- `WP-0100` documentation-only readiness completed independently: exact readiness head `a721753a5a49ecb44bd87520cd72b65f51d53516` passed pinned-Linux CI run/job `30373118880` / `90321830721`, PR `#54` passed Section 91 with no open finding or unresolved thread, squash-merged as `7ed86c4ca4372f480376e4bfd4de2e20331386fd`, and post-merge exact-main CI run/job `30373798814` / `90324160501` passed before implementation branch creation and readiness resource cleanup.

- `WP-0046 — Audit Hash Chain、KMS-signed Daily Digest and Immutable Archive Verification` is implemented、verified、integrated and cleaned at squash merge `f3610e075d378f19ecbe12f973c795d001731b59`. Its implementation baseline was exact `origin/main@df438688324130a9cf4f74fc69a33567083b038d` and exact head was `0809481f9c02d8fb6e56cb023fb18fa4e0e534e4`. PR [#53](https://github.com/gangzhao2021/bop-rms/pull/53) exact-head run/job `30370827189` / `90313914232` and post-merge exact-main run/job `30371576199` / `90316499891` passed, including the pinned-Linux isolated PostgreSQL lifecycle. Section 91 recorded open Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`; local/remote branch、generated/runtime and Docker resources were removed. Real KMS/S3/Object Lock/retention evidence remains gated and unclaimed.

- `WP-0046 — Audit Hash Chain、KMS-signed Daily Digest and Immutable Archive Verification` implementation is locally verified from exact `origin/main@df438688324130a9cf4f74fc69a33567083b038d` on branch `codex/wp-0046`. It adds the per-scope transactional chain/head、dependency-free RFC 8785、non-empty UTC daily manifest、closed KMS P-256 digest port、archive receipt verifier and 29 focused / 41 total Audit tests. Format、lint、typecheck、build、architecture and production audit gates pass；the existing macOS APFS/realpath and Docker compose exit `125` boundaries remain recorded, with exact-head pinned-Linux CI pending. Readiness PR [#52](https://github.com/gangzhao2021/bop-rms/pull/52) exact head `b6f867d8954b7623ba898bf628684f7c8958d66b` passed run/job `30349616905` / `90243767176`; squash `df438688324130a9cf4f74fc69a33567083b038d` passed post-merge run/job `30350236805` / `90245729505`. Real KMS/S3/retention evidence remains gated and unclaimed.

- `WP-0046 — Audit Hash Chain、KMS-signed Daily Digest and Immutable Archive Verification` documentation-only readiness is active from exact `origin/main@5e8b50b340d9764388f4013375cf50ef3e22defe` on branch `codex/wp-0046-readiness`. The candidate repository increment adds a per-Brand/Store-scope ordered SHA-256 chain、RFC 8785 canonicalization、daily manifest/signature/archive verification ports and fail-closed synthetic evidence without creating a KMS key、S3 bucket、Object Lock policy、credential or cloud resource. Real KMS ECDSA P-256 signing、cross-account immutable archive、retention and restore verification remain gated External Evidence and cannot be represented as passed.

- `WP-0045 — Alert Routing and Basic Runbook` is implemented、verified、integrated and cleaned at squash merge `5e8b50b340d9764388f4013375cf50ef3e22defe`. Its exact implementation baseline was `origin/main@5693627a0150fb3b7939e6c4959b83d1c60d75c4` and exact head was `2234bc10738ffaabee7dc92d19a12420f4fdecc5`. PR [#51](https://github.com/gangzhao2021/bop-rms/pull/51) exact-head run/job `30347705878` / `90237711252` and post-merge exact-main run/job `30348279845` / `90239521438` passed. Section 91 recorded open Blocker/High/Medium/Low `0`、reviews `0` and unresolved threads `0`; branch、generated/runtime and Docker resources were removed. External CloudWatch/SNS/contact/staging evidence remains gated and unclaimed.

- `WP-0045 — Alert Routing and Basic Runbook` implementation is locally verified from exact `origin/main@5693627a0150fb3b7939e6c4959b83d1c60d75c4` on branch `codex/wp-0045`. It adds five closed technical alert classes、registry-owned service/result/error/severity/role routing、a privacy-safe deterministic route plan、25 dedicated acceptance tests and a versioned basic observability runbook. No cloud/provider/contact resource or dependency/lockfile change occurs；real staging delivery、verified subscriptions、contacts and acknowledgement remain gated External Evidence. Readiness PR [#50](https://github.com/gangzhao2021/bop-rms/pull/50) exact-head run/job `30345420544` / `90230374267` and squash `5693627a0150fb3b7939e6c4959b83d1c60d75c4` post-merge run/job `30346034283` / `90232342633` passed.

- `WP-0045 — Alert Routing and Basic Runbook` documentation-only readiness is active from exact `origin/main@3f32f67c877214051c415ba01531165f2ccc19f5` on branch `codex/wp-0045-readiness`. The adopted boundary is a closed、privacy-safe alert-routing contract、role-based escalation plan、deterministic synthetic acceptance evidence and a versioned basic observability runbook. It creates no AWS、CloudWatch、SNS、subscription、credential、contact、staging or paid resource. Real staging fault delivery、verified primary/backup subscriptions and acknowledgement drill remain External Evidence owned by WP-2065/deployment composition and are not represented as passed.

- `WP-0044 — Error Tracking and Core Metrics` is implemented、verified、integrated and cleaned at squash merge `3f32f67c877214051c415ba01531165f2ccc19f5`. Its implementation baseline was `origin/main@165a6d82915462c11a4af00f1b47decdaeb5c428` and exact head was `46645c8af12054dd471056b2c039b588ad4b207d`. PR [#49](https://github.com/gangzhao2021/bop-rms/pull/49) exact-head run [`30343310489`](https://github.com/gangzhao2021/bop-rms/actions/runs/30343310489) / job [`90223646614`](https://github.com/gangzhao2021/bop-rms/actions/runs/30343310489/job/90223646614) and post-merge exact-main run [`30343939082`](https://github.com/gangzhao2021/bop-rms/actions/runs/30343939082) / job [`90225631207`](https://github.com/gangzhao2021/bop-rms/actions/runs/30343939082/job/90225631207) passed. Section 91 recorded Blocker `0`、High `0`、reviews `0` and unresolved threads `0`; local/remote branch and generated/runtime resources were removed. The protected Owner file retained SHA-256 `b4e7ce40a75c05397aefeca5c46789640877c45543adeb8aff3d7ac6cf844892`. Real Collector/AWS/staging evidence remains gated and unclaimed.

- `WP-0044 — Error Tracking and Core Metrics` implementation is locally verified from exact `origin/main@165a6d82915462c11a4af00f1b47decdaeb5c428` on branch `codex/wp-0044`. It adds the accepted OpenTelemetry API `1.9.1` + Node SDK `0.220.0` boundary、three closed operational instruments、sanitized stable-code error tracking and bounded API/Worker lifecycle integration. Dedicated telemetry、privacy/cardinality、affected-package、architecture and quality gates pass；production dependency audit reports no known vulnerabilities. Local macOS Migration/root-test APFS results and the missing local `docker compose` command are recorded without downgrade；exact-head pinned-Linux CI remains pending and owns the complete repository/isolated-PostgreSQL evidence.

- `WP-0047 — React Router 8.3.0 Security Remediation` is implemented、verified、integrated and cleaned at squash merge `165a6d82915462c11a4af00f1b47decdaeb5c428`. Its implementation baseline was `origin/main@5bbe3e0f3f76ec617249b2a5f1aceff48b8f9319` and exact head was `58afa3b6feac06ea3c2e2412d40f1d226039de72`. PR [#48](https://github.com/gangzhao2021/bop-rms/pull/48) exact-head run [`30341303258`](https://github.com/gangzhao2021/bop-rms/actions/runs/30341303258) / job [`90217281158`](https://github.com/gangzhao2021/bop-rms/actions/runs/30341303258/job/90217281158) and post-merge exact-main run [`30341899937`](https://github.com/gangzhao2021/bop-rms/actions/runs/30341899937) / job [`90219146473`](https://github.com/gangzhao2021/bop-rms/actions/runs/30341899937/job/90219146473) passed. Both frontends and the authoritative WP-0004 baseline resolve exact `react-router@8.3.0`; the production audit reports no known vulnerabilities；Section 91 recorded Blocker `0`、High `0`、reviews `0` and unresolved threads `0`. Local/remote branches and generated/runtime resources were removed；the Owner file retained SHA-256 `b4e7ce40a75c05397aefeca5c46789640877c45543adeb8aff3d7ac6cf844892`.

- `WP-0047 — React Router 8.3.0 Security Remediation` documentation-only readiness is active from exact `origin/main@3f3af5dcee496997bf0ee842ee24726bb3e614b4` on branch `codex/wp-0047-readiness`. The Owner authorized this independent inserted WP after the WP-0044 production dependency audit found GitHub-reviewed High advisory `GHSA-qwww-vcr4-c8h2` in both baseline frontend `react-router@8.2.0` pins. The adopted target is exact patched `8.3.0`; readiness is limited to this index and `docs/spec/work-packages/WP-0047.md`. WP-0044's in-allowlist local implementation is parked separately and remains paused.

- `WP-0044 — Error Tracking and Core Metrics` readiness is integrated at squash commit `3f3af5dcee496997bf0ee842ee24726bb3e614b4`. Its initially parked implementation was restored without conflict onto exact `origin/main@165a6d82915462c11a4af00f1b47decdaeb5c428` only after WP-0047 completed its full lifecycle. The prior React Router High advisory is closed by exact `8.3.0`; WP-0044 does not reopen or modify that frontend security boundary.

- `WP-0044 — Error Tracking and Core Metrics` documentation-only readiness is active from exact `origin/main@e50261d43450e84b265a7f9fc9092f16361dfac5` on branch `codex/wp-0044-readiness`. Accepted IDR-0014 fixes OpenTelemetry API `1.9.1` + Node SDK `0.220.0`、ADOT and CloudWatch/X-Ray as the v0.1 direction and excludes an independent Error Tracking SaaS. The Owner's serial authorization adopts the brief's bounded Recommended Owner Decisions `1–18` and exact candidate implementation allowlist. Real AWS/Collector/CloudWatch behavior、alert routing、staging/production evidence and credentials remain gated and unclaimed. No implementation、dependency、lockfile、cloud or external-service mutation occurs on this readiness branch.

- `WP-0043 — Health / Readiness Endpoint` is implemented、verified、integrated and cleaned at squash merge `e50261d43450e84b265a7f9fc9092f16361dfac5`. Its exact implementation baseline was `origin/main@7ba9839715f923671f5c6361eb1e631d33796e39` and exact implementation head was `9ffcaa285d8ba4edaffd5c0ef5b84f4cdcefb812`. PR [#45](https://github.com/gangzhao2021/bop-rms/pull/45) exact-head pinned-Linux run [`30326473458`](https://github.com/gangzhao2021/bop-rms/actions/runs/30326473458) / job [`90172851259`](https://github.com/gangzhao2021/bop-rms/actions/runs/30326473458/job/90172851259) passed, including environment、quality、Realtime/Eventing、frozen-install idempotence and isolated PostgreSQL lifecycle. The explicit Section 91 Process-enforced / GitHub Free solo self-review recorded open Blocker `0`、open High `0`、reviews `0` and unresolved threads `0`; no independent approval or GitHub server-side Branch Protection / Rulesets enforcement is claimed. Post-merge exact-main run [`30326860558`](https://github.com/gangzhao2021/bop-rms/actions/runs/30326860558) / job [`90173954550`](https://github.com/gangzhao2021/bop-rms/actions/runs/30326860558/job/90173954550) passed. Local `main` was synchronized; local/remote WP-0043 branches and generated/runtime resources were removed; the protected Owner file retained SHA-256 `b4e7ce40a75c05397aefeca5c46789640877c45543adeb8aff3d7ac6cf844892`. External Evidence remains gated and unclaimed.

- `WP-0042 — Audit Append-only Contract and Table` is implemented、verified、integrated and closed at authorized squash merge `2b64184458b0da422530c14f68abd5b6fcda4734`. Its exact implementation baseline was `origin/main@9a1a2c42e41425174f19175d840cf824bbe520d0`、implementation branch was `codex/wp-0042` and exact implementation head was `a3eb973671751be0fc6b0aa6ea5f37475e739532`. Draft PR [#42](https://github.com/gangzhao2021/bop-rms/pull/42) exact-head pinned-Linux run [`30303131351`](https://github.com/gangzhao2021/bop-rms/actions/runs/30303131351) / job [`90100703442`](https://github.com/gangzhao2021/bop-rms/actions/runs/30303131351/job/90100703442) concluded `SUCCESS`. The explicit Section 91 Process-enforced / GitHub Free solo self-review covered scope、architecture、Tenant / Brand / Store、forced RLS、permissions、append-only、correction、transaction、idempotency、Audit、error contract、migration、tests、logging / PII / Secret、documentation and generated churn；it recorded open Blocker `0`、open High `0`、reviews `0` and unresolved threads `0`, with no independent approval or GitHub server-side Branch Protection / Rulesets enforcement claimed. Post-merge exact-main run [`30304876508`](https://github.com/gangzhao2021/bop-rms/actions/runs/30304876508) / job [`90106536963`](https://github.com/gangzhao2021/bop-rms/actions/runs/30304876508/job/90106536963) concluded `SUCCESS` against the exact squash commit. The remote and authorized local implementation branches were deleted and confirmed absent；local `main` was synchronized to `origin/main`；the protected Owner file retained SHA-256 `b4e7ce40a75c05397aefeca5c46789640877c45543adeb8aff3d7ac6cf844892`；and the final WP-owned container、volume、network、generated build/cache/store、isolated-lease and temporary-resource inventory was empty. External Evidence remains gated and unclaimed. Deployment is `NOT APPLICABLE / NOT PERFORMED`. This documentation-only closeout is Owner-authorized from the exact integration baseline；WP-0043 and every later Work Package remain unauthorized.

- `WP-0041 — Request / Command / Event Correlation` is implemented、verified、integrated and closed at authorized squash merge `4d780df66b324e1cd0743bbc2419b852ab82ea13`. Its exact implementation baseline was `origin/main@4efb36a61973995ff3241764c37c6aea00ea6b78` and implementation branch was `codex/wp-0041`. Draft PR [#39](https://github.com/gangzhao2021/bop-rms/pull/39) initial exact head `604125b7efc8171ca2c85ab3c8af76ce69b473b1` failed pinned-Linux run [`30237851631`](https://github.com/gangzhao2021/bop-rms/actions/runs/30237851631) / job [`89888957809`](https://github.com/gangzhao2021/bop-rms/actions/runs/30237851631/job/89888957809) at `Verify WP-0006 root environment and startup` because the existing `@bop/eventing` runtime export pointed clean Node at non-emitted source `.js` imports. This failure remains preserved and is not represented as a pass or retry. The Owner-authorized two-file Eventing correction retained source TypeScript types、emitted executable `dist` JavaScript and redirected runtime import to `dist/index.js` without changing any public Eventing contract or dependency version. Replacement head `ff1d40e122224c52a332672f1855e3bf4d9fef1e` passed run [`30274272336`](https://github.com/gangzhao2021/bop-rms/actions/runs/30274272336) / job [`90004214077`](https://github.com/gangzhao2021/bop-rms/actions/runs/30274272336/job/90004214077)；final PR head `f96ba611aea5adf303ffcaa5bee571f07f5ecb31` passed run [`30274941486`](https://github.com/gangzhao2021/bop-rms/actions/runs/30274941486) / job [`90006495357`](https://github.com/gangzhao2021/bop-rms/actions/runs/30274941486/job/90006495357). The explicit Section 91 Process-enforced / GitHub Free solo self-review recorded open Blocker `0`、open High `0` with no independent approval or GitHub server-side Branch Protection / Rulesets enforcement claimed. Post-merge exact-main run [`30275632743`](https://github.com/gangzhao2021/bop-rms/actions/runs/30275632743) / job [`90008858330`](https://github.com/gangzhao2021/bop-rms/actions/runs/30275632743/job/90008858330) concluded `SUCCESS`; the remote implementation branch was deleted and confirmed absent；the final WP-owned container、volume、network、generated build/cache/store and isolated-lease inventory was empty. The known macOS APFS、Linux-only environment verifier、loopback and Docker/Colima boundaries remain recorded without downgrade；External Evidence remains gated and unclaimed. Deployment is `NOT APPLICABLE / NOT PERFORMED`. WP-0042 and every later Work Package remain unauthorized.

- `WP-0040 — Structured Logging` is implemented、verified、integrated and closed at authorized squash merge `5afb2a2afdfab0d3c8a325ea7342fb02075d658d`. Its exact implementation baseline was `origin/main@3fae5dbe18b0c4212f9c2259d694fa02f24c0b5d`, implementation branch was `codex/wp-0040`, and final PR head was `4f9c75250d6f933af09c7c1ad8b4069a11d08039`. PR [#37](https://github.com/gangzhao2021/bop-rms/pull/37) exact-head pinned-Linux run [`30178513599`](https://github.com/gangzhao2021/bop-rms/actions/runs/30178513599) / job [`89731125295`](https://github.com/gangzhao2021/bop-rms/actions/runs/30178513599/job/89731125295) concluded `SUCCESS`; the explicit Section 91 GitHub Free solo self-review was recorded against that exact head with open Blocker `0`、open High `0` and no independent approval claimed. The authorized squash merge was followed by exact-main run [`30178779411`](https://github.com/gangzhao2021/bop-rms/actions/runs/30178779411) / job [`89731787426`](https://github.com/gangzhao2021/bop-rms/actions/runs/30178779411/job/89731787426), also `SUCCESS`. The remote implementation branch was deleted and confirmed absent. The protected untracked Owner file retained SHA-256 `b4e7ce40a75c05397aefeca5c46789640877c45543adeb8aff3d7ac6cf844892` and remained unmodified、undeleted、unmoved and unstaged. Final owned runtime、container、volume、network and generated-resource inventory was empty. The known local macOS filesystem/Docker boundaries remain recorded without downgrading；the final owning evidence is the exact-head pinned-Linux CI. External Evidence remains gated and unclaimed. No GitHub server-side branch protection or independent approval is claimed. Deployment is `NOT APPLICABLE / NOT PERFORMED`. WP-0041 and every later Work Package were unauthorized at that closeout.

- `WP-0036 — same-origin SSE Realtime Hint Transport、Scope Revalidation and Reconnect Contract` is implemented、verified、integrated and closed at squash commit `c68c5b60258890c170d6cdf2ceac5397161b4949`. Its implementation baseline was `origin/main@63220a74e4b4ea07a1eb9848a533b8a435e67898` and exact implementation head was `4528537853213b086d8b848065b713adf62634aa`. PR [#35](https://github.com/gangzhao2021/bop-rms/pull/35) exact-head run [`30143891215`](https://github.com/gangzhao2021/bop-rms/actions/runs/30143891215) / job `89642078777`、explicit GitHub Free solo self-review、authorized squash merge and post-merge `main` run [`30144106945`](https://github.com/gangzhao2021/bop-rms/actions/runs/30144106945) / job `89642626776` passed on `2026-07-25` Toronto time. All fifteen Owner Decisions remain accepted；External Evidence remains gated and unclaimed；deployment、runtime grants、credentials、Provider/external broker mutation and non-local database action remain unauthorized. The remote implementation branch was deleted.

- `WP-0035 — Event Catalog Tooling and Contract Test` is implemented、verified、integrated and closed at squash commit `5be313fbf48a5ac26b8c02e32d46fc90a20bf9b6`. Its implementation baseline was `origin/main@a396930a16578e28e8c5b4df219ee5f517582eed` and exact implementation head was `46ca736c3ac78c9fab281eb343c9b0db64f95a1a`. PR [#33](https://github.com/gangzhao2021/bop-rms/pull/33) exact-head run [`30141041182`](https://github.com/gangzhao2021/bop-rms/actions/runs/30141041182) / job `89634192159`、explicit GitHub Free solo self-review、authorized squash merge and post-merge `main` run [`30141252102`](https://github.com/gangzhao2021/bop-rms/actions/runs/30141252102) / job `89634770536` passed on `2026-07-24` Toronto time. All fourteen Owner Decisions remain accepted；the initial catalog is empty；External Evidence remains gated and unclaimed；deployment、runtime grants、credentials、Provider/external broker mutation and non-local database action remain unauthorized. The remote implementation branch was deleted.

- `WP-0034 — Correlation / Causation Context` is integrated and closed at implementation squash commit `b4051c1fabfe9d5d80f85bb4c60eae64472be1b0`. The implementation baseline was `origin/main@133abf11c63ada66fe284ca86aac661f0a07aaee` and the exact implementation head was `562a555ad044de0a6a407f14bd0645a488498e07`. PR #31 exact-head run `30125566959` / job `89588139756`、explicit GitHub Free solo self-review、authorized squash merge and post-merge `main` run `30127250959` / job `89593547351` passed on `2026-07-24`. Decisions 1–12 remain accepted；External Evidence remains gated and unclaimed；deployment、runtime grant、credential、external broker and non-local database action remain unauthorized. No next Work Package is inferred or authorized.
- `WP-0032 — Inbox / Consumer Idempotency` is integrated into `main` at squash commit `5c95b21f08a426aba554bbbf06a34f3878838b3e`. PR #27 exact-head run `30059992182` / job `89379525670`、explicit GitHub Free solo self-review、authorized squash merge and post-merge `main` run `30060272695` / job `89380338169` passed on `2026-07-23` Toronto time (`2026-07-24` UTC). Deployment、runtime grant、external broker and non-local database action remain unauthorized.
- `WP-0033 — Retry / Dead-letter` is integrated into `main` at squash commit `76ca67a7422f43424bb79c662b19c76ac2a0a3e9`. PR #29 exact head `1789c32efefdfdf530b4766e022c14f217b9a4ea`、run `30065998074` / job `89396985271`、explicit GitHub Free solo self-review、authorized squash merge and post-merge `main` run `30094395470` / job `89484902952` passed on `2026-07-24` Toronto time. Deployment、runtime grant、external broker and non-local database action remain unauthorized.
- `WP-0031 — Worker Outbox Dispatcher` is integrated into `main` at squash commit `2810ba2964dd4e995cadbb210b48bf5d63e817b7`. Its accepted lease/fencing、bounded fairness、at-least-once、Aggregate ordering、Tenant/Store RLS、least-privilege、failure parking and transport-neutral contracts are closed. Deployment、runtime grant、non-local database and external broker integration remain outside WP-0031.
- `WP-0030 — Transactional Outbox Contract and Table` implementation is integrated into `main` at squash commit `9e267c2fe13e8e9fa509cc82e286d0289638d567`。The Owner authorized its documentation-only closeout on `2026-07-23` to reconcile the index and brief with the completed delivery evidence.
- WP-0030 owns only the business-agnostic Event Envelope、caller-transaction Outbox append contract、`platform_eventing.outbox_event` and synthetic atomicity/Tenant evidence。WP-0031–0036 publisher、Inbox、retry/dead-letter、trace/catalog and SSE capabilities remain excluded and are not authorized by this closeout.
- WP-0025 repository documentation is integrated。Its real AWS/RDS Staging restore drill remains blocked by the External Evidence recorded in its brief and is not reopened by WP-0030.

WP-0001 through WP-0036 and WP-0040 through WP-0043 are integrated into `main`；WP-0037–WP-0039 do not exist. WP-0043 exact toolchain、frozen install、dedicated and affected regressions、exact-head owning CI、explicit Section 91 Process-enforced / GitHub Free solo self-review、authorized squash merge and post-merge exact-main CI passed. Its implementation integration baseline is `main@e50261d43450e84b265a7f9fc9092f16361dfac5`. Deployment remains `NOT APPLICABLE / NOT PERFORMED`.

The WP-0022 documentation closeout baseline was `main@d0e1b271aba001104e0cbb989272e47fd5af35c1`；WP-0023 supersedes it only as the later implementation integration baseline recorded above。

WP-0024 implementation commit `6371aa8cc96da021fc2a337a768039abce46548b`、PR #20 owning run `29866659176` / job `88756495623`、explicit solo self-review、authorized exact-head squash merge `bde2871b0f519c9942b8ce49f12583584a701518` and post-merge main run `29867139621` / job `88758070077` passed on `2026-07-21`。Final owned container、volume、network、lease and temporary-resource inventory was empty。External Evidence remains gated and unclaimed；deployment and non-local database action remain unauthorized。

Agents must read the root `AGENTS.md`, this index, and the active Work Package brief before editing. If this index or brief cites an older Handoff version than the current canonical Library file, stop, review the superseding sections, and refresh the bounded brief before implementation. A refresh records the new document version and only the authoritative sections needed by the active Work Package.

## Current repository stage

WP-1404 local implementation verification is active from exact integrated and exact-main verified
`origin/main@2cbc0be35980e8245eeda486d60730004bc5ce8f` on the sole active branch
`codex/wp-1404`. WP-1403 exact implementation head
`2b8fa27a9491e65df76fd65a7b06eb5b3410a042`、PR #151 exact-head run/job
`31301418393 / 93214703808`、the explicit Section 91 Process-enforced / GitHub Free self-review at
`https://github.com/gangzhao2021/bop-rms/pull/151#issuecomment-5230384259`、authorized squash
integration `2cbc0be35980e8245eeda486d60730004bc5ce8f` and exact-main run/job
`31302055359 / 93216317282` are complete. WP-1404 is confined to the exact 31-file allowlist in its
brief. Its implemented provider-neutral contract keeps Ticket status
`Open`, preserves the closed Work Item state vocabulary, records Accept as an append-only fact and
Ready as an OrderItem result, and truthfully separates partial
`KitchenItemProgressRecorded.v1` from final `KitchenItemCompleted.v1`. Frozen install, all affected
application / contract / static database and architecture checks, Kitchen `188/188`, Contracts
`15/15`, root lint / typecheck / build and supplemental disposable PostgreSQL 15 evidence pass.
Official PostgreSQL 18 / Docker acceptance is blocked before assertions by the unavailable local
daemon; four unchanged macOS `/tmp` realpath / case-fold fixtures block the broad local database
test, and restricted npm advisory-registry access blocks the local production audit. Exact-head CI
therefore remains the owning portable gate. No dependency / lockfile, API / UI / SSE / Worker,
runtime role / grant, external service, commit, push, PR, merge or deployment action has occurred.
WP-1405–WP-1408,
WP-1804, WP-1808, `STORE-LIVE-GATE-CA-ON-TOR-001`, external `IDR-0037`, WP-2027 and WP-2045 plus
real Store / Expo / operator / safety / Provider evidence remain gated and unclaimed.
This paragraph supersedes the historical active-stage snapshots below.

WP-0047 documentation-only readiness is active from exact `origin/main@3f3af5dcee496997bf0ee842ee24726bb3e614b4` on the sole active branch `codex/wp-0047-readiness`. WP-0044 readiness is integrated；its uncommitted in-allowlist implementation is parked in a local named stash and must not resume until WP-0047 completes readiness、implementation、exact-head CI、merge、post-merge exact-main verification and cleanup. This paragraph supersedes the historical WP-0044 readiness snapshot retained below.

WP-0044 documentation-only readiness is active from exact `origin/main@e50261d43450e84b265a7f9fc9092f16361dfac5` on the sole branch `codex/wp-0044-readiness`. WP-0043 implementation、exact-head CI、Section 91 review、squash merge、post-merge exact-main CI、main synchronization and branch/resource cleanup are complete. Readiness is limited to this index and `docs/spec/work-packages/WP-0044.md`; implementation、dependency/lockfile changes、cloud resources、credentials、alerts and external-service mutation remain gated until readiness integration.

WP-0042 implementation is integrated and closed at exact `main@2b64184458b0da422530c14f68abd5b6fcda4734`. The Owner authorized this documentation-only closeout from that exact baseline with a two-file tracked allowlist: this index and `docs/spec/work-packages/WP-0042.md`. The closeout records existing accepted evidence only；it does not change the Audit contract、migration、tests、runtime behavior or accepted decisions and does not authorize query/export、Event、production role/grant、hash chain/archive、deployment、external-service mutation or WP-0043+. Governance remains Process-enforced / GitHub Free and does not claim independent approval or GitHub server-side Branch Protection / Rulesets enforcement.

WP-0036 exact implementation head `4528537853213b086d8b848065b713adf62634aa`、PR #35 exact-head run `30143891215` / job `89642078777`、explicit GitHub Free solo self-review、authorized squash merge `c68c5b60258890c170d6cdf2ceac5397161b4949` and post-merge `main` run `30144106945` / job `89642626776` passed on `2026-07-25` Toronto time. The complete pinned-Linux `pnpm verify` gate、Realtime dedicated acceptance and Event Catalog plus PostgreSQL 18 Outbox、Dispatcher、Consumer Inbox、Retry / Dead-letter and Correlation Context regression matrix passed. The final matrix covers exact same-origin and Fetch Metadata denial、injected immutable Session authorization、server-derived Brand/Store scope、minimal lossy hints、revocation、shared synthetic connection limits、heartbeat/lifetime/drain、canonical Query refresh without Command replay、bounded telemetry and unchanged Eventing public contracts. The final implementation resource inventory was empty and the remote implementation branch was deleted. External Evidence remains gated and unclaimed；deployment、runtime grants、credentials、non-local database and external broker action remain unauthorized.

WP-0035 exact implementation head `46ca736c3ac78c9fab281eb343c9b0db64f95a1a`、PR #33 exact-head run `30141041182` / job `89634192159`、explicit GitHub Free solo self-review、authorized squash merge `5be313fbf48a5ac26b8c02e32d46fc90a20bf9b6` and post-merge `main` run `30141252102` / job `89634770536` passed on `2026-07-24` Toronto time. The complete pinned-Linux `pnpm verify` gate、Event Catalog dedicated acceptance and PostgreSQL 18 Outbox、Dispatcher、Consumer Inbox、Retry / Dead-letter and Correlation Context regression matrix passed. The final matrix covers Zod-first authority、empty initial catalog、deterministic JSON Schema / AsyncAPI / Markdown generation、parser / CLI validation、conservative compatibility、safe failures、bounded metric labels and unchanged Eventing public contracts. The final implementation resource inventory was empty and the remote implementation branch was deleted. External Evidence remains gated and unclaimed；deployment、runtime grants、credentials、non-local database and external broker action remain unauthorized.

WP-0034 exact implementation head `562a555ad044de0a6a407f14bd0645a488498e07`、PR #31 exact-head run `30125566959` / job `89588139756`、explicit GitHub Free solo self-review、authorized squash merge `b4051c1fabfe9d5d80f85bb4c60eae64472be1b0` and post-merge `main` run `30127250959` / job `89593547351` passed on `2026-07-24`。The complete pinned-Linux `pnpm verify` gate and PostgreSQL 18 Correlation Context、Outbox、Dispatcher、Consumer Inbox and Retry / Dead-letter acceptance matrix passed；the final matrix covers injected UUIDv7 root creation、immediate Command/Event causation、retry/replay/redelivery/commit-unknown preservation、parallel isolation、fail-closed validation、bounded telemetry and reuse of existing persistence without migration。The final implementation resource inventory was empty。External Evidence remains gated and unclaimed；deployment、runtime grants、credentials、non-local database and external broker action remain unauthorized。

WP-0033 implementation commit `f38375f6fd3fd9044266b6fc5673964ee1b83a82` and final documentation head `1789c32efefdfdf530b4766e022c14f217b9a4ea`、PR #29 exact-head run `30065998074` / job `89396985271`、explicit GitHub Free solo self-review、authorized squash merge `76ca67a7422f43424bb79c662b19c76ac2a0a3e9` and post-merge `main` run `30094395470` / job `89484902952` passed on `2026-07-24` Toronto time。The complete pinned-Linux `pnpm verify` gate and PostgreSQL 18 isolated acceptance for Outbox、Dispatcher、Consumer Inbox and Retry / Dead-letter passed；the final matrix covers versioned full-jitter retry、maximum handoff and horizon、same-key commit-unknown reconciliation、separate Outbox/Consumer state machines、concurrent scheduling/operator commands、append-only evidence、Aggregate head blocking/release、forced Brand/Store RLS、least privilege、metadata-only redaction and cleanup。External Evidence remains gated and unclaimed；deployment、runtime grants、non-local database and external broker action remain unauthorized。

WP-0032 implementation commit `e30c9d75c60ec94c0cad15dbae9e058a0889fb1c`、PR #27 exact-head run `30059992182` / job `89379525670`、explicit GitHub Free solo self-review、authorized squash merge `5c95b21f08a426aba554bbbf06a34f3878838b3e` and post-merge `main` run `30060272695` / job `89380338169` passed on `2026-07-23` Toronto time (`2026-07-24` UTC)。The complete Linux `pnpm verify` gate and PostgreSQL 18 isolated acceptance for WP-0024、Outbox、Dispatcher and Consumer Inbox passed；the final matrix covers registry fail-closed behavior、sequential/concurrent idempotency、atomic Inbox/effect/Outbox success and rollback、crash/lost-ack redelivery、Aggregate ordering boundary、forced Brand/Store RLS、least privilege、safe telemetry/redaction and cleanup。External Evidence remains gated and unclaimed；deployment、runtime grants、non-local database and external broker action remain unauthorized。

WP-0031 implementation commit `13a504085630cfde7dc067758bf8732d6f1d84df`、PR #25 owning run `30044249873` / job `89331382679`、explicit GitHub Free solo self-review、authorized exact-head squash merge `2810ba2964dd4e995cadbb210b48bf5d63e817b7` and post-merge `main` run `30044681013` / job `89332836662` passed on `2026-07-23`。Local isolated resource inventory and runtime cleanup completed。External Evidence remains gated and unclaimed；deployment、runtime grants、non-local database and external broker action remain unauthorized。

WP-0021、WP-0022 and WP-0023 are integrated and closed without changing their accepted designs。WP-0023 supplies bounded synthetic integration evidence for Sections 50.9 and 52.8 only；it creates no production database object or generic persistence abstraction。PR #18 final head `5a003ea30f33ac2d2b43d74baa8f5b79e068cea6`、owning run `29862008680` / job `88740808872`、explicit solo self-review、authorized squash merge `51ee9cf0d46544c065534194fd2f05e5bfdcba3a` and post-merge main run `29862383538` / job `88742098487` passed on `2026-07-21`。External Evidence remains gated and unclaimed；deployment and non-local database action remain unauthorized。

The current accepted floor is：PostgreSQL `18.4`；application-owned business、Command、Event and Correlation IDs use UUIDv7 through `uuid 14.0.1`；a database default may call built-in PostgreSQL 18 `uuidv7()` only for migration / repair paths；the extension allowlist remains only `pg_trgm` and `unaccent`。Money facts use `amount_minor bigint` plus ISO 4217 `currency_code char(3)` and never PostgreSQL `money` or binary floating point。Instants use UTC `timestamptz`，Store zones use IANA identifiers，local operating dates use `date` and wall-clock configuration uses `time without time zone`。Brand is the primary Tenant boundary；Store-owned facts carry both required scopes；critical uniqueness and query indexes include scope；future Brand / Store tables require application authorization plus RLS defense in depth using transaction-local server-resolved context。Cross-domain private-table access remains prohibited。All mutable Aggregate Roots continue to require `version bigint not null`、conditional update by expected version and an explicit conflict instead of last-write-wins；WP-0023 supplies bounded synthetic integration evidence for that rule。WP-0024 now owns the reusable synthetic-only、parallel-safe isolated PostgreSQL lifecycle and does not create a business seed or production fact。

## WP-0022 accepted decision record

The Owner accepted the following implementation-significant choices in Canonical Section 96 / ADR-0033 / IDR-0046：

1. **Helper inventory and ownership** — accept the exact database objects，signatures and owning schema。Recommended：keep pure technical helpers in a migration-owner-owned shared-infrastructure schema distinct from Module facts，enumerate every object and prohibit tables / business facts。Impact：chooses the long-lived public database contract and WP-0013 ownership evidence。
2. **UUID boundary** — decide whether WP-0022 creates any UUID function/default at all，which columns may use it，and validation behavior for supplied IDs。Recommended：no extension and no universal default；use PostgreSQL 18 built-in `uuidv7()` only in the already accepted migration / repair boundary，leaving ordinary ID generation application-owned。Impact：avoids silently moving Domain identity ownership into PostgreSQL。
3. **Money and decimal contract** — accept exact `numeric(precision, scale)` pairs for rates / percentages / divisible quantities，valid currency-code normalization / validation，business bounds and each rounding mode / allocation remainder rule。Recommended：retain `amount_minor bigint + char(3)` for Money and place calculation / rounding in the Domain unless a narrowly enumerated database constraint helper is proven necessary。Impact：prevents inconsistent tax、quote、payment and reporting results；the accepted text does not supply these missing numbers or algorithms。
4. **Time contract** — enumerate any validation/conversion helpers and decide whether Business Date resolution is excluded for WP-1223 or partially implemented now。Recommended：WP-0022 only enforces storage/type and IANA-zone validation contracts；keep versioned Business Day Start、DST gap / overlap resolution and order-number boundary in WP-1223。Impact：avoids two competing Business Date authorities。
5. **Tenant scope contract** — accept exact identifiers / column compatibility，constraint and index templates，RLS metadata boundary，GUC validation behavior and whether WP-0022 creates reusable policy functions without any Tenant table。Recommended：metadata / validation helpers only；actual FK、index and RLS policies remain with each owning-table WP and must follow Section 87.7.5。Impact：prevents a generic helper from becoming an authorization bypass or cross-domain coupling point。
6. **Privilege contract** — accept owner，`SECURITY INVOKER` versus narrowly justified `SECURITY DEFINER`，fixed `search_path`，PUBLIC revocation，function `EXECUTE` defaults，runtime principals and per-object grants。Recommended：default deny、no PUBLIC execute、no advance runtime grant and invoker rights unless an individually threat-modeled definer function is indispensable。Impact：this is a Security / Architecture decision and cannot be inferred from WP-0021 schema ACLs。
7. **Migration and verification contract** — accept exact ordered filenames after `0000_005`，one-schema-per-migration grouping，diagnostic codes / exits，catalog assertions，failure injection and forward-fix behavior。Recommended：immutable ordered forward migrations under Section 94，read-only verification，transaction rollback per migration and no down / repair / baseline behavior。Impact：turns the object decisions into deterministic acceptance evidence without changing the runner。

Dependencies remain：WP-0020 owns catalog / runner behavior；WP-0021 owns the existing foundation schemas / ACL；WP-0023 owns optimistic-concurrency integration；WP-0024 owns reusable seed / fixture / isolated-test database infrastructure。Future business-table WPs own their facts、constraints、indexes、RLS policies and least-privilege grants。WP-0022 must not create business tables、Tenant / Brand / Store facts、roles / logins、seed data、ORM / Repository code、Outbox / Inbox / Audit / Job / Projection objects or application Money / Business Date logic。

External Evidence remains gated and unclaimed：PostgreSQL 18.4 / Amazon RDS compatibility for every selected built-in or extension，actual migration and runtime roles / memberships，production ACL and RLS matrix，IANA tzdata lifecycle，ISO 4217 update source，query-plan / index evidence，backup / restore，staging migration and production approval。No dependency / lockfile、Provider or external-service change was made；the only database connection was the authorized synthetic isolated acceptance suite。
