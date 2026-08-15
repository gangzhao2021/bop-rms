import { createComplianceRelatedScope, type ComplianceRelatedScope } from "./compliance-case.js";
import {
  findingSeverities,
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceCode,
  type ComplianceReference,
  type ComplianceScope,
  type FindingSeverity,
} from "./compliance-dashboard.js";

export const inspectionTypes = [
  "InternalSelfInspection",
  "ManagerInspection",
  "ThirdPartyAudit",
  "RegulatoryInspection",
  "TriggeredInvestigation",
] as const;
export type InspectionType = (typeof inspectionTypes)[number];
export const inspectionStatuses = [
  "Draft",
  "Scheduled",
  "InProgress",
  "Finalized",
  "Cancelled",
] as const;
export type InspectionStatus = (typeof inspectionStatuses)[number];
export const findingStatuses = [
  "Open",
  "AcceptedRisk",
  "CorrectiveActionInProgress",
  "PendingVerification",
  "Resolved",
  "NotApplicable",
] as const;
export type FindingStatus = (typeof findingStatuses)[number];
export const correctiveActionStatuses = [
  "Planned",
  "InProgress",
  "Blocked",
  "Completed",
  "VerificationFailed",
  "Verified",
  "Cancelled",
] as const;
export type CorrectiveActionStatus = (typeof correctiveActionStatuses)[number];
export const correctiveActionPriorities = ["Low", "Medium", "High", "Critical"] as const;
export type CorrectiveActionPriority = (typeof correctiveActionPriorities)[number];
export const verificationResults = [
  "Passed",
  "PassedWithConditions",
  "Failed",
  "UnableToVerify",
] as const;
export type VerificationResult = (typeof verificationResults)[number];

export interface ComplianceInspectionRecord {
  readonly inspectionReference: ComplianceReference;
  readonly revisionReference: ComplianceReference;
  readonly priorRevisionReference: ComplianceReference | null;
  readonly caseReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly aggregateVersion: number;
  readonly recordVersion: number;
  readonly inspectionType: InspectionType;
  readonly status: InspectionStatus;
  readonly checklistVersionReference: ComplianceReference;
  readonly requirementVersionReference: ComplianceReference;
  readonly inspectionScope: ComplianceRelatedScope;
  readonly inspectorReference: ComplianceReference;
  readonly authorityReference: ComplianceReference | null;
  readonly scheduledAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly internalRatingCode: ComplianceCode | null;
  readonly authorityRatingCode: ComplianceCode | null;
  readonly evidenceReferences: readonly ComplianceReference[];
  readonly immediateActionCode: ComplianceCode | null;
  readonly followUpRequirementCode: ComplianceCode | null;
  readonly changeReasonCode: ComplianceCode | null;
  readonly recordedAt: string;
  readonly actorReference: ComplianceReference;
}

export interface ComplianceFindingRecord {
  readonly findingReference: ComplianceReference;
  readonly revisionReference: ComplianceReference;
  readonly priorRevisionReference: ComplianceReference | null;
  readonly caseReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly aggregateVersion: number;
  readonly recordVersion: number;
  readonly inspectionReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly hardRequirement: boolean;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly evidenceReferences: readonly ComplianceReference[];
  readonly ownerActionReference: ComplianceReference | null;
  readonly riskReviewAt: string | null;
  readonly recordedAt: string;
  readonly actorReference: ComplianceReference;
}

