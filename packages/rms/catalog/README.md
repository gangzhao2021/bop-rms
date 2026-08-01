# `@rms/catalog`

WP-1020 establishes the Brand-scoped Product Aggregate, complete Draft Product Version,
Product-owned SKU entities and the non-authorizing SKU Sellable value.
WP-1021 adds Brand-scoped Category trees and complete Draft Menu structures. Menu Sections remain
display entities distinct from Categories, while Sellable Placements reference SKU identity only.
WP-1022 adds Draft Option Set/Option authoring and Product Version-owned Option Bindings.

All mutations use exact Tenant/Permission/Audit evidence, Product expected version and an
idempotent operation reference. Product/SKU codes are Brand-unique; unit quantity is canonical
positive decimal text. SKU never becomes an independent Aggregate.

This package does not publish Option Sets or own Availability、price、tax calculation、inventory、
Recipe、Order or Payment. Draft Menu structure、Placement and Option Binding do not authorize
availability or purchase. The package
does not publish Catalog content or expose HTTP/UI/Projection/Event contracts. Fixtures are
synthetic and External Evidence is not claimed.
