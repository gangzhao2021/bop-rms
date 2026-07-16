# ADR-0017 — Microservice Decomposition

- Status: `Proposed`
- Owner: Architecture Owner
- Affected modules: Any candidate module
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

The modular monolith is frozen for v0.1.

## Decision

Do not decompose BOP-RMS into microservices in the current baseline.

## Consequences

Module ownership and public contracts remain explicit without distributed deployment complexity.

## Revisit trigger

Measured independent scale, fault isolation, team ownership, or deployment evidence requires decomposition, at an architecture review.
