import type {
  PublishingApprovalEvidence,
  PublishingCode,
  PublishingDigest,
  PublishingLifecycleRecord,
  PublishingReference,
  PublishingReleaseRecord,
  PublishingScope,
  PublishingValidationEvidence,
} from "./publishing.js";
import type { CanonicalInstant } from "@bop/tenant";

/** Owning current release plus immutable original review history. This is recorded
 * independence, not renewed approval, current validation or consumer eligibility. */
export interface RecordedReleasedIndependentPublishingApproval {
  readonly profile: "RecordedReleasedIndependentPublishingApprovalV1";
  readonly tenantReference: string;
  readonly scope: PublishingScope;
  readonly familyReference: PublishingReference;
  readonly lifecycleReference: PublishingReference;
  readonly configurationType: PublishingCode;
  readonly purposeCode: PublishingCode;
  readonly snapshotReference: PublishingReference;
  readonly snapshotDigest: PublishingDigest;
  readonly currentRelease: Readonly<{
    release: PublishingReleaseRecord;
    lifecycle: PublishingLifecycleRecord;
    validationEvidence: PublishingValidationEvidence;
    approvalEvidence: PublishingApprovalEvidence;
    auditReference: PublishingReference;
    observedAt: CanonicalInstant;
  }>;
  readonly approvedLifecycleVersion: number;
  readonly reviewVersion: number;
  readonly draftOperationReference: PublishingReference;
  readonly reviewOperationReference: PublishingReference;
  readonly approvalOperationReference: PublishingReference;
  readonly authoredByActorReference: PublishingReference;
  readonly requestedByActorReference: PublishingReference;
  readonly approvedByActorReference: PublishingReference;
  readonly validationEvidenceReference: PublishingReference;
  readonly approvalEvidenceReference: PublishingReference;
  readonly validationCheckCodes: readonly PublishingCode[];
  readonly observedAt: CanonicalInstant;
  readonly sourceDigest: PublishingDigest;
  readonly digest: PublishingDigest;
  readonly recordedIndependence: "Verified";
  readonly currentValidation: "NotEvaluated";
  readonly referenceEligibility: "NotEvaluated";
  readonly eligibility: "NotEvaluated";
}
