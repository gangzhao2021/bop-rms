# ADR-0008 — Legal / Risk Domain

- Status: `Proposed`
- Owner: Compliance Owner
- Affected modules: Compliance, Payment, Delivery, Privacy
- Source: Canonical Handoff Section 80.7, version `0.5.3`

## Context

Compliance cases currently remain within their owning Domains.

## Decision

Do not introduce a generic Legal/Risk Domain now.

## Consequences

Existing ownership stays explicit; legal-case or enterprise-risk semantics are not generalized without a real lifecycle.

## Revisit trigger

A formal legal-case lifecycle or enterprise risk controls are required, before a legal/risk WP.
