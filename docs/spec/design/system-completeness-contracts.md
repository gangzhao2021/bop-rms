# System Completeness Contracts

## Status, authority and scope

This is the documentation proposal owned by [WP-2224](../work-packages/WP-2224.md).
It covers release compatibility, privacy-owner coverage and performance acceptance. It creates no
runtime behavior, manifest schema, API field, database object, policy value or executed test.

`Baseline` identifies an existing accepted repository contract. `Proposed` identifies a concrete
design for source reconciliation and owner review. `Decision required` identifies an unset choice;
`External evidence` identifies a real-world result that documents or synthetic tests cannot supply.
The complete external Handoff was unavailable; local absence is not proof of a missing external rule.
The design index and business-scenario matrix track these proposals alongside the other handoffs.

## Release compatibility

### Baseline

[WP-2064](../work-packages/WP-2064.md) and the
[deployment policy](../../security/release-deployment-pipeline-baseline.json) require the same
scanned immutable digest in Staging and production, a 10% canary, at least 10 minutes of observation,
automatic rollback to the prior healthy digest, and a dedicated one-shot migration role/task.
Migration order remains expand, backfill, dual-compatible application, verify, then contract;
contract waits for its observation window. Application startup never runs migrations.

[WP-2049](../work-packages/WP-2049.md) forbids activating a waiting PWA update on Cart, Checkout,
Payment or Order routes. Activation requires explicit action on an accepted stateless route.
There is no background mutation replay or automatic transactional-page reload.
[WP-2002](../work-packages/WP-2002.md) already requires exact Event/Consumer schema compatibility,
scope and replay-safety declarations; this proposal adds release coordination, not Event identity.

### Proposed: a versioned compatibility manifest

Release owns one immutable manifest per candidate; API, Customer PWA, Worker, Database and Event
owners attest their rows. The manifest uses controlled artifact/evidence references. Actual registry
digests, environment identities and deployment evidence stay in the approved restricted system.

| Required field         | Meaning and rejection condition                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest identity      | Schema/version, candidate reference, source baseline, owner roles, review decision and effective time; missing or superseded review blocks release.      |
| Component set          | Exact PWA build, API build, Worker build and database migration watermark; no ambiguous `latest` component.                                              |
| Supported combinations | Explicit old/new component tuples, supported public request/response versions, persisted formats and allowed reads/writes; absence means unverified.     |
| Client cohorts         | Existing open PWA, installed cached shell, returning offline client and newly loaded client; identify each supported build and its retirement condition. |
| Worker cohorts         | Existing leased work, new claims and queued/replayed Events, with exact Consumer identity and accepted schema versions.                                  |
| Transition evidence    | Expand/backfill completion, consistency verification, coexistence results and contract eligibility; no inference from migration exit alone.              |
| Recovery set           | Prior healthy digest plus compatible schema/consumer watermark, verified rollback combinations and controlled compensation/restore procedure.            |
| Observation decision   | Canary window, separate migration-contract window, cohort retirement evidence, reviewers and unresolved conditions.                                      |

The manifest records both directions: new readers against pre-transition facts and retained readers
against facts written by the new version. It covers response parsing, command validation, stored
operation results, leases and Event payloads. A passing schema comparison alone is insufficient.

Proposed transition rules:

1. Before expansion, reject incompatible old/new combinations and incomplete recovery evidence.
2. During coexistence, preserve each declared old client's safe read, status-query and command
   behavior. Unknown results retain the same logical operation reference; refresh never resubmits.
3. Before contract, verify backfill completeness and the retirement or continued compatibility of
   old API/Worker consumers. An old PWA's disappearance from samples is not retirement proof.
4. Keep contract blocked if it makes the accepted prior-healthy rollback digest incompatible.
   Do not silently disable automatic rollback; a conflicting release strategy needs a new decision.
5. If compatibility is unknown, stop promotion or the affected transition. Recovery uses only the
   owner-approved procedure and retains append-only migration, transaction and evidence history.

