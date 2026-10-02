import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError } from "./product.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
import { parseProductCurrentReferenceHistoryPair } from "./product-reference-history-source.js";
import {
  parseAvailabilityReferenceSourceSnapshot,
  type AvailabilityStoredRuleReference,
} from "./availability-reference-source.js";
/** Defensive output bound; missing coverage fails rather than truncating a review. */
export const productAvailabilityReferenceMatchMaximumRows = 10000;
/** Direct stored references only. Per-configuration graphs stay separate: neither
 * matching, lifecycle, dates nor Store IDs establish sale applicability or approval. */
export function matchProductAvailabilityReferences(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly availabilitySource: unknown;
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
      source = parseAvailabilityReferenceSourceSnapshot(
        input.availabilitySource,
        {
          purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
          brandReference: request.brandReference,
          actorReference: request.actorReference,
          operationReference: request.operationReference,
          catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
        },
        input.now,
      );
    let count = 0;
    function matches(skus: readonly string[]) {
      if (request.skuReference !== null && !skus.includes(request.skuReference))
        return Object.freeze({
          targetMembership: "Absent" as const,
          references: Object.freeze([]) as readonly AvailabilityStoredRuleReference[],
        });
      const selected = new Set(request.skuReference === null ? skus : [request.skuReference]);
      const references = source.rules.filter((r) =>
        r.sellableType === "Product"
          ? r.sellableReference === request.productReference
          : r.sellableType === "Sku" && selected.has(r.sellableReference),
      );
      count += references.length;
      if (count > productAvailabilityReferenceMatchMaximumRows)
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({
        targetMembership: "Present" as const,
        references: Object.freeze(references),
      });
    }
    const current = Object.freeze({
      catalogSourceDigest: pair.current.digest,
      versionReference: pair.current.versionReference,
      ...matches(pair.current.skuReferences),
    });
    const recorded = Object.freeze(
      pair.recorded.configurations.map((configuration) =>
        Object.freeze({
          configurationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(configuration)),
          configuration,
          ...matches(configuration.skuReferences),
        }),
      ),
    );
    const body = {
      request,
      coverage: "DirectProductSkuStoredReferences" as const,
      applicability: "Unavailable" as const,
      indirectBundleCoverage: "Unavailable" as const,
      publicationCoverage: pair.recorded.publicationCoverage,
      futureScheduleCoverage: pair.recorded.futureScheduleCoverage,
      availabilitySourceDigest: source.digest,
      availabilityGeneration: source.generation,
      recordedCatalogSourceDigest: pair.recorded.digest,
      current,
      recorded,
    };
    const observations = Object.freeze({
      catalogCurrent: pair.current.observedAt,
      catalogHistory: pair.recorded.observedAt,
      availability: source.observedAt,
    });
    return Object.freeze({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
      observations,
      observedAt: [
        observations.catalogCurrent,
        observations.catalogHistory,
        observations.availability,
      ].sort()[0] as string,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
