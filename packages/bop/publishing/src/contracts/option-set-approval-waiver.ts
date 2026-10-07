import { parsePublishingOptionSetCurrentQualification } from "./option-set-current-qualification.js";
import type {
  PublishingLifecycleRecord,
  PublishingReleaseRecord,
  PublishingValidationEvidence,
  PublishingApprovalEvidence,
  PublishingReference,
} from "./publishing.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingOptionSetPublicationPolicy,
  publishingOptionSetPublicationPolicyDigest,
} from "./option-set-publication-policy.js";
import {
  PublishingContractError,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  parsePublishingReference,
  parsePublishingInstant,
  parseReleaseSequence,
  samePublishingScope,
} from "./publishing.js";
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function record(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((k) => !Object.hasOwn(descriptors, k)) ||
    keys.some(
      (k) =>
        typeof k !== "string" ||
        !fields.includes(k) ||
        !descriptors[k]?.enumerable ||
        !("value" in descriptors[k]),
    )
  )
    return fail();
  return Object.fromEntries(fields.map((k) => [k, descriptors[k]?.value]));
}
/** Confidential immutable original Review facts. This DTO is not authorization or a policy selector. */
export function parsePublishingOptionSetReviewPolicy(value: unknown) {
  const r = record(value, [
    "profile",
    "tenantReference",
    "policyContent",
    "policyReleaseReference",
    "policyReleaseSequence",
    "policySnapshotDigest",
    "reviewOperationReference",
    "reviewLifecycle",
    "validationEvidence",
    "submittedActorReference",
    "submittedAt",
  ]);
  if (r.profile !== "PublishingOptionSetReviewPolicyV1") return fail();
  const policyContent = parsePublishingOptionSetPublicationPolicy(r.policyContent);
  const reviewLifecycle = createPublishingLifecycleRecord(
    r.reviewLifecycle as Parameters<typeof createPublishingLifecycleRecord>[0],
  );
  const validationEvidence = createPublishingValidationEvidence(
    r.validationEvidence as Parameters<typeof createPublishingValidationEvidence>[0],
  );
  const tenantReference = parsePublishingReference(r.tenantReference);
  const submittedAt = parsePublishingInstant(r.submittedAt);
  const policySnapshotDigest = publishingOptionSetPublicationPolicyDigest(policyContent);
  if (
    r.policySnapshotDigest !== policySnapshotDigest ||
    policyContent.tenantReference !== tenantReference ||
    reviewLifecycle.scope.kind !== "Brand" ||
    policyContent.brandReference !== String(reviewLifecycle.scope.brandReference) ||
    reviewLifecycle.configurationType !== "CATALOG_OPTION_SET" ||
    reviewLifecycle.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
    reviewLifecycle.state !== "InReview" ||
    reviewLifecycle.approvalEvidenceReference !== null ||
    reviewLifecycle.validationEvidenceReference !== validationEvidence.evidenceReference ||
    validationEvidence.result !== "Pass" ||
    !samePublishingScope(reviewLifecycle.scope, validationEvidence.scope) ||
    reviewLifecycle.snapshotReference !== validationEvidence.snapshotReference ||
    reviewLifecycle.snapshotDigest !== validationEvidence.snapshotDigest ||
    reviewLifecycle.changedAt > submittedAt ||
    validationEvidence.checkedAt > submittedAt ||
    validationEvidence.validUntil <= submittedAt ||
    policyContent.effectiveFrom > submittedAt ||
    (policyContent.effectiveUntil !== null && policyContent.effectiveUntil <= submittedAt)
  )
    return fail();
  return Object.freeze({
    profile: "PublishingOptionSetReviewPolicyV1" as const,
    tenantReference,
    policyContent,
    policyReleaseReference: parsePublishingReference(r.policyReleaseReference),
    policyReleaseSequence: parseReleaseSequence(r.policyReleaseSequence),
    policySnapshotDigest,
    reviewOperationReference: parsePublishingReference(r.reviewOperationReference),
    reviewLifecycle,
    validationEvidence,
    submittedActorReference: parsePublishingReference(r.submittedActorReference),
    submittedAt,
  });
}
export type PublishingOptionSetReviewPolicy = ReturnType<
  typeof parsePublishingOptionSetReviewPolicy
