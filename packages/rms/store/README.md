# `@rms/store`

`@rms/store` owns the provider-neutral Store Public Profile Query and Store Operating Status Query
contracts for WP-1000 and WP-1001.

The package resolves a strict public Store reference through injected evidence and returns only a
closed Public field allowlist from one published, currently effective profile. It can also resolve
one published, currently effective operating-hours configuration at an explicit UTC instant and
derive Store-local weekly/exception hours, temporary closure and the available `DineIn`、`Pickup`
and `Delivery` modes.

It does not provide Store search, internal-ID lookup, Business Date, cutoff/lead-time or capacity
evaluation, QR or Customer Session authority, persistence, transport, authoring, Event publication,
Provider integration, or deployment.

All fixtures are synthetic. Public references are lookup handles, never authorization grants.
