export interface DomainPublishingScope {
  readonly kind: "Brand" | "Store";
  readonly brandReference: string;
  readonly storeReference: string | null;
}

export interface DomainPublishingLifecycleRecord {
  readonly lifecycleId: string;
  readonly familyReference: string;
  readonly configurationType: string;
  readonly purposeCode: string;
  readonly snapshotReference: string;
  readonly snapshotDigest: string;
  readonly scope: DomainPublishingScope;
  readonly version: number;
  readonly state: "Draft" | "InReview" | "Approved" | "Published" | "Archived" | "Superseded";
  readonly validationEvidenceReference: string | null;
  readonly approvalEvidenceReference: string | null;
  readonly createdAt: string;
  readonly changedAt: string;
}

export const publishingOperations = [
  "CreateDraft",
  "SubmitReview",
  "Approve",
  "Publish",
  "Archive",
  "Rollback",
] as const;
export type PublishingOperation = (typeof publishingOperations)[number];

export const publishingTransitionReasons = ["TRANSITION_ALLOWED", "TRANSITION_INVALID"] as const;
export type PublishingTransitionReason = (typeof publishingTransitionReasons)[number];

export interface PublishingTransitionEvaluation {
  readonly allowed: boolean;
  readonly reason: PublishingTransitionReason;
}

function sameFamily(
  current: DomainPublishingLifecycleRecord,
  next: DomainPublishingLifecycleRecord,
): boolean {
  return (
    current.lifecycleId === next.lifecycleId &&
    current.familyReference === next.familyReference &&
    current.configurationType === next.configurationType &&
    current.purposeCode === next.purposeCode &&
    current.scope.kind === next.scope.kind &&
    current.scope.brandReference === next.scope.brandReference &&
    current.scope.storeReference === next.scope.storeReference &&
    current.createdAt === next.createdAt
  );
}

function sameSnapshot(
  current: DomainPublishingLifecycleRecord,
  next: DomainPublishingLifecycleRecord,
): boolean {
  return (
    current.snapshotReference === next.snapshotReference &&
    current.snapshotDigest === next.snapshotDigest
  );
}

function nextVersion(
  current: DomainPublishingLifecycleRecord,
  next: DomainPublishingLifecycleRecord,
  expectedVersion: number,
): boolean {
  return (
    current.version === expectedVersion &&
    next.version === current.version + 1 &&
    Date.parse(next.changedAt) >= Date.parse(current.changedAt)
  );
}

function result(allowed: boolean): PublishingTransitionEvaluation {
  return Object.freeze({
    allowed,
    reason: allowed ? "TRANSITION_ALLOWED" : "TRANSITION_INVALID",
  });
}

export function evaluatePublishingTransition(input: {
  readonly operation: PublishingOperation;
  readonly expectedVersion: number;
  readonly current: DomainPublishingLifecycleRecord | null;
  readonly next: DomainPublishingLifecycleRecord;
}): PublishingTransitionEvaluation {
  const { operation, current, next, expectedVersion } = input;
  if (operation === "CreateDraft" && current === null) {
    return result(
      expectedVersion === 1 &&
        next.version === 1 &&
        next.state === "Draft" &&
        next.validationEvidenceReference === null &&
        next.approvalEvidenceReference === null,
    );
  }
  if (
    current === null ||
    !sameFamily(current, next) ||
    !nextVersion(current, next, expectedVersion)
  )
    return result(false);

  if (operation === "CreateDraft") {
    return result(
      current.state === "Draft" &&
        next.state === "Draft" &&
        next.validationEvidenceReference === null &&
        next.approvalEvidenceReference === null,
    );
  }
  if (!sameSnapshot(current, next)) return result(false);

  if (operation === "SubmitReview")
    return result(
      current.state === "Draft" &&
        next.state === "InReview" &&
        current.validationEvidenceReference === null &&
        next.validationEvidenceReference !== null &&
        next.approvalEvidenceReference === null,
    );
  if (operation === "Approve")
    return result(
      current.state === "InReview" &&
        next.state === "Approved" &&
        current.validationEvidenceReference !== null &&
        next.validationEvidenceReference === current.validationEvidenceReference &&
        current.approvalEvidenceReference === null &&
        next.approvalEvidenceReference !== null,
    );
  if (operation === "Publish" || operation === "Rollback")
    return result(
      current.state === "Approved" &&
        next.state === "Published" &&
        next.validationEvidenceReference === current.validationEvidenceReference &&
        next.approvalEvidenceReference === current.approvalEvidenceReference &&
        next.validationEvidenceReference !== null &&
        next.approvalEvidenceReference !== null,
    );
  return result(
    operation === "Archive" &&
      current.state === "Published" &&
      next.state === "Archived" &&
      next.validationEvidenceReference === current.validationEvidenceReference &&
      next.approvalEvidenceReference === current.approvalEvidenceReference,
  );
}
