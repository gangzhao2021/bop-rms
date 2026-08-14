# `customer-loyalty`

## Identity and responsibility

`@rms/customer-loyalty` owns Brand-specific Customer Profiles, relationship facts and append-only
verified Guest-transaction associations. Identity owns authentication and real Email/Phone values;
Order and Reservation own their immutable Guest snapshots and transaction history.

## Public contract

`customer_profile_v1` supplies purpose-authorized, field-trimmed list/detail reads. Mutations require
Tenant, Brand, Actor, purpose, exact permission, operation reference, Expected Version and Audit.
A Profile requires an explicit allowed basis. Verified contacts and User links consume Identity
proof; Guest links consume source-owner proof and never rewrite the source transaction or Actor.

`customer_merge_review_v1` supplies Privacy-purpose duplicate evidence, conflict, impact and rollback
views. Merge review requires two pinned Profile versions, same-Brand exact evidence, a distinct
approved Actor and append-only Audit. The resulting local `CustomerProfilesMerged` fact retains both
Profile IDs and explicitly forbids rewriting transaction facts or historical Actors.

`loyalty_program_v1` owns stable Brand-scoped Program identities and append-only configuration
Versions. Rules use exact integer Points, require deterministic lifecycle/conservation simulation and
distinct approval before publish/schedule. Monetary benefit calculation remains Pricing-owned and
Points are never Payment tender.

`loyalty_account_v1` and `loyalty_points_exception_v1` expose derived balances, bounded active
Reservations, append-only Ledger facts and source-linked correction reviews. No command can set a
balance directly; expiry, release, redemption, reversal and adjustment remain distinct immutable
facts, and insufficient reversals create visible Points Debt.

`customer_consent_preference_v1` exposes Brand-scoped, append-only purpose/channel Consent choices
using opaque Identity-owned Contact Method references. Contact Preference is a separate versioned
record and never authorizes Marketing. Withdrawal derives an immediate deny decision, while
necessary operational communication remains separately classified.

## Privacy and exclusions

Raw contacts, passwords, authentication identity, sensitive notes, unrestricted object IDs and
proof are prohibited in logs, URLs and analytics. Fixtures are synthetic. The current package does
not implement persistence/live Ledger feeds, communications, Privacy Request workflow, persistence,
live Outbox/Event Catalog publication, external adapters or Provider integration.
