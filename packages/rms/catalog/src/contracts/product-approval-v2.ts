import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import {
  parseCatalogApprovalValiditySeconds,
  productApprovalReviewFields,
} from "./product-approval-decision.js";
import {
  parseCatalogProductApprovalReceipt,
  buildCatalogProductApprovalReceipt,
  parseCatalogProductApprovalRequest,
  productApprovalSourceFields,
} from "./product-approval-receipt.js";
import { bindCatalogProductApprovalToCurrentPolicy } from "./product-approval-policy.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
  parseProductPublicationApprovalV2,
} from "./product-publication-v2.js";

export { parseCatalogApprovalValiditySeconds as parseCatalogApprovalValiditySecondsV2 } from "./product-approval-decision.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const digest = (value: unknown): string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value : fail();
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const r = copyCategoryPersistenceValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
/** Private projection only for unchanged receipt/request/policy tuple rules.
 * Pending reviews never enter V1 parsers or binders. */
function base(value: object) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
    ),
  );
}
const reviewFields = [
  "profile",
  "review",
  "observedAggregateVersion",
  "commandIntentDigest",
  "replacementIntentDigest",
  "observedAt",
  "validUntil",
] as const;
const receiptFields = [
  "profile",
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "approvalOperationReference",
  "originalIntentDigest",
  "approvalPublicationVersion",
  "resultAggregateVersion",
  "recordedAt",
  "approval",
  "replacementIntentDigest",
  "digest",
] as const;
const requestFields = [
  "profile",
  "productReference",
  "versionReference",
  "expectedAggregateVersion",
  "expectedPublicationVersion",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "policyReference",
  "policyVersion",
  "originalIntentDigest",
  "replacementIntentDigest",
  "observedAt",
  "validUntil",
] as const;
const observationFields = [
  "receipt",
  "observedAggregateVersion",
  "currentPublicationVersion",
  "observationIntentDigest",
  "replacementIntentDigest",
  "observedAt",
  "validUntil",
  "currentPolicy",
  "eligibility",
] as const;

export const productApprovalReviewFieldsV2 = Object.freeze([
  ...productApprovalReviewFields,
  "replacementIntent",
  "replacementIntentDigest",
] as const);
export const productApprovalSourceFieldsV2 = Object.freeze([
  ...productApprovalSourceFields,
  "replacementIntent",
  "replacementIntentDigest",
] as const);

/** Pure consistency binding. Actual current SQL provenance and independent
 * Actor/field/purpose authority must be held by the owning application. */
export function bindCatalogProductReviewForApprovalV2(
  commandValue: unknown,
  reviewValue: unknown,
  observedAtValue: unknown,
) {
  const command = parseProductPublicationCommandV2(commandValue),
    review = parseProductPublicationVersionV2(reviewValue),
    observedAt = parseCatalogInstant(observedAtValue);
  if (
    command.action !== "Approve" ||
    command.actorKind !== "User" ||
    command.occurredAt > observedAt ||
    command.occurredAt < review.occurredAt ||
    command.operationReference === review.operationReference ||
    review.state !== "InReview" ||
    review.actorKind !== "User" ||
    review.approvalPolicy !== "Required" ||
    !["ApprovalPending", "Pass"].includes(review.validationDecision) ||
    review.approvalEvidenceReference !== null ||
    review.tenantReference !== command.tenantReference ||
    review.brandReference !== command.brandReference ||
    review.productReference !== command.productReference ||
    review.versionReference !== command.versionReference ||
    review.publicationVersion !== command.expectedPublicationVersion ||
    review.productAggregateVersion + 1 !== command.expectedProductAggregateVersion ||
    review.reviewVersion !== review.publicationVersion ||
    review.reviewReference === null ||
    review.submittedByActorReference === null ||
    review.actorReference !== review.submittedByActorReference ||
    review.submittedByActorReference === command.actorReference ||
    review.occurredAt > observedAt ||
    review.contentDigest !== command.contentDigest ||
    review.configurationDigest !== command.configurationDigest ||
    review.scopeDigest !== hash(command.scopeSet) ||
    review.periodDigest !== hash(command.effectivePeriod) ||
    review.replacementIntentDigest !== command.replacementIntentDigest
  )
    return fail();
  return Object.freeze({
    profile: "CatalogProductApprovalReviewV2" as const,
    review,
    observedAggregateVersion: command.expectedProductAggregateVersion,
    commandIntentDigest: hash(command),
    replacementIntentDigest: command.replacementIntentDigest,
    observedAt,
    validUntil: parseCatalogInstant(new Date(Date.parse(observedAt) + 30000).toISOString()),
  });
}
export type CatalogProductApprovalReviewV2 = ReturnType<
  typeof bindCatalogProductReviewForApprovalV2
