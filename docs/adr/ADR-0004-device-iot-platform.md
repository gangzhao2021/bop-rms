# ADR-0004 — BOP Device / IoT Platform

- Status: `Proposed`
- Owner: Platform Owner
- Affected modules: Device, Printing, KDS, Store Ops
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

The accepted Device Aggregate and adapters cover initial printers and KDS needs.

## Decision

Do not create a generic Device/IoT platform in the current baseline.

## Consequences

Initial device work remains bounded; fleet provisioning and remote-management infrastructure are not prebuilt.

## Revisit trigger

Fleet provisioning, remote commands, telemetry scale, or many device classes are committed, before a device-fleet WP.
