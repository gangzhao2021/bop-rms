# ADR-0024 — Pilot Operating Entity Model

- Status: `Accepted`
- Owner: Product Owner + Finance / Compliance Owner
- Affected modules: Operating Entity, Tax, Payment, Compliance, Store
- Source: Canonical Handoff Sections 80.7 and 83, version `0.5.3`

## Context

The v0.1 pilot needs one operating-entity planning model without inventing a real legal identity.

## Decision

One Canadian Operating Entity resolves all mandatory v0.1 Pilot Business Functions. Franchise and multiple Operating Entities are excluded from v0.1; legal identity is a separate decision.

## Consequences

Tenant/entity flows remain simple and cannot imply unapproved franchise or multi-entity behavior.

## Revisit trigger

Multi-entity or franchise scope is explicitly committed.
