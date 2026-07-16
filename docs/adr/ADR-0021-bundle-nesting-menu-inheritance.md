# ADR-0021 — Bundle Nesting and Menu Inheritance

- Status: `Accepted`
- Owner: Catalog Owner
- Affected modules: Catalog, Menu
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Unbounded Bundle nesting and Menu inheritance create cycles and unclear resolution.

## Decision

For v0.1, Bundle nesting depth is zero and Menu inheritance has a maximum of one level.

## Consequences

Resolution stays deterministic and cycle-free; validators must reject deeper structures.

## Revisit trigger

A future feature requires deeper nesting/inheritance and a new accepted ADR defines maximum depth, cycle detection, pricing, availability, and history semantics.
