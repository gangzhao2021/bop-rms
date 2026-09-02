# `@rms/dining`

`@rms/dining` is the provider-neutral Dining contract for WP-1002, WP-1006, WP-1007 and WP-2112.

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

WP-2112 adds strict, versioned Table configuration and QR / temporary-block lifecycle contracts,
plus an exact-version Active Session move policy. The Application boundary authorizes every
attempt before repository lookup, verifies Store-scoped Audit evidence, protects idempotency and
commits one future minimal Event record atomically with the result. The merchant UI implements the
complete `DIN-FLOOR-BOARD` and `DIN-TABLE-LIST` read contracts with privacy-minimized controlled
summaries; mutation controls remain disabled until an authorized command-capable BFF exists.

Section 50 provides no `rms_dining` schema or Dining migration namespace, and accepted WP-1006 /
WP-1007 explicitly keep Dining persistence behind injected ports. WP-2112 therefore creates no
database migration, outbox publication, realtime connection or Event Catalog registration. A later
accepted persistence package must resolve that ownership before any durable adapter is added.

There is no Guest Self-Start、Convenience Mode、Order/Payment/Write-off authority、private key、
KMS/provider integration、Task storage、abuse bucket、production persistence、transport、live
Projection or real QR/Store/Table/Order/Payment fact. Raw Join credentials exist only at the
trusted mint/consume boundary and all fixtures are synthetic.
