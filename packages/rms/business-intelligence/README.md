# `business-intelligence`

## Identity and responsibility

- Module Name: `business-intelligence`
- Package Name: `@rms/business-intelligence`
- Layer / Domain: `RMS / Business Intelligence`
- Phase / owning Work Package: `Later / WP-2161`
- Owner role: `Business Intelligence Engineering Owner`
- Status: `active, runtime-inactive adapters`
- Responsibility: versioned Report Definitions, certification, publication and Schedule definitions.
- Explicit non-goals: source facts, Metric definitions, Report Runs/artifacts and delivery attempts.

## Public contract

`createReportDefinitionService` exposes strict create, replace, submit-review, publish, archive and
schedule operations. Every mutation carries Tenant/Brand/optional Store, Actor, purpose,
permission, expected version and idempotency. Query-view contracts are permission-trimmed BFF
inputs; private persistence shapes are not public.

Private paths, Domain entities, ORM models, Provider payloads, and database fields are not public contracts.

## Dependencies

- Allowed synchronous dependencies: `@bop/publishing` public evidence contract.
- Allowed asynchronous dependencies: approved Dataset/Metric version references only.
- Forbidden dependencies: source RMS modules, their repositories/tables, SQL/expression input,
  Provider SDKs and recipient contact data.
- Failure/degradation behavior: validation, authorization and repository uncertainty fail closed.

## Data ownership and lifecycle

- Owned objects: Report Definition Aggregate, immutable Report Version, append-only Operation Record
  and immutable Schedule Version.
- Write owner: `@rms/business-intelligence`; reads only through owner repository or public Query.
- Scope: Tenant plus Brand and optional Store; schedule scope cannot expand the Report scope.
- Money: no money field is accepted in WP-2161.
- Time: UTC instants plus explicit IANA timezone/effective period; Business Date semantics are pinned.
- Concurrency/idempotency/audit: exact expected aggregate version, intent digest and atomic Audit.
- Classification: internal configuration and indirect identifiers; no PII, Payment, health or secret.
- Correction: new version or archive; immutable versions and operations are never edited.

## Persistence and eventing

WP-2161 creates the `rms_reporting` schema and Report Definition tables under namespace 1800 with
forced Brand RLS. Repository ports require aggregate/version/operation/Audit composition in one
transaction. Published versions and schedules are immutable; actual Report Run scheduling and
artifact delivery begin in WP-2162 and later Worker/Notification packages.

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

Tests cover strict contracts, lifecycle/concurrency/idempotency, four-eyes certification, schedule
scope/time/format and the isolated RLS/append-only persistence contract.

## Decisions and follow-up

- Authority: Handoff Sections 38, 48, 50 and 88.15.
- External Evidence: real certified Metric/Dataset, membership and schedule execution are unavailable.
- Revisit trigger: WP-2162 Report Run/artifact implementation.
- Next allowed Work Package: WP-2162.
