# `@rms/dining`

`@rms/dining` is the provider-neutral Phase-1 Dining contract for WP-1002, WP-1006 and WP-1007.

It verifies a bounded canonical ES256 static QR through injected key-registry, signature-verifier
and Tenant/Table-context evidence, then returns only public Store/Table/channel/locale context.
A fixed QR is context, never authorization: this package creates no Guest Session, Dining join,
Cart/Order capability or Merchant access.

WP-1006 adds only Staff-authorized, idempotent Dining Session start、separate short-lived Join
capability consumption、Session-scoped Participant creation、first-Participant Host selection and
fresh-credential regeneration. Tenant/Permission/Audit、Table eligibility、Guest context、abuse
admission and persistence are injected public ports. Successful join returns a one-time opaque
Identity admission; Dining never writes Identity storage.

WP-1007 adds exact-version `Active → Closing`、guarded `Closing → Active` and
invariant-satisfied `Closing → Closed` transitions. Only Active admits a new Batch. Closing
consumes immutable owner-Domain Batch/financial summaries and ensures one deterministic
Store-scoped `@bop/task` exception receipt per unpaid or indeterminate Order before close.
Authorized write-off is accepted only as opaque owner finality evidence.

There is no Guest Self-Start、Convenience Mode、Order/Payment/Write-off authority、private key、
KMS/provider integration、Task storage、abuse bucket、production persistence、transport、UI、
Projection or real QR/Store/Table/Order/Payment fact. Raw Join credentials exist only at the
trusted mint/consume boundary and all fixtures are synthetic.