For an unsupported returning PWA, the proposed behavior is an explicit update/recovery state:
preserve available operation references in the existing permitted memory boundary, query uncertain
outcomes through a supported owner-approved path and block unsupported new mutations. Offer update
only after reaching an accepted safe route. Do not invent persistent private browser storage or a
new recovery endpoint. If that path is unavailable, retain uncertainty and provide existing support.

### Decision required and acceptance

| ID     | Required decision/input                                                                                                                          | Accountable roles                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| SC-D01 | Source-reconciled supported-client/build set, support/retirement duration and safe recovery behavior; no arbitrary universal N-minus-one policy. | Product + Customer PWA + API               |
| SC-D02 | Database/Worker coexistence combinations, contract observation window and rollback-compatible release sequence.                                  | Release + Database + Event/Consumer owners |

Real cohort observations, migration/backfill execution and rollback drills are External Evidence.
Neither the accepted 10-minute canary minimum nor the proposed cohort record supplies an automatic
client-support lifetime or permission to contract a schema.

| Scenario ID | Designed acceptance; all unexecuted in WP-2224                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-COMP-01  | Exercise every declared old/new tuple across public responses, command validation, stored replay results and queued Events; reject an omitted/unsupported tuple.  |
| SC-COMP-02  | Keep an old PWA on Payment during rollout and reopen an offline cohort; show safe uncertainty/recovery without activation, private persistence or command replay. |
| SC-COMP-03  | Fail a canary after expansion/backfill and prove the prior healthy digest can read and operate against the current schema with the same idempotency facts.        |
| SC-COMP-04  | Attempt contract with an old Worker lease, unsupported client or incompatible rollback digest; block until the recorded compatibility/retirement conditions pass. |

## Privacy-owner coverage

### Baseline

[WP-2051](../work-packages/WP-2051.md), [WP-2146](../work-packages/WP-2146.md) and the
[privacy policy](../../security/privacy-execution-policy.json) retain the four rights, proportional
identity proof, a 30-calendar-day response target, encrypted single-use export up to 24 hours,
legal-hold/statutory precedence and preservation of required financial/Audit history.
The [statutory archive policy](../../security/statutory-archive-policy.json) separates archives
from backups and excludes unnecessary contact/free text/health detail from archive snapshots.
Minimal tombstones must replay before restored traffic; they are excluded from search/analytics.

Privacy coordinates requests; each Data Owner retains its facts and performs its own authorized
operation. WP-2146's repositories, Jobs, owner commands and artifacts remain ports. This document
does not create a Privacy namespace, dispatch runtime, actual subject inventory or professional rule.

### Proposed: coverage manifest and request coverage snapshot

Privacy and the Data Owners maintain a versioned metadata manifest. Each request pins its reviewed
manifest version and a minimized coverage snapshot before collection can enter final review.

| Required field         | Meaning and rejection condition                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifest identity      | Version, source/policy references, effective period and Privacy/Data Owner review; unknown or ambiguous policy blocks planning.                                   |
| Owner and data surface | Registered owner Module, controlled public field/record-class references, classification and scope rules; no private table lookup or actual field value.          |
| Applicability          | Right, subject category and purpose mapped to owner responsibilities; each candidate owner requires a recorded applicable or not-applicable disposition.          |
| Copies and derivations | Owner of each declared projection, search copy, artifact, downstream recipient or recovery copy, with reconciliation/tombstone duties.                            |
| Retention/hold         | Accepted policy version, trigger reference, hold-check owner and permitted operation; professional requirements are references, never inferred legal conclusions. |
| Execution evidence     | Owner command/operation contract, idempotency rule, expected result kind and controlled evidence reference; no raw export/deletion content.                       |
| Completion rule        | Required outcome, verification and delivery/replay evidence per right; requester-visible result uses the existing minimized contract.                             |

The request snapshot records the exact expected owner/data-surface set and its coverage digest,
scoped opaque subject reference, policy version, reviewer, work-item links and outstanding items.
These are proposed planning metadata, not additions to the current closed work-item status enum.
No names, email, phone, unrestricted object IDs, credentials or source rows belong in the manifest.

