import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";
import {
  createPublishingApprovalEvidence,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  evaluatePublishingTransition,
  samePublishingScope,
  type PublishingApprovalEvidence,
  type PublishingLifecycleRecord,
  type PublishingOperation,
  type PublishingValidationEvidence,
} from "@bop/publishing";

import { CatalogError } from "./product.js";

function conflict(): never {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
}

export function validateMenuPublicationEvidence(input: {
  readonly current: PublishingLifecycleRecord;
  readonly validation: PublishingValidationEvidence | null;
  readonly approval: PublishingApprovalEvidence | null;
  readonly at: string;
}): {
  readonly validation: PublishingValidationEvidence | null;
  readonly approval: PublishingApprovalEvidence | null;
} {
  const validation =
    input.validation === null ? null : createPublishingValidationEvidence(input.validation);
  const approval =
    input.approval === null ? null : createPublishingApprovalEvidence(input.approval);
  if (validation !== null) {
    if (
      validation.snapshotReference !== input.current.snapshotReference ||
      validation.snapshotDigest !== input.current.snapshotDigest ||
      !samePublishingScope(validation.scope, input.current.scope) ||
      Date.parse(validation.checkedAt) > Date.parse(input.at) ||
      Date.parse(validation.validUntil) <= Date.parse(input.at)
    )
      conflict();
  }
  if (approval !== null) {
    if (
      approval.reviewLifecycleId !== input.current.lifecycleId ||
      approval.reviewVersion !== input.current.version ||
      approval.snapshotReference !== input.current.snapshotReference ||
      approval.snapshotDigest !== input.current.snapshotDigest ||
      !samePublishingScope(approval.scope, input.current.scope) ||
      Date.parse(approval.approvedAt) > Date.parse(input.at) ||
      Date.parse(approval.validUntil) <= Date.parse(input.at)
    )
      conflict();
  }
  return Object.freeze({ validation, approval });
}

export function transitionMenuPublication(input: {
  readonly operation: Exclude<PublishingOperation, "CreateDraft" | "Rollback">;
  readonly current: PublishingLifecycleRecord;
  readonly validation: PublishingValidationEvidence | null;
  readonly approval: PublishingApprovalEvidence | null;
  readonly at: string;
}): PublishingLifecycleRecord {
  const current = createPublishingLifecycleRecord(input.current);
  const evidence = validateMenuPublicationEvidence({ ...input, current });
  const state =
    input.operation === "SubmitReview"
      ? "InReview"
      : input.operation === "Approve"
        ? "Approved"
        : input.operation === "Publish"
          ? "Published"
          : "Archived";
  const next = createPublishingLifecycleRecord({
    ...current,
    version: (current.version + 1) as never,
    state,
    validationEvidenceReference:
      evidence.validation?.evidenceReference ?? current.validationEvidenceReference,
    approvalEvidenceReference:
      evidence.approval?.evidenceReference ?? current.approvalEvidenceReference,
    changedAt: input.at as never,
  });
  if (
    !evaluatePublishingTransition({
      operation: input.operation,
      expectedVersion: current.version,
      current,
      next,
    }).allowed
  )
    conflict();
  return next;
}

export function validateMenuEffectivePeriod(value: EffectivePeriod | null): EffectivePeriod {
  if (value === null) conflict();
  return createEffectivePeriod(value);
}

export function supersedePublishedMenu(
  value: PublishingLifecycleRecord,
  changedAt: string,
): PublishingLifecycleRecord {
  const current = createPublishingLifecycleRecord(value);
  if (current.state !== "Published" || Date.parse(changedAt) < Date.parse(current.changedAt))
    conflict();
  return createPublishingLifecycleRecord({
    ...current,
    version: (current.version + 1) as never,
    state: "Superseded",
    changedAt: changedAt as never,
  });
}
