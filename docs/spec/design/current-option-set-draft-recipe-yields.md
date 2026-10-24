# Current Option Draft Recipe yield quantities

[WP-2421 milestone60](../work-packages/WP-2421.md) adds a Recipe-owned current
yield source and an API composition from the actual complete Option Draft.
Accepted Handoff29.1–29.5 gives Recipe ownership of yield, units and theoretical
consumption;71.4 retains consumption references in Option content. It builds on
[current consumption metadata](./current-option-set-draft-consumption-references.md)
and complements [Inventory unit arithmetic](./current-option-set-draft-inventory-units.md).

## Exact quantity decision

The source reads the existing owning Recipe version columns for batch yield in
microunits, yield unit code and dimension. It requires the exact pinned Recipe
version and parent, the current root pointer, Published lifecycle, matching stored
snapshot digest/version number and a half-open effective period covering both
current observation and proposed activation. Published metadata is insufficient
for complete Recipe or sale qualification.

Consumed quantities are positive decimal strings with at most six fractional
places. BigInt converts them to exact microunits, with the existing owning
positive bound of10^30. The new public parser wraps the existing owning natural
number parser; existing snapshot behavior is unchanged. Quantity2 against a batch
yield3000000 microunits produces requested yield2000000 and the reduced rational
batch ratio2/3. Partial batches retain that exact ratio; no floating point,
integer-batch assumption or rounding is introduced.

Only an exact match with the current yield unit is supported by this source.
Recipe has no configured yield-conversion record in the accepted stored contract.
An unknown unit produces HardError rather than borrowing an Inventory item rule
or inventing a standard map. Overflow also produces HardError. Closed parsing
bounds inputs to100 Option pins,40 quantity characters, and rejects accessors,
extra fields, duplicates, malformed identities and inconsistent current rows.
Actual Catalog consumption inputs retain their stricter14 whole-digit bound;
that makes the Recipe microunit overflow unreachable through today's ordinary
Draft shape. The owning public contract still rejects overflow independently.

## Current owning source and authority

The adapter directly constructs the existing complete Recipe reference source,
using its accepted Catalog lifecycle read purpose and original operation/intent.
The caller supplies no owner snapshot. Under the owning locks and generation
barrier it reads only identity, version, digest and the three normalized yield
columns. It does not load ingredients, allergen evidence, preparation instructions
or full snapshot JSON to perform arithmetic.

A separate field holder receives the fixed Tenant, accepted Brand/User request,
recipe.manage permission, full Brand scope and exact requested version references.
All declared yield fields and complete metadata fields remain held on the original
transaction, including an empty consumption list. The source captures the clock,
authority methods, transaction runner and query. Its exclusive deadline is five
seconds after the original metadata observation; subsequent reads cannot renew it.

Replaced queries, backward time, expiry, missing/repeated callbacks, changed
completion identity and caught recursive entry refuse. After tentative work the
source holds yield fields again and re-reads their digest; the enclosing complete
source then rechecks authority and generation. Any refusal requires outer rollback.
This callback does not provide a Recipe writer or permission to alter history.

The access manifest adds one read declaration for the existing Recipe version
table. The ownership validator accepts exactly the new adapter filename within
the existing RecipeReference package/schema/six-table guards. Wrong owners,
schemas, paths, missing assets and unsafe drivers remain rejected. No migration,
production ACL or module dependency changes are required.

## Actual Draft composition and limits

The API directly constructs the [actual Draft source](./current-option-set-draft-graph.md)
and owning yield source on the captured original unit of work. It derives every
Recipe pin, quantity and unit from retained actual Option details, including
disabled and archived records. Requests contain only original graph expectations,
accepted Recipe request and activation time; Tenant/Brand/User are server-fixed.
Caller content, source bodies and readiness flags cannot supply provenance.

Authority receives the original transaction. The deadline is the earlier original
Draft lease, bounded to30 seconds, and the owning observation plus five seconds.
Final yield/metadata checks remain enclosed by final current Draft permission and
root re-reading. Results are frozen, scoped, minimal and digested, containing
exact requested microunits and batch ratio or failure status. They omit full
Recipe content, health facts, costs and stock.

yieldArithmetic Pass proves only this arithmetic against current stored yield
columns. Quantity policy, ingredients, Sub-recipe graph, Binding/SKU and scope,
reference eligibility and overall eligibility remain NotEvaluated.
publishValidation remains Incomplete. Complete current validation must consume
each missing owning source before review, publication or System activation.

## Evidence and remaining implementation

Recipe's initial four affected files89/89 pass; after the explicit Tenant holder
addition the new37 cases pass again. API18/18, both affected types/builds and
selected lint pass. The finite ownership regression1372/1372 and five actual
architecture/ownership/permission scans have valid unchanged-input evidence.
Protocol query responses and authority callbacks are synthetic.

The final selected actual isolated SQL case passes9.56 seconds/10.43 seconds total.
Every earlier assertion is retained. Separate actual Draft, complete Recipe and
new yield acquisitions pass before the combined source. Exact2/3 partial batches,
the largest permitted Catalog decimal and unknown units execute without writes;
oversized ordinary Draft input is rejected without changing state. Seven
individually armed late probes complete real tentative Catalog/Audit/Outbox writes
before current yield/metadata/root field withdrawal, expiry, backward time,
Recipe root update with a proved generation change, or Catalog root revision
change. Final checks reject each; exact nineteen-table state is restored by outer
rollback. Seeded Published metadata and authorities remain synthetic; they are
not an owning Recipe publication workflow, actual IAM or business qualification.

Initial protocol mocks omitted the required read-committed response; those
fixtures were corrected. SQL failures exposed the stricter Catalog quantity
bound, incorrect creator-result parsing, and an isolated role limited to old
metadata columns. The fixture now preserves the accepted bound and parsing,
and grants exactly the three additional yield columns after all earlier field
permission assertions. It still cannot read snapshot or health fields. A fixed
stage-only diagnostic was removed by restoring the production adapter byte-exact.
All failures and corrections remain in the WP; no failure is labelled a pass.

Current Binding/SKU/scope applicability, ingredient and Sub-recipe qualification,
Media and current Published child resolution, complete quantity policy and all
five [Option seal checks](./option-set-content-seal-writer.md) remain repository
work. Ordinary complete Product editing/review/release and Store capability
management also remain. No normal HTTP/browser, owning System activation, live
Store/Provider/Future Trigger, UAT, formal release or project completion follows
from these component results.
