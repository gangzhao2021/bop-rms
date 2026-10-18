# Current publication management client

WP-2421 milestone93 consumes the Catalog-owned management projection introduced
in92, through the ordinary CAT-PRODUCT-EDIT Merchant POST endpoint. Expected
Tenant, Brand, Store, Product and root revision are exact current context values.
Only Product and root revision enter the JSON body; selected Brand and Store use
the existing private scope header, with native CSRF and same-origin credentials.

The frozen closed wire keeps recorded states, scope, effective period, schedule
reference/counter and owning Draft content/configuration digests. An empty history
stays empty. Stored metadata never supplies current validation, approval, topology,
policy, action permission or sale eligibility. Incomplete and NotEvaluated remain
explicit. No synthetic command or operation is constructed to validate a source.
Existing publication wire period/scope parsers are reused as structural helpers.

Canonical SHA256, exact scope/revision, original shortest exclusive deadline at
most five seconds, and pre/post asynchronous freshness checks refuse rebound,
expired or changed results. HTTP responses require no-store JSON, bounded two MiB
streamed fatal UTF8 and finite fifteen-second cancellation even when fetch ignores
abort. Errors redact source content; no source data enters logs, URLs or storage.

This is the source transport for following controller and ordinary page work.
Synthetic protocol tests and92 actual native SQL/API proof remain distinct. No
frontend current admission decision or complete publishing UI is claimed here.
