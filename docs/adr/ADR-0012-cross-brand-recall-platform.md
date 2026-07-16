# ADR-0012 — Cross-brand Recall Platform

- Status: `Proposed`
- Owner: Compliance Owner
- Affected modules: Compliance, Inventory, Supplier
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Recall handling remains within tenant and compliance boundaries.

## Decision

Do not create a cross-brand Recall Platform now.

## Consequences

Recall facts and permissions remain tenant-scoped; no unapproved fan-out occurs.

## Revisit trigger

A regulator or supplier recall must fan out across tenants, before shared recall integration.
