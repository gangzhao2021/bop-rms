# @rms/printing-device

Owns the tenant/store-scoped Device Aggregate, versioned validated capabilities, effective
assignments, append-only health signals/current health projection and lifecycle controls defined by
WP-2180.

The module does not own human Sessions, Store/station facts, Kitchen work, Payment status, device
vendor credentials or output payloads. Those facts are consumed or linked only through public
contracts and stable references. Credential values, tokens, certificates, PAN/PIN, Provider payloads
and raw logs are prohibited.

IDR-0039 remains active: the first Pilot supports only the managed browser KDS boundary. Physical
printers, generic POS peripherals, Store Gateway, vendor SDKs/adapters and application Offline Queue
are not enabled by this package.

Persistence is owned in `rms_device` under migration namespace `1600-rms-device`. Device and current
health are mutable only through expected-version owner operations; assignment/capability/health and
operation history are append-only. Every table is forced Tenant/Store RLS.

```bash
pnpm --filter @rms/printing-device test
pnpm --filter @rms/printing-device typecheck
pnpm verify
```

Real devices, models, signals, assignments, operators, credentials, pairing, UAT and support
procedures remain External Evidence and are unavailable/unclaimed.