>;

/** Only actual owning Approve may record this decision. No supplied policy or
 * parsed review creates current authority, validation or replacement eligibility. */
export function createCatalogProductApprovalDecisionV2(
  commandValue: unknown,
  reviewValue: unknown,
  policyValue: unknown,
  nowValue: unknown,
  maximumValiditySecondsValue: unknown,
) {
  const command = parseProductPublicationCommandV2(commandValue),
    r = closed(reviewValue, reviewFields),
    review = bindCatalogProductReviewForApprovalV2(command, r.review, r.observedAt),
    p = closed(policyValue, ["content", "currentPublicationReference", "observedAt", "validUntil"]),
    now = parseCatalogInstant(nowValue),
    content = parsePublishingProductPublicationPolicy(p.content),
    policyUntil = parseCatalogInstant(p.validUntil),
    policyPublicationReference = parseCatalogReference(p.currentPublicationReference),
    maximumValiditySeconds = parseCatalogApprovalValiditySeconds(maximumValiditySecondsValue);
  if (
    canonicalizeRfc8785(r) !== canonicalizeRfc8785(review) ||
    p.observedAt !== review.observedAt ||
    now < review.observedAt ||
    now >= review.validUntil ||
    now >= policyUntil ||
    policyUntil > new Date(Date.parse(review.observedAt) + 30000).toISOString() ||
    parseCatalogReference(content.tenantReference) !== command.tenantReference ||
    parseCatalogReference(content.brandReference) !== command.brandReference ||
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
        : ceiling,
    approval = parseProductPublicationApprovalV2({
      profile: "CatalogProductPublicationApprovalV2",
      replacementIntentDigest: command.replacementIntentDigest,
      evidenceReference: command.operationReference,
      reviewReference: review.review.reviewReference,
      reviewVersion: review.review.reviewVersion,
      requestedByActorReference: review.review.submittedByActorReference,
      approvedByActorReference: command.actorReference,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
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
    replacementIntentDigest: command.replacementIntentDigest,
  });
}
export type CatalogProductApprovalDecisionV2 = ReturnType<
  typeof createCatalogProductApprovalDecisionV2
>;

export function parseCatalogProductApprovalReceiptV2(value: unknown) {
  const r = closed(value, receiptFields);
  if (r.profile !== "CatalogProductApprovalReceiptV2") return fail();
  const approval = parseProductPublicationApprovalV2(r.approval),
    replacementIntentDigest = digest(r.replacementIntentDigest);
  if (approval.replacementIntentDigest !== replacementIntentDigest) return fail();
  const projectedBody = {
    ...base(Object.fromEntries(Object.entries(r).filter(([key]) => key !== "digest"))),
    profile: "CatalogProductApprovalReceiptV1",
    approval: base(approval),
  };
  const parsed = parseCatalogProductApprovalReceipt({
    ...projectedBody,
    digest: hash(projectedBody),
  });
  const body = {
    profile: "CatalogProductApprovalReceiptV2" as const,
    tenantReference: parsed.tenantReference,
    brandReference: parsed.brandReference,
    productReference: parsed.productReference,
    versionReference: parsed.versionReference,
    approvalOperationReference: parsed.approvalOperationReference,
    originalIntentDigest: parsed.originalIntentDigest,
    approvalPublicationVersion: parsed.approvalPublicationVersion,
    resultAggregateVersion: parsed.resultAggregateVersion,
    recordedAt: parsed.recordedAt,
    approval,
    replacementIntentDigest,
  };
  if (
    approval.evidenceReference !== body.approvalOperationReference ||
    approval.approvedAt > body.recordedAt ||
    body.approvalPublicationVersion !== approval.reviewVersion + 1 ||
    r.digest !== hash(body) ||
    new TextEncoder().encode(canonicalizeRfc8785(body)).length > 65536
  )
    return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
export type CatalogProductApprovalReceiptV2 = ReturnType<
  typeof parseCatalogProductApprovalReceiptV2
>;

/** Receipts belong only to the actual independent Approve operation. A changed
 * timing review for a direct Required Reschedule needs its own owning provenance. */
export function buildCatalogProductApprovalReceiptV2(
  publicationValue: unknown,
  approvalValue: unknown,
) {
  const p = parseProductPublicationVersionV2(publicationValue),
    approval = parseProductPublicationApprovalV2(approvalValue);
  if (
    p.validationDecision !== "Pass" ||
    p.replacementIntentDigest !== approval.replacementIntentDigest
  )
    return fail();
  const receipt = buildCatalogProductApprovalReceipt(base(p), base(approval)),
    body = {
      ...Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "digest")),
      profile: "CatalogProductApprovalReceiptV2",
      approval,
      replacementIntentDigest: p.replacementIntentDigest,
    };
  return parseCatalogProductApprovalReceiptV2({ ...body, digest: hash(body) });
}

