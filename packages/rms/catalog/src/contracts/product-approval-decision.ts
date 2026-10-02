import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  parseProductPublicationApproval,
} from "./product-publication.js";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
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
export const productApprovalReviewFields = Object.freeze([
  "review",
  "requestingActor",
  "contentIdentity",
  "policyIdentity",
  "currentRoot",
] as const);
/** Pure tuple binding; actual owner must establish current SQL provenance first. */
export function bindCatalogProductReviewForApproval(
  commandValue: unknown,
  reviewValue: unknown,
  observedAtValue: unknown,
) {
  const c = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue)),
    review = parseProductPublicationVersion(copyCategoryPersistenceValue(reviewValue)),
    observedAt = parseCatalogInstant(observedAtValue);
  if (
    c.action !== "Approve" ||
    c.actorKind !== "User" ||
    c.occurredAt > observedAt ||
    review.state !== "InReview" ||
    review.approvalPolicy !== "Required" ||
    review.validationDecision !== "Pass" ||
    review.tenantReference !== c.tenantReference ||
    review.brandReference !== c.brandReference ||
    review.productReference !== c.productReference ||
    review.versionReference !== c.versionReference ||
    review.publicationVersion !== c.expectedPublicationVersion ||
    review.productAggregateVersion + 1 !== c.expectedProductAggregateVersion ||
    review.reviewVersion !== review.publicationVersion ||
    review.reviewReference === null ||
    review.submittedByActorReference === null ||
    review.actorReference !== review.submittedByActorReference ||
    review.submittedByActorReference === c.actorReference ||
    review.occurredAt > observedAt ||
    review.contentDigest !== c.contentDigest ||
    review.configurationDigest !== c.configurationDigest ||
    review.scopeDigest !== hash(c.scopeSet) ||
    review.periodDigest !== hash(c.effectivePeriod)
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductApprovalReviewV1" as const,
    review,
    observedAggregateVersion: c.expectedProductAggregateVersion,
    commandIntentDigest: hash(c),
    observedAt,
    validUntil: parseCatalogInstant(new Date(Date.parse(observedAt) + 30000).toISOString()),
  });
}
/** This operational ceiling is explicit server configuration, never a client fact. */
export function parseCatalogApprovalValiditySeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 86400)
    return fail();
  return value as number;
}
/** Only an authorized owning Approve may persist this decision. Supplied values
 * and a pure builder confer no authority or complete current validation. */
export function createCatalogProductApprovalDecision(
  commandValue: unknown,
  reviewValue: unknown,
  policyValue: unknown,
  nowValue: unknown,
  maximumValiditySecondsValue: unknown,
) {
  const r = closed(reviewValue, [
      "profile",
      "review",
      "observedAggregateVersion",
      "commandIntentDigest",
      "observedAt",
      "validUntil",
    ]),
    p = closed(policyValue, ["content", "currentPublicationReference", "observedAt", "validUntil"]),
    c = parseProductPublicationCommand(copyCategoryPersistenceValue(commandValue)),
    now = parseCatalogInstant(nowValue),
    review = bindCatalogProductReviewForApproval(c, r.review, r.observedAt),
    content = parsePublishingProductPublicationPolicy(p.content),
    policyUntil = parseCatalogInstant(p.validUntil),
    policyPublicationReference = parseCatalogReference(p.currentPublicationReference),
    maximumValiditySeconds = parseCatalogApprovalValiditySeconds(maximumValiditySecondsValue);
  if (
    r.profile !== review.profile ||
    r.observedAggregateVersion !== review.observedAggregateVersion ||
    r.commandIntentDigest !== review.commandIntentDigest ||
    r.validUntil !== review.validUntil ||
    p.observedAt !== review.observedAt ||
    now < review.observedAt ||
    now >= review.validUntil ||
    now >= policyUntil ||
    policyUntil > new Date(Date.parse(review.observedAt) + 30000).toISOString() ||
    parseCatalogReference(content.tenantReference) !== c.tenantReference ||
    parseCatalogReference(content.brandReference) !== c.brandReference ||
    parseCatalogReference(content.policyReference) !== review.review.policyReference ||
    content.policyVersion !== review.review.policyVersion ||
    content.approvalPolicy !== "Required" ||
    parseCatalogInstant(content.effectiveFrom) > review.observedAt ||
    (content.effectiveUntil !== null && policyUntil > parseCatalogInstant(content.effectiveUntil))
  )
    return fail();
  const ceiling = parseCatalogInstant(
      new Date(Date.parse(now) + maximumValiditySeconds * 1000).toISOString(),
    ),
    originalUntil =
      content.effectiveUntil !== null && parseCatalogInstant(content.effectiveUntil) < ceiling
        ? parseCatalogInstant(content.effectiveUntil)
        : ceiling;
  const approval = parseProductPublicationApproval({
    evidenceReference: c.operationReference,
    reviewReference: review.review.reviewReference,
    reviewVersion: review.review.reviewVersion,
    requestedByActorReference: review.review.submittedByActorReference,
    approvedByActorReference: c.actorReference,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: review.review.scopeDigest,
    periodDigest: review.review.periodDigest,
    policyReference: review.review.policyReference,
    policyVersion: review.review.policyVersion,
    approvedAt: now,
    validUntil: originalUntil,
  });
  return Object.freeze({
    approval,
    policyPublicationReference,
    observedAt: review.observedAt,
    validUntil: [review.validUntil, policyUntil, originalUntil].sort()[0] ?? fail(),
    validation: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  });
}
