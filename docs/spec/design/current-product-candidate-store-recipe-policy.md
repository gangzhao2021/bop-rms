# Current Validate Store and Brand Recipe policy

WP-2421 milestone81 extends the [actual Validate candidate membership](./current-product-candidate-recipe-binding-scope.md)
with current registered Store topology and current Published Brand policy. It
uses the accepted Recipe whole-version Store precedence and the existing
[Tenant and Publishing composition](./current-store-recipe-override-policy.md).

The API acquires the complete Product candidate through Catalog's current Validate
reader and derives the entire SKU/Option target using its owning public binder.
The actual original User command, aggregate/version, content/configuration digests
and effectiveFrom remain unchanged. No LifecycleReview request, selected SKU or
current-source DTO is fabricated. Server context supplies Store/configuration
references and expected Brand revision; owning reads establish their currentness.

A registered Store can be assessed for an original unfiltered Brand scope or its
same exact unfiltered Store scope. A StoreGroup-only, Channel/OrderType-only or
filtered-only context cannot establish coverage with these accepted inputs and
is refused. This bounded subset does not establish admission for every scope in
a multi-scope publication. Additional accepted current topology is separate work.

Catalog, Tenant Store, Recipe and Tenant Brand content plus public Publishing
release readers use the original transaction. Current field authorities remain
mandatory. The Brand policy is derived from the current published content and
its owning release/validation/independent approval proof. RECIPE.VERSION overrides
must be explicitly allowed and cannot be hard requirements. Actual Recipe rules
choose an applicable exact Store whole-version override before Brand defaults;
a bad or ambiguous override cannot silently fall back. Unknown/inactive topology,
stale versions, denied overrides and ambiguity return no selected Recipe.

The caller cannot supply observation, deadline or a new activation. A captured
server clock bounds entry, then the actual Catalog candidate's original lease
and subsequent observations narrow it, including each five-second source window
and Brand expiry. Final candidate and Brand reads keep original selectors and
windows. Current permissions, generations, captured query identity, before/after
in-flight checks, monotonic clock, exact callbacks/results and poisoned failed
transactions remain mandatory. A held barrier alone cannot certify same-UoW
writes; the full candidate body and current Brand/Publishing projection are
explicitly reread after consumer work. Trusted Catalog field denial survives
nested foreign error mapping without recovering consumer-manufactured authority.

The output identifies the complete candidate and one Store's stored whole-version
selection. It contains no full editor or Brand prose. Full V2 content, recursive
measurement/unit qualification, Option modifiers, preparation classification and
complete publication admission remain open; publishValidation is Incomplete and
eligibility is NotEvaluated. Past effectiveFrom is refused by the current owning
Recipe contract; immediate/scheduler timing cannot be repaired by changing intent.

Tests use synthetic holder protocols and current authorities with actual owning
Catalog identity/binders, Recipe resolution and Tenant/Publishing content proof
composition. They cover Store override/default decisions, absent/inactive/ambiguous
sources, final permission/content/publication drift, substituted query, deadlines,
callbacks/results, exact command/context and refusal of supplied policy/timestamps.
This is no joined Store/Brand SQL, ordinary HTTP/browser, UAT or release evidence.
Actual joined acceptance is the next bounded milestone; complete normal Product
publishing and Store capability management remain repository work.

Milestone82 actual joined SQL now covers all public readers in one original UoW,
exact override and Brand fallback, Unknown/Archived Store, current native
replacement Brand release forbidding overrides, ten independently armed late
refusals and three pre-consumer refusals. Each late probe first calls the same
native different-Product creation with real Audit/Outbox; every covered table in
Catalog/Recipe/Tenant/Publishing/Audit/Eventing is restored exactly by rollback.
Native Publishing Archive is appended inside the original transaction, verified
for that exact lifecycle, then refused by final current-publication reread and
rolled back. Current Product drift, field revocation, Store generation/Brand
lifecycle, exclusive deadline and query substitution are also verified.

Tenant Store/configuration and Published Recipe metadata remain synthetic; the
existing fixture uses real native Publishing lifecycle/validation/review/approve/
publish writes with synthetic validation and independent approver facts. Reusing
the already exact Active Brand preserves the older Tax acceptance setup/counts.
No ordinary Tenant writer, full V2 Recipe qualification, normal HTTP/browser,
real IAM/Store/Future Trigger/UAT or release proof follows from this acceptance.
