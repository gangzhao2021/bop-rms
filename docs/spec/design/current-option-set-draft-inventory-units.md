# Current Option Draft Inventory consumption units

[WP-2421 milestone59](../work-packages/WP-2421.md) adds an owning Inventory
unit source and an API composition from the actual current full Option Draft.
It extends [consumption metadata provenance](./current-option-set-draft-consumption-references.md).
Accepted Handoff29.4 governs explicit versioned unit conversions;71.4 governs
retained Option consumption references. Unit arithmetic is one part of current
reference qualification, not complete Product or Option publication admission.

## Software decision and arithmetic

Inventory owns the current item's base Unit and configured conversion rules.
The consumption version UUID identifies its exact current configuration operation
and associated numeric revision, as resolved in milestone58. The new public
source requires that revision to be current and Active. It does not infer units
from a client DTO, a static module map or Recipe projection metadata.

Base-unit consumption uses identity conversion. Other unit codes require exactly
one explicit Active item conversion at both current observation and proposed
activation. Missing, future-only, retired or overlapping rules refuse arithmetic;
a changed conversion at activation also refuses. This conservative initial
source supplies no implicit standard conversion catalogue. An unavailable
conversion stays unavailable until its owning configuration exists.

Quantities and multipliers are positive decimal strings with at most six
fractional places and40 characters. BigInt scaled integers multiply them without
binary floating point. The product must be exactly representable at the owning
base Unit's ledgerPrecision. A required rounding step, zero or an oversized
normalized quantity produces HardError. No consumption value is silently rounded
or rewritten. For example, configured CASE→EA multiplier6 and quantity2 produces
base quantity12; quantity0.1 EA against ledgerPrecision0 refuses.

The closed parser accepts at most100 distinct Option pins and100 conversion
records per item. It rejects extra fields, accessors, duplicate identities,
malformed values, mismatched item/version/operation, inconsistent timestamps,
missing units and activation earlier than the current observation. These bounds
are explicit software limits, not claims about physical stock or sale eligibility.

## Owning source and current barriers

The additive PostgreSQL adapter uses the existing accepted Inventory configuration
read purpose, original operation and intent digest. It directly constructs the
complete owning metadata source; it never accepts a caller's metadata snapshot.
Under that source's locks and generation barrier it reads only current identity,
recorded time, baseUnit and unitConversions from Inventory's own version and
operation tables. Unit JSON is parsed with existing public Inventory Unit and
conversion rules. The conversion parser gains an additive public alias without
changing its implementation.

A separate holder covers every declared unit field and both item read/history
permissions for the full Brand scope, even for an empty consumption list. The
adapter captures the clock, authority methods, transaction runner and query.
It preserves an exclusive deadline five seconds after the original complete
metadata observation. Backward time, expiry, replaced queries, repeated or
missing callbacks, changed completion identity and caught recursive entry refuse.

After tentative work it holds unit fields again and re-reads their exact digest.
The enclosing complete metadata source then rechecks current fields and
generation. A refusal poisons that transaction for this source; the caller must
roll back its outer unit of work. The callback does not provide an Inventory
mutation workflow or permission to alter history.

Inventory's access manifest adds only read declarations for the existing version
and operation tables. The ownership validator accepts exactly this new adapter
filename under its existing owning package/schema/table guards. Foreign owners,
schemas, paths, unsafe drivers and incomplete declared assets remain rejected;
there is no generic persistence exemption or production ACL change.

## Actual Draft API composition

The API directly constructs the [actual current full Draft source](./current-option-set-draft-graph.md)
and new owning Inventory adapter on the same captured caller transaction. A closed
request supplies only original graph expectations, accepted Inventory request and
activation instant. Server Tenant, Brand and User are fixed. All retained
Inventory consumption pins, quantities and unit codes come from the actual
Draft, including disabled and archived Options. Caller content, snapshots and
readiness flags are not accepted.

Authority receives the original transaction through the captured facade. The
deadline is the earlier original Draft lease, bounded to30 seconds, and owning
metadata observation plus five seconds. Final unit and metadata checks are
enclosed by the Draft source's final current permission/root re-read. Acquiring a
new observation cannot renew the original root window.

The frozen minimal result contains root and owning source digests, generations,
original/current observations, activation, exclusive deadline and per-Option
normalized quantity or failure status. It carries no full item content, source
prose, price or stock facts. unitArithmetic Pass means only exact current
arithmetic. Quantity policy, Binding/SKU and scope applicability, reference
eligibility and overall eligibility remain NotEvaluated; publishValidation stays
Incomplete. HardError is evidence for rejection by complete validation, never a
publication authorization.

## Local evidence and next work

Four directly affected Inventory test files109/109, API protocol18/18 and the
ownership validator regression1361/1361 pass. Inventory/API types and builds,
selected lint and five actual architecture/ownership/permission scans have valid
evidence; unchanged inputs reuse their recorded runs rather than being re-tested.
Protocol query responses and authority callbacks are explicitly synthetic.

The existing isolated Recipe SQL case retains every old assertion and appends
actual Inventory unit acquisition from actual full Drafts. Controlled snapshots
configure CASE6 and two conflicting PALLET rules. Positive exact conversion and
separate missing-conversion, rounding and ambiguous-conversion results execute
without writes. Seven individually armed late probes complete a real tentative
Catalog Draft/Audit/Outbox write before withdrawing unit/metadata/root fields,
expiring the window, moving time backward, appending an Inventory revision and
operation, or changing the Catalog root revision. Current barriers reject each;
exact nineteen-table state is restored by outer rollback. The selected actual
SQL case passes10.54 seconds/11.60 seconds total. Seeded configurations, Actors
and authority policies are synthetic; owning SQL, locks, generation triggers,
Audit and rollback execute locally.

Initial test type/lint and unregistered ownership failures were corrected.
The first SQL run failed before new Draft creation because its helper used the
wrong owning input property; only the new helper was corrected. These failures
remain in the WP history and are not reported as passing runs.

Recipe yield/quantity units, current Binding/SKU/scope applicability, Media and
Published child resolution, full quantity policy and all five
[Option seal checks](./option-set-content-seal-writer.md) remain repository work.
Ordinary Product editing/review/release and complete Store capability management
also remain. This source has no normal HTTP/browser evidence, owning System
activation, live IAM, real Store/Provider evidence, UAT, formal release or project
completion claim. Activation must reacquire all required current sources and
permissions.
