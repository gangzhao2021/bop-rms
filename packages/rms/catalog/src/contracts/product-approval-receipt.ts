import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { CatalogError, parseCatalogInstant, parseCatalogReference } from "./product.js";
import {
  parseProductPublicationApproval,
  parseProductPublicationVersion,
} from "./product-publication.js";

const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const digest = (v: unknown): string =>
  typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v) ? v : fail();
const integer = (v: unknown): number =>
  Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 2147483647
    ? (v as number)
    : fail();
function record(v: unknown, fields: readonly string[]): Record<string, unknown> {
  const r = copyCategoryPersistenceValue(v);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== fields.length ||
    fields.some((k) => !Object.hasOwn(r, k))
  )
    return fail();
  return r as Record<string, unknown>;
}
const fields = [
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
] as const;
export function parseCatalogProductApprovalReceipt(value: unknown) {
  const r = record(value, [...fields, "digest"]);
  if (r.profile !== "CatalogProductApprovalReceiptV1") return fail();
  const body = Object.freeze({
    profile: "CatalogProductApprovalReceiptV1" as const,
    tenantReference: parseCatalogReference(r.tenantReference),
    brandReference: parseCatalogReference(r.brandReference),
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    approvalOperationReference: parseCatalogReference(r.approvalOperationReference),
    originalIntentDigest: digest(r.originalIntentDigest),
    approvalPublicationVersion: integer(r.approvalPublicationVersion),
    resultAggregateVersion: integer(r.resultAggregateVersion),
    recordedAt: parseCatalogInstant(r.recordedAt),
    approval: parseProductPublicationApproval(r.approval),
  });
  if (
    body.approval.validUntil <= body.recordedAt ||
    r.digest !== hash(body) ||
    new TextEncoder().encode(canonicalizeRfc8785(body)).length > 65536
  )
    return fail();
  return Object.freeze({ ...body, digest: hash(body) });
}
export type CatalogProductApprovalReceipt = ReturnType<typeof parseCatalogProductApprovalReceipt>;
/** Called only by actual owning Approve. A pure receipt builder grants no authority. */
export function buildCatalogProductApprovalReceipt(
  publicationValue: unknown,
  approvalValue: unknown,
) {
  const p = parseProductPublicationVersion(copyCategoryPersistenceValue(publicationValue)),
    a = parseProductPublicationApproval(copyCategoryPersistenceValue(approvalValue));
  if (
    p.state !== "Approved" ||
    p.actorKind !== "User" ||
    p.approvalPolicy !== "Required" ||
    a.evidenceReference !== p.approvalEvidenceReference ||
    a.reviewReference !== p.reviewReference ||
    a.reviewVersion !== p.reviewVersion ||
    a.requestedByActorReference !== p.submittedByActorReference ||
    a.approvedByActorReference !== p.actorReference ||
    a.contentDigest !== p.contentDigest ||
    a.configurationDigest !== p.configurationDigest ||
    a.scopeDigest !== p.scopeDigest ||
    a.periodDigest !== p.periodDigest ||
    a.policyReference !== p.policyReference ||
    a.policyVersion !== p.policyVersion
  )
    return fail();
  const body = {
    profile: "CatalogProductApprovalReceiptV1",
    tenantReference: p.tenantReference,
    brandReference: p.brandReference,
    productReference: p.productReference,
    versionReference: p.versionReference,
    approvalOperationReference: p.operationReference,
    originalIntentDigest: p.intentDigest,
    approvalPublicationVersion: p.publicationVersion,
    resultAggregateVersion: p.productAggregateVersion + 1,
    recordedAt: p.occurredAt,
    approval: a,
  };
  return parseCatalogProductApprovalReceipt({ ...body, digest: hash(body) });
}
export const productApprovalSourceFields = Object.freeze([
  "approval",
  "review",
  "approvalActor",
  "originalApprovalExpiry",
  "publicationContentIdentity",
] as const);
export function parseCatalogProductApprovalRequest(value: unknown) {
  const r = record(value, [
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
      "observedAt",
      "validUntil",
    ]),
    observedAt = parseCatalogInstant(r.observedAt),
    validUntil = parseCatalogInstant(r.validUntil);
  if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 30000)
    return fail();
  return Object.freeze({
    productReference: parseCatalogReference(r.productReference),
    versionReference: parseCatalogReference(r.versionReference),
    expectedAggregateVersion: integer(r.expectedAggregateVersion),
    expectedPublicationVersion: integer(r.expectedPublicationVersion),
    contentDigest: digest(r.contentDigest),
    configurationDigest: digest(r.configurationDigest),
    scopeDigest: digest(r.scopeDigest),
    periodDigest: digest(r.periodDigest),
    policyReference: parseCatalogReference(r.policyReference),
    policyVersion: integer(r.policyVersion),
    originalIntentDigest: digest(r.originalIntentDigest),
    observedAt,
    validUntil,
  });
}
export type CatalogProductApprovalRequest = ReturnType<typeof parseCatalogProductApprovalRequest>;
/** Actual owning source acquisition and current policy must surround this binding. */
export function bindCatalogProductApprovalReceipt(
  receiptValue: unknown,
  approvedValue: unknown,
  reviewValue: unknown,
  currentValue: unknown,
  requestValue: unknown,
  nowValue: unknown,
) {
  const receipt = parseCatalogProductApprovalReceipt(receiptValue),
    approved = parseProductPublicationVersion(copyCategoryPersistenceValue(approvedValue)),
    review = parseProductPublicationVersion(copyCategoryPersistenceValue(reviewValue)),
    current = parseProductPublicationVersion(copyCategoryPersistenceValue(currentValue)),
    request = parseCatalogProductApprovalRequest(requestValue),
    now = parseCatalogInstant(nowValue),
    a = receipt.approval;
  if (
    canonicalizeRfc8785(buildCatalogProductApprovalReceipt(approved, a)) !==
      canonicalizeRfc8785(receipt) ||
    review.state !== "InReview" ||
    review.reviewReference !== a.reviewReference ||
    review.reviewVersion !== a.reviewVersion ||
    review.publicationVersion !== a.reviewVersion ||
    review.actorReference !== a.requestedByActorReference ||
    review.submittedByActorReference !== a.requestedByActorReference ||
    review.occurredAt > a.approvedAt ||
    approved.occurredAt < review.occurredAt ||
    a.approvedAt > now ||
    a.validUntil <= now ||
    now < request.observedAt ||
    now >= request.validUntil ||
    !["Approved", "Scheduled"].includes(current.state) ||
    current.approvalEvidenceReference !== a.evidenceReference ||
    current.publicationVersion !== request.expectedPublicationVersion ||
    current.productAggregateVersion + 1 !== request.expectedAggregateVersion ||
    current.reviewReference !== a.reviewReference ||
    current.reviewVersion !== a.reviewVersion ||
    current.submittedByActorReference !== a.requestedByActorReference ||
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
    observedAt: request.observedAt,
    validUntil: request.validUntil < a.validUntil ? request.validUntil : a.validUntil,
    currentPolicy: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  });
}
