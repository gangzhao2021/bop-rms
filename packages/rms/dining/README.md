# `@rms/dining`

`@rms/dining` is the provider-neutral Phase-1 Dining stub for WP-1002.

It verifies a bounded canonical ES256 static QR through injected key-registry, signature-verifier
and Tenant/Table-context evidence, then returns only public Store/Table/channel/locale context.
A fixed QR is context, never authorization: this package creates no Guest Session, Dining join,
Host, Participant, Cart/Order capability or Merchant access.

There is no private key, KMS/provider integration, abuse limiter, persistence, transport, UI or
real QR/Store/Table fact. All fixtures are synthetic.