Proposed planning and closure rules:

1. Resolve scope and proportional proof through accepted ports, then enumerate owners from the
   pinned manifest. Manual work-item entry cannot by itself prove complete data coverage.
2. Distinguish owner-confirmed no applicable data from missing, failed or timed-out owner results.
   Record the evidence for a no-data disposition; absence of rows/logs is not such evidence.
3. Run only owner commands with exact scope, purpose, version and idempotency. Correction preserves
   transaction history; withdrawal does not imply erasure, and hold-blocked erasure is not complete.
4. Reconcile every expected owner result before final review. Failed/held items keep a controlled
   unresolved disposition; a reviewed denial can follow the existing lifecycle, never false success.
5. Access/Portability requires the approved export and delivery outcome; Correction requires owner
   correction evidence; Withdrawal requires applicable consent/use changes; Deletion/Anonymization
   requires owner outcomes and applicable tombstone/derived-copy disposition. Exact evidence types
   and lawful exceptions must be approved through SC-D03 rather than invented by the coordinator.
6. If the manifest changes during a request, compare coverage sets and obtain a recorded addendum
   decision before closure. Preserve the original snapshot and prior outcomes; do not overwrite them.

| ID     | Required decision/input                                                                                                | Accountable roles                                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| SC-D03 | Complete owner/data-surface inventory, per-right applicability, fulfillment/denial evidence and review responsibility. | Privacy + Data Owners; Legal for professional policy |
| SC-D04 | Changed-manifest handling, derived-copy duties and tombstone coverage across restore/replay.                           | Privacy + Data + Projection/Archive owners           |

Real identity proof, legal holds, retention approvals, owner execution, artifacts and delivery are
External Evidence. The accepted retention periods are preserved; this proposal assigns no new one.

| Scenario ID | Designed acceptance; all unexecuted in WP-2224                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-PRIV-01  | Omit an applicable owner or derived copy while every entered work item is Completed; coverage reconciliation must prevent Fulfilled.                 |
| SC-PRIV-02  | Exercise owner-confirmed no data, timeout, foreign scope, legal hold and failure separately; none may become inferred erasure success.               |
| SC-PRIV-03  | Add a data surface during collection and attempt closure with the old set; require a reviewed coverage addendum and preserve history.                |
| SC-PRIV-04  | Reconstruct source/derived data after restore and check applicable tombstones before traffic; test each right's required completion/export evidence. |

## Performance and capacity acceptance

### Baseline

[WP-0045](../work-packages/WP-0045.md) leaves numeric thresholds/windows to an accepted SLO/capacity
WP. [WP-2065](../work-packages/WP-2065.md) and the
[capacity policy](../../security/cloud-operations-evidence-baseline.json) require bounded scaling,
CPU/memory/request-load/queue-lag signals and a maximum 70% database connection budget, including
protection during deployment. Cost alarms remain notify-only and cannot stop transactions/delete data.
[WP-2053](../work-packages/WP-2053.md) retains transaction RPO 5 minutes and RTO 60 minutes;
performance measurement does not weaken those recovery objectives or claim a recovery drill ran.

### Proposed: workload, objective and result records

Product, Operations, Domain owners and Platform/SRE approve the input record before executing an
acceptance run. Unknown target values are explicitly `Decision required`, never zero or a pass.

| Record          | Required inputs                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload        | Synthetic fixture/version, Store count, sessions per Store, arrival pattern, operation mix, item/menu sizes, think time and concurrent Worker work.                  |
| Phases          | Warm-up, steady load, burst, sustained load, dependency fault, recovery and old/new deployment overlap; each has duration and finite stop/resource bounds.           |
| Environment     | Component manifest, resource class, replicas/pool maxima, dataset scale, cache state, network profile and synthetic dependency delay/error/Unknown model.            |
| Objective       | Journey/operation, start/end boundary, eligibility denominator, target percentile/success ratio, observation window, minimum sample requirement and approving roles. |
| Resource budget | Database limit and allocation per API/Worker/other approved client, rollout overlap/surge, queue/memory/file-descriptor bounds and reserved capacity.                |
| Result          | Offered/completed/rejected/timed-out/Unknown counts, latency distribution, queue lag, peak resources, errors, recovery time, safe evidence and objective decision.   |

