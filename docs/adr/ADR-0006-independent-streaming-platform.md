# ADR-0006 — Independent Streaming Platform

- Status: `Proposed`
- Owner: Platform Owner
- Affected modules: All event producers and consumers
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Transactional Outbox plus a PostgreSQL-backed job runtime is the preferred initial direction.

## Decision

Do not add an independent streaming platform in the current baseline.

## Consequences

Event delivery begins with fewer operational systems while preserving public Event contracts and replay requirements.

## Revisit trigger

Sustained event throughput/backlog violates NFRs, or independent retention/replay is required, after measured eventing evidence.
