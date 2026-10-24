# Complete Product Draft client transport

WP-2421 milestone85 extends the browser ProductVersion wire value with the optional
CatalogProductEditorContentV1 details accepted by the existing owning Draft command.
The [owning content structure](../../../packages/rms/catalog/src/domain/product-editor-content.ts)
controls structural normalization and relationships. The browser mirror imports no
Domain runtime and supplies no current reference, permission, validation or selling facts.

The current editor read verifies the full snapshot digest, exact Brand/Product/revision
and exclusive five-second lease before retaining the complete immutable Draft. Its
separate presentation still omits raw reference labels. The previous presentation
counts and booleans cannot be used as a write baseline. Legacy absent content remains
absent; explicit malformed content is refused, never silently dropped.

Complete localized descriptions, preparation, Tags, typed attributes, Media tuples,
variant dimensions/combinations, Option rules, allergen references and nutrition tuples
are detached and frozen. Decimal normalization uses strings and BigInt. Same-Draft
variant and Option relationships are structural checks; owning current sources must
still qualify every external reference and policy at Save/Validate/Publish.

The unchanged command client binds receipt comparisons to complete content together
with original scope, operation, Product and expected aggregate version. Unknown outcome
retries the exact original prepared bytes. Missing or rebound receipt details cannot
confirm a save. The existing bounded 8192-byte request and 65536-byte response limits
remain in force; larger complete candidates currently refuse and require a separately
reviewed normal HTTP limit decision. No arbitrary limit increase accompanies this change.

Ordinary editable controls, current write-capability gating, keyboard/mobile/offline
recovery evidence, complete validation and publishing actions are following milestones.
This transport milestone alone does not establish an ordinary editor, full publish
admission, actual HTTP write, browser journey, IAM, UAT or production release.

## Complete request bound and native HTTP composition (milestone88)

Complete parsed Draft requests now use the existing native HTTP JSON ceiling of65536
UTF8 bytes. Create and legacy Draft retain8192, responses remain65536. Strings,
properties, depth, graph caps, headers and server limits are unchanged. Candidates
above the complete bound refuse before transport; this is finite support, not arbitrary
large editor or reference eligibility. This supersedes85 request-bound limitation only.

The isolated SQL case runs actual browser command preparation and immutable original
Apply/Replay/permission-restored recovery bytes through the existing local BFF HTTP
listener and native Catalog persistence. The test adapter forwards actual observed
status, Content-Type and no-store headers; it does not make a successful receipt.
Existing synthetic full reference/field declarations remain explicitly separate from
actual native Product write/current IAM/permission guard, and no real Store/Provider
or publication eligibility is inferred. All existing negative and native SQL assertions
remain; no production reference source, ACL, schema or HTTP limit is changed.

Actual88 HTTP verification corrected the transport assumption: Merchant BFF used
8KiB independently of the outer64KiB HTTP security ceiling. The exact POST Draft
route now parses up to that existing outer ceiling only for complete-content
candidates; legacy Draft and all other paths/methods retain8KiB. Closed command
parsing/current ownership remains mandatory. Oversize or malformed Draft JSON
returns a finite no-store redacted rejection. The isolated observed-response helper
rejects non-JSON without exposing HTML or leaving a pending Promise.
