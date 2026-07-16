# ADR-0005 — Enterprise Search Platform

- Status: `Proposed`
- Owner: Architecture Owner
- Affected modules: Catalog, Order, Customer, BI
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

PostgreSQL and module-owned Projections are the accepted initial search approach.

## Decision

Do not introduce an independent enterprise search platform now.

## Consequences

Search stays aligned with module ownership and avoids a second data authority.

## Revisit trigger

Measured search SLO, cross-module ranking, language scale, or index size exceeds the defined Projection baseline.
