import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  parseProductCurrentReferenceHistoryPair,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import { matchRecipeCatalogReferenceGraphs } from "@rms/recipe";
/** API validates Catalog pair and transports each closed graph separately to owning Recipe matching. */
export function composeMerchantProductRecipeReferenceMatches(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly recipeSource: unknown;
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
      recipeRequest = {
        purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
        brandReference: request.brandReference,
        actorReference: request.actorReference,
        operationReference: request.operationReference,
        catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
      };
    const graph = (
      configuration: Pick<
        (typeof pair.recorded.configurations)[number],
        "versionReference" | "skuReferences" | "bindings"
      >,
      configurationDigest: string,
    ) => ({
      mappingProfile: "KnownDraftBindings",
      catalogConfigurationDigest: configurationDigest,
      productReference: request.productReference,
      versionReference: configuration.versionReference,
      skuReference: request.skuReference,
      skuReferences: configuration.skuReferences,
      bindings: configuration.bindings.map((b) => ({
        bindingReference: b.bindingReference,
        enabledOptionReferences: b.enabledOptionReferences,
        includedSkuReferences: b.includedSkuReferences,
        excludedSkuReferences: b.excludedSkuReferences,
      })),
    });
    const matches = matchRecipeCatalogReferenceGraphs({
      request: recipeRequest,
      targets: [
        graph(pair.current, pair.current.digest),
        ...pair.recorded.configurations.map((configuration) =>
          graph(configuration, "sha256:" + sha256Hex(canonicalizeRfc8785(configuration))),
        ),
      ],
      source: input.recipeSource,
      now: input.now,
    });
    const current = matches[0];
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
      recipeSourceDigest: current.recipeSourceDigest,
      recipeGeneration: current.recipeGeneration,
      recordedCatalogSourceDigest: pair.recorded.digest,
      current,
      recorded,
    };
    // Source observation is kept outside the stable composition digest.
    const stable = (match: typeof current) => {
      const { observedAt, ...facts } = match;
      void observedAt;
      return facts;
    };
    const digestBody = {
      ...body,
      current: stable(current),
      recorded: recorded.map((r) => ({ ...r, matches: stable(r.matches) })),
    };
    const observations = Object.freeze({
      catalogCurrent: pair.current.observedAt,
      catalogHistory: pair.recorded.observedAt,
      recipe: current.observedAt,
    });
    return Object.freeze({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(digestBody)),
      observations,
      observedAt: [
        observations.catalogCurrent,
        observations.catalogHistory,
        observations.recipe,
      ].sort()[0] as string,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
