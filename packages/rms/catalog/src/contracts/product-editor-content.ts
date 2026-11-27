import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogLocale,
  parseProductAggregate,
  parseProductVersion,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductEditorContentStructure,
  parseProductEditorContentDetails,
} from "../domain/product-editor-content.js";
export type {
  ProductEditorContent,
  ProductEditorContentDetails,
  ProductContentReference,
  ProductAttributeValue,
  ProductContentMedia,
  ProductVariantDimension,
  ProductVariantCombination,
  ProductOptionContentRule,
} from "../domain/product-editor-content.js";
/** Initial structural proposal only, before owning identity allocation. It grants
 * no reference readiness, permission or publication eligibility. */
export function parseCatalogProductInitialEditorContent(value: unknown, defaultLocale: unknown) {
  return parseProductEditorContentDetails(value, {
    defaultLocale: parseCatalogLocale(defaultLocale),
    skus: [],
    optionBindings: [],
  });
}
/** Structural content preparation using an actual parsed owning Product candidate.
 * Neither this value nor its fingerprint supplies source coverage or permission.
 * Legacy absence stays absent; full producers need independent current sources. */
export function parseCatalogProductEditorContent(sourceValue: unknown, contentValue: unknown) {
  try {
    const source = parseProductAggregate(copyCategoryPersistenceValue(sourceValue));
    const { content, contentDigest, configurationDigest } =
      deriveCatalogProductEditorContentIdentity(source.draft, contentValue);
    return Object.freeze({
      tenantCoverage: "NotEvaluated" as const,
      brandReference: source.brandReference,
      productReference: source.productReference,
      versionReference: source.draft.versionReference,
      sourceAggregateVersion: source.aggregateVersion,
      content,
      contentDigest,
      configurationDigest,
      referenceEligibility: "NotEvaluated" as const,
    });
  } catch {
    throw new CatalogError("CATALOG_INPUT_INVALID");
  }
}

/** Exact full-content identity shared by current preparation and immutable recovery. */
export function deriveCatalogProductEditorContentIdentity(
  draftValue: unknown,
  contentValue: unknown,
) {
  const parsed = parseProductVersion(copyCategoryPersistenceValue(draftValue));
  const { editorContent, ...draft } = parsed;
  void editorContent;
  const content = parseProductEditorContentStructure(
    copyCategoryPersistenceValue(contentValue),
    Object.freeze(draft),
  );
  const contentDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(content));
  const configuration = Object.freeze({
    profile: content.profile,
    versionReference: draft.versionReference,
    categoryClassification: draft.categoryClassification ?? null,
    classificationCoverage: draft.categoryClassification === undefined ? "Unavailable" : "Known",
    taxClassificationReference: draft.taxClassificationReference,
    skus: content.sourceDraft.skus.map((sku) => ({
      skuReference: sku.skuReference,
      skuCode: sku.skuCode,
      lifecycle: sku.lifecycle,
      variantSelections: sku.variantSelections,
      unitOfSale: sku.unitOfSale,
      unitQuantity: sku.unitQuantity,
    })),
    optionBindings: content.sourceDraft.optionBindings,
    tagReferences: content.tagReferences,
    attributeValues: content.attributeValues,
    media: content.media.map((media) => ({
      mediaReference: media.mediaReference,
      assetReference: media.assetReference,
      assetVersionReference: media.assetVersionReference,
      role: media.role,
      sortOrder: media.sortOrder,
      cropReference: media.cropReference,
      focusReference: media.focusReference,
    })),
    variantDimensions: content.variantDimensions.map((dimension) => ({
      dimensionReference: dimension.dimensionReference,
      code: dimension.code,
      sortOrder: dimension.sortOrder,
      selectionRequirement: dimension.selectionRequirement,
      values: dimension.values.map((value) => ({
        valueReference: value.valueReference,
        code: value.code,
        sortOrder: value.sortOrder,
        attributeReference: value.attributeReference,
        mediaReference: value.mediaReference,
      })),
    })),
    variantCombinations: content.variantCombinations,
    optionRules: content.optionRules,
    allergenReferences: content.allergenReferences,
    nutritionProfile: content.nutritionProfile,
  });
  const configurationDigest = "sha256:" + sha256Hex(canonicalizeRfc8785(configuration));

  return Object.freeze({ content, contentDigest, configurationDigest });
}
