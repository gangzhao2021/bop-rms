# `@rms/store`

`@rms/store` owns the provider-neutral Store Public Profile Query, Store Operating Status Query and
Store Business Date contracts.

The package resolves a strict public Store reference through injected evidence and returns only a
closed Public field allowlist from one published, currently effective profile. It can also resolve
one published, currently effective operating-hours configuration at an explicit UTC instant and
derive Store-local weekly/exception hours, temporary closure and the available `DineIn`、`Pickup`
and `Delivery` modes. WP-1223 resolves an explicit UTC instant through one effective, versioned
IANA time-zone and Business Day Start snapshot. The declared default is `04:00:00` local; DST gaps
move forward and overlaps use the earlier occurrence so Business Date never moves backward.

It does not provide Store search, internal-ID lookup, Business Date configuration selection or
authoring, Order Number allocation, cutoff/lead-time or capacity evaluation, QR or Customer Session
authority, persistence, transport, Event publication, Provider integration, or deployment.

All fixtures are synthetic. Public references are lookup handles, never authorization grants.
