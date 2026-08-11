# BOP-RMS Event Catalog

This file is generated from the Zod-first source in `packages/contracts/events/catalog.ts`.
Do not edit it directly. The catalog contains only Owner-approved concrete registrations.

## Registered Events

- `KitchenItemCompleted:v1` — owner `@rms/kitchen`; stable; store; personal
- `KitchenItemProgressRecorded:v1` — owner `@rms/kitchen`; stable; store; personal
- `KitchenWorkAccepted:v1` — owner `@rms/kitchen`; stable; store; personal
- `KitchenWorkCreated:v1` — owner `@rms/kitchen`; stable; store; indirect_identifier
- `KitchenWorkStarted:v1` — owner `@rms/kitchen`; stable; store; personal
- `MenuPublished:v1` — owner `@rms/catalog`; stable; brand; none
- `OrderConfirmed:v1` — owner `@rms/ordering`; stable; store; indirect_identifier
- `OrderCreated:v1` — owner `@rms/ordering`; stable; store; indirect_identifier
- `PaymentFailed:v1` — owner `@rms/payment`; stable; store; payment
- `PaymentRefunded:v1` — owner `@rms/payment`; stable; store; payment
- `PaymentSucceeded:v1` — owner `@rms/payment`; stable; store; payment

Registered Event identities are the only bounded Event-type metric label candidates.
An empty catalog therefore enables no Event-type production metric label.
