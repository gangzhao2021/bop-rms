import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingReference,
  parsePublishingVersion,
  parseReleaseSequence,
  publishingLifecycleStates,
  type PublishingApprovalEvidence,
  type PublishingLifecycleRecord,
  type PublishingReleaseRecord,
  type PublishingValidationEvidence,
} from "./publishing.js";
import {
  evaluatePublishingTransition,
  publishingOperations,
  type PublishingOperation,
} from "../domain/evaluate-publishing-transition.js";

export const platformBrandTemplateConfigurationType = "PLATFORM_BRAND_TEMPLATE" as const;
export interface PlatformPublishingScope {
  readonly kind: "Platform";
  readonly brandReference: null;
  readonly storeReference: null;
}
export interface PlatformPublishingLifecycleRecord extends Omit<
  PublishingLifecycleRecord,
  "scope" | "configurationType" | "purposeCode"
> {
  readonly scope: PlatformPublishingScope;
  readonly configurationType: typeof platformBrandTemplateConfigurationType;
  readonly purposeCode: typeof platformBrandTemplateConfigurationType;
  readonly authoredActorReference: PublishingLifecycleRecord["lifecycleId"];
  readonly submittedActorReference: PublishingLifecycleRecord["lifecycleId"] | null;
  /** Original business deadline, independent of any current authorization lease. */
  readonly reviewValidUntil: PublishingLifecycleRecord["changedAt"] | null;
}
export interface PlatformPublishingValidationEvidence extends Omit<
  PublishingValidationEvidence,
  "scope"
> {
  readonly scope: PlatformPublishingScope;
}
export interface PlatformPublishingApprovalEvidence extends Omit<
  PublishingApprovalEvidence,
  "scope"
> {
  readonly scope: PlatformPublishingScope;
  readonly authoredActorReference: PublishingApprovalEvidence["approvedActorReference"];
  readonly submittedActorReference: PublishingApprovalEvidence["approvedActorReference"];
}
export interface PlatformPublishingReleaseRecord extends Omit<
  PublishingReleaseRecord,
  "scope" | "configurationType" | "purposeCode"
> {
  readonly scope: PlatformPublishingScope;
  readonly configurationType: typeof platformBrandTemplateConfigurationType;
  readonly purposeCode: typeof platformBrandTemplateConfigurationType;
}
/** A parsed command is intent, never permission or proof of persisted publication. */
export interface PlatformPublishingCommand {
  readonly profile: "PlatformPublishingCommandV1";
  readonly operation: PublishingOperation;
  readonly operationReference: PublishingLifecycleRecord["lifecycleId"];
  readonly currentActorReference: PublishingLifecycleRecord["lifecycleId"];
  readonly expectedVersion: PublishingLifecycleRecord["version"];
  readonly current: PlatformPublishingLifecycleRecord | null;
  readonly next: PlatformPublishingLifecycleRecord;
  readonly validationEvidence: PlatformPublishingValidationEvidence | null;
  readonly approvalEvidence: PlatformPublishingApprovalEvidence | null;
  readonly release: PlatformPublishingReleaseRecord | null;
  readonly previousRelease: PlatformPublishingReleaseRecord | null;
  readonly rollbackTarget: PlatformPublishingReleaseRecord | null;
  readonly occurredAt: PublishingLifecycleRecord["changedAt"];
}
function fail(): never {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
}
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key) ||
        !descriptors[key]?.enumerable ||
        !("value" in descriptors[key]),
    )
  )
    return fail();
  return Object.fromEntries(fields.map((key) => [key, descriptors[key]?.value]));
}
function codes(value: unknown): readonly PublishingValidationEvidence["checkCodes"][number][] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 128
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1) return fail();
  const parsed = Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return fail();
    return parsePublishingCode(descriptor.value);
  });
  if (new Set(parsed).size !== parsed.length) return fail();
  return Object.freeze(parsed);
}
const referenceOrNull = (value: unknown) =>
  value === null ? null : parsePublishingReference(value);
