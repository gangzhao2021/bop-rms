# Complete initial Product creation

Implemented under [WP-2421](../work-packages/WP-2421.md), following accepted
Handoff68.8–68.9 and the existing owning Product Create/Draft persistence contracts.
This software decision supplies a bounded initial producer; it does not supply
current reference readiness, selling eligibility or publication evidence.

Create may explicitly include CatalogProductEditorContentV1. Initial complete
proposals contain no SKU because new SKU identities and Variant mappings require
their owning generation command. Structural parsing uses the known default locale,
empty SKU and Option binding context before server identity allocation. No temporary
Product/Version/SKU UUID is invented to validate the input. The owning service then
records server identities, complete content and its original intent atomically.

Legacy requests omit editorContent and preserve their existing intent and recovery.
Old snapshots remain partial; neither client nor server silently fills them with
empty complete fields. Initial complete content is closed, bounded and immutable;
extra authority/evidence fields, dangling SKU/Option references and malformed
values refuse. Merchant request size remains8192 bytes; later full Draft Save uses
its existing65536 byte ceiling. Neither path changes publication validation.

The native composition requires independently configured complete-field/reference
sources. CATALOG_PRODUCT_CREATE is a distinct held purpose; existing replacement
adapters keep CATALOG_PRODUCT_DRAFT_REPLACE. Current authenticated Tenant, Brand,
Store, Actor, session and native permissions are resolved in the same outer
transaction. The original five-second source lease is rechecked through COMMIT,
including tentative writes and original operation recovery. Missing/withdrawn
sources refuse; unsupported replacement-only adapters cannot qualify Create.
Original replay binds original content and clock even after a later Draft.

The native acceptance entry uses actual local HTTP, an encrypted synthetic session,
current native IAM, owning SQL and Audit/Outbox. Screen and cross-domain field/
reference policies remain explicitly synthetic. Ordinary Create UI is following
work; this contract alone does not complete the Product management flow, full
current publication validation, Store management, UAT or production release.

## Ordinary initial Draft page

WP-2421 milestone100 adds the registered standalone CAT-PRODUCT-CREATE route
`/app/commerce/products/new`. Products exposes it only while the independently
loaded current Create capability allows the exact Store/Brand. Shell navigation
and the static capability mapping supply no creation permission. The page resolves
current access again, and every explicit create/retry resolves it before dispatch.
Exclusive five-second source expiry, offline/background, changed context and late
aborted reads remain unavailable. Native current field/reference holders and IAM
remain final authority.

The user explicitly supplies code, type, locale, name and descriptions, and
acknowledges an initial unconfigured Draft. Empty SKU/media/reference/Variant/
Option/allergen/nutrition proposals do not assert safety, sale eligibility or
current source facts. No new Product/Version/SKU identity is supplied by the page;
the owning receipt supplies its Product and root1 editor navigation. Current
reference pickers and generation/mapping remain separate incomplete work.

An uncertain result locks fields and new intents. Explicit recovery checks current
access and reuses the in-session original prepared bytes and operation, including
after current capability or native permission refusal. No automatic resend occurs.
This Create controller does not persist a credential or infer a Tenant from the
capability DTO. Reload/departure can lose the local original; durable creation
operation discovery remains open. The separately scoped publication recovery
journal remains unchanged.

The page uses existing Merchant AppFrame, controls and tokens with explicit
labels, result association, keyboard focus,44px targets and scoped narrow/zoom
reflow. Actual local Chromium/HTTP checks use synthetic current source and
native-shaped receipts; milestone99's actual native IAM/owning SQL proof is
separate. Neither is full current publication qualification, UAT or release.

Milestone101 detaches the descriptor-safe bounded proposed value before awaiting
current capability. Later caller edits or accessors cannot alter that original
proposal. Nonfinite or reversed local clocks refuse before source acquisition and
dispatch, matching existing complete Draft authoring discipline. Ordinary limits
match owner code64/name120/short240/description4096/notes1000; the whole initial
Create still has its independent8192-byte ceiling. No source requirement or
original recovery identity changes.

## Current initial Category selection

Milestone102 embeds current Category selection in CAT-PRODUCT-CREATE, using the
existing related lookup and assignment consumer contract. Current capability
supplies Brand; Store and explicit locale remain exact. Names and lifecycle come
only from a currently parsed scoped lookup. Search narrows current choices with
an explicit100-item display ceiling; the projection is partial Draft configuration,
not selling or publication qualification. Primary assignment is explicit and must
belong to the selected members. No primary is inferred.

Classification stays omitted until the user explicitly selects members or chooses
Use no Categories from a fresh source. Source denial, expiry, invalid locale and
late context cannot silently create a known-empty assignment. A prior proposal is
retained while choices are hidden; fresh source and eligible membership are required
before a new Create. This source is cloned without evaluating accessors before
awaiting Create access, then its exclusive five-second lease and exact scope/locale/
parent/members are checked again immediately before preparing original bytes.
Native current Category policy remains final admission authority.

