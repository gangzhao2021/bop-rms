# ADR-0028 — Pilot Store and Fulfillment Baseline

- Status: `Accepted`
- Owner: Product Owner + Store Operations Owner
- Affected modules: Store, Fulfillment, Delivery, Ordering, Kitchen
- Source: Canonical Handoff Sections 80.7 and 86, version `0.5.3`

## Context

The first pilot needs a synthetic planning location and bounded fulfillment capabilities before real Store evidence exists.

## Decision

Use Toronto as the planning location and one synthetic Pilot Store `CA-ON-TOR-PILOT-001`. Enable Dine-in and Pickup; disable third-party Delivery for the first Pilot.

## Consequences

The Store identifier is synthetic and not a real address or operating fact. Delivery cannot be silently enabled.

## Revisit trigger

A real Store agreement/address is evidenced or an approved Delivery Phase changes the capability scope.
