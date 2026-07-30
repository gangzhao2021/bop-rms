# `@rms/dining`

`@rms/dining` is the provider-neutral Phase-1 Dining contract for WP-1002 and WP-1006.

It verifies a bounded canonical ES256 static QR through injected key-registry, signature-verifier
and Tenant/Table-context evidence, then returns only public Store/Table/channel/locale context.
A fixed QR is context, never authorization: this package creates no Guest Session, Dining join,
Cart/Order capability or Merchant access.

WP-1006 adds only Staff-authorized, idempotent Dining Session start、separate short-lived Join
capability consumption、Session-scoped Participant creation、first-Participant Host selection and
fresh-credential regeneration. Tenant/Permission/Audit、Table eligibility、Guest context、abuse
admission and persistence are injected public ports. Successful join returns a one-time opaque
Identity admission; Dining never writes Identity storage.

There is no Guest Self-Start、Convenience Mode、Closing command、Order/Payment authority、private
key、KMS/provider integration、abuse bucket、production persistence、transport、UI or real
QR/Store/Table fact. Raw Join credentials exist only at the trusted mint/consume boundary and all
fixtures are synthetic.
