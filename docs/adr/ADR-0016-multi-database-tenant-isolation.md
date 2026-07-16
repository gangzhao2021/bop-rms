# ADR-0016 — Multi-database Tenant Isolation

- Status: `Proposed`
- Owner: Security + Architecture Owner
- Affected modules: All persistence modules
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

A single PostgreSQL database with module schemas and tenant controls is the accepted baseline.

## Decision

Do not introduce per-tenant or multi-database isolation now.

## Consequences

Tenant isolation must be enforced in the accepted shared-database architecture and proven by owning WPs.

## Revisit trigger

Regulatory isolation, enterprise contract, or measured scale cannot meet controls, before the first isolated-enterprise-tenant WP.
