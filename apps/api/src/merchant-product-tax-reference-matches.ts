import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  parseProductPricingBindingSourceSnapshot,
  parseProductReferenceHistorySourceSnapshot,
  type ProductLifecycleReviewRequest,
  type RecordedProductReferenceConfiguration,
} from "@rms/catalog";
import {
  parseTaxConfigurationReferenceSourceRequest,
  matchProductVersionTaxReferences,
  matchProductVersionBrandTaxReferences,
  parsePriceBookReferenceSourceRequest,
} from "@rms/pricing";
/** Composition only. Store must be bound to the enclosing actual current authorized context; DTOs don't authorize a Store. */
export function composeMerchantProductTaxReferenceMatches(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly storeReference: string;
  readonly sourceProfile: "CurrentDraftBindings" | "RecordedDraftConfigurations";
  readonly catalogSource: unknown;
  readonly taxConfigurations: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request);
    let configurations: readonly RecordedProductReferenceConfiguration[],
      catalogSourceDigest: string;
    if (input.sourceProfile === "CurrentDraftBindings") {
      const c = parseProductPricingBindingSourceSnapshot(input.catalogSource, request, input.now);
      catalogSourceDigest = c.digest;
      configurations = [
        {
          versionReference: c.versionReference,
          skuReferences: c.skuReferences,
          categoryCoverage: c.categoryCoverage,
          categoryReferences: c.categoryReferences,
          primaryCategoryReference: c.primaryCategoryReference,
          taxClassificationReference: c.taxClassificationReference,
          bindings: c.bindings,
        },
      ];
    } else if (input.sourceProfile === "RecordedDraftConfigurations") {
      const c = parseProductReferenceHistorySourceSnapshot(input.catalogSource, request, input.now);
      catalogSourceDigest = c.digest;
      configurations = c.configurations;
    } else throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    const pricingRequest = parseTaxConfigurationReferenceSourceRequest({
      purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      operationReference: request.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
      storeReference: input.storeReference,
    });
    return matchProductVersionTaxReferences({
      request: pricingRequest,
      target: {
        profile: input.sourceProfile,
        catalogSourceDigest,
        productReference: request.productReference,
        skuReference: request.skuReference,
        configurations: configurations.map((c) => ({
          catalogConfigurationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(c)),
          versionReference: c.versionReference,
          skuReferences: c.skuReferences,
          taxClassificationReference: c.taxClassificationReference,
        })),
      },
      taxConfigurations: input.taxConfigurations,
      now: input.now,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}

/** Composition only. Call from the enclosing current source-holder workflow; a parsed Brand snapshot grants no permission. */
export function composeMerchantProductBrandTaxReferenceMatches(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly sourceProfile: "CurrentDraftBindings" | "RecordedDraftConfigurations";
  readonly catalogSource: unknown;
  readonly taxConfigurations: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request);
    let configurations: readonly RecordedProductReferenceConfiguration[],
      catalogSourceDigest: string;
    if (input.sourceProfile === "CurrentDraftBindings") {
      const c = parseProductPricingBindingSourceSnapshot(input.catalogSource, request, input.now);
      catalogSourceDigest = c.digest;
      configurations = [
        {
          versionReference: c.versionReference,
          skuReferences: c.skuReferences,
          categoryCoverage: c.categoryCoverage,
          categoryReferences: c.categoryReferences,
          primaryCategoryReference: c.primaryCategoryReference,
          taxClassificationReference: c.taxClassificationReference,
          bindings: c.bindings,
        },
      ];
    } else if (input.sourceProfile === "RecordedDraftConfigurations") {
      const c = parseProductReferenceHistorySourceSnapshot(input.catalogSource, request, input.now);
      catalogSourceDigest = c.digest;
      configurations = c.configurations;
    } else throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    const pricingRequest = parsePriceBookReferenceSourceRequest({
      purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      operationReference: request.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
    });
    return matchProductVersionBrandTaxReferences({
      request: pricingRequest,
      target: {
        profile: input.sourceProfile,
        catalogSourceDigest,
        productReference: request.productReference,
        skuReference: request.skuReference,
        configurations: configurations.map((c) => ({
          catalogConfigurationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(c)),
          versionReference: c.versionReference,
          skuReferences: c.skuReferences,
          taxClassificationReference: c.taxClassificationReference,
        })),
      },
      taxConfigurations: input.taxConfigurations,
      now: input.now,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
