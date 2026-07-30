# `@bop/public-capability`

## Identity and responsibility

- Layer: BOP cross-cutting contract
- Phase / owner: Phase 1 / WP-1005
- Owner role: Public Capability Security Owner
- Status: implemented contract
- Responsibility: closed credential grammar, maximum lifetime policy, purpose/scope separation,
  and pure fail-closed evaluation for Order Resume and Pickup Proof capabilities
- Non-goals: credential generation or hashing, persistence, transactions, Guest Session mutation,
  Ordering or Fulfillment facts, HTTP/PWA routes, notifications, abuse limiting, completion, and
  Manager Override

## Public contract

The public interface exports branded parsers for the 128-bit public Order reference, 256-bit raw
Order Resume credential, 128-bit opaque Pickup proof, six-digit Pickup code, keyed selector hash,
UUIDv7 scope/reference values, and canonical UTC instants. Raw credential parsers validate trusted
mint/consume memory only; raw values are absent from capability records and policy results.

`OrderResumeCapability` is scoped to exact purpose, Store, internal Order, and public Order
reference. `evaluateOrderResume` validates an Active, unexpired, exact-version record and returns
the next immutable Consumed record plus the server-derived clean Order path. The caller still owns
atomic compare-version persistence, sibling revocation, and Guest Session set/rotation.

`PickupProofCapability` is scoped to exact Store, Fulfillment, generation, and Ready evidence.
`evaluatePickupProof` returns proof evidence only; it never grants Fulfillment completion or
Manager Override authority. `regeneratePickupProof` requires the exact next generation and fresh
capability reference/hash while returning the prior record as Revoked.

Detailed bounded reason codes are trusted-adapter diagnostics. Public callers must map every
rejection to one generic `Unavailable` response without existence disclosure.

## Dependencies and ownership

- Synchronous dependencies: none
- Asynchronous dependencies: none
- Owned database, jobs, events, projections, configuration, or health dependencies: none
- Forbidden dependencies: Domain private paths/tables, infrastructure/HTTP/ORM/SDK code, Provider
  payloads, BOP-to-RMS imports, and credential material
- Failure behavior: malformed or non-canonical input throws a bounded generic contract error;
  well-formed but unavailable capability evidence returns a closed unavailable decision

Ordering remains owner of Order facts and public-reference issuance. Fulfillment remains owner of
readiness, proof generation, verification, completion, and handoff facts. Identity remains owner
of Guest Session state. Calling adapters supply exact owner-domain evidence; this package never
queries their storage.

## Security, privacy, and lifecycle

Raw credentials and selector hashes are classified as credentials. They are prohibited from logs,
URLs sent to servers, analytics, events, screenshots, ordinary fixtures, and public errors.
Selector records contain only a purpose-separated keyed hash and positive pepper version; pepper
material never enters this module. Public Order references are routing/display facts, never bearer
authorization or telemetry labels.

Resume lifetime is at most 30 minutes with at most two unexpired siblings per Order/purpose.
Pickup lifetime is at most 60 minutes from Ready and ends earlier on completion or cancellation.
Regeneration invalidates the previous generation. Records are immutable; correction is a new
versioned transition rather than a history edit.

No production persistence, eventing, runtime secret, external evidence, or abuse control is
implemented. WP-2048 owns abuse budgets, WP-1723 owns notification mint/delivery, and later
Ordering/Fulfillment and HTTP/PWA packages own transactional and fragment-scrubbing adapters.

## Development and verification

```bash
pnpm public-capability:acceptance
pnpm --filter @bop/public-capability format:check
pnpm --filter @bop/public-capability lint
pnpm --filter @bop/public-capability typecheck
pnpm --filter @bop/public-capability build
```

Synthetic tests cover canonical encodings, closed-object rejection, lifetime boundaries, replay,
scope/version/hash/generation mismatch, regeneration, clean redirects, and absence of completion
or override authority. Repository architecture, production-audit, and pinned-Linux gates remain
part of the WP handoff.

## Decisions and follow-up

- Authority: Handoff IDR-0031 and WP-1005
- External Evidence: not available / not claimed
- Revisit triggers: implementation WPs for Ordering, Fulfillment, Identity transaction adapters,
  notifications, PWA consume, and abuse control
- Next allowed Work Package: WP-1006 after WP-1005 verification and integration
