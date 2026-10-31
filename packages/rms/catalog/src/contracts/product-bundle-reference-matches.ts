import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError } from "./product.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
import { parseProductCurrentReferenceHistoryPair } from "./product-reference-history-source.js";
import { parseBundleReferenceSourceSnapshot } from "./bundle-reference-source.js";
/** Defensive output bound; missing coverage fails rather than truncating a review. */
export const productBundleReferenceMatchMaximumRows = 10000;
/** Direct stored component references across all Bundle versions. Product configuration
 * graphs stay separate; current pointers/status never establish publication use, sale or approval. */
export function matchProductBundleReferences(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly bundleSource: unknown;
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
      source = parseBundleReferenceSourceSnapshot(
        input.bundleSource,
        {
          purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ",
          brandReference: request.brandReference,
          actorReference: request.actorReference,
          operationReference: request.operationReference,
          catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
        },
        input.now,
      );
    const roots = new Map(source.bundles.map((r) => [r.bundleReference, r])),
      versions = new Map(source.versions.map((v) => [v.bundleVersionReference, v])),
      groups = new Map(source.groups.map((g) => [g.groupReference, g]));
    const stored = source.members.map((member) => {
      const bundle = roots.get(member.bundleReference),
        version = versions.get(member.bundleVersionReference),
        group = groups.get(member.groupReference);
      if (!bundle || !version || !group) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({
        bundle,
        version,
        group,
        member,
        isCurrentBundleVersion: bundle.currentVersionReference === version.bundleVersionReference,
      });
    });
    let count = 0;
    function matches(skus: readonly string[]) {
      if (request.skuReference !== null && !skus.includes(request.skuReference))
        return Object.freeze({
          targetMembership: "Absent" as const,
          references: Object.freeze([]) as readonly (typeof stored)[number][],
        });
      const selected = new Set(request.skuReference === null ? skus : [request.skuReference]);
      const references = stored.filter((r) =>
        r.member.sellableType === "Product"
          ? r.member.sellableReference === request.productReference
          : selected.has(r.member.sellableReference),
      );
      count += references.length;
      if (count > productBundleReferenceMatchMaximumRows)
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
      bundlePublicationCoverage: "Unavailable" as const,
      bundleReferenceCoverage: "CompleteStoredGraph" as const,
      publicationCoverage: pair.recorded.publicationCoverage,
      futureScheduleCoverage: pair.recorded.futureScheduleCoverage,
      bundleSourceDigest: source.digest,
      bundleGeneration: source.generation,
      recordedCatalogSourceDigest: pair.recorded.digest,
      current,
      recorded,
    };
    const observations = Object.freeze({
      catalogCurrent: pair.current.observedAt,
      catalogHistory: pair.recorded.observedAt,
      bundle: source.observedAt,
    });
    return Object.freeze({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
      observations,
      observedAt: [
        observations.catalogCurrent,
        observations.catalogHistory,
        observations.bundle,
      ].sort()[0] as string,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
