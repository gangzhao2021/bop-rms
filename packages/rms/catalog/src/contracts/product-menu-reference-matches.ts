import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { CatalogError } from "./product.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "./product-lifecycle-review.js";
import { parseProductCurrentReferenceHistoryPair } from "./product-reference-history-source.js";
import {
  parseMenuReferenceSourceSnapshot,
  type MenuPlacementReference,
} from "./menu-reference-source.js";
/** Aggregate expanded Menu result budget: repeated history is refused, never truncated. */
export const productMenuReferenceMatchMaximumRows = 10000;
/** Each placement binds SKU and ProductVersion in one owning Product graph.
 * All stored publication history is reference evidence; sale/approval and complete
 * Product publication/future membership require independent owning sources. */
export function matchProductMenuReferences(input: {
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly menuSource: unknown;
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
      source = parseMenuReferenceSourceSnapshot(
        input.menuSource,
        {
          purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ",
          brandReference: request.brandReference,
          actorReference: request.actorReference,
          operationReference: request.operationReference,
          catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
        },
        input.now,
      );
    const reviews = new Map(source.reviews.map((r) => [r.reviewReference, r])),
      knownVersions = new Set(pair.recorded.configurations.map((c) => c.versionReference)),
      knownSkus = new Set(pair.recorded.configurations.flatMap((c) => c.skuReferences));
    let count = 0;
    function contexts(placements: readonly MenuPlacementReference[]) {
      const selected = new Map<string, MenuPlacementReference[]>();
      for (const p of placements) {
        const list = selected.get(p.reviewReference) ?? [];
        list.push(p);
        selected.set(p.reviewReference, list);
      }
      return Object.freeze(
        [...selected.entries()].map(([reviewReference, items]) => {
          const review = reviews.get(reviewReference);
          if (!review) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          const revisions = Object.freeze(
              source.revisions.filter((r) => r.reviewReference === reviewReference),
            ),
            releases = Object.freeze(
              source.releases.filter((r) => r.reviewReference === reviewReference),
            ),
            releaseIds = new Set(releases.map((r) => r.releaseReference)),
            periods = Object.freeze(
              source.periods.filter((p) => releaseIds.has(p.releaseReference)),
            ),
            latest = revisions.at(-1);
          count += 1 + items.length + revisions.length + releases.length + periods.length;
          if (count > productMenuReferenceMatchMaximumRows)
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          return Object.freeze({
            review,
            placements: Object.freeze(items),
            revisions,
            releases,
            periods,
            lifecycle: latest
              ? Object.freeze({
                  state: latest.state,
                  version: latest.lifecycleVersion,
                  changedAt: latest.changedAt,
                })
              : null,
          });
        }),
      );
    }
    function matches(versionReference: string, skus: readonly string[]) {
      if (request.skuReference !== null && !skus.includes(request.skuReference))
        return Object.freeze({ targetMembership: "Absent" as const, references: contexts([]) });
      const selected = new Set(request.skuReference === null ? skus : [request.skuReference]);
      return Object.freeze({
        targetMembership: "Present" as const,
        references: contexts(
          source.placements.filter(
            (p) => p.productVersionReference === versionReference && selected.has(p.skuReference),
          ),
        ),
      });
    }
    const unresolved = contexts(
      source.placements.filter((p) => {
        const related =
          request.skuReference === null
            ? knownSkus.has(p.skuReference) || knownVersions.has(p.productVersionReference)
            : p.skuReference === request.skuReference;
        return (
          related &&
          !pair.recorded.configurations.some(
            (c) =>
              c.versionReference === p.productVersionReference &&
              c.skuReferences.includes(p.skuReference),
          )
        );
      }),
    );
    const current = Object.freeze({
        catalogSourceDigest: pair.current.digest,
        versionReference: pair.current.versionReference,
        ...matches(pair.current.versionReference, pair.current.skuReferences),
      }),
      recorded = Object.freeze(
        pair.recorded.configurations.map((configuration) =>
          Object.freeze({
            configurationDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(configuration)),
            configuration,
            ...matches(configuration.versionReference, configuration.skuReferences),
          }),
        ),
      );
    const body = {
      request,
      coverage: "KnownCurrentAndRecordedDraftGraphs" as const,
      menuReferenceCoverage: "CompleteStoredGraph" as const,
      applicability: "Unavailable" as const,
      publicationCoverage: pair.recorded.publicationCoverage,
      futureScheduleCoverage: pair.recorded.futureScheduleCoverage,
      menuSourceDigest: source.digest,
      menuGeneration: source.generation,
      recordedCatalogSourceDigest: pair.recorded.digest,
      current,
      recorded,
      unresolved,
    };
    const observations = Object.freeze({
      catalogCurrent: pair.current.observedAt,
      catalogHistory: pair.recorded.observedAt,
      menu: source.observedAt,
    });
    return Object.freeze({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
      observations,
      observedAt: [
        observations.catalogCurrent,
        observations.catalogHistory,
        observations.menu,
      ].sort()[0] as string,
    });
  } catch {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  }
}
