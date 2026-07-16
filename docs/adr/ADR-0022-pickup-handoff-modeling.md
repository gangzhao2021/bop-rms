# ADR-0022 — Pickup Handoff Modeling

- Status: `Accepted`
- Owner: Fulfillment Owner
- Affected modules: Fulfillment, Ordering, Kitchen
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Pickup completion needs an immutable handoff fact without a second overlapping task lifecycle.

## Decision

Model Pickup Handoff Record inside the Fulfillment Aggregate. Do not create a Pickup Task Aggregate Root.

## Consequences

Registry, commands, events, and screen naming follow Fulfillment ownership.

## Revisit trigger

An approved future Fulfillment architecture revision demonstrates a separate Aggregate lifecycle and ownership need.
