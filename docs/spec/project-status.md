# BOP-RMS Project Status

## Authority and snapshot

This is the current delivery-status ledger. The [Specification Index](./README.md) remains the
authority entry point; the accepted composite Handoff `0.5.3`, Sections 0–97 and the owning Work
Packages determine behavior and scope. This ledger reconciles delivery evidence without changing
those decisions or granting runtime, Provider or production authority.

- Audit date: `2026-09-05`.
- Integrated snapshot: `main@ac08c14d076ca76b71f55571605b61ef3ed1efde`.
- Snapshot inventory: **264 `WP-*.md` records and one `SPIKE-1300.md` record**.
- Current local work: [WP-2226 — Lossless Quote Snapshot Codec](./work-packages/WP-2226.md)
  on `codex/wp-2226`, based on verified local WP-2225 checkpoint `2a9444b`.
- WP-2215's persisted Entry browser and full local gates passed; its local checkpoint is `7b43cf9`.
- WP-2216's creation/current service and opt-in durable adapter passed the complete local gate
  (root 350/350, Ordering 174/174, all 40 builds) and are locally committed at `ed35fb7`.
- WP-2217 adds safe empty-Cart DTO and Identity-authorized HTTP composition. API 185/185, Ordering 185/185, real HTTP-to-PostgreSQL acceptance and the complete local
  `pnpm verify` gate passed (root 350/350, all 40 builds). It does not
  present nonempty Carts, implement item mutation persistence, supply real Store display sources,
  configure the default runtime or establish a production transaction journey.
- WP-2217 is locally checkpointed at `2f54a23`. WP-2218 implements opt-in Item mutation
  persistence and retry reconciliation. Dedicated PostgreSQL acceptance and complete local verification
  passed (root 354/354, Ordering 189/189, API 185/185, all 40 builds). It does not activate
  Customer HTTP item mutations.
- WP-2218 is locally checkpointed at `9f5571e`. WP-2219 adds optional HTTP reads of persisted
  unquoted Pickup contents and changed-empty Carts, using the real public Catalog query contract
  and Ordering-owned database Quote-absence proof. Dedicated acceptance and complete local verification passed
  (root 358/358, Ordering 210/210, API 187/187, all 40 builds). Price remains explicitly unavailable; nonempty DineIn visibility,
  Item HTTP writes, actual source wiring and default runtime activation remain incomplete.
- WP-2220 adds optional pre-commit public label preparation and atomic operation snapshots.
  Complete local verification passed (root 358/358, Ordering 226/226, API 187/187, all 40 builds).
  HTTP Item writes remain unavailable.
- WP-2221 supplies optional Pickup Item HTTP mutations and original response replay, with
  transaction-locked Quote absence evidence. Dedicated acceptance and complete verification
  passed (root 358/358, Ordering 227/227, API 189/189, all 40 builds). Real runtime/source wiring, Pricing and DineIn visibility are still unavailable.
- WP-2222 passes a normal-assets Chromium journey from signed synthetic Pickup QR through Menu
  and persisted Cart Add/Update/Remove, on mobile and desktop. It checks offline recovery,
  refreshed reads, absent in-memory CSRF refusal, scoped Cart/operation/Audit results and private
  cache/storage/URL/log handling. Retained Entry (2/2) and complete local verification passed
  (root 358/358, Ordering 227/227, API 189/189, all 40 builds).
- WP-2223 adds optional durable Abandon/Expire commands with exact replay, Cart version checks,
  atomic Audit and retained Item/Quote history. Dedicated database acceptance and Ordering 234/234
  passed; the Owner subsequently authorized exact-file ownership registration, and its 49 tests
  passed. Complete local verification passed (root 362/362, Ordering 234/234, API 189/189,
  all 40 builds).
  No HTTP, scheduler or real policy activation is added.
- WP-2224 implements optional Ordering quote-attachment persistence: exact bigint amounts,
  immutable header/line history, version checks and atomic Audit. Dedicated database and retained
  Cart browser acceptance passed; Ordering 241/241 passed. Exact-file ownership registration was
  explicitly authorized and its 53-test check passed. Complete local verification passed
  (root 366/366, Ordering 241/241, API 189/189, all 40 builds).