export interface ComplianceCorrectiveActionRecord {
  readonly actionReference: ComplianceReference;
  readonly revisionReference: ComplianceReference;
  readonly priorRevisionReference: ComplianceReference | null;
  readonly caseReference: ComplianceReference;
  readonly findingReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly aggregateVersion: number;
  readonly recordVersion: number;
  readonly requirementVersionReference: ComplianceReference;
  readonly hardRequirement: boolean;
  readonly severity: FindingSeverity;
  readonly requiredActionCode: ComplianceCode;
  readonly ownerReference: ComplianceReference;
  readonly dueAt: string;
  readonly dueTimezone: string;
  readonly priority: CorrectiveActionPriority;
  readonly status: CorrectiveActionStatus;
  readonly completionEvidenceReferences: readonly ComplianceReference[];
  readonly ownerOutcomeReference: ComplianceReference | null;
  readonly completedByActorReference: ComplianceReference | null;
  readonly verifierReference: ComplianceReference | null;
  readonly verificationResult: VerificationResult | null;
  readonly verificationEvidenceReference: ComplianceReference | null;
  readonly conditionCode: ComplianceCode | null;
  readonly conditionExpiresAt: string | null;
  readonly reviewAt: string | null;
  readonly followUpTaskReference: ComplianceReference | null;
  readonly recordedAt: string;
  readonly actorReference: ComplianceReference;
}

const invalid = (): never => {
  throw new Error("Compliance Inspection/Action input is invalid");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : invalid();
const positive = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : invalid();
const nullable = <T>(value: unknown, parse: (item: unknown) => T): T | null =>
  value === null ? null : parse(value);
const timezone = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 64) return invalid();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
  } catch {
    return invalid();
  }
  return value;
};
function references(value: unknown, maximum = 20): readonly ComplianceReference[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const parsed = value.map(parseComplianceReference);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return Object.freeze(parsed);
}
function revision(recordVersion: number, priorRevisionReference: ComplianceReference | null) {
  if ((recordVersion === 1) !== (priorRevisionReference === null)) return invalid();
}

export function createComplianceInspectionRecord(value: unknown): ComplianceInspectionRecord {
  const raw = exact(value, [
    "inspectionReference",
    "revisionReference",
    "priorRevisionReference",
    "caseReference",
    "scope",
    "aggregateVersion",
    "recordVersion",
    "inspectionType",
    "status",
    "checklistVersionReference",
    "requirementVersionReference",
    "inspectionScope",
    "inspectorReference",
    "authorityReference",
    "scheduledAt",
    "startedAt",
    "completedAt",
    "internalRatingCode",
    "authorityRatingCode",
    "evidenceReferences",
    "immediateActionCode",
    "followUpRequirementCode",
    "changeReasonCode",
    "recordedAt",
    "actorReference",
  ]);
  const recordVersion = positive(raw.recordVersion);
  const status = oneOf(raw.status, inspectionStatuses);
  const inspectionType = oneOf(raw.inspectionType, inspectionTypes);
  const priorRevisionReference = nullable(raw.priorRevisionReference, parseComplianceReference);
  const changeReasonCode = nullable(raw.changeReasonCode, parseComplianceCode);
  revision(recordVersion, priorRevisionReference);
  if ((recordVersion > 1 || status === "Cancelled") && changeReasonCode === null) return invalid();
  const authorityReference = nullable(raw.authorityReference, parseComplianceReference);
  if (
    (inspectionType === "RegulatoryInspection" || inspectionType === "ThirdPartyAudit") &&
    authorityReference === null
  )
    return invalid();
  const scheduledAt = nullable(raw.scheduledAt, parseComplianceInstant);
  const startedAt = nullable(raw.startedAt, parseComplianceInstant);
  const completedAt = nullable(raw.completedAt, parseComplianceInstant);
  if (
    (status === "Scheduled" &&
      (scheduledAt === null || startedAt !== null || completedAt !== null)) ||
    (status === "InProgress" &&
      (scheduledAt === null || startedAt === null || completedAt !== null)) ||
    (status === "Finalized" && (startedAt === null || completedAt === null)) ||
    (status === "Draft" && (startedAt !== null || completedAt !== null)) ||
    (status === "Cancelled" && completedAt !== null) ||
    (startedAt !== null &&
      scheduledAt !== null &&
      Date.parse(startedAt) < Date.parse(scheduledAt)) ||
    (completedAt !== null && startedAt !== null && Date.parse(completedAt) < Date.parse(startedAt))
  )
    return invalid();
  return Object.freeze({
    inspectionReference: parseComplianceReference(raw.inspectionReference),
    revisionReference: parseComplianceReference(raw.revisionReference),
    priorRevisionReference,
    caseReference: parseComplianceReference(raw.caseReference),
    scope: parseComplianceScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    recordVersion,
    inspectionType,
    status,
    checklistVersionReference: parseComplianceReference(raw.checklistVersionReference),
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    inspectionScope: createComplianceRelatedScope(raw.inspectionScope),
    inspectorReference: parseComplianceReference(raw.inspectorReference),
    authorityReference,
    scheduledAt,
    startedAt,
    completedAt,
    internalRatingCode: nullable(raw.internalRatingCode, parseComplianceCode),
    authorityRatingCode: nullable(raw.authorityRatingCode, parseComplianceCode),
    evidenceReferences: references(raw.evidenceReferences),
    immediateActionCode: nullable(raw.immediateActionCode, parseComplianceCode),
    followUpRequirementCode: nullable(raw.followUpRequirementCode, parseComplianceCode),
    changeReasonCode,
    recordedAt: parseComplianceInstant(raw.recordedAt),
    actorReference: parseComplianceReference(raw.actorReference),
  });
}

