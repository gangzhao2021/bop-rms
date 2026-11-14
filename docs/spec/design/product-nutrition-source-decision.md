# Product Nutrition source decision

Status: **Proposed**. Owning implementation: [WP-2421](../work-packages/WP-2421.md), current M133 ordinary Product authoring. This document records a reviewable proposal, not an accepted ownership change, implemented producer, professional approval or actual nutritional evidence.

## Existing authority and missing source

The accepted source is [BOP-RMS Complete Handoff Package](../../../BOP-RMS%20Complete%20Handoff%20Package.md):

- Section 68.3 makes `nutrition_profile_reference` optional but requires a versioned reference with unit and serving basis in the source profile.
- Sections 68.7 and 68.8 allow incomplete Draft configuration. They do not authorize a fabricated profile, invalid reference or cross-Brand source.
- Section 29.1 assigns Recipe aggregation of Nutrition and Allergen sources. It does not establish a Nutrition source from Recipe measurement, yield, Ingredient requirement or allergen evidence.
- Sections 11.2 and 48.4.2 assign Product configuration snapshots and their references to Catalog. Section 92 and the module manifests govern actual database ownership; new ownership cannot be inferred from a field label.

Current Catalog `ProductContentReference` represents `reference` plus `versionReference`. There is no implemented Nutrition profile registration, versioned payload, owning reader or management workflow in Catalog or Recipe. The runtime allows a legitimate null reference and rejects a nonnull DraftWrite reference without its actual source. Those branches do not prove nonempty Nutrition support.

## Recommended business-source choice

Permit authorized staff to manually register an immutable Nutrition profile version for the Product from an actual supplied source, then select that version in Product Draft. The application records what was supplied and who recorded it. It neither calculates missing values nor attests to laboratory accuracy, regulated label compliance or professional review.

Catalog would own the profile descriptor, immutable recorded version and Product reference registration. The supplier, laboratory, manufacturer or other actual origin remains the provenance of supplied values; registration does not transfer ownership of upstream measurements to Catalog. Recipe would consume the public versioned reference if it later aggregates nutrition. It must not read Catalog private tables.

This choice finishes a usable reference workflow without making Recipe calculations a prerequisite. It still requires real source material for an operational record; development fixtures must be marked controlled InternalTest examples.

| Choice                                   | First ordinary workflow                                                                                                                    | Requirements and limitations                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual source registration — recommended | Record supplied values, explicit serving basis and provenance; register a version; select and save it in Draft                             | Needs an actual source and staff authority. Does not imply measured accuracy or approval.                                                                                                           |
| Derive values from Recipe                | Resolve versioned ingredient nutrient sources, quantities, conversions, yield and loss rules; calculate a versioned result with provenance | Current measurement/allergen sources do not provide ingredient nutrient values. Requires a separate accepted calculation/source contract and genuine inputs; cannot supply today's missing profile. |

## Proposed version contract

Use one bounded recorded-source contract, not a new Configuration Domain or parallel nutritional calculation framework. These proposed fields and limits require review before implementation; they are not existing accepted nutrient standards.

| Field                     | Proposed meaning and constraint                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and scope        | Server-owned `profileReference`, `versionReference`, Tenant, Brand and Product references; monotonically increasing `profileVersion`. First version belongs to the actual Product authoring context.                                                                                                                                                     |
| Serving basis             | Explicit positive decimal `servingQuantity`, measurement `servingUnitCode` and bounded display `servingLabel`. Values in the record are amounts for that basis. No assumed “per serving,” “per 100 g” or yield conversion.                                                                                                                               |
| Nutrient amounts          | A bounded, duplicate-free list of reported nutrient codes and nonnegative decimal amounts with explicit units. Missing amounts remain absent; zero is recorded only when supplied by the source.                                                                                                                                                         |
| Initial code/unit mapping | Proposed first fields: energy (`kJ` or `kcal`), protein/fat/carbohydrate/fibre/sugars (`g`), sodium (`mg`). Serving units: `g`, `mL` or explicitly labelled count. This is an application input vocabulary, not a claim of jurisdictional label completeness. No automatic conversion or extra nutrient inference.                                       |
| Decimal encoding          | Canonical decimal strings, maximum 14 integer digits and 6 fractional digits; store exact decimal values, never binary floats. Serving quantity must be greater than zero. Unknown units, duplicate nutrient codes, negatives and values outside bounds reject registration.                                                                             |
| Provenance                | Explicit source kind and bounded source title/record identifier, source occurrence date or instant when known, and an actual evidence reference plus immutable version/digest where the evidence owner's public contract exposes them. No invented supplier, measurement date or reviewer.                                                               |
| Evidence linkage          | The first implementation must identify and use the actual accessible evidence owner's public reference/reader. A typed UUID or client digest alone does not establish evidence existence, permission or content. If no suitable existing evidence contract is available, that is a concrete producer dependency to resolve before enabling registration. |
| Recorded integrity        | Server registration instant, registering Actor, operation reference, previous version reference and canonical content digest. These describe registration; they are separate from upstream measurement time and source claims.                                                                                                                           |
| State                     | Registered immutable versions are selectable; retirement appends a state operation and prevents new selection. Existing Product history retains its exact recorded reference. Correction registers a successor version; it never edits prior values/evidence.                                                                                            |

