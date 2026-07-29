# `@bop/effective-period`

Provider-neutral Effective Period owner for WP-0123.

The package validates immutable configuration timing metadata, canonical UTC/IANA/local-offset
round trips, half-open periods, exact family-and-scope overlap, and reproducible resolution at an
explicit instant. It carries opaque references and digests only; caller configuration payload and
business priority remain outside this package.

Schedule and Renew create immutable timing versions plus deterministic activation and optional
expiry intents through injected ports. Every mutation requires exact Tenant scope, Permission,
accepted approval evidence, positive expected version, idempotency, and an atomic Audit commit.

This minimum contains no clock, worker, Task/Notification delivery, database, migration, Event,
production API/UI, Provider resource, or real activation/expiry claim.