- WP-2225 corrects Pricing line/component uniqueness to permit immutable requotes retaining
  Cart line references. Fresh-database constraints passed, but upgrading the full predecessor
  database fails with `MIGRATION_OUT_OF_ORDER`: ADR-0031's global high-water rule prevents a new
  Pricing migration after later namespaces have executed. The Owner subsequently authorized
  namespace-local append checks with retained immutable-history protections. The real upgrade
  and full verification now pass (root 377/377, Pricing 97/97, Quote database 2/2, all 40 builds).
  Migration drift/lock/rollback and isolated lifecycle checks also pass. Full Pricing snapshot storage still needs lossless evidence fields, codec
  and adapter; it is not complete.
- WP-2226 adds strict immutable Phase-1 Quote validation and lossless versioned encoding for
  monetary values and complete calculation evidence. Pricing 139/139 and complete local verification
  passed (root 377/377, all 40 builds); it does not
  add database fields, a Quote repository, HTTP wiring or real Price/Tax sources.
- These local checkpoints are outside the fixed 264-WP integrated snapshot. No GitHub integration
  or production result is claimed by this local task.

The software has broad Domain, application, schema, UI and isolated-test coverage. The remaining
priority is a persisted Customer transaction journey through those owners. The ordinary API and
Worker entry points do not yet compose that complete journey. Work Package counts, registered
Screens, migrations, passing synthetic tests and integrated commits are separate from usable
business transactions and production readiness.

## Evidence meanings

| Evidence                      | What it establishes                                                                      | Limit                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Git-confirmed integration     | The named commit and WP records are present in the audited main history/tree             | Does not prove every acceptance criterion or deployment                           |
| Recorded local verification   | An owning WP records commands and results for its bounded implementation                 | Historical evidence; not a new execution in this audit                            |
| Recorded CI result            | A tracked WP records an exact head/main run and job outcome                              | Historical evidence; remote Actions were not independently refreshed by this work |
| Current observed verification | The current owning WP records an actually executed command against its local change      | Pending until the command completes; never inferred from historical counts        |
| Runtime composition           | An entry point supplies the required owner contracts and persistence dependencies        | A callable adapter or injectable factory alone is insufficient                    |
| Browser acceptance            | A specific browser path was exercised with the stated assets, transport and dependencies | A synthetic read-only demo does not prove persisted transactions                  |
| Production readiness          | Applicable external evidence, runtime controls and independent go/no-go are accepted     | Remains blocked; no local software result supplies those facts                    |

## Integrated delivery batches

The counts below are reconstructed from Git trees at the fixed snapshot, not from heterogeneous
`Done`, `Pending` or `Deferred` strings in historical briefs.

| Batch                    | Git evidence                                                                                                 | WP records | CI evidence                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------: | ------------------------------------------------------------------------------------------------------- |
| Before aggregate PR #168 | Tree at `3ce5966960dd860acc8f41fb804b01f468d992c0`, an ancestor of the snapshot                              |        114 | Historical individual WP/index records; not re-audited as 114 separate CI results                       |
| Aggregate PR #168        | `41ac34f2ff8a51d4b79c4e024d7d2cb552273056`, whose sole parent is `3ce5966`; all 138 WP changes are additions |        138 | [WP-2202](./work-packages/WP-2202.md) records exact-main run/job `33654851978 / 100330734031` as passed |
| After aggregate PR #168  | The 12 separately integrated WPs listed below, WP-2203 through WP-2214                                       |         12 | Separate historical sources and limits below                                                            |
| Total at `ac08c14`       | 114 + 138 + 12                                                                                               |    **264** | No blanket claim that all 264 are full production capabilities                                          |

Both the pre-aggregate and aggregate commits pass Git ancestry checks against the snapshot. The
exact 138-WP aggregate set is:

```text
WP-1704–1709, WP-1720–1724,
WP-1800–1809, WP-1900–1905,
WP-2000–2005, WP-2020–2028, WP-2040–2055, WP-2060–2066,
WP-2100–2105, WP-2110–2116, WP-2120–2126, WP-2130–2137,
WP-2140–2146, WP-2150–2155, WP-2160–2165, WP-2170–2178,
WP-2180–2183, WP-2190–2199, WP-2200–2202
```

