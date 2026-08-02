# `@rms/catalog`

WP-1020 establishes the Brand-scoped Product Aggregate, complete Draft Product Version,
Product-owned SKU entities and the non-authorizing SKU Sellable value.
WP-1021 adds Brand-scoped Category trees and complete Draft Menu structures. Menu Sections remain
display entities distinct from Categories, while Sellable Placements reference SKU identity only.
WP-1022 adds Draft Option Set/Option authoring and Product Version-owned Option Bindings.
WP-1023 adds Catalog-owned Brand-default and exact-Store Availability Rule configuration for SKU、
channel、order type and UTC effective scope. Store specificity wins before priority; ambiguous
equal-priority decisions and invalid safety evidence fail closed. Fresh exact-scope Kill Switch and
Inventory evidence can constrain resolution without becoming Catalog-owned facts.
WP-1202 adds the public current Sellable/Option `Validate Selection` contract. It validates exact
Brand/Store/channel/order-type/time scope, enabled Options, quantities, rule limits, triggers and
conflicts, then returns pinned Menu/Product/Binding/Option Set evidence for Ordering.

All mutations use exact Tenant/Permission/Audit evidence, Product expected version and an
idempotent operation reference. Product/SKU codes are Brand-unique; unit quantity is canonical
positive decimal text. SKU never becomes an independent Aggregate.

This package owns Availability configuration, not Inventory balance or downstream effective Menu
publication. It does not publish Option Sets or own price、tax calculation、inventory、Recipe、Order
or Payment. Draft Menu structure、Placement and Option Binding do not authorize availability or
purchase. Catalog does not calculate price/tax, mutate Cart/Order, or expose this validation through
HTTP/UI in WP-1202. Fixtures are synthetic and External Evidence is not claimed.