export function parseCatalogProductApprovalRequestV2(value: unknown) {
  const r = closed(value, requestFields);
  if (r.profile !== "CatalogProductApprovalRequestV2") return fail();
  return Object.freeze({
    ...parseCatalogProductApprovalRequest(base(r)),
    profile: "CatalogProductApprovalRequestV2" as const,
    replacementIntentDigest: digest(r.replacementIntentDigest),
  });
}
export type CatalogProductApprovalRequestV2 = ReturnType<
  typeof parseCatalogProductApprovalRequestV2
>;

function receiptBase(receipt: CatalogProductApprovalReceiptV2) {
  const body = {
    ...base(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "digest"))),
    profile: "CatalogProductApprovalReceiptV1",
    approval: base(receipt.approval),
  };
  return parseCatalogProductApprovalReceipt({ ...body, digest: hash(body) });
}

/** Current owning sources must prove the original Approve/SubmitReview chain.
 * No changed period or target can inherit that original approval receipt. */
export function bindCatalogProductApprovalReceiptV2(
  receiptValue: unknown,
  approvedValue: unknown,
  reviewValue: unknown,
  currentValue: unknown,
  requestValue: unknown,
  nowValue: unknown,
) {
  const receipt = parseCatalogProductApprovalReceiptV2(receiptValue),
    approved = parseProductPublicationVersionV2(approvedValue),
    review = parseProductPublicationVersionV2(reviewValue),
    current = parseProductPublicationVersionV2(currentValue),
    request = parseCatalogProductApprovalRequestV2(requestValue),
    now = parseCatalogInstant(nowValue),
    approval = receipt.approval;
  if (
    receipt.replacementIntentDigest !== request.replacementIntentDigest ||
    [approved, review, current].some(
      (p) => p.replacementIntentDigest !== request.replacementIntentDigest,
    ) ||
    canonicalizeRfc8785(buildCatalogProductApprovalReceiptV2(approved, receipt.approval)) !==
      canonicalizeRfc8785(receipt) ||
    review.state !== "InReview" ||
    review.actorKind !== "User" ||
    review.approvalPolicy !== "Required" ||
    !["ApprovalPending", "Pass"].includes(review.validationDecision) ||
    review.approvalEvidenceReference !== null ||
    review.reviewReference !== approval.reviewReference ||
    review.reviewVersion !== approval.reviewVersion ||
    review.publicationVersion !== approval.reviewVersion ||
    review.actorReference !== approval.requestedByActorReference ||
    review.submittedByActorReference !== approval.requestedByActorReference ||
    review.operationReference === approved.operationReference ||
    review.productAggregateVersion + 1 !== approved.productAggregateVersion ||
    review.occurredAt > approval.approvedAt ||
    approved.occurredAt < review.occurredAt ||
    approval.approvedAt > now ||
    approval.validUntil <= now ||
    now < request.observedAt ||
    now >= request.validUntil ||
    !["Approved", "Scheduled"].includes(current.state) ||
    current.validationDecision !== "Pass" ||
    current.approvalEvidenceReference !== approval.evidenceReference ||
    current.publicationVersion !== request.expectedPublicationVersion ||
    current.productAggregateVersion + 1 !== request.expectedAggregateVersion ||
    current.reviewReference !== approval.reviewReference ||
    current.reviewVersion !== approval.reviewVersion ||
    current.submittedByActorReference !== approval.requestedByActorReference ||
    current.approvalPolicy !== "Required" ||
    current.occurredAt > request.observedAt ||
    current.publicationVersion < approved.publicationVersion
  )
    return fail();
  for (const p of [approved, review, current]) {
    if (
      p.tenantReference !== receipt.tenantReference ||
      p.brandReference !== receipt.brandReference ||
      p.productReference !== request.productReference ||
      p.versionReference !== request.versionReference ||
      p.contentDigest !== request.contentDigest ||
      p.configurationDigest !== request.configurationDigest ||
      p.scopeDigest !== request.scopeDigest ||
      p.periodDigest !== request.periodDigest ||
      p.policyReference !== request.policyReference ||
      p.policyVersion !== request.policyVersion
    )
      return fail();
  }
  return Object.freeze({
    receipt,
    observedAggregateVersion: request.expectedAggregateVersion,
    currentPublicationVersion: current.publicationVersion,
    observationIntentDigest: request.originalIntentDigest,
    replacementIntentDigest: request.replacementIntentDigest,
    observedAt: request.observedAt,
    validUntil: request.validUntil < approval.validUntil ? request.validUntil : approval.validUntil,
    currentPolicy: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  });
}
export type CatalogProductApprovalObservationV2 = ReturnType<
  typeof bindCatalogProductApprovalReceiptV2
>;

/** Pure binding only. Both original approval and current policy sources must
 * remain held; this preserves their original deadlines and supplies no grant. */
export function bindCatalogProductApprovalToCurrentPolicyV2(
  approvalValue: unknown,
  policyValue: unknown,
  requestValue: unknown,
  nowValue: unknown,
) {
  const r = closed(approvalValue, observationFields),
    receipt = parseCatalogProductApprovalReceiptV2(r.receipt),
    request = parseCatalogProductApprovalRequestV2(requestValue);
  if (
    r.replacementIntentDigest !== request.replacementIntentDigest ||
    receipt.replacementIntentDigest !== request.replacementIntentDigest
  )
    return fail();
  const bound = bindCatalogProductApprovalToCurrentPolicy(
    { ...base(r), receipt: receiptBase(receipt) },
    policyValue,
    base(request),
    nowValue,
  );
  return Object.freeze({
    ...bound,
    profile: "CatalogProductApprovalPolicyObservationV2" as const,
    receipt,
    replacementIntentDigest: request.replacementIntentDigest,
  });
}
export type CatalogProductApprovalPolicyObservationV2 = ReturnType<
  typeof bindCatalogProductApprovalToCurrentPolicyV2
>;
