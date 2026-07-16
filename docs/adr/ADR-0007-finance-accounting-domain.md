# ADR-0007 — Finance / Accounting Domain

- Status: `Proposed`
- Owner: Finance Product Owner
- Affected modules: Order, Payment, Procurement, Tax, BI
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

BOP-RMS preserves operational business facts but is not a general ledger.

## Decision

Do not create a Finance/Accounting Domain in the current baseline.

## Consequences

Operational facts remain available for reconciliation/export without claiming statutory accounting ownership.

## Revisit trigger

Statutory accounting, journals, reconciliation, or ERP ownership enters committed scope, before an accounting feature commitment.
