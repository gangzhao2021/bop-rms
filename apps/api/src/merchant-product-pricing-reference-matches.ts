import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  parseProductPricingBindingSourceSnapshot,
  parseProductReferenceHistorySourceSnapshot,
  parseProductCurrentReferenceHistoryPair,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import {
  parsePriceBookReferenceSourceRequest,
  parseConfigurationReferenceSourceSnapshot,
  matchPricingConfigurationReferences,
  matchRecordedPricingConfigurationReferences,
} from "@rms/pricing";
/** Composition only. Actual current source holders are required by the enclosing review provider. */
export function composeMerchantProductPricingReferenceMatches(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalog: unknown;
  readonly priceBooks: unknown;
  readonly optionPrices: unknown;
  readonly promotions: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request),
      catalog = parseProductPricingBindingSourceSnapshot(input.catalog, request, input.now),
      pricingRequest = parsePriceBookReferenceSourceRequest({
        purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
        brandReference: request.brandReference,
        actorReference: request.actorReference,
        operationReference: request.operationReference,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
      });
    return matchPricingConfigurationReferences({
      request: pricingRequest,
      target: {
        mappingProfile: catalog.profile,
        catalogSourceDigest: catalog.digest,
        productReference: request.productReference,
        skuReference: request.skuReference,
        skuReferences: catalog.skuReferences,
        categoryReferences: catalog.categoryReferences,
        bindings: catalog.bindings.map((b) => ({
          bindingReference: b.bindingReference,
          enabledOptionReferences: b.enabledOptionReferences,
          includedSkuReferences: b.includedSkuReferences,
          excludedSkuReferences: b.excludedSkuReferences,
          channelCodes: b.channelCodes,
        })),
      },
      priceBooks: input.priceBooks,
      optionPrices: input.optionPrices,
      promotions: input.promotions,
      now: input.now,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}

/** Transport/composition only; owning Catalog validates history, Pricing owns matching semantics. */
export function composeMerchantProductRecordedPricingReferenceMatches(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogHistory: unknown;
  readonly priceBooks: unknown;
  readonly optionPrices: unknown;
  readonly promotions: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request),
      catalog = parseProductReferenceHistorySourceSnapshot(
        input.catalogHistory,
        request,
        input.now,
      ),
      pricingRequest = parsePriceBookReferenceSourceRequest({
        purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
        brandReference: request.brandReference,
        actorReference: request.actorReference,
        operationReference: request.operationReference,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
      });
    return matchRecordedPricingConfigurationReferences({
      request: pricingRequest,
      target: {
        mappingProfile: catalog.profile,
        catalogSourceDigest: catalog.digest,
        productReference: request.productReference,
        skuReference: request.skuReference,
        configurations: catalog.configurations.map((c) => ({
          catalogConfigurationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(c)),
          versionReference: c.versionReference,
          skuReferences: c.skuReferences,
          categoryReferences: c.categoryReferences,
          bindings: c.bindings.map((b) => ({
            bindingReference: b.bindingReference,
            enabledOptionReferences: b.enabledOptionReferences,
            includedSkuReferences: b.includedSkuReferences,
            excludedSkuReferences: b.excludedSkuReferences,
            channelCodes: b.channelCodes,
          })),
        })),
      },
      priceBooks: input.priceBooks,
      optionPrices: input.optionPrices,
      promotions: input.promotions,
      now: input.now,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}

/** Validated public source composition; currentness comes from enclosing owner callbacks,
 * never this DTO parser or a matching digest. Catalog owns graph/revision coherence. */
export function composeMerchantProductPricingReferenceSourceMatches(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly pricingSource: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request),
      pair = parseProductCurrentReferenceHistoryPair(
        input.catalogCurrent,
        input.catalogHistory,
        request,
        input.now,
      ),
      pricingRequest = parsePriceBookReferenceSourceRequest({
        purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
        brandReference: request.brandReference,
        actorReference: request.actorReference,
        operationReference: request.operationReference,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
      }),
      source = parseConfigurationReferenceSourceSnapshot(
        input.pricingSource,
        pricingRequest,
        input.now,
      ),
      common = {
        request,
        priceBooks: source.priceBooks,
        optionPrices: source.optionPrices,
        promotions: source.promotions,
        now: input.now,
      };
    return Object.freeze({
      pricingSourceDigest: source.digest,
      pricingGeneration: source.generation,
      current: composeMerchantProductPricingReferenceMatches({ ...common, catalog: pair.current }),
      recorded: composeMerchantProductRecordedPricingReferenceMatches({
        ...common,
        catalogHistory: pair.recorded,
      }),
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
