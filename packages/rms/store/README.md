# `@rms/store`

`@rms/store` owns the provider-neutral Store Public Profile Query contract for WP-1000.

The package resolves a strict public Store reference through injected evidence and returns only a
closed Public field allowlist from one published, currently effective profile. It does not provide
Store search, internal-ID lookup, operating status or hours, QR or Customer Session authority,
persistence, transport, authoring, Provider integration, or deployment.

All fixtures are synthetic. Public references are lookup handles, never authorization grants.
