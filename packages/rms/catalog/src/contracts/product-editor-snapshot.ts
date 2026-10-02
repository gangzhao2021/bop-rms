import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseProductAggregate,
} from "./product.js";
import { parseProductPublicationSourceRequest } from "./product-publication-source.js";
import { deriveCatalogProductPublicationContentIdentity } from "./product-publication-content.js";
import { productValidationCandidateFields } from "./product-validation-candidate.js";

export const productEditorSnapshotFields = productValidationCandidateFields;
export const productEditorSnapshotMaximumBytes = 8 * 1024 * 1024;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function bound(value: unknown) {
  if (
    new TextEncoder().encode(canonicalizeRfc8785(value)).length > productEditorSnapshotMaximumBytes
  )
    return fail();
}
/** Structural envelope only. The current owner and held field/purpose authority
 * establish its provenance; this value grants no reference or publication right. */
export function buildCatalogProductEditorSnapshot(
  value: unknown,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  request: unknown,
  observation: unknown,
) {
  const query = parseProductPublicationSourceRequest(request),
    aggregate = parseProductAggregate(copyCategoryPersistenceValue(value)),
    tenantReference = parseCatalogReference(scope.tenantReference),
    brandReference = parseCatalogReference(scope.brandReference),
    observedAt = parseCatalogInstant(observation),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  if (
    aggregate.brandReference !== brandReference ||
    aggregate.productReference !== query.productReference ||
    aggregate.aggregateVersion !== query.expectedAggregateVersion ||
    aggregate.updatedAt > observedAt ||
    aggregate.draft.updatedAt > observedAt
  )
    return fail();
  const body = Object.freeze({
    profile: "CatalogProductEditorSnapshotV1" as const,
    tenantReference,
    brandReference,
    productReference: aggregate.productReference,
    aggregateVersion: aggregate.aggregateVersion,
    aggregate,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    contentStatus:
      aggregate.draft.editorContent === undefined ? ("Unavailable" as const) : ("Present" as const),
    observedAt,
    validUntil: parseCatalogInstant(new Date(Date.parse(observedAt) + 5000).toISOString()),
    referenceEligibility: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  });
  const result = Object.freeze({
    ...body,
    digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
  });
  bound(result);
  return result;
}
export type CatalogProductEditorSnapshot = ReturnType<typeof buildCatalogProductEditorSnapshot>;
export function parseCatalogProductEditorSnapshot(value: unknown): CatalogProductEditorSnapshot {
  try {
    const r = copyCategoryPersistenceValue(value);
    const keys = [
      "profile",
      "tenantReference",
      "brandReference",
      "productReference",
      "aggregateVersion",
      "aggregate",
      "contentDigest",
      "configurationDigest",
      "contentStatus",
      "observedAt",
      "validUntil",
      "referenceEligibility",
      "publishValidation",
      "eligibility",
      "digest",
    ];
    if (
      !r ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(r, key))
    )
      return fail();
    const raw = r as Record<string, unknown>,
      result = buildCatalogProductEditorSnapshot(
        raw.aggregate,
        {
          tenantReference: parseCatalogReference(raw.tenantReference),
          brandReference: parseCatalogReference(raw.brandReference),
        },
        { productReference: raw.productReference, expectedAggregateVersion: raw.aggregateVersion },
        raw.observedAt,
      );
    if (canonicalizeRfc8785(result) !== canonicalizeRfc8785(raw)) return fail();
    return result;
  } catch {
    return fail();
  }
}
