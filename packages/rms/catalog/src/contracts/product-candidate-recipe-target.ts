import { bindCatalogProductValidationCandidate } from "./product-validation-candidate.js";

/** Catalog-owned membership only. Invoke with the held current candidate; this
 * pure binding does not establish current source authority or Recipe eligibility. */
export function deriveCatalogProductCandidateRecipeTarget(
  command: unknown,
  aggregate: unknown,
  observedAt: unknown,
) {
  const candidate = bindCatalogProductValidationCandidate(command, aggregate, observedAt),
    draft = candidate.aggregate.draft;
  return Object.freeze({
    mappingProfile: "KnownDraftBindings" as const,
    catalogConfigurationDigest: candidate.configurationDigest,
    productReference: candidate.aggregate.productReference,
    versionReference: draft.versionReference,
    skuReference: null,
    skuReferences: Object.freeze(draft.skus.map((s) => s.skuReference).sort()),
    bindings: Object.freeze(
      draft.optionBindings
        .map((b) =>
          Object.freeze({
            bindingReference: b.bindingReference,
            enabledOptionReferences: Object.freeze([...b.enabledOptionReferences].sort()),
            includedSkuReferences: Object.freeze([...b.includedSkuReferences].sort()),
            excludedSkuReferences: Object.freeze([...b.excludedSkuReferences].sort()),
          }),
        )
        .sort((a, b) => a.bindingReference.localeCompare(b.bindingReference)),
    ),
  });
}
export type CatalogProductCandidateRecipeTarget = ReturnType<
  typeof deriveCatalogProductCandidateRecipeTarget
>;
