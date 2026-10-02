import { CatalogError, type ProductAggregate } from "./product.js";
import type { ProductPublicationVersion } from "./product-publication.js";
/** Owning application commits the frozen source and successor atomically. This
 * plan does not move relational SKU identities or claim publication eligibility. */
export function planProductPublicationSuccessor(
  source: ProductAggregate,
  publication: ProductPublicationVersion,
): ProductAggregate {
  if (
    publication.state !== "Published" ||
    publication.productReference !== source.productReference ||
    publication.brandReference !== source.brandReference ||
    publication.versionReference !== source.draft.versionReference ||
    publication.productAggregateVersion !== source.aggregateVersion ||
    publication.publishedAt === null ||
    publication.publishedAt < source.updatedAt ||
    publication.publishedAt < source.draft.updatedAt ||
    publication.successorDraftVersionReference === null ||
    publication.successorDraftVersionReference === source.draft.versionReference ||
    publication.successorDraftVersionReference === source.draft.baseVersionReference ||
    source.aggregateVersion >= 2147483647
  )
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  // Reference branding and structural validation remain in the public contract.
  return Object.freeze({
    ...source,
    aggregateVersion: source.aggregateVersion + 1,
    updatedAt: publication.publishedAt as ProductAggregate["updatedAt"],
    draft: Object.freeze({
      ...source.draft,
      versionReference:
        publication.successorDraftVersionReference as ProductAggregate["draft"]["versionReference"],
      baseVersionReference: source.draft.versionReference,
      createdAt: publication.publishedAt as ProductAggregate["draft"]["createdAt"],
      updatedAt: publication.publishedAt as ProductAggregate["draft"]["updatedAt"],
    }),
  });
}
