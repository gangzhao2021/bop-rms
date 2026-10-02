import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import {
  parseCatalogProductApprovalReceipt,
  parseCatalogProductApprovalRequest,
} from "./product-approval-receipt.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function closed(value: unknown, keys: readonly string[]) {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(r, k))
  )
    return fail();
  return r as Record<string, unknown>;
}
/** Pure binding only. Both current owning sources and permissions must be held
 * around this rule; supplied observations do not confer current authority. */
export function bindCatalogProductApprovalToCurrentPolicy(
  approvalValue: unknown,
  policyValue: unknown,
  requestValue: unknown,
  nowValue: unknown,
) {
  const r = closed(approvalValue, [
      "receipt",
      "observedAggregateVersion",
      "currentPublicationVersion",
      "observationIntentDigest",
      "observedAt",
      "validUntil",
      "currentPolicy",
      "eligibility",
    ]),
    p = closed(policyValue, ["content", "currentPublicationReference", "observedAt", "validUntil"]),
    request = parseCatalogProductApprovalRequest(requestValue),
    receipt = parseCatalogProductApprovalReceipt(r.receipt),
    content = parsePublishingProductPublicationPolicy(p.content),
    policyPublicationReference = parseCatalogReference(p.currentPublicationReference),
    now = parseCatalogInstant(nowValue),
    approvalUntil = parseCatalogInstant(r.validUntil),
    policyUntil = parseCatalogInstant(p.validUntil),
    a = receipt.approval;
  if (
    r.currentPolicy !== "NotEvaluated" ||
    r.eligibility !== "NotEvaluated" ||
    r.observedAggregateVersion !== request.expectedAggregateVersion ||
    r.currentPublicationVersion !== request.expectedPublicationVersion ||
    r.observationIntentDigest !== request.originalIntentDigest ||
    r.observedAt !== request.observedAt ||
    p.observedAt !== request.observedAt ||
    receipt.productReference !== request.productReference ||
    receipt.versionReference !== request.versionReference ||
    parseCatalogReference(content.tenantReference) !== receipt.tenantReference ||
    parseCatalogReference(content.brandReference) !== receipt.brandReference ||
    parseCatalogReference(content.policyReference) !== request.policyReference ||
    content.policyVersion !== request.policyVersion ||
    content.approvalPolicy !== "Required" ||
    a.policyReference !== request.policyReference ||
    a.policyVersion !== request.policyVersion ||
    a.contentDigest !== request.contentDigest ||
    a.configurationDigest !== request.configurationDigest ||
    a.scopeDigest !== request.scopeDigest ||
    a.periodDigest !== request.periodDigest ||
    approvalUntil > request.validUntil ||
    approvalUntil > a.validUntil ||
    policyUntil > new Date(Date.parse(request.observedAt) + 30000).toISOString() ||
    parseCatalogInstant(content.effectiveFrom) > request.observedAt ||
    (content.effectiveUntil !== null &&
      policyUntil > parseCatalogInstant(content.effectiveUntil)) ||
    a.approvedAt > now ||
    now < request.observedAt ||
    approvalUntil <= now ||
    policyUntil <= now
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductApprovalPolicyObservationV1" as const,
    receipt,
    observedAggregateVersion: request.expectedAggregateVersion,
    currentPublicationVersion: request.expectedPublicationVersion,
    observationIntentDigest: request.originalIntentDigest,
    observedAt: request.observedAt,
    validUntil: approvalUntil < policyUntil ? approvalUntil : policyUntil,
    currentPolicy: Object.freeze({
      policyReference: request.policyReference,
      policyVersion: request.policyVersion,
      publicationReference: policyPublicationReference,
      contentDigest: publishingProductPublicationPolicyDigest(content),
      approvalPolicy: "Required" as const,
    }),
    validation: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  });
}
export type CatalogProductApprovalPolicyObservation = ReturnType<
  typeof bindCatalogProductApprovalToCurrentPolicy
>;