Proposed measurement rules:

1. Report menu query, Cart mutation, Order submission, Payment status convergence and kitchen
   propagation separately. Time the accepted durable/visible outcome, not merely HTTP acknowledgement.
2. Count one logical operation separately from HTTP attempts; idempotent retries add attempt cost
   without adding business throughput. Unknown, timeout and lost acknowledgement are never success.
3. Report p50/p95/p99 and all outcome counts. Fix eligibility/exclusion rules before the run;
   intentional denials remain visible, and exclusions cannot hide overload or dependency failure.
4. Measure end-to-end and dependency segments separately. A synthetic Provider delay model proves
   behavior under that model only; it does not establish a real Provider latency or availability SLO.
5. Include simultaneous old/new API/Worker pool maxima in the budget. Record every connection
   consumer/reserve and reconcile the total allocation against the accepted 70% ceiling before load.
6. Verify bounded overload/recovery without duplicate Commands, financial side effects, unsafe
   cache authority or cross-Store starvation. Exact admission priority and recovery targets need
   SC-D05/06; no new load shedding, autoscaling or retry policy is enabled here.
7. Missing samples, unknown objectives or mismatched environments produce `Not evaluable`; a
   breached objective produces `Fail`. Both block the performance-readiness claim, not evidence capture.
8. Use synthetic fixtures and approved bounded dimensions; no Tenant/Store/Actor/object identifiers,
   payloads, credentials or health data enter public performance artifacts or telemetry labels.

| ID     | Required decision/input                                                                                         | Accountable roles                               |
| ------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| SC-D05 | Business latency/success/queue/recovery targets, observation windows and sample/denominator definitions.        | Product + Operations + Domain owners + SRE      |
| SC-D06 | Representative Pilot/scale workload, resource allocation, overload priority and recovery acceptance boundaries. | Store Operations + Platform/SRE + Domain owners |

Measured Store demand, production capacity, Provider behavior, alert delivery and operator drills
remain External Evidence. No production latency, throughput or availability threshold is assigned.

| Scenario ID | Designed acceptance; all unexecuted in WP-2224                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-PERF-01  | Run single/multiple synthetic Store profiles and publish every approved journey denominator and distribution; reject missing objectives or insufficient samples. |
| SC-PERF-02  | Model burst, slow dependency and Unknown Payment; prove finite resource usage, visible rejection and no duplicate logical effect.                                |
| SC-PERF-03  | Model simultaneous rollout pools plus other approved clients; reject allocation above the 70% ceiling before a load run.                                         |
| SC-PERF-04  | Remove the injected fault and measure queue/latency recovery and Store fairness against approved targets; report misses without changing targets after the run.  |

## Verification boundaries and next action

Existing root commands are regression anchors for later owning implementation packages:

- Compatibility: `pnpm release-deployment-pipeline:check`, `pnpm pwa-security:acceptance`,
  `pnpm event-catalog:check`, `pnpm migration:check`.
- Privacy: `pnpm privacy-execution:check`, `pnpm --filter @bop/privacy-governance test`,
  `pnpm statutory-archive:check`, `pnpm disaster-recovery:check`.
- Performance controls: `pnpm cloud-operations-evidence:check`, `pnpm core-telemetry:acceptance`.

These commands exist in the current repository but do not implement the new manifest/coverage/load
scenarios above. None is claimed executed by this document. New executable acceptance requires an
owning WP with an exact contract, test harness, resources, cleanup and command allowlist.
WP-2224's documentation verification is recorded only in its brief, not substituted for those tests.
Next action: reconcile SC-D01–06 with source and owner decisions, record versioned dispositions,
then authorize bounded implementation. No deployment, real data processing or external action follows
from this proposal alone.
