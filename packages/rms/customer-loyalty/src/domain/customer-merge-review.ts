import {
  CustomerProfileError,
  customerInstant,
  customerReference,
  type CustomerInstant,
  type CustomerReference,
} from "./customer-profile.js";

export type MergeReviewStatus = "PendingApproval" | "Approved" | "Rejected";
export interface MergeEvidence {
  readonly evidenceReference: CustomerReference;
  readonly kind:
    "VerifiedContact" | "VerifiedUser" | "AuthorizedTransaction" | "StaffInvestigation";
  readonly profileReferences: readonly [CustomerReference, CustomerReference];
  readonly verifiedAt: CustomerInstant;
}
export interface MergeConflict {
  readonly fieldCode:
    "DISPLAY_NAME" | "LOCALE" | "USER_LINK" | "CONTACT" | "CONSENT" | "LOYALTY_ACCOUNT";
  readonly resolution:
    "KeepCanonical" | "KeepCandidate" | "KeepBothReferences" | "RequiresFollowUp";
}
export interface CustomerMergeReview {
  readonly reviewReference: CustomerReference;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly canonicalProfileReference: CustomerReference;
  readonly candidateProfileReference: CustomerReference;
  readonly canonicalProfileVersion: number;
  readonly candidateProfileVersion: number;
  readonly evidence: readonly MergeEvidence[];
  readonly conflicts: readonly MergeConflict[];
  readonly linkedAccountReferences: readonly CustomerReference[];
  readonly linkedTransactionReferences: readonly CustomerReference[];
  readonly consentEvidenceReferences: readonly CustomerReference[];
  readonly impactReference: CustomerReference;
  readonly rollbackReference: CustomerReference;
  readonly requestedBy: CustomerReference;
  readonly requestedAt: CustomerInstant;
  readonly status: MergeReviewStatus;
  readonly decidedBy: CustomerReference | null;
  readonly decidedAt: CustomerInstant | null;
  readonly decisionReasonCode: string | null;
  readonly decisionEvidenceReference: CustomerReference | null;
  readonly aggregateVersion: number;
}

const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const code = (value: unknown) =>
  typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : fail();
const uniqueReferences = (value: readonly unknown[], maximum = 200) => {
  if (!Array.isArray(value) || value.length > maximum) fail();
  const result = value.map(customerReference);
  if (new Set(result).size !== result.length) fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  return Object.freeze(result);
};