export function createComplianceFindingRecord(value: unknown): ComplianceFindingRecord {
  const raw = exact(value, [
    "findingReference",
    "revisionReference",
    "priorRevisionReference",
    "caseReference",
    "scope",
    "aggregateVersion",
    "recordVersion",
    "inspectionReference",
    "requirementVersionReference",
    "hardRequirement",
    "severity",
    "status",
    "evidenceReferences",
    "ownerActionReference",
    "riskReviewAt",
    "recordedAt",
    "actorReference",
  ]);
  const recordVersion = positive(raw.recordVersion);
  const priorRevisionReference = nullable(raw.priorRevisionReference, parseComplianceReference);
  revision(recordVersion, priorRevisionReference);
  if (typeof raw.hardRequirement !== "boolean") return invalid();
  const status = oneOf(raw.status, findingStatuses);
  const riskReviewAt = nullable(raw.riskReviewAt, parseComplianceInstant);
  if (
    (status === "AcceptedRisk" && (raw.hardRequirement || riskReviewAt === null)) ||
    (status !== "AcceptedRisk" && riskReviewAt !== null)
  )
    return invalid();
  return Object.freeze({
    findingReference: parseComplianceReference(raw.findingReference),
    revisionReference: parseComplianceReference(raw.revisionReference),
    priorRevisionReference,
    caseReference: parseComplianceReference(raw.caseReference),
    scope: parseComplianceScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    recordVersion,
    inspectionReference: nullable(raw.inspectionReference, parseComplianceReference),
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    hardRequirement: raw.hardRequirement,
    severity: oneOf(raw.severity, findingSeverities),
    status,
    evidenceReferences: references(raw.evidenceReferences),
    ownerActionReference: nullable(raw.ownerActionReference, parseComplianceReference),
    riskReviewAt,
    recordedAt: parseComplianceInstant(raw.recordedAt),
    actorReference: parseComplianceReference(raw.actorReference),
  });
}

