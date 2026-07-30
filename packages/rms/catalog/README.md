# `@rms/catalog`

WP-1020 establishes the Brand-scoped Product Aggregate, complete Draft Product Version,
Product-owned SKU entities and the non-authorizing SKU Sellable value.

All mutations use exact Tenant/Permission/Audit evidence, Product expected version and an
idempotent operation reference. Product/SKU codes are Brand-unique; unit quantity is canonical
positive decimal text. SKU never becomes an independent Aggregate.

This package does not own Category、Menu、Option、Availability、price、tax calculation、inventory、
Recipe、Order or Payment. It does not publish Product content or expose HTTP/UI/Projection/Event
contracts. Fixtures are synthetic and External Evidence is not claimed.