const instantOrNull = (value: unknown) => (value === null ? null : parsePublishingInstant(value));
function fixedFamily(r: Record<string, unknown>): void {
  if (
    r.configurationType !== platformBrandTemplateConfigurationType ||
    r.purposeCode !== platformBrandTemplateConfigurationType
  )
    fail();
}
export function parsePlatformPublishingScope(value: unknown): PlatformPublishingScope {
  const r = record(value, ["kind", "brandReference", "storeReference"]);
  if (r.kind !== "Platform" || r.brandReference !== null || r.storeReference !== null) fail();
  return Object.freeze({ kind: "Platform", brandReference: null, storeReference: null });
}
export function parsePlatformPublishingLifecycleRecord(
  value: unknown,
): PlatformPublishingLifecycleRecord {
  const r = record(value, [
    "lifecycleId",
    "familyReference",
    "configurationType",
    "purposeCode",
    "snapshotReference",
    "snapshotDigest",
    "scope",
    "version",
    "state",
    "validationEvidenceReference",
    "approvalEvidenceReference",
    "createdAt",
    "changedAt",
    "authoredActorReference",
    "submittedActorReference",
    "reviewValidUntil",
  ]);
  fixedFamily(r);
  if (
    typeof r.state !== "string" ||
    !publishingLifecycleStates.includes(r.state as PublishingLifecycleRecord["state"])
  )
    fail();
  const result: PlatformPublishingLifecycleRecord = Object.freeze({
    lifecycleId: parsePublishingReference(r.lifecycleId),
    familyReference: parsePublishingReference(r.familyReference),
    configurationType: platformBrandTemplateConfigurationType,
    purposeCode: platformBrandTemplateConfigurationType,
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    scope: parsePlatformPublishingScope(r.scope),
    version: parsePublishingVersion(r.version),
    state: r.state as PublishingLifecycleRecord["state"],
    validationEvidenceReference: referenceOrNull(r.validationEvidenceReference),
    approvalEvidenceReference: referenceOrNull(r.approvalEvidenceReference),
    createdAt: parsePublishingInstant(r.createdAt),
    changedAt: parsePublishingInstant(r.changedAt),
    authoredActorReference: parsePublishingReference(r.authoredActorReference),
    submittedActorReference: referenceOrNull(r.submittedActorReference),
    reviewValidUntil: instantOrNull(r.reviewValidUntil),
  });
  if (result.createdAt > result.changedAt) fail();
  if (result.state === "Draft") {
    if (
      result.validationEvidenceReference !== null ||
      result.approvalEvidenceReference !== null ||
      result.submittedActorReference !== null ||
      result.reviewValidUntil !== null
    )
      fail();
  } else {
    if (
      result.validationEvidenceReference === null ||
      result.submittedActorReference === null ||
      result.reviewValidUntil === null ||
      result.reviewValidUntil <= result.createdAt
    )
      fail();
    if ((result.state === "InReview") !== (result.approvalEvidenceReference === null)) fail();
    if (
      (result.state === "InReview" ||
        result.state === "Approved" ||
        result.state === "Published") &&
      result.changedAt >= result.reviewValidUntil
    )
      fail();
  }
  return result;
}
export function parsePlatformPublishingValidationEvidence(
  value: unknown,
): PlatformPublishingValidationEvidence {
  const r = record(value, [
    "evidenceReference",
    "snapshotReference",
    "snapshotDigest",
    "scope",
    "result",
    "checkedAt",
    "validUntil",
    "checkCodes",
  ]);
  if (r.result !== "Pass") fail();
  const checkedAt = parsePublishingInstant(r.checkedAt),
    validUntil = parsePublishingInstant(r.validUntil);
  if (checkedAt >= validUntil) fail();
  return Object.freeze({
    evidenceReference: parsePublishingReference(r.evidenceReference),
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    scope: parsePlatformPublishingScope(r.scope),
    result: "Pass",
    checkedAt,
    validUntil,
    checkCodes: codes(r.checkCodes),
  });
}
export function parsePlatformPublishingApprovalEvidence(
  value: unknown,
): PlatformPublishingApprovalEvidence {
  const r = record(value, [
    "evidenceReference",
    "reviewLifecycleId",
    "reviewVersion",
    "snapshotReference",
    "snapshotDigest",
    "scope",
    "decision",
    "approvedActorReference",
    "approvedAt",
    "validUntil",
    "authoredActorReference",
    "submittedActorReference",
  ]);
  if (r.decision !== "Accepted") fail();
  const approvedAt = parsePublishingInstant(r.approvedAt),
    validUntil = parsePublishingInstant(r.validUntil);
  const approvedActorReference = parsePublishingReference(r.approvedActorReference),
    authoredActorReference = parsePublishingReference(r.authoredActorReference),
    submittedActorReference = parsePublishingReference(r.submittedActorReference);
  if (
    approvedAt >= validUntil ||
    approvedActorReference === authoredActorReference ||
    approvedActorReference === submittedActorReference
  )
    fail();
  return Object.freeze({
    evidenceReference: parsePublishingReference(r.evidenceReference),
    reviewLifecycleId: parsePublishingReference(r.reviewLifecycleId),
    reviewVersion: parsePublishingVersion(r.reviewVersion),
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    scope: parsePlatformPublishingScope(r.scope),
    decision: "Accepted",
    approvedActorReference,
    approvedAt,
    validUntil,
    authoredActorReference,
    submittedActorReference,
  });
}
export function parsePlatformPublishingReleaseRecord(
  value: unknown,
): PlatformPublishingReleaseRecord {
  const r = record(value, [
    "releaseId",
    "familyReference",
    "configurationType",
    "purposeCode",
    "snapshotReference",
    "snapshotDigest",
    "scope",
    "sequence",
    "sourceLifecycleId",
    "kind",
    "previousReleaseId",
    "createdAt",
  ]);
  fixedFamily(r);
  if (r.kind !== "Publish" && r.kind !== "Rollback") fail();
  const sequence = parseReleaseSequence(r.sequence),
    previousReleaseId = referenceOrNull(r.previousReleaseId),
    releaseId = parsePublishingReference(r.releaseId);
  if ((sequence === 1) !== (previousReleaseId === null) || previousReleaseId === releaseId) fail();
  return Object.freeze({
    releaseId,
    familyReference: parsePublishingReference(r.familyReference),
    configurationType: platformBrandTemplateConfigurationType,
    purposeCode: platformBrandTemplateConfigurationType,
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    scope: parsePlatformPublishingScope(r.scope),
    sequence,
    sourceLifecycleId: parsePublishingReference(r.sourceLifecycleId),
    kind: r.kind,
    previousReleaseId,
    createdAt: parsePublishingInstant(r.createdAt),
  });
}
export function parsePlatformPublishingCommand(value: unknown): PlatformPublishingCommand {
  const r = record(value, [
    "profile",
    "operation",
    "operationReference",
    "currentActorReference",
    "expectedVersion",
    "current",
    "next",
    "validationEvidence",
    "approvalEvidence",
    "release",
    "previousRelease",
    "rollbackTarget",
    "occurredAt",
  ]);
  if (
    r.profile !== "PlatformPublishingCommandV1" ||
    typeof r.operation !== "string" ||
    !publishingOperations.includes(r.operation as PublishingOperation)
  )
    fail();
  return Object.freeze({
    profile: "PlatformPublishingCommandV1",
    operation: r.operation as PublishingOperation,
    operationReference: parsePublishingReference(r.operationReference),
    currentActorReference: parsePublishingReference(r.currentActorReference),
    expectedVersion: parsePublishingVersion(r.expectedVersion),
    current: r.current === null ? null : parsePlatformPublishingLifecycleRecord(r.current),
    next: parsePlatformPublishingLifecycleRecord(r.next),
    validationEvidence:
      r.validationEvidence === null
        ? null
        : parsePlatformPublishingValidationEvidence(r.validationEvidence),
    approvalEvidence:
      r.approvalEvidence === null
        ? null
        : parsePlatformPublishingApprovalEvidence(r.approvalEvidence),
    release: r.release === null ? null : parsePlatformPublishingReleaseRecord(r.release),
    previousRelease:
      r.previousRelease === null ? null : parsePlatformPublishingReleaseRecord(r.previousRelease),
    rollbackTarget:
      r.rollbackTarget === null ? null : parsePlatformPublishingReleaseRecord(r.rollbackTarget),
    occurredAt: parsePublishingInstant(r.occurredAt),
  });
}
export function platformPublishingCommandDigest(
  value: unknown,
): PublishingLifecycleRecord["snapshotDigest"] {
  return parsePublishingDigest(
    `sha256:${sha256Hex(canonicalizeRfc8785(parsePlatformPublishingCommand(value)))}`,
  );
}
function sameSnapshot(
  left: PlatformPublishingLifecycleRecord,
  right:
    | PlatformPublishingValidationEvidence
    | PlatformPublishingApprovalEvidence
    | PlatformPublishingReleaseRecord,
): boolean {
  return (
    left.snapshotReference === right.snapshotReference &&
    left.snapshotDigest === right.snapshotDigest
  );
}
function sameFamily(
  left: PlatformPublishingLifecycleRecord,
  right: PlatformPublishingReleaseRecord,
): boolean {
  return (
    left.familyReference === right.familyReference &&
    left.configurationType === right.configurationType &&
    left.purposeCode === right.purposeCode
  );
}
/** Pure business validation only. The caller must supply real owning facts and authority. */
export function validatePlatformPublishingTransition(value: unknown): PlatformPublishingCommand {
  const command = parsePlatformPublishingCommand(value);
  const {
    operation,
    current,
    next,
    validationEvidence: validation,
    approvalEvidence: approval,
    release,
    previousRelease: previous,
    rollbackTarget: target,
    occurredAt: at,
  } = command;
  if (
    !evaluatePublishingTransition({
      operation,
      current,
      next,
      expectedVersion: command.expectedVersion,
    }).allowed ||
    next.changedAt !== at
  )
    fail();
  if (
    current &&
    current.snapshotReference === next.snapshotReference &&
    (current.snapshotDigest !== next.snapshotDigest ||
      current.authoredActorReference !== next.authoredActorReference)
  )
    fail();
  if (operation === "CreateDraft") {
    if (
      next.authoredActorReference !== command.currentActorReference ||
      validation !== null ||
      approval !== null ||
      release !== null ||
      previous !== null ||
      target !== null ||
      (current === null && next.createdAt !== at)
    )
      fail();
    return command;
  }
  if (
    !current ||
    next.authoredActorReference !== current.authoredActorReference ||
    !validation ||
    !sameSnapshot(next, validation) ||
    validation.evidenceReference !== next.validationEvidenceReference ||
    validation.checkedAt > at
  )
    fail();
  if (operation === "SubmitReview") {
    if (
      next.submittedActorReference !== command.currentActorReference ||
      next.reviewValidUntil !== validation.validUntil ||
      validation.checkedAt < current.changedAt ||
      at >= validation.validUntil ||
      approval !== null ||
      release !== null ||
      previous !== null ||
      target !== null
    )
      fail();
    return command;
  }
  if (
    next.submittedActorReference !== current.submittedActorReference ||
    next.reviewValidUntil !== current.reviewValidUntil ||
    validation.validUntil !== current.reviewValidUntil ||
    !approval ||
    !sameSnapshot(next, approval) ||
    approval.evidenceReference !== next.approvalEvidenceReference ||
    approval.reviewLifecycleId !== current.lifecycleId ||
    approval.authoredActorReference !== current.authoredActorReference ||
    approval.submittedActorReference !== current.submittedActorReference ||
    approval.validUntil !== current.reviewValidUntil ||
    approval.approvedAt > at
  )
    fail();
  const reviewVersion =
    operation === "Approve" ? current.version : current.version - (operation === "Archive" ? 2 : 1);
  if (approval.reviewVersion !== reviewVersion) fail();
  if (
    operation !== "Archive" &&
    (current.reviewValidUntil === null || at >= current.reviewValidUntil)
  )
    fail();
  if (operation === "Approve") {
    if (
      validation.checkedAt > current.changedAt ||
      approval.approvedActorReference !== command.currentActorReference ||
      approval.approvedAt !== at ||
      approval.approvedAt < current.changedAt ||
      release !== null ||
      previous !== null ||
      target !== null
    )
      fail();
    return command;
  }
  if (validation.checkedAt > approval.approvedAt || approval.approvedAt > current.changedAt) fail();
  if (operation === "Archive") {
    if (release !== null || previous !== null || target !== null) fail();
    return command;
  }
  if (
    !release ||
    !sameFamily(next, release) ||
    !sameSnapshot(next, release) ||
    release.sourceLifecycleId !== next.lifecycleId ||
    release.kind !== operation ||
    release.createdAt !== at ||
    release.sequence !== (previous === null ? 1 : previous.sequence + 1) ||
    release.previousReleaseId !== (previous?.releaseId ?? null)
  )
    fail();
  if (
    previous &&
    (!sameFamily(next, previous) ||
      previous.createdAt > at ||
      previous.releaseId === release.releaseId)
  )
    fail();
  if (operation === "Publish") {
    if (target !== null) fail();
  } else if (
    !previous ||
    !target ||
    !sameFamily(next, target) ||
    !sameSnapshot(next, target) ||
    target.releaseId === previous.releaseId ||
    target.releaseId === release.releaseId ||
    target.sequence >= previous.sequence ||
    target.createdAt >= at
  )
    fail();
  return command;
}
