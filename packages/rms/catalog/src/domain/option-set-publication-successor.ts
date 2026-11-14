import { CatalogError } from "./product.js";
import type { OptionSetAggregate } from "./option-set.js";

/** Pure owning plan. The actual writer must hold authority/validation, prove the
 * new version unused in history, and commit frozen content plus this Draft atomically. */
export function planOptionSetPublicationSuccessor(
  source: OptionSetAggregate,
  publication: Readonly<{
    optionSetReference: string;
    brandReference: string;
    versionReference: string;
    sourceAggregateVersion: number;
    sealedAt: string;
    successorDraftVersionReference: string;
  }>,
): OptionSetAggregate {
  if (
    source.lifecycle !== "Draft" ||
    publication.optionSetReference !== source.optionSetReference ||
    publication.brandReference !== source.brandReference ||
    publication.versionReference !== source.draft.versionReference ||
    publication.sourceAggregateVersion !== source.aggregateVersion ||
    source.aggregateVersion >= 2147483647 ||
    publication.sealedAt < source.updatedAt ||
    publication.sealedAt < source.draft.updatedAt ||
    publication.successorDraftVersionReference === source.draft.versionReference ||
    publication.successorDraftVersionReference === source.optionSetReference ||
    source.draft.options.some(
      (option) => option.optionReference === publication.successorDraftVersionReference,
    )
  )
    throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  return Object.freeze({
    ...source,
    aggregateVersion: source.aggregateVersion + 1,
    updatedAt: publication.sealedAt as OptionSetAggregate["updatedAt"],
    draft: Object.freeze({
      ...source.draft,
      versionReference:
        publication.successorDraftVersionReference as OptionSetAggregate["draft"]["versionReference"],
      createdAt: publication.sealedAt as OptionSetAggregate["draft"]["createdAt"],
      updatedAt: publication.sealedAt as OptionSetAggregate["draft"]["updatedAt"],
    }),
  });
}
