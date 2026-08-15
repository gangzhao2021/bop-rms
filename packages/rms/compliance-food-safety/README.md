# `compliance-food-safety`

## Identity and responsibility

- Module Name: `compliance-food-safety`
- Package Name: `@rms/compliance-food-safety`
- Layer / Domain: `RMS / Compliance and Food Safety`
- Phase / owning Work Package: `Later / WP-2170`
- Owner role: `Compliance and Food Safety Engineering Owner`
- Status: `active contracts, runtime-inactive adapters`
- Responsibility: closed Compliance Dashboard query policy and rebuildable operational summaries.
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

## Dependencies

- Allowed synchronous dependencies: `@bop/permission` Tenant Context revalidation and public
  `@bop/tenant` contract types.
- Allowed asynchronous dependencies: owner-authorized summary snapshots through the source port.
- Forbidden dependencies: foreign repositories/tables, private module paths, source Domain writes,
  Provider SDKs and unrestricted content.
- Failure/degradation behavior: deny or malformed/unavailable/cross-scope source fails closed;
  partial and stale snapshots remain explicit and never imply compliance.

## Data ownership and lifecycle

- Owned object: rebuildable Compliance Dashboard query policy; no source fact or Regulatory Record.
- Write owner: owning Case/Record and source Domains; this package is read-only.
- Scope: Tenant plus Brand and optional Store, revalidated at query execution.
- Money: not accepted.
- Time: canonical UTC instants; due state is derived at the pinned observation instant.
- Concurrency/idempotency/audit: query-only operation reference and stable projection version; no
  mutation or history rewrite.
- Classification: internal opaque references/codes and aggregate counts only; no PII, health,
  allergy, incident narrative, credentials or raw Evidence.
- Correction: rebuild from corrected owner summaries; never edit a source fact.

## Persistence and eventing

Not implemented. Section 50 grants no Compliance schema, migration namespace or Event authority.

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
math, filtering, stale/partial presentation and restricted-field rejection.

## Decisions and follow-up

- Authority: Handoff Sections 40, 46.6, 48.5, 50 and 88.16.
- External Evidence: real Cases, Requirements, licenses, Findings, actions, Evidence, deadlines,
  regulators and legal interpretations remain unavailable and unclaimed.
- Revisit trigger: a later accepted WP authorizes source Case/Record contracts or persistence.
- Next allowed Work Package: WP-2171.