These ranges enumerate existing consecutive IDs within each group. They do not include absent
numbers between groups. `SPIKE-1300` is counted separately: its public feasibility conclusion is
resolved, while real Payment account, capability, residency and reader evidence remain gated.

The integration count includes bounded documentation and test outcomes. In particular,
[WP-1806](./work-packages/WP-1806.md) and [WP-2024](./work-packages/WP-2024.md) are explicit no-code
closeouts under later accepted authority. [WP-0025](./work-packages/WP-0025.md) completes a restore
runbook without a real staging restore, and [WP-2206](./work-packages/WP-2206.md) completes a readiness
inventory without satisfying its external requirements.

## Recent integrated work

Every implementation commit below is in the audited Git history. CI results are repository-recorded
evidence, not newly fetched results. A PR reference without a recorded run/job means the ledger lacks
that CI evidence; it means neither failure nor a newly verified pass.

| WP                                    | Bounded result                                     | Implementation commit / PR | Exact-main CI evidence source                                |
| ------------------------------------- | -------------------------------------------------- | -------------------------- | ------------------------------------------------------------ |
| [WP-2203](./work-packages/WP-2203.md) | Automated local Merchant demo acceptance           | `34e10a3` / #174           | Recorded PASS: `33695751384 / 100464115563`                  |
| [WP-2204](./work-packages/WP-2204.md) | Local synthetic Customer workflow preview          | `c6afd95` / #176           | Recorded PASS: `33713587992 / 100518007560`                  |
| [WP-2205](./work-packages/WP-2205.md) | Automated local Customer demo acceptance           | `59183f4` / #178           | Recorded PASS: `33754686414 / 100646148155`                  |
| [WP-2206](./work-packages/WP-2206.md) | Pilot readiness inventory                          | `b327467` / #180           | Recorded PASS: `33797765237 / 100789479743`                  |
| [WP-2207](./work-packages/WP-2207.md) | API dependency wiring and HTTP regression          | `75b0f51` / #182           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2208](./work-packages/WP-2208.md) | Customer Entry Domain composition                  | `7f7f09c` / #183           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2209](./work-packages/WP-2209.md) | Identity-owned PostgreSQL Entry persistence        | `e24d3e1` / #184           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2210](./work-packages/WP-2210.md) | Interactive Guest Session renewal persistence      | `a6baec4` / #185           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2211](./work-packages/WP-2211.md) | Session rotation, revocation and operation history | `c0546a5` / #186           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2212](./work-packages/WP-2212.md) | Scoped pooled Session transactions                 | `ec6650c` / #187           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2213](./work-packages/WP-2213.md) | Read-only legacy Session rollout inspection        | `c687106` / #188           | Brief delegates exact delivery evidence to PR; not refreshed |
| [WP-2214](./work-packages/WP-2214.md) | Opt-in cryptographic credential provider           | `ac08c14` / #189           | Brief delegates exact delivery evidence to PR; not refreshed |

The local WP-2216–2224 implementation is tracked separately from the integrated snapshot below.
The local catalog now contains 87 migrations; the baseline count of 85 remains historical.

## Capability layers at the integrated snapshot