export function createComplianceCorrectiveActionRecord(
  value: unknown,
): ComplianceCorrectiveActionRecord {
  const raw = exact(value, [
    "actionReference",
    "revisionReference",
    "priorRevisionReference",
    "caseReference",
    "findingReference",
    "scope",
    "aggregateVersion",
    "recordVersion",
    "requirementVersionReference",
    "hardRequirement",
    "severity",
    "requiredActionCode",
    "ownerReference",
    "dueAt",
    "dueTimezone",
    "priority",
    "status",
    "completionEvidenceReferences",
    "ownerOutcomeReference",
    "completedByActorReference",
    "verifierReference",
    "verificationResult",
    "verificationEvidenceReference",
    "conditionCode",
    "conditionExpiresAt",
    "reviewAt",
    "followUpTaskReference",
    "recordedAt",
    "actorReference",
  ]);
  const recordVersion = positive(raw.recordVersion);
  const priorRevisionReference = nullable(raw.priorRevisionReference, parseComplianceReference);
  revision(recordVersion, priorRevisionReference);
  if (typeof raw.hardRequirement !== "boolean") return invalid();
  const status = oneOf(raw.status, correctiveActionStatuses);
  const completionEvidenceReferences = references(raw.completionEvidenceReferences);
  const ownerOutcomeReference = nullable(raw.ownerOutcomeReference, parseComplianceReference);
  const completedByActorReference = nullable(
    raw.completedByActorReference,
    parseComplianceReference,
  );
  const verifierReference = nullable(raw.verifierReference, parseComplianceReference);
  const verificationResult = nullable(raw.verificationResult, (item) =>
    oneOf(item, verificationResults),
  );
  const verificationEvidenceReference = nullable(
    raw.verificationEvidenceReference,
    parseComplianceReference,
  );
  const conditionCode = nullable(raw.conditionCode, parseComplianceCode);
  const conditionExpiresAt = nullable(raw.conditionExpiresAt, parseComplianceInstant);
  const reviewAt = nullable(raw.reviewAt, parseComplianceInstant);
  const followUpTaskReference = nullable(raw.followUpTaskReference, parseComplianceReference);
  const complete = ["Completed", "VerificationFailed", "Verified"].includes(status);
  const verified = status === "Verified";
  const failed = status === "VerificationFailed";
  const unable = status === "Completed" && verificationResult === "UnableToVerify";
  if (
    complete !==
      (completionEvidenceReferences.length > 0 &&
        ownerOutcomeReference !== null &&
        completedByActorReference !== null) ||
    (verified && !["Passed", "PassedWithConditions"].includes(verificationResult ?? "")) ||
    (failed && verificationResult !== "Failed") ||
    (!verified && !failed && !unable && verificationResult !== null) ||
    (verificationResult === null) !== (verifierReference === null) ||
    (verificationResult === null) !== (verificationEvidenceReference === null) ||
    (verificationResult === "PassedWithConditions") !==
      (conditionCode !== null && conditionExpiresAt !== null && reviewAt !== null) ||
    (verificationResult !== "PassedWithConditions" &&
      (conditionCode !== null || conditionExpiresAt !== null || reviewAt !== null)) ||
    unable !== (followUpTaskReference !== null) ||
    (verificationResult === "PassedWithConditions" &&
      (Date.parse(conditionExpiresAt ?? "") <= Date.parse(String(raw.recordedAt)) ||
        Date.parse(reviewAt ?? "") > Date.parse(conditionExpiresAt ?? "")))
  )
    return invalid();
  return Object.freeze({
    actionReference: parseComplianceReference(raw.actionReference),
    revisionReference: parseComplianceReference(raw.revisionReference),
    priorRevisionReference,
    caseReference: parseComplianceReference(raw.caseReference),
    findingReference: parseComplianceReference(raw.findingReference),
    scope: parseComplianceScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    recordVersion,
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    hardRequirement: raw.hardRequirement,
    severity: oneOf(raw.severity, findingSeverities),
    requiredActionCode: parseComplianceCode(raw.requiredActionCode),
    ownerReference: parseComplianceReference(raw.ownerReference),
    dueAt: parseComplianceInstant(raw.dueAt),
    dueTimezone: timezone(raw.dueTimezone),
    priority: oneOf(raw.priority, correctiveActionPriorities),
    status,
    completionEvidenceReferences,
    ownerOutcomeReference,
    completedByActorReference,
    verifierReference,
    verificationResult,
    verificationEvidenceReference,
    conditionCode,
    conditionExpiresAt,
    reviewAt,
    followUpTaskReference,
    recordedAt: parseComplianceInstant(raw.recordedAt),
    actorReference: parseComplianceReference(raw.actorReference),
  });
}
