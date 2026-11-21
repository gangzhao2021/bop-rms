import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  parseProductPublicationVersion,
  productPublicationActions,
  type ProductPublicationVersion,
  type ProductPublicationAction,
} from "./product-publication.js";
import {
  parseCatalogProductPublicationContent,
  deriveCatalogProductPublicationContentIdentity,
} from "./product-publication-content.js";
import type { RecordedProductReferenceConfiguration } from "./product-reference-history-source.js";
export const productPublicationSourceFields = Object.freeze([
  "productReference",
  "aggregateVersion",
  "publicationHistory",
  "scopeSet",
  "effectivePeriod",
  "schedule",
  "referenceConfiguration",
  "publicationContentIdentity",
] as const);
export interface ProductPublicationSourceRequest {
  readonly productReference: string;
  readonly expectedAggregateVersion: number;
}
export interface ProductPublicationSourceSnapshot {
  readonly profile: "CatalogProductPublicationSourceV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly productReference: string;
  readonly aggregateVersion: number;
  readonly observedAt: string;
  readonly coverage: "Complete";
  readonly eligibility: "NotEvaluated";
  readonly history: readonly {
    readonly action: ProductPublicationAction;
    readonly publication: ProductPublicationVersion;
    readonly configuration: RecordedProductReferenceConfiguration;
  }[];
  readonly latest: readonly ProductPublicationVersion[];
  readonly digest: string;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function record(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    return fail();
  return v as Record<string, unknown>;
}
export function parseProductPublicationSourceRequest(
  value: unknown,
): ProductPublicationSourceRequest {
  const r = record(copyCategoryPersistenceValue(value), [
    "productReference",
    "expectedAggregateVersion",
  ]);
  if (
    !Number.isSafeInteger(r.expectedAggregateVersion) ||
    (r.expectedAggregateVersion as number) < 1 ||
    (r.expectedAggregateVersion as number) > 2147483647
  )
    return fail();
  return Object.freeze({
    productReference: parseCatalogReference(r.productReference),
    expectedAggregateVersion: r.expectedAggregateVersion as number,
  });
}
/** Owning SQL checks commit/operation links; the closed builder additionally checks
 * immutable snapshots and digests. Complete recorded coverage is not sale,
 * validation, approval, scheduling authority or current topology eligibility. */
export function buildProductPublicationSourceSnapshot(
  value: unknown,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  input: ProductPublicationSourceRequest,
  now: string,
): ProductPublicationSourceSnapshot {
  try {
    const request = parseProductPublicationSourceRequest(input),
      tenantReference = parseCatalogReference(scope.tenantReference),
      brandReference = parseCatalogReference(scope.brandReference);
    const raw = record(copyCategoryPersistenceValue(value), [
        "aggregateVersion",
        "observedAt",
        "revisions",
      ]),
      observedAt = parseCatalogInstant(raw.observedAt),
      at = parseCatalogInstant(now);
    if (
      raw.aggregateVersion !== request.expectedAggregateVersion ||
      observedAt > at ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      !Array.isArray(raw.revisions) ||
      raw.revisions.length > 1000
    )
      return fail();
    const ids = new Set<string>(),
      latest = new Map<string, ProductPublicationVersion>();
    const parsed = raw.revisions.map((v) => {
      const r = record(v, [
        "action",
        "publication",
        "aggregate",
        "content",
        "coherent",
        "snapshotDigest",
      ]);
      if (
        r.coherent !== true ||
        !productPublicationActions.includes(r.action as ProductPublicationAction)
      )
        return fail();
      const publication = parseProductPublicationVersion(r.publication),
        aggregate = parseProductAggregate(r.aggregate);
      if (
        r.snapshotDigest !== "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate)) ||
        publication.tenantReference !== tenantReference ||
        publication.brandReference !== brandReference ||
        publication.productReference !== request.productReference ||
        aggregate.brandReference !== brandReference ||
        aggregate.productReference !== request.productReference ||
        aggregate.aggregateVersion !== publication.productAggregateVersion + 1 ||
        aggregate.aggregateVersion > request.expectedAggregateVersion ||
        aggregate.updatedAt !== publication.occurredAt ||
        publication.occurredAt > observedAt ||
        ids.has(publication.operationReference)
      )
        return fail();
      ids.add(publication.operationReference);
      const old = latest.get(publication.versionReference);
      if (
        (old &&
          (publication.publicationVersion !== old.publicationVersion + 1 ||
            publication.productAggregateVersion <= old.productAggregateVersion ||
            publication.occurredAt < old.occurredAt)) ||
        (!old && publication.publicationVersion !== 1)
      )
        return fail();
      latest.set(publication.versionReference, publication);
      return { r, publication, aggregate };
    });
    const history = Object.freeze(
      parsed.map(({ r, publication, aggregate }) => {
        let configuration: RecordedProductReferenceConfiguration;
        if (publication.state === "Published" || publication.state === "Superseded") {
          if (r.content === null) return fail();
          const content = parseCatalogProductPublicationContent(r.content);
          const committed = parsed.find(
            (p) => p.publication.operationReference === content.publicationOperationReference,
          );
          if (
            content.tenantReference !== tenantReference ||
            content.brandReference !== brandReference ||
            content.productReference !== request.productReference ||
            content.versionReference !== publication.versionReference ||
            content.contentDigest !== publication.contentDigest ||
            content.configurationDigest !== publication.configurationDigest ||
            !committed ||
            committed.publication.state !== "Published" ||
            committed.publication.productAggregateVersion !== content.sourceAggregateVersion ||
            committed.publication.publishedAt !== content.sealedAt ||
            committed.publication.versionReference !== content.versionReference
          )
            return fail();
          configuration = content.referenceConfiguration;
        } else {
          const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
          if (
            aggregate.draft.versionReference !== publication.versionReference ||
            identity.contentDigest !== publication.contentDigest ||
            identity.configurationDigest !== publication.configurationDigest
          )
            return fail();
          configuration = identity.referenceConfiguration;
        }
        return Object.freeze({
          action: r.action as ProductPublicationAction,
          publication,
          configuration,
        });
      }),
    );
    const content = {
      profile: "CatalogProductPublicationSourceV1" as const,
      tenantReference,
      brandReference,
      productReference: request.productReference,
      aggregateVersion: request.expectedAggregateVersion,
      observedAt,
      coverage: "Complete" as const,
      eligibility: "NotEvaluated" as const,
      history,
      latest: Object.freeze(
        [...latest.values()].sort((a, b) => a.versionReference.localeCompare(b.versionReference)),
      ),
    };
    return Object.freeze({
      ...content,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
    });
  } catch {
    return fail();
  }
}