export function startCustomerMergeReview(input: {
  reviewReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  canonicalProfileReference: unknown;
  candidateProfileReference: unknown;
  canonicalProfileVersion: unknown;
  candidateProfileVersion: unknown;
  evidence: readonly MergeEvidence[];
  conflicts: readonly MergeConflict[];
  linkedAccountReferences: readonly unknown[];
  linkedTransactionReferences: readonly unknown[];
  consentEvidenceReferences: readonly unknown[];
  impactReference: unknown;
  rollbackReference: unknown;
  requestedBy: unknown;
  requestedAt: unknown;
}): CustomerMergeReview {
  const canonical = customerReference(input.canonicalProfileReference);
  const candidate = customerReference(input.candidateProfileReference);
  const brand = customerReference(input.brandReference);
  const canonicalVersion = input.canonicalProfileVersion;
  const candidateVersion = input.candidateProfileVersion;
  if (
    canonical === candidate ||
    input.evidence.length === 0 ||
    input.evidence.length > 20 ||
    input.conflicts.length > 30 ||
    !Number.isSafeInteger(canonicalVersion) ||
    (canonicalVersion as number) < 1 ||
    !Number.isSafeInteger(candidateVersion) ||
    (candidateVersion as number) < 1
  )
    fail();
  const pair = new Set([canonical, candidate]);
  const requestedAt = customerInstant(input.requestedAt);
  const evidence = input.evidence.map((item) => {
    if (
      !pair.has(item.profileReferences[0]) ||
      !pair.has(item.profileReferences[1]) ||
      item.profileReferences[0] === item.profileReferences[1]
    )
      fail();
    if (
      !["VerifiedContact", "VerifiedUser", "AuthorizedTransaction", "StaffInvestigation"].includes(
        item.kind,
      )
    )
      fail();
    const verifiedAt = customerInstant(item.verifiedAt);
    if (verifiedAt > requestedAt) fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
    return Object.freeze({
      evidenceReference: customerReference(item.evidenceReference),
      kind: item.kind,
      profileReferences: Object.freeze([
        customerReference(item.profileReferences[0]),
        customerReference(item.profileReferences[1]),
      ]) as readonly [CustomerReference, CustomerReference],
      verifiedAt,
    });
  });
  const conflicts = input.conflicts.map((item) => {
    if (
      !["DISPLAY_NAME", "LOCALE", "USER_LINK", "CONTACT", "CONSENT", "LOYALTY_ACCOUNT"].includes(
        item.fieldCode,
      ) ||
      !["KeepCanonical", "KeepCandidate", "KeepBothReferences", "RequiresFollowUp"].includes(
        item.resolution,
      )
    )
      fail();
    return Object.freeze({ fieldCode: item.fieldCode, resolution: item.resolution });
  });
  if (new Set(conflicts.map((item) => item.fieldCode)).size !== conflicts.length) fail();
  return Object.freeze({
    reviewReference: customerReference(input.reviewReference),
    tenantReference: customerReference(input.tenantReference),
    brandReference: brand,
    canonicalProfileReference: canonical,
    candidateProfileReference: candidate,
    canonicalProfileVersion: canonicalVersion as number,
    candidateProfileVersion: candidateVersion as number,
    evidence: Object.freeze(evidence),
    conflicts: Object.freeze(conflicts),
    linkedAccountReferences: uniqueReferences(input.linkedAccountReferences),
    linkedTransactionReferences: uniqueReferences(input.linkedTransactionReferences),
    consentEvidenceReferences: uniqueReferences(input.consentEvidenceReferences),
    impactReference: customerReference(input.impactReference),
    rollbackReference: customerReference(input.rollbackReference),
    requestedBy: customerReference(input.requestedBy),
    requestedAt,
    status: "PendingApproval",
    decidedBy: null,
    decidedAt: null,
    decisionReasonCode: null,
    decisionEvidenceReference: null,
    aggregateVersion: 1,
  });
}

export function decideCustomerMergeReview(
  review: CustomerMergeReview,
  input: {
    expectedVersion: number;
    decision: "Approve" | "Reject";
    actorReference: unknown;
    occurredAt: unknown;
    reasonCode: unknown;
    decisionEvidenceReference: unknown;
  },
): CustomerMergeReview {
  if (review.status !== "PendingApproval" || review.aggregateVersion !== input.expectedVersion)
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const actor = customerReference(input.actorReference);
  if (actor === review.requestedBy) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  return Object.freeze({
    ...review,
    status: input.decision === "Approve" ? "Approved" : "Rejected",
    decidedBy: actor,
    decidedAt: customerInstant(input.occurredAt),
    decisionReasonCode: code(input.reasonCode),
    decisionEvidenceReference: customerReference(input.decisionEvidenceReference),
    aggregateVersion: review.aggregateVersion + 1,
  });
}

export interface CustomerProfilesMergedFact {
  readonly eventName: "CustomerProfilesMerged";
  readonly eventReference: CustomerReference;
  readonly eventVersion: 1;
  readonly tenantReference: CustomerReference;
  readonly brandReference: CustomerReference;
  readonly reviewReference: CustomerReference;
  readonly canonicalProfileReference: CustomerReference;
  readonly retainedProfileReference: CustomerReference;
  readonly rollbackReference: CustomerReference;
  readonly occurredAt: CustomerInstant;
  readonly sourceFactsRewritten: false;
  readonly historicalActorsRewritten: false;
}
export const customerProfilesMergedFact = (
  review: CustomerMergeReview,
  eventReference: unknown,
): CustomerProfilesMergedFact => {
  if (review.status !== "Approved" || review.decidedAt === null)
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const occurredAt = review.decidedAt as CustomerInstant;
  return Object.freeze({
    eventName: "CustomerProfilesMerged",
    eventReference: customerReference(eventReference),
    eventVersion: 1,
    tenantReference: review.tenantReference,
    brandReference: review.brandReference,
    reviewReference: review.reviewReference,
    canonicalProfileReference: review.canonicalProfileReference,
    retainedProfileReference: review.candidateProfileReference,
    rollbackReference: review.rollbackReference,
    occurredAt,
    sourceFactsRewritten: false,
    historicalActorsRewritten: false,
  });
};