| Capability                                                               | Core implementation                                                                                        | Persistence evidence                                                                                                                                   | Runtime and browser integration                                                                                                                         | Production state                                                                               |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Customer Entry and Guest Session                                         | QR/Store/Identity composition, Session lifecycle and credential provider exist                             | Identity-owned PostgreSQL adapter and pooled HTTP/Session isolated acceptance exist                                                                    | Opt-in composition exists; ordinary API startup does not supply the dependencies. WP-2215 separately passed local persisted normal-browser acceptance   | Real QR/Store/admission sources, runtime keys, principals and rollout remain unavailable       |
| Menu, Cart and Quote                                                     | Customer transports/screens and owner services exist for bounded query, item, lifecycle and Quote behavior | Tables and isolated acceptance exist; creation/current-Cart ownership, callable repositories and source composition still need their owning increments | Local Customer demo uses synthetic dependencies; no complete persisted Customer Cart/Quote browser journey is established                               | Unconfigured dependencies fail closed                                                          |
| Order and Payment                                                        | Ordering submission, Payment orchestration, events, reconciliation and Provider contracts exist            | Schemas and isolated transaction tests exist; the complete runtime repository/Provider composition is not established                                  | No complete normal-browser persisted Checkout/Payment/Order journey is established                                                                      | Stripe account, credentials, webhook trust, supported methods and real acceptance remain gated |
| Worker, Kitchen, Pickup and Receipt                                      | Dispatcher/Inbox/retry, owner services, projections and UI contracts exist                                 | Owner tables and isolated contract/transaction tests exist                                                                                             | Ordinary Worker startup does not activate the complete business consumer chain; demo visibility does not prove it                                       | Named operators, Store/device UAT and operational evidence remain unavailable                  |
| Administration, Inventory, Procurement, CRM, Delivery, BI and Compliance | Broad bounded Domain/workflow/Screen implementations exist                                                 | Coverage varies by owning WP; a migration or projection contract is not a deployed repository/source                                                   | Real source/provider composition and complete operating journeys are not established by the WP count                                                    | Delivery remains disabled for the first Pilot; external facts are unclaimed                    |
| Cloud, release and recovery                                              | Policies, validators and runbooks exist                                                                    | Synthetic evidence validates controls, not real resources or artifacts                                                                                 | WP-2063 adds no CDK stack/bootstrap/synth; WP-2064 adds no live deployment workflow; report/pipeline execution also remains behind unavailable adapters | No production deployment, real release evidence bundle or restore/DR result is claimed         |

The read-only demo baselines recorded [42 Merchant Chromium cases](./work-packages/WP-2203.md) and
[36 Customer Chromium cases](./work-packages/WP-2205.md). They intentionally use synthetic data and
exclude demo behavior from production builds. WP-2215 instead targets normal Customer assets,
same-origin loopback HTTPS, the real credential implementation and isolated PostgreSQL. Its passed
Entry acceptance establishes a persisted Guest Session only; it does not establish Cart, Quote,
Order, Payment, Fulfillment, Stripe Sandbox or complete Phase-1 transaction acceptance.

## Ordered remaining transaction increments

These are prerequisite descriptions for later bounded Work Packages, not new WP assignments or
implementation authorization. Each increment must preserve owner contracts, explicit scope,
permissions, expected versions, idempotency, Audit and immutable history.

1. **Persisted browser Entry — WP-2215 locally verified.** Verified normal Customer assets → same-origin HTTPS
   Entry API → public Domain composition → pooled Identity PostgreSQL persistence → the existing
   Entry screen. Use synthetic QR/Store/admission inputs and ephemeral test key material. Verify
   secure cookie handling, fresh-adapter persistence, denied requests, unavailable storage and
   cleanup. No transaction-completion claim follows from Entry success.
2. **Ordering-owned Cart creation and current-Cart resolution.** WP-2216 implements the local
   application service and opt-in PostgreSQL repository: Pickup Session ownership, shared Dining
   Session ownership, exact operation replay, explicit lifecycle policy, atomic Audit and concurrent
   creation. Its isolated database acceptance passed; final expanded `pnpm verify` passed.
   Existing unmapped Cart data fails closed, with no arbitrary selection or duplicate creation.
   WP-2217 connects the existing transport to Identity and a strict purpose/scope-bound display
   source port for pristine empty Carts, with real HTTP and database acceptance. WP-2219 supplies
   nonempty Pickup display; real public display sources and default runtime wiring remain missing.

