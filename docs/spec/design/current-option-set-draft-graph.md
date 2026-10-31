# Current full Option Draft graph source

WP-2421 milestone53 supplies a current full Draft root for the
[content-policy assessment](./option-set-content-policy-assessment.md), using
Catalog's existing owning current full Draft reader and immutable operation/
snapshot provenance. It does not supply CurrentPublished triggered children.
[WP-2421](../work-packages/WP-2421.md) owns the bounded scope and evidence.

## Supported source and refusal

The API captures server Tenant, Brand, User Actor, clock and current full read
field authority. A closed request pins Set/version/revision, source/content/
configuration digests and an original finite exclusive observation window.
Positive int32 revisions include the final legal revision; a new write past that
revision is still refused by its existing owning command. Selectors are expected
current identities and never source authority. Client graph/Ready fields are refused.

The provider binds Catalog's public current reader to a captured facade of the
caller's actual SQL transaction. Current field authority receives that same outer
transaction identity; Catalog alone queries its tables. The owner verifies full
live Draft content, actual original operation/snapshot provenance and holds source
barriers/rows. The API strictly parses and compares that public result, derives a
single-node full graph and its existing canonical mechanical identity, then
allows one callback. It writes no business facts.

A trigger Set/version edge refuses before graph delivery, including disabled or
optional trigger metadata. There is no installed actual CurrentPublished child
producer at this boundary. Do not substitute Frozen history, caller data, static
mapping, a successful empty witness or silently omitted child. This software
source must be extended alongside the owning publication producer/resolver;
missing real external facts remain separate gates.

## Window and source continuity

Every clock sample is monotonic and inside the original window. The effective
window is the earliest original/captured current read lease, never renewed.
The result separately records original observation and actual initial source
observation. Methods and SQL query are captured; changed query, expiry, backward
time, callback failure and recursive admission refuse. Failure poisons this
transaction identity even if caught inside a callback.

After the callback, a second actual owning current read repeats authority,
provenance and expected revision/content checks in the same transaction.
A source/graph change or shortened declared source window refuses. SHARE locks
block other writers; they do not replace this reread against the caller's own
writes. The caller must abort the outer unit of work on refusal. Providers and
transaction facades must be scoped to an authorized request/unit of work;
a pooled physical client is not a new identity after another BEGIN.

## Result boundary and evidence

The internal callback receives a detached frozen full graph and pins, with
sourceAuthority CurrentDraftRootOnly, referenceEligibility NotEvaluated,
publishValidation Incomplete and eligibility NotEvaluated. Full content is
internal configuration data: it is not emitted in logs, errors, URLs or a public
endpoint by this provider. Current Draft does not certify Media/Pricing/
Inventory/Recipe facts, applicability, independent approval, Published status,
Store activation or sale. Those owning checks and all five seal prerequisites
remain mandatory, as does actual activation revalidation.

Unit tests use an explicitly synthetic public reader protocol. The existing fifth
isolated Option SQL case adds actual current root graph/read, current read fields/
action/purpose, no-write state preservation and late refusal after SELECT-observed
controlled same-transaction root changes, followed by exact outer rollback.
Actor/authority/reference inputs remain synthetic; storage/provenance/locks and
rollback are actual local execution. Controlled UPDATE is not an owning publish
operation. Existing other SQL cases and owner sources are retained. This is not
ordinary HTTP/browser, a combined current policy+graph journey, scheduler,
production IAM/UAT or whole-project evidence.
