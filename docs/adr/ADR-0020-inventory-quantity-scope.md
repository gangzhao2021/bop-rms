# ADR-0020 — Inventory Quantity Scope

- Status: `Accepted`
- Owner: Inventory Owner
- Affected modules: Inventory
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Inventory identity can exist at Brand scope, but quantity facts require an operational stock scope.

## Decision

Require explicit Store, Site, or Location scope for quantity, reorder, and stock actions. Brand-only lists are identity-only.

## Consequences

Commands and Projections cannot silently treat Brand scope as a stock location.

## Revisit trigger

An explicitly approved cross-scope aggregate product replaces the current stock-scope model.
