# Product validation explicit Variant prerequisite

WP-2421 milestone121 closes one necessary-condition gap under accepted Sections68.8/68.9. Complete Draft content may retain explicitly NotGenerated combinations during authoring. Publish validation must not treat them as resolved Variant/SKU mappings.

## Owning source and composition

The existing Catalog editor parser distinguishes Valid, Invalid and NotGenerated. Valid binds an exact owning SKU and matching selections, including required dimensions. Invalid is an explicit exclusion. NotGenerated has no SKU mapping. These states are preserved; no Cartesian expansion or implicit generated combination is introduced.

The content binder derives only `UnmappedCombinationPresent`, `NoExplicitUnmappedCombination` or `Unavailable`. This pure observation has no current authority by itself. Ordinary Validate receives it only through the actual owning complete candidate source, original Product root/digests/intent, full current fields and existing source barriers. It is included in the minimal candidate/scope observation fingerprint, without exposing names, dimensions, values or SKU references.

Catalog downgrades VariantMapping to HardError when an explicit NotGenerated combination is present, and recomputes HardErrorsCleared alongside the actual code/UniqueScope outcomes and no-Active-SKU prerequisite. NoExplicitUnmappedCombination preserves the independent VariantMapping outcome; it never produces Pass or clears Warning/HardError. Legacy missing complete content is Unavailable and cannot stand in for a known empty set. Actor/Reason, evidence, all remaining checks, earliest leases/current permissions/CAS/Audit/Outbox and original source-free recovery remain mandatory.

## Verification boundary

Synthetic binding/merge/native adapter tests cover each disposition, unavailable content, closed/getter/stale proof, independent outcomes and acknowledged Warning inconsistency. Actual isolated native HTTP/SQL retains the original empty-SKU/code barrier/late rollback/permission/recovery scenario. A separate bounded initial fixture stores one Active SKU mapped to a Valid combination plus another explicit NotGenerated combination. With known current Brand scope and actual unique code, ordinary Validate must still persist HardError despite supplied remaining Pass outcomes; original lost-response replay must perform zero source acquisitions.

The fixture's Active SKU is synthetic business input, not sellability evidence. The remaining outcomes/governance/field-authority fixtures are synthetic. No complete VariantMapping producer, target-scope SKU eligibility, processed Media/reference policy, System activation integration, UI/full repository verification or whole-project completion is claimed. Other current publication and Store management work remains in progress.
