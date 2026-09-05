# Applications

This directory contains deployable composition roots, transports, runtime entry points, and deployment entry points only.

The API contains application transports and optional Domain composition; Merchant Web and Customer PWA contain their accepted Section 88 screens; the worker contains lifecycle, dispatcher, consumer-delivery and retry composition. Their presence does not mean the default runtimes have configured business dependencies or production authority. See the [current delivery-status ledger](../docs/spec/project-status.md) for implemented, connected and remaining increments.

Domain rules and reusable contracts belong in the owning package, not in an application entry point. Add or wire behavior only within its owning Work Package and preserve fail-closed behavior for unavailable dependencies.
