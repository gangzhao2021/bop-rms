# BOP-RMS Event Catalog

This file is generated from the Zod-first source in `packages/contracts/events/catalog.ts`.
Do not edit it directly. The catalog contains only Owner-approved concrete registrations.

## Registered Events

- `AvailabilityRuleCreated:v1` — owner `@rms/catalog`; stable; brand; none
- `AvailabilityRuleLifecycleChanged:v1` — owner `@rms/catalog`; stable; brand; none
- `AvailabilityRuleReplaced:v1` — owner `@rms/catalog`; stable; brand; none
- `BundleDraftCreated:v1` — owner `@rms/catalog`; stable; brand; none
- `BundleDraftReplaced:v1` — owner `@rms/catalog`; stable; brand; none
- `BundleLifecycleChanged:v1` — owner `@rms/catalog`; stable; brand; none
- `BundleVersionPublished:v1` — owner `@rms/catalog`; stable; brand; none
- `FulfillmentCompleted:v1` — owner `@rms/fulfillment`; stable; store; indirect_identifier
- `KitchenItemCompleted:v1` — owner `@rms/kitchen`; stable; store; personal
- `KitchenItemProgressRecorded:v1` — owner `@rms/kitchen`; stable; store; personal
- `KitchenItemReady:v1` — owner `@rms/kitchen`; stable; store; indirect_identifier
- `KitchenOrderReady:v1` — owner `@rms/kitchen`; stable; store; indirect_identifier
- `KitchenWorkAccepted:v1` — owner `@rms/kitchen`; stable; store; personal
- `KitchenWorkCreated:v1` — owner `@rms/kitchen`; stable; store; indirect_identifier
- `KitchenWorkStarted:v1` — owner `@rms/kitchen`; stable; store; personal
- `MenuPublished:v1` — owner `@rms/catalog`; stable; brand; none
- `OrderConfirmed:v1` — owner `@rms/ordering`; stable; store; indirect_identifier
- `OrderCreated:v1` — owner `@rms/ordering`; stable; store; indirect_identifier
- `PaymentFailed:v1` — owner `@rms/payment`; stable; store; payment
- `PaymentRefunded:v1` — owner `@rms/payment`; stable; store; payment
- `PaymentSucceeded:v1` — owner `@rms/payment`; stable; store; payment
- `PriceBookArchived:v1` — owner `@rms/pricing`; stable; brand; none
- `PriceBookDraftCreated:v1` — owner `@rms/pricing`; stable; brand; none
- `PriceBookDraftReplaced:v1` — owner `@rms/pricing`; stable; brand; none
- `PriceBookVersionPublished:v1` — owner `@rms/pricing`; stable; brand; none
- `TaxConfigDraftCreated:v1` — owner `@rms/pricing`; stable; store; none
- `TaxConfigDraftReplaced:v1` — owner `@rms/pricing`; stable; store; none
- `TaxConfigPublished:v1` — owner `@rms/pricing`; stable; store; none

Registered Event identities are the only bounded Event-type metric label candidates.
An empty catalog therefore enables no Event-type production metric label.