An uncertain classified Create retains the original classification and primary in
its original prepared bytes. Explicit original retry does not substitute refreshed
choices or mint another operation; native admission still resolves current source
and permission. Offline and locale departure abort reads without applying late
choices, and a current reload can restore the retained proposal. No classification
or lookup authority is placed in a URL, log or browser storage.

Local ordinary browser proof uses synthetic scoped Category lookup and bound
classified receipts. It does not establish successful native complete Create with
Category policy composition: milestone99 native fixture deliberately has no Category
policy holder. Existing owning classification persistence proof and99 unclassified
complete Create proof stay separate. Initial owning source composition, full current
validation and Store management remain incomplete repository work.

## Current referenced Category permission during Create (WP-2421 milestone103)

The native Create composition independently resolves the authenticated current Merchant Brand scope for every held classified Read/Write policy call. Tenant, Brand, selected Store, Actor and session remain bound to the original Product transaction. Both current Brand `catalog.product.manage` and referenced `catalog.manage` must allow the exact action before and after the awaited independent Category policy holder. Store grants cannot replace Brand grants. Existing assignment final checks invoke the same wrapper before COMMIT, preserving the initial exclusive five-second deadline, monotonic clock, transaction/query identity and failed-transaction latch.

Catalog still owns the held current Category facts and membership/lifecycle checks. The independent field/phase policy callback remains mandatory, with no default allowed lifecycle list; missing sources fail closed even for explicitly empty classification. Original operation recovery retains the original classification and receipt, while rechecking current access and the configured policy shape without re-running original business qualification. This composition adds native IAM evidence, not a full current publication-policy producer or sale eligibility.

The bounded acceptance uses physical isolated PostgreSQL, an owning Category repository seed and change, native encrypted synthetic sessions/current IAM, loopback HTTP and original command recovery. Full-content/screen and Category field/phase holders remain synthetic. It adds no production schema, ACL, route, client contract, System activation or external facts.

## Classified complete Draft editing (WP-2421 milestone104)

Ordinary Draft Save uses the same independent native current Category permission wrapper as initial Create. The actual current authenticated Brand Product and referenced Category permissions surround the configured field/phase policy, while the existing owning Product update/field/source guard remains required. The selected Store/session and Product bind to the original transaction; final classified Read/Write checks keep the first exclusive deadline. Missing policy cannot turn existing classification into an empty or unclassified fallback.

An uncertain Save retains its original operation and bytes. Current referenced permission denial suppresses recovery until restored; authorized recovery returns the original root2 full Draft even after a later deliberate empty-classification Save reaches root3. Read/replay does not re-run original Category business qualification. Native Catalog writes and Audit/Outbox/source changes remain atomic. The added isolated SQL/HTTP acceptance consumes the actual initial Product and history from milestone103; independent field/phase/screen policy holders stay synthetic. Lifecycle already checks both native Brand permissions and publication retains its own public source contracts.

## Ordinary classified complete Draft form (WP-2421 milestone105)

CAT-PRODUCT-EDIT uses the same related Category picker with an explicit Edit parent. The current Store capability resolves Brand independently of SKUs. Recorded classification is retained until an explicit current multi-selection, primary selection or empty classification proposal; omitted or failed lookup never means empty. Recorded members absent from current choices are retained without an eligibility claim, and an unavailable recorded primary is identified as outside current choices. Other recorded reference identities remain unchanged.

Changed classification requires a detached closed lookup matching the exact parent, Brand, Store and locale, current exclusive five-second observation, membership and primary constraints. The controller checks the original source after reading the complete current baseline and again after final capability admission, before a new transport. Text-only edits that retain classification do not require a lookup. Partial Draft choices constrain authoring but never replace native field/phase policy or publication qualification.

Unknown Save freezes the original command. Offline or current native denial preserves its bytes; authorized original retry does not refresh Category choices, allocate another operation or requalify original business facts. A confirmed receipt clears the offline recovery banner but leaves editable content hidden until an explicit current read. Source reads abort on offline, background or departure; late choices cannot restore old context. A refreshed lookup can restore a retained local proposal, without silently removing unavailable members.

The evidence is an actual ordinary production Chromium/local HTTP flow with synthetic editor, capability, lookup and receipt sources, separately linked to unchanged milestone104 isolated native IAM/SQL atomic Save and replay proof. It does not close full publication current-source composition or Store initial management.

Category refresh completion merges only classification into the latest local candidate. It never replaces concurrently edited content or recorded configuration with the full candidate captured when the lookup began. The delayed-source browser case edits Decimal and Option fields during refresh and verifies the current proposal and all fields in the original saved bytes, including the existing canonical decimal normalization. Scoped editor CSS overrides the shared body minimum only while this editor is present, supporting320px200% reflow without changing global UI tokens.
