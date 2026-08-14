# `business-intelligence`

## Identity and responsibility

- Module Name: `business-intelligence`
- Package Name: `@rms/business-intelligence`
- Layer / Domain: `RMS / Business Intelligence`
- Phase / owning Work Package: `Later / WP-2161–2163`
- Owner role: `Business Intelligence Engineering Owner`
- Status: `active, runtime-inactive adapters`
- Responsibility: versioned Report and Metric Definitions, certification, Lineage metadata,
  Schedule definitions, immutable Report Runs and controlled artifact metadata.
- Explicit non-goals: source facts, Warehouse / Pipeline execution, Metric calculation, artifact
  bytes/URLs and delivery attempts.

## Public contract

`createReportDefinitionService` exposes strict create, replace, submit-review, publish, archive and
schedule operations. Every mutation carries Tenant/Brand/optional Store, Actor, purpose,
permission, expected version and idempotency. Query-view contracts are permission-trimmed BFF
inputs; private persistence shapes are not public.

`createReportRunService` queues or reruns an exact published version, appends state facts, records
opaque artifact revisions/revocations and returns download authorization metadata without a storage
URL.

`createMetricDefinitionService` records immutable semantic Versions, validates closed Lineage,
requires distinct Business Owner and Data Owner approval evidence for certification, and preserves
replacement-aware deprecation without rewriting pinned historical consumers.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: `@bop/publishing` public evidence contract.
- Allowed asynchronous dependencies: approved Dataset/Metric version references only.
- Forbidden dependencies: source RMS modules, their repositories/tables, SQL/expression input,
  Provider SDKs and recipient contact data.
- Failure/degradation behavior: validation, authorization and repository uncertainty fail closed.

## Data ownership and lifecycle

- Owned objects: Report Definition and Metric Definition Aggregates, immutable Report / Schedule /
  Metric Versions, Metric Lineage/certification evidence, Report Run, append-only Run State,
  artifact revision/revocation and operation/download audit records.
- Write owner: `@rms/business-intelligence`; reads only through owner repository or public Query.
- Scope: Tenant plus Brand and optional Store; schedule scope cannot expand the Report scope.
- Money: no money field is accepted.
- Time: UTC instants plus explicit IANA timezone/effective period; Business Date semantics are pinned.
- Concurrency/idempotency/audit: exact expected aggregate version, intent digest and atomic Audit.
- Classification: internal configuration and indirect identifiers; no PII, Payment, health or secret.
- Correction: new version or archive; immutable versions and operations are never edited.

## Persistence and eventing

WP-2161 creates the `rms_reporting` schema and Report Definition tables; WP-2162 adds immutable Run,
state, artifact metadata and access-audit tables; WP-2163 adds Metric Definition, Version, Lineage,
dual-owner certification and operation evidence under namespace 1800. All use forced Brand/Store
RLS. Repository ports require operation/Event/Audit composition in one transaction.
Output/Notification continues to own artifact bytes and delivery.

## Security and privacy

Server authorization remains mandatory. Dataset/Metric/dimension/filter values use closed references
or codes; no SQL, expression, remote URL, recipient contact, unrestricted free text or export content
is accepted. Errors are stable codes and fixtures are synthetic.

## Operations

- Configuration: none.
- Health/readiness: runtime adapters remain unconfigured and therefore unavailable.
- Logs/metrics/traces: stable operation/outcome codes only; identifiers are not metric dimensions.
- Failure/recovery/disable: fail closed, retry the same idempotency key, or create a new version.

## Development and verification

```bash
pnpm --filter @rms/business-intelligence test
pnpm --filter @rms/business-intelligence typecheck
pnpm verify
```

Tests cover strict contracts, lifecycle/concurrency/idempotency, Report four-eyes and Metric
dual-owner certification, exact rerun pinning, terminal finality, artifact expiry/revocation,
Lineage metadata and isolated RLS/append-only persistence.

## Decisions and follow-up

- Authority: Handoff Sections 38, 48, 50 and 88.15.
- External Evidence: real certified Metric/Dataset, membership, execution engine, Output asset,
  recipient and delivery are unavailable.
- Revisit trigger: WP-2164 Data Quality / reconciliation implementation.
- Next allowed Work Package: WP-2164.