3. **Cart Item HTTP wiring, lifecycle persistence and authorized Catalog/Store sources.** WP-2218
   supplies the opt-in Ordering Item repository, exact version conflicts, atomic Audit and original
   operation outcomes, with fresh-pool reads and isolated concurrency/rollback evidence. Full local
   verification passed. WP-2219 adds unquoted Pickup and changed-empty presentation through optional
   HTTP reads, with Catalog names and explicit unavailable estimates; complete local verification
   passed. Nonempty DineIn still needs Host/Participant field-visibility authority. WP-2220 adds durable public labels for original operation replay. WP-2221 connects optional Pickup Item HTTP writes with original response replay and transactional Quote checks. WP-2222 supplies browser evidence for this unquoted Pickup path using synthetic public sources; refresh preserves reads but cannot restore in-memory CSRF for writes. Session resume remains an explicit later increment.
   WP-2223 supplies optional lifecycle persistence; lifecycle HTTP/scheduler composition and real Catalog/Store source wiring remain missing. A Pickup `ContextOnly` Session and a DineIn Session have different
   rules: DineIn mutations require `DiningBound`, the matching Dining Session and participant.
   A ContextOnly DineIn Entry cannot substitute for the accepted admission/binding flow.
4. **Immutable Quote storage and Checkout sources.** WP-2224 implements the optional Ordering attachment repository, with dedicated and complete local verification passed. Pricing-owned full Quote storage remains separate. Compose Pricing-owned Quote creation,
   lifecycle/recalculation and durable Quote retrieval with authorized Catalog/Pricing/Store
   sources, Cart version attachment and Checkout revalidation. Prove freshness, expiry, repricing,
   denied scope and reload behavior without client-supplied money, tax or manufactured Store facts.
5. **Payment-owned public orchestration of Ordering submission.** The public payment workflow
   must call Ordering's accepted internal creation service; do not add a standalone Customer
   Create Order endpoint. The Ordering repository must commit Order, first Batch/Items, allocation,
   Submission, Audit and Outbox atomically under [WP-1224](./work-packages/WP-1224.md) and
   [WP-1226](./work-packages/WP-1226.md). Payment consumes durable, exact submission/capacity evidence
   before Provider work. Preserve permanent idempotency and unknown outcomes; synthetic Provider
   tests cannot establish real Provider-confirmed Payment success or replace future real Provider
   acceptance.
6. **Worker consumers and owner projections.** Wire the accepted dispatcher, scoped work source,
   Inbox consumers, exact public snapshots, retries/dead-letter and transactional projection
   effects. Prove duplicate delivery, failure/recovery and observable Customer/merchant reads without
   reading other Domains' private tables or inventing confirmation facts.
7. **Kitchen, Pickup and Receipt closure.** Drive Kitchen and Fulfillment only through their
   accepted authoritative facts; prove named-operator command authorization, item-ready progression,
   Pickup proof/handoff, Order completion and immutable Receipt retrieval in the persisted browser
   journey. Repeat/reload/failure tests must preserve the same durable facts. Real device/Store UAT,
   notification delivery and operational acceptance remain separate gates.

## External and future gates

The [Pilot Integration Readiness Inventory](../runbooks/pilot-integration-readiness-inventory.md)
contains **26 blocked items** at this snapshot: one governing-source item and 25 evidence items.
The authoritative external `IDR-0037` and accepted real corporation, premises, professional review,
tax, payment, privacy, accessibility, staffing, device, production platform, recovery, release,
communications, initialization and go/no-go evidence remain unavailable and unclaimed. This WP
does not advance any row or configure runtime keys.

The first Pilot still plans Dine-in and Pickup for the synthetic Toronto Store; Delivery is
disabled. Physical printers, Store Gateway and an application offline command queue remain accepted
Future Triggers. Their absence is not an implementation defect or authorization to add them.

## Reading historical status records

Earlier briefs and index entries retain the state, authorization and limitations recorded at their
own execution time. Exactly 109 baseline WP files still contain the old explicit
`GitHub publication/integration: Deferred by Owner direction` status; all 109 belong to the
138-package PR #168 set above. The later Git integration supersedes that integration status only.
It does not retroactively authorize an earlier action, replace old CI evidence, enable runtime
dependencies or satisfy external readiness.

Likewise, old `DRAFT PR PENDING`, `Implementation active` and repository-stage paragraphs are
historical snapshots. Use this ledger for current integration and the named current WP for current
work. Preserve historical evidence; correct present-tense guidance through an explicit later
update. A future ledger refresh must name its new snapshot, recount its Git tree and distinguish
new observations from records inherited from this one.
