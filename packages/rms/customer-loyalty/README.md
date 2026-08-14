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

## Privacy and exclusions

Raw contacts, passwords, authentication identity, sensitive notes, unrestricted object IDs and
proof are prohibited in logs, URLs and analytics. Fixtures are synthetic. WP-2140 does not implement
merge, Loyalty ledger/programs, Consent mutation, communications, Privacy Request workflow,
persistence, external adapters or Provider integration.
