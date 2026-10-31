# Original publication pending recovery

WP-2421 milestone96 defines the closed pending-record codec and restored command
transport; IndexedDB integration and actual navigation recovery are following97.
Section86/88 prohibit OAuth tokens, session identifiers and credential material in
WebStorage/IndexedDB/ServiceWorker. The record contains none: no cookie, CSRF,
Actor, source observation, approval evidence or current eligibility is persisted.
No credential or encryption key is created or read.

The bounded internal configuration metadata record contains exact current
Tenant/Brand/Store/Product boundary, original operation and original fifteen-field
command bytes. The ordinary UI uses the fixed USER_REQUEST reason code. Scope,
period, version, root, hashes, schedule and successor identities are unchanged.
Closed parsing, exact original normalized bytes and SHA256 integrity detect
corruption; an unkeyed digest provides no authorization or fact authenticity.
Current owning native session/Actor/permissions/intent digest and CAS decide every
explicit retry, including originals restored under a different session.

A restored pending request is conservatively uncertain until an exact native
Applied/Replayed receipt binds it. Current denial, invalid or conflict responses
retain OutcomeUnknown with attempt classification; no response is converted into
a new operation, updated root, current timestamp or renewed qualification. There
is no automatic send. This prevents a restarted client from discarding an unknown
original and accidentally creating another mutation.

Following storage must atomically reserve one original per exact Product scope
before dispatch, refuse collisions/storage failure, restore only exact current
context, and delete only its exact operation/digest after a bound native receipt.
Unresolved intent does not silently expire. Permanent server history remains
append-only; this bounded local pending cursor is separate. Missing/corrupt storage
must fail closed and disclose the pending recovery limitation.

Milestone97 implements the native IndexedDB journal and ordinary page consumer.
The fixed versioned database holds one record under the four exact scope references.
A read-write transaction requests strict durability and serializes competing reservations. Different original
bytes refuse without replacement; cleanup compares the entire closed record,
including operation and digest, before removing the transient cursor. Open,
blocked, version-change and transaction failures have a five-second bound and
close their own connection. Failed persistence prevents dispatch; corruption has
no implicit reset or in-memory substitute. Pending records do not silently expire.

Explicit opening resolves current authenticated context, checks current capability
and reads this journal before loading management facts. A pending record restores
only the original uncertain request, hides new controls and requires explicit retry.
Every new command commits its original record before any command HTTP request.
Native receipt binding precedes cleanup; cleanup failure preserves the original
for exact replay. A recorded replay root cannot lower the root already observed
when entering the page. Explicit refresh still checks that observed root with the
owning source. Current backend admission, Actor and System activation are unchanged.

Unconfirmed intent may remain after a definitive current refusal or browser storage
loss. The browser grants no cancellation or discard authority and cannot establish
an outcome without a bound owning receipt. Recovery of an irretrievably lost local
record requires an owning operation-status protocol; this remains a separate gap.
Internal route navigation and reload restoration use nonsecret original parameters,
not credential persistence, cached permission or renewed qualification.
