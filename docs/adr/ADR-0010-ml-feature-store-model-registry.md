# ADR-0010 — ML Feature Store / Model Registry

- Status: `Proposed`
- Owner: Data / ML Owner
- Affected modules: BI, Recommendation, Fraud
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

No production ML model dependency is part of v0.1.

## Decision

Do not add an ML Feature Store or Model Registry now.

## Consequences

The system avoids production ML governance and infrastructure without a committed model-serving need.

## Revisit trigger

Online model serving, feature reuse, or regulated model governance is committed, before the first production ML WP.
