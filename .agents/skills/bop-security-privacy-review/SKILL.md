---
name: bop-security-privacy-review
description: Perform a BOP-RMS security and privacy review for authentication, permission, PII, Payment, allergy/health data, uploads, exports, logging, analytics, Provider, or production-impacting changes. Use to trace data flows, classify fields, enforce least privilege/redaction/retention, test abuse and failure cases, and assign blocking findings.
---

# BOP-RMS Security and Privacy Review

## Required inputs

- `docs/spec/README.md`, current WP brief, applicable `AGENTS.md`, changed diff, and cited security/privacy/data contracts.
- Data-flow entry/exit points, identities/roles, storage/logging/analytics paths, and environment classification.

## Workflow

1. Bound actors, assets, trust boundaries, entry points, external services, Tenant/Brand/Store scope, and production impact.
2. Trace each field from collection through transport, validation, authorization, storage, Event/Projection, logs/metrics/traces, export, retention, and deletion/compensation.
3. Classify public, internal, PII, sensitive PII, Payment, allergy/health, credential, Provider, and audit/evidence data; minimize fields and purposes.
4. Verify authentication, least privilege, object- and field-level authorization, tenant isolation, CSRF/SSRF/injection/path/upload controls, rate/abuse limits, idempotency, concurrency, and safe failure behavior as applicable.
5. Verify secrets never enter source, URLs, arguments, logs, analytics, fixtures, screenshots, artifacts, or unrestricted object references. Require redaction and bounded retention.
6. Map abuse, denial, replay, stale/unknown Provider results, partial failure, recovery, export/download, and deletion cases to tests.
7. Record findings as Blocker/High/Medium/Low with evidence, affected asset, required owner/WP, and disposition. Unaccepted Blocker/High findings block Done.

## Hard stops

- Do not access/rotate credentials, accept risk, mutate Providers/production, reveal sensitive data, or downgrade a control without explicit target-specific authority and the owning gate.
- Do not invent compliance, legal, Provider, or production evidence.

## Output

Return scope/data flow, classification, controls/tests, findings with severity and evidence, blocking disposition, residual risks, external evidence, and authorized remediation boundary.

## Smoke scenarios

- Positive: an export review identifies permission, purpose, field minimization, artifact expiry, audit, and abuse tests.
- Boundary: a request to paste a production token for debugging stops without reading or rotating it and proposes a synthetic/local evidence path.
