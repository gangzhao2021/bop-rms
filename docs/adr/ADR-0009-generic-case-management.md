# ADR-0009 — Generic Case Management

- Status: `Proposed`
- Owner: Architecture Owner
- Affected modules: Compliance, Payment, Delivery, Device
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Shared Task, Evidence, and Audit capabilities are sufficient while case semantics remain local.

## Decision

Do not create a generic Case Management platform now.

## Consequences

Domains retain their lifecycle truth and reuse only the appropriate shared primitives.

## Revisit trigger

At least three Domains require the same case lifecycle and shared queue, before case-platform extraction.