>;
export function parsePublishingOptionSetApprovalWaiver(value: unknown) {
  const qualified =
    !!value && typeof value === "object" && Object.hasOwn(value, "currentQualification");
  const r = record(
    value,
    qualified
      ? ["profile", "reviewPolicy", "recordedAt", "currentQualification"]
      : ["profile", "reviewPolicy", "recordedAt"],
  );
  const currentQualification = qualified
    ? parsePublishingOptionSetCurrentQualification(r.currentQualification)
    : undefined;
  if (r.profile !== "PublishingOptionSetApprovalWaiverV1") return fail();
  const reviewPolicy = parsePublishingOptionSetReviewPolicy(r.reviewPolicy);
  const recordedAt = parsePublishingInstant(r.recordedAt);
  const policy = reviewPolicy.policyContent;
  if (
    policy.approvalPolicy !== "NotRequired" ||
    recordedAt < reviewPolicy.submittedAt ||
    (!currentQualification && reviewPolicy.validationEvidence.validUntil <= recordedAt) ||
    (currentQualification !== undefined &&
      (currentQualification.checkedAt > recordedAt ||
        currentQualification.validUntil <= recordedAt ||
        currentQualification.approvalEvidenceReference !== null ||
        currentQualification.reviewOperationReference !== reviewPolicy.reviewOperationReference ||
        currentQualification.latestMutationOperationReference !==
          reviewPolicy.reviewOperationReference ||
        currentQualification.expectedLifecycleVersion !== reviewPolicy.reviewLifecycle.version ||
        currentQualification.snapshotReference !== reviewPolicy.reviewLifecycle.snapshotReference ||
        currentQualification.snapshotDigest !== reviewPolicy.reviewLifecycle.snapshotDigest ||
        currentQualification.validationEvidenceReference !==
          reviewPolicy.validationEvidence.evidenceReference ||
        currentQualification.policyReference !== policy.policyReference ||
        currentQualification.policyVersion !== policy.policyVersion ||
        currentQualification.policyContentDigest !== reviewPolicy.policySnapshotDigest ||
        currentQualification.policyPublicationReference !== reviewPolicy.policyReleaseReference ||
        !samePublishingScope(currentQualification.scope, reviewPolicy.reviewLifecycle.scope))) ||
    (policy.effectiveUntil !== null && policy.effectiveUntil <= recordedAt)
  )
    return fail();
  return Object.freeze({
    profile: "PublishingOptionSetApprovalWaiverV1" as const,
    ...(currentQualification === undefined ? {} : { currentQualification }),
    reviewPolicy,
    recordedAt,
  });
}
export type PublishingOptionSetApprovalWaiver = ReturnType<
  typeof parsePublishingOptionSetApprovalWaiver
>;
export const publishingOptionSetReviewPolicyDigest = (value: unknown) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingOptionSetReviewPolicy(value)));
export const publishingOptionSetApprovalWaiverDigest = (value: unknown) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingOptionSetApprovalWaiver(value)));

/** Approval disposition records the actual proof used, separately from policy requirements. */
type OptionSetReleaseBase = Readonly<{
  release: PublishingReleaseRecord;
  lifecycle: PublishingLifecycleRecord;
  validationEvidence: PublishingValidationEvidence;
  auditReference: PublishingReference;
  observedAt: string;
}>;
type OptionSetApprovalDisposition =
  | Readonly<{
      approvalDisposition: "Approved";
      approvalEvidence: PublishingApprovalEvidence;
      waiver: null;
    }>
  | Readonly<{
      approvalDisposition: "PolicyWaived";
      approvalEvidence: null;
      waiver: PublishingOptionSetApprovalWaiver;
    }>;
export type PublishingOptionSetCurrentRelease = OptionSetReleaseBase & OptionSetApprovalDisposition;
export type PublishingOptionSetRecordedRelease = Omit<OptionSetReleaseBase, "observedAt"> &
  OptionSetApprovalDisposition;
export type PublishingOptionSetReferencedCurrentRelease = Readonly<{
  recorded: PublishingOptionSetRecordedRelease;
  current: PublishingOptionSetCurrentRelease;
  observedAt: string;
}>;
