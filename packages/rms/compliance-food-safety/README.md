# `compliance-food-safety`

## Identity and responsibility

- Module Name: `compliance-food-safety`
- Package Name: `@rms/compliance-food-safety`
- Layer / Domain: `RMS / Compliance and Food Safety`
- Phase / owning Work Package: `Later / WP-2170–2172`
- Owner role: `Compliance and Food Safety Engineering Owner`
- Status: `active contracts, runtime-inactive adapters`
- Responsibility: closed Compliance Dashboard query policy, rebuildable operational summaries and
  versioned Compliance Case, Inspection, Finding, Corrective Action, containment, Verification and
  Regulatory Notification contracts.
- Explicit non-goals: source Compliance Case/Record persistence and Product, Recipe, Supplier,
  Inventory, Kitchen, Device, Workforce or Order facts and commands.

## Public contract

`createComplianceDashboardService` exposes `compliance_dashboard_v1`. It requires a current
workforce Tenant Context, Actor, purpose, `compliance.dashboard.view` decision and exact
Tenant/Brand/optional Store scope. The response pins generated/source-as-of instants, projection
version, freshness/completeness, closed signal kind and Finding Severity, derived due state and
decimal-string Evidence coverage. Only opaque owning Case/Record references cross the contract.

Private source records, narratives, contacts, health/allergy facts, authority payloads, raw Evidence
and navigation URLs are not public contracts.

`createComplianceCaseService` exposes optimistic-concurrency and idempotent Case commands. Case
revisions preserve canonical Type, Severity, Lifecycle, owner, UTC/IANA deadline, stable related
scope snapshots and Requirement Versions. Containment records only owner-issued operational Action
outcomes; Regulatory Notification records never infer submission. Critical closure requires current,
complete and independent gate evidence. Canonical Section 40.29 Case and Notification Events are
registered in the Event Catalog; no generic transition or unaccepted event is published.

`createComplianceInspectionActionService` adds Case-versioned, append-only Inspection corrections,
stable Findings and Case-owned Corrective Actions. Checklist and Requirement Versions remain pinned;
Critical Findings emit explicit escalation; Hard Requirements cannot be accepted as risk; completion
does not imply Verification; and high-risk Actions require a distinct verifier. Operational work and
Evidence bytes remain outside the contract.

## Dependencies

- Allowed synchronous dependencies: `@bop/audit` safe Audit validation, `@bop/permission` Tenant
  Context revalidation and public `@bop/tenant` contract types.
- Allowed asynchronous dependencies: owner-authorized summary snapshots through the source port.
- Forbidden dependencies: foreign repositories/tables, private module paths, source Domain writes,
  Provider SDKs and unrestricted content.
- Failure/degradation behavior: deny or malformed/unavailable/cross-scope source fails closed;
  partial and stale snapshots remain explicit and never imply compliance.

## Data ownership and lifecycle

- Owned objects: rebuildable Compliance Dashboard query policy, Compliance Case Aggregate contract,
  immutable Inspection/Finding/Corrective Action revisions, Containment outcome and Regulatory
  Notification records.
- Write owner: `@rms/compliance-food-safety`; business outcomes remain owner-issued references.
- Scope: Tenant plus Brand and optional Store, revalidated at query execution.
- Money: not accepted.
- Time: canonical UTC instants; due state is derived at the pinned observation instant.
- Concurrency/idempotency/audit: exact expected aggregate version, intent digest and atomic Audit;
  no history rewrite.
- Classification: internal opaque references/codes and aggregate counts only; no PII, health,
  allergy, incident narrative, credentials or raw Evidence.
- Correction: rebuild from corrected owner summaries; never edit a source fact.

## Persistence and eventing

Persistence is not implemented because Section 50 grants no Compliance schema or migration
namespace. Section 40.29 authorizes the bounded Case, Finding, Corrective Action and Regulatory
Notification Events registered through WP-2172; runtime publication remains inactive until an
accepted durable adapter exists.

## Security and privacy

Authorization, purpose and exact scope are mandatory. Payloads are exact-field parsed, capped at
500 signals and reject extra/restricted fields, duplicate references, future observations,
cross-scope signals and impossible Evidence counts. Logs, URLs, analytics and fixtures may not
contain restricted facts; tests use synthetic opaque identifiers only.

## Operations

- Configuration: none.
- Health/readiness: runtime adapters remain unconfigured and therefore unavailable.
- Logs/metrics/traces: stable outcome codes only; references are not metric dimensions.
- Failure/recovery/disable: fail closed or display explicit stale/partial/unavailable state.

## Development and verification

```bash
pnpm --filter @rms/compliance-food-safety test
pnpm --filter @rms/compliance-food-safety typecheck
pnpm verify
```

Tests cover authorization, scope isolation, exact parsing, stable severity/due sorting, Evidence
math, Case lifecycle/concurrency/idempotency, append-only Inspection correction, Finding escalation,
Corrective Action completion/independent Verification, independent closure, owning-Domain
containment, Regulatory Notification, filtering, stale/partial presentation and restricted-field
rejection.

## Decisions and follow-up

- Authority: Handoff Sections 40, 46.6, 48.5, 50 and 88.16.
- External Evidence: real Cases, Requirements, licenses, Findings, actions, Evidence, deadlines,
  regulators and legal interpretations remain unavailable and unclaimed.
- Revisit trigger: a later accepted WP authorizes Compliance persistence/runtime adapters.
- Next allowed Work Package: WP-2173.
