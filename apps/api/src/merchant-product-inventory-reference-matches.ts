import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseProductLifecycleReviewRequest,
  parseProductCurrentReferenceHistoryPair,
  type ProductLifecycleReviewRequest,
  type RecordedProductReferenceConfiguration,
} from "@rms/catalog";
import { matchInventorySkuMappingReferenceGraphs } from "@rms/inventory";
/** Each current/recorded graph uses the same seven-field identity as the Catalog
 * current-SKU source. Lifecycle request metadata cannot change that identity. */
export function composeMerchantProductInventoryReferenceMatches(input: {
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly inventorySource: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request),
      tenant = parseCatalogReference(input.tenantReference),
      pair = parseProductCurrentReferenceHistoryPair(
        input.catalogCurrent,
        input.catalogHistory,
        request,
        input.now,
      ),
      inventoryRequest = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
        tenantReference: tenant,
        brandReference: request.brandReference,
        actorReference: request.actorReference,
        operationReference: request.operationReference,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
      };
    const currentConfiguration: RecordedProductReferenceConfiguration = Object.freeze({
      versionReference: pair.current.versionReference,
      skuReferences: pair.current.skuReferences,
      categoryCoverage: pair.current.categoryCoverage,
      categoryReferences: pair.current.categoryReferences,
      primaryCategoryReference: pair.current.primaryCategoryReference,
      taxClassificationReference: pair.current.taxClassificationReference,
      bindings: pair.current.bindings,
    });
    const graph = (configuration: RecordedProductReferenceConfiguration) => ({
      productReference: request.productReference,
      productVersionReference: configuration.versionReference,
      skuReference: request.skuReference,
      skuReferences: configuration.skuReferences,
      catalogConfigurationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(configuration)),
    });
    const matches = matchInventorySkuMappingReferenceGraphs({
        request: inventoryRequest,
        targets: [graph(currentConfiguration), ...pair.recorded.configurations.map(graph)],
        source: input.inventorySource,
        now: input.now,
      }),
      current = matches[0];
    if (!current) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    const recorded = Object.freeze(
      pair.recorded.configurations.map((configuration, i) => {
        const result = matches[i + 1];
        if (!result) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        return Object.freeze({ configuration, matches: result });
      }),
    );
    const body = {
      request,
      coverage: "KnownCurrentAndRecordedDraftGraphs" as const,
      applicability: "Unavailable" as const,
      publicationCoverage: pair.recorded.publicationCoverage,
      futureScheduleCoverage: pair.recorded.futureScheduleCoverage,
      inventorySourceDigest: current.inventorySourceDigest,
      inventoryGeneration: current.inventoryGeneration,
      recordedCatalogSourceDigest: pair.recorded.digest,
      current,
      recorded,
    };
    const stable = (match: typeof current) => {
      const { observedAt, ...facts } = match;
      void observedAt;
      return facts;
    };
    const observations = Object.freeze({
      catalogCurrent: pair.current.observedAt,
      catalogHistory: pair.recorded.observedAt,
      inventory: current.observedAt,
    });
    return Object.freeze({
      ...body,
      digest:
        "sha256:" +
        sha256Hex(
          canonicalizeRfc8785({
            ...body,
            current: stable(current),
            recorded: recorded.map((r) => ({ ...r, matches: stable(r.matches) })),
          }),
        ),
      observations,
      observedAt: [
        observations.catalogCurrent,
        observations.catalogHistory,
        observations.inventory,
      ].sort()[0] as string,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
