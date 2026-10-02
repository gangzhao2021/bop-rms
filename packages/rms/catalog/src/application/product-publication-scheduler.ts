import { CatalogError, parseCatalogReference } from "../contracts/product.js";
import { copyCategoryPersistenceValue } from "../contracts/category-persistence.js";
import {
  parseProductPublicationVersion,
  type ProductPublicationCommand,
  type ProductPublicationVersion,
} from "../contracts/product-publication.js";
import type { ProductPublicationWriteResult } from "../infrastructure/persistence/product-publication-store.js";

export interface DueProductPublicationCandidate {
  readonly publication: ProductPublicationVersion;
  readonly expectedAggregateVersion: number;
}
/** Discovery is a locator. The real owning writer repeats current System
 * authority, source/policy/approval validation, expected versions and atomic
 * content/successor/Audit/Outbox. Stable IDs are supplied by trusted runtime
 * composition for the exact schedule reference/version; never random per retry. */
export function createProductPublicationScheduledActivator(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly systemActorReference: string;
  readonly references: {
    operation(candidate: DueProductPublicationCandidate): string;
    successorDraft(candidate: DueProductPublicationCandidate): string;
  };
  readonly writer: {
    execute(command: ProductPublicationCommand): Promise<ProductPublicationWriteResult>;
  };
}) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.systemActorReference);
  return Object.freeze({
    async activate(value: unknown): Promise<"Applied" | "Replayed"> {
      const raw = copyCategoryPersistenceValue(value) as Record<string, unknown>;
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        Object.keys(raw).length !== 2 ||
        !Object.hasOwn(raw, "publication") ||
        !Object.hasOwn(raw, "expectedAggregateVersion")
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const p = parseProductPublicationVersion(raw.publication);
      if (
        p.tenantReference !== tenant ||
        p.brandReference !== brand ||
        p.state !== "Scheduled" ||
        p.scheduleReference === null ||
        !Number.isInteger(raw.expectedAggregateVersion) ||
        (raw.expectedAggregateVersion as number) < p.productAggregateVersion + 1 ||
        (raw.expectedAggregateVersion as number) >= 2147483647
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      const candidate = Object.freeze({
        publication: p,
        expectedAggregateVersion: raw.expectedAggregateVersion as number,
      });
      const operationReference = parseCatalogReference(options.references.operation(candidate)),
        successorDraftVersionReference = parseCatalogReference(
          options.references.successorDraft(candidate),
        );
      const result = await options.writer.execute(
        Object.freeze({
          purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
          tenantReference: tenant,
          brandReference: brand,
          actorReference: actor,
          actorKind: "System",
          operationReference,
          productReference: p.productReference,
          versionReference: p.versionReference,
          expectedProductAggregateVersion: candidate.expectedAggregateVersion,
          expectedPublicationVersion: p.publicationVersion,
          action: "ActivateScheduled",
          contentDigest: p.contentDigest,
          configurationDigest: p.configurationDigest,
          scopeSet: p.scopeSet,
          effectivePeriod: p.effectivePeriod,
          scheduleReference: p.scheduleReference,
          replacementVersionReference: null,
          successorDraftVersionReference,
          occurredAt: p.effectivePeriod.effectiveFrom.instant,
          reasonCode: "SCHEDULE_DUE",
        }),
      );
      if (
        (result.status !== "Applied" && result.status !== "Replayed") ||
        result.publication.state !== "Published" ||
        result.publication.operationReference !== operationReference ||
        result.publication.versionReference !== p.versionReference ||
        result.publication.scheduleReference !== p.scheduleReference ||
        result.publication.scheduleVersion !== p.scheduleVersion + 1 ||
        result.aggregate.aggregateVersion !== candidate.expectedAggregateVersion + 1 ||
        result.publication.successorDraftVersionReference !== successorDraftVersionReference ||
        result.content === null
      )
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return result.status;
    },
  });
}