The unit vocabulary is independent of Product sales units. Registering a selling unit does not validate a nutrition measurement or serving basis. A nutrition profile does not establish Allergen, Contains/free-from, Recipe coverage or publication readiness.

## Owning write, read and retention behavior

The smallest proposed persistence is a Catalog profile descriptor plus immutable version and append-only registration/retirement operations, in its owning schema. Declare any new assets in ownership/manifests and provide migrations, scoped RLS and narrow role permissions. Do not add a separate Nutrition Domain merely to obtain a reader.

Registration and correction use server identity/clock, explicit Tenant/Brand/Product/Actor/purpose, expected profile version, an idempotency key and current authorization. The implementation must select existing appropriate Catalog permissions or explicitly register a new permission; a permission name in this proposal grants nothing. Exact operation retry returns the original receipt; changed payload under the same key conflicts. Persist version, Audit and Outbox atomically through the owner. The evidence source must survive that transaction's final checks.

A public owning read returns the exact requested registered version, canonical digest, unit/serving basis, recorded provenance and explicit state. It holds the actual source and access authority in the Product transaction through COMMIT. Product DraftWrite requires the exact profile/version, same Tenant/Brand and applicable Product registration; no missing row or denied source becomes an empty profile. Recorded Product Read and original-operation recovery preserve historical references without reclassifying them under a successor profile. New selection of a retired version rejects; the final behavior for an unchanged previously selected retired version must be made explicit in the accepted owner policy.

Data classification must be explicit. Product nutrition values are Product facts; source attachments can contain private contact, contract or supplier information and require their own access policy. Avoid personal health/customer information. Show only authorized source metadata; never log raw evidence, credentials, URLs, unrestricted references or source attachment contents. Public Product display, export and label compliance require their own accepted presentation/evidence rules and are not enabled by registration.

## Ordinary interface and acceptance

Use the canonical Product editor Nutrition section and its accepted screen contract. Staff can leave the optional reference empty, inspect the selected source version, open the authorized source evidence, register a supplied version, select it, and save the Product Draft. The registration command receipt and the later Product save receipt are distinct: creating a profile does not claim the Draft now references it. Show explicit field/source errors and retain edits after failure; retry an unknown operation with its original key and payload. After success, refresh the persisted source and Product state.

A complete implementation needs the registration/correction/retirement source commands, exact version reader, authorized HTTP/runtime composition, rendered selection/registration workflow, persisted refresh and original-operation recovery. Acceptance must cover nonempty exact decimal/unit/serving/evidence persistence, cross-Brand/foreign evidence denial, malformed units or missing basis, source retirement/correction, expected-version and idempotency conflicts, late permission/evidence withdrawal with full rollback, and recovery after a later source version. Passing tests with null Nutrition do not satisfy these criteria.

Future imports can register the same immutable source contract only after real mapping, provenance and authorization are defined. Future Recipe aggregation consumes public source versions and records its actual inputs/calculation version; it is separate work and does not rewrite manually supplied profiles.

## Decision and architecture disposition

The remaining business choice is whether the first source is **manual registration of supplied Nutrition data** or a separately defined import/calculation source. This proposal recommends manual registration. The accepted schema must also settle the initial nutrient/unit vocabulary, actual evidence owner/reference, and retired-version selection behavior; software design and composition are implementation duties, not requests for the user to manufacture evidence or credentials.

Catalog currently owns Product Nutrition references, but the accepted baseline does not explicitly assign a Nutrition source registry or upstream measurement ownership. Assigning the new descriptor/version registration to Catalog is therefore proposed ownership clarification. Before changing a frozen public ownership boundary, record the required accepted ADR/Handoff clarification under the domain-change rule and update only the affected module/source contracts. Do not treat this document, a user's general request to finish the project, or permission to adjust requirements as acceptance of a new source owner or medical/label policy.

Until the source choice and required architecture clarification are accepted and the actual producer is implemented, preserve the valid optional-null branch and explicit nonnull-source failure. Continue independent Product workflow implementation; this document does not close M133 or move missing software into an external Store/UAT gate.
