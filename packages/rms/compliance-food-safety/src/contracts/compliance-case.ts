import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  findingSeverities,
  type ComplianceCode,
  type ComplianceReference,
  type ComplianceScope,
  type FindingSeverity,
} from "./compliance-dashboard.js";

export const complianceCaseTypes = [
  "LicensePermit",
  "FoodSafetyInspection",
  "TemperatureMonitoring",
  "AllergenControl",
  "CleaningSanitation",
  "EmployeeCertification",
  "SupplierProductCompliance",
  "RegulatoryAudit",
  "FoodSafetyIncident",
  "ComplianceInvestigation",
  "CorrectiveAction",
  "RecallWithdrawal",
  "Other",
] as const;
export type ComplianceCaseType = (typeof complianceCaseTypes)[number];
export const complianceCaseLifecycles = [
  "Open",
  "Investigating",
  "CorrectiveAction",
  "Verification",
  "Closed",
  "OnHold",
  "Escalated",
  "Cancelled",
] as const;
export type ComplianceCaseLifecycle = (typeof complianceCaseLifecycles)[number];
export const complianceScopeKinds = [
  "Brand",
  "LegalEntity",
  "Store",
  "OperationalLocation",
  "EmployeeQualification",
  "SupplierOffering",
  "InventoryLotBatch",
  "ProductRecipeAllergen",
  "DeviceSensor",
  "OrderFulfillment",
  "ExternalAuthority",
] as const;
export type ComplianceRelatedScopeKind = (typeof complianceScopeKinds)[number];

export interface ComplianceRelatedScope {
  readonly kind: ComplianceRelatedScopeKind;
  readonly reference: ComplianceReference;
  readonly snapshotCode: ComplianceCode;
}
export interface ComplianceCaseSnapshot {
  readonly caseReference: ComplianceReference;
  readonly revisionReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly aggregateVersion: number;
  readonly caseType: ComplianceCaseType;
  readonly severity: FindingSeverity;
  readonly lifecycle: ComplianceCaseLifecycle;
  readonly ownerReference: ComplianceReference | null;
  readonly deadlineAt: string | null;
  readonly deadlineTimezone: string | null;
  readonly primaryScope: ComplianceRelatedScope;
  readonly supportingScopes: readonly ComplianceRelatedScope[];
  readonly requirementVersionReferences: readonly ComplianceReference[];
  readonly openedAt: string;
  readonly openedByActorReference: ComplianceReference;
  readonly cancellationReasonCode: ComplianceCode | null;
  readonly closedAt: string | null;
}

export const containmentActions = [
  "StopSelling",
  "StopProduction",
  "StopReceiving",
  "HoldInventory",
  "DisableEquipment",
  "SuspendDeliveryPickup",
  "StoreEmergencyClosure",
] as const;
export type ContainmentAction = (typeof containmentActions)[number];
export interface ComplianceContainmentRecord {
  readonly containmentReference: ComplianceReference;
  readonly caseReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly sequence: number;
  readonly action: ContainmentAction;
  readonly hardBlock: boolean;
  readonly targetScope: ComplianceRelatedScope;
  readonly status: "Requested" | "Applied" | "Rejected" | "Failed" | "Released";
  readonly ownerActionReference: ComplianceReference | null;
  readonly releaseVerificationReference: ComplianceReference | null;
  readonly requestedAt: string;
  readonly occurredAt: string;
  readonly actorReference: ComplianceReference;
}

export const regulatoryNotificationStatuses = [
  "Required",
  "Preparing",
  "Submitted",
  "Acknowledged",
  "RejectedReturned",
  "Completed",
  "NotRequired",
] as const;
export type RegulatoryNotificationStatus = (typeof regulatoryNotificationStatuses)[number];
export interface RegulatoryNotificationRecord {
  readonly notificationReference: ComplianceReference;
  readonly caseReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly sequence: number;
  readonly authorityReference: ComplianceReference;
  readonly requirementVersionReference: ComplianceReference;
  readonly deadlineAt: string;
  readonly status: RegulatoryNotificationStatus;
  readonly submissionReference: ComplianceReference | null;
  readonly basisCode: ComplianceCode | null;
  readonly occurredAt: string;
  readonly actorReference: ComplianceReference;
}

const invalid = (): never => {
  throw new Error("Compliance Case input is invalid");
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
const timezone = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 64) return invalid();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
  } catch {
    return invalid();
  }
  return value;
};
function unique<T>(value: unknown, parse: (item: unknown) => T, maximum: number): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  const parsed = value.map(parse);
  if (new Set(parsed.map((item) => JSON.stringify(item))).size !== parsed.length) return invalid();
  return Object.freeze(parsed);
}
export function createComplianceRelatedScope(value: unknown): ComplianceRelatedScope {
  const raw = exact(value, ["kind", "reference", "snapshotCode"]);
  return Object.freeze({
    kind: oneOf(raw.kind, complianceScopeKinds),
    reference: parseComplianceReference(raw.reference),
    snapshotCode: parseComplianceCode(raw.snapshotCode),
  });
}
export function createComplianceCaseSnapshot(value: unknown): ComplianceCaseSnapshot {
  const raw = exact(value, [
    "caseReference",
    "revisionReference",
    "scope",
    "aggregateVersion",
    "caseType",
    "severity",
    "lifecycle",
    "ownerReference",
    "deadlineAt",
    "deadlineTimezone",
    "primaryScope",
    "supportingScopes",
    "requirementVersionReferences",
    "openedAt",
    "openedByActorReference",
    "cancellationReasonCode",
    "closedAt",
  ]);
  const severity = oneOf(raw.severity, findingSeverities);
  const lifecycle = oneOf(raw.lifecycle, complianceCaseLifecycles);
  const ownerReference =
    raw.ownerReference === null ? null : parseComplianceReference(raw.ownerReference);
  const deadlineAt = raw.deadlineAt === null ? null : parseComplianceInstant(raw.deadlineAt);
  const deadlineTimezone = raw.deadlineTimezone === null ? null : timezone(raw.deadlineTimezone);
  const cancellationReasonCode =
    raw.cancellationReasonCode === null ? null : parseComplianceCode(raw.cancellationReasonCode);
  const closedAt = raw.closedAt === null ? null : parseComplianceInstant(raw.closedAt);
  if (
    (deadlineAt === null) !== (deadlineTimezone === null) ||
    ((severity === "Critical" || severity === "ImmediateDanger") &&
      (ownerReference === null || deadlineAt === null)) ||
    (lifecycle === "Cancelled") !== (cancellationReasonCode !== null) ||
    (lifecycle === "Closed") !== (closedAt !== null)
  )
    return invalid();
  const openedAt = parseComplianceInstant(raw.openedAt);
  if (
    (deadlineAt !== null && Date.parse(deadlineAt) <= Date.parse(openedAt)) ||
    (closedAt !== null && Date.parse(closedAt) < Date.parse(openedAt))
  )
    return invalid();
  const requirementVersionReferences = unique(
    raw.requirementVersionReferences,
    parseComplianceReference,
    20,
  );
  if (requirementVersionReferences.length === 0) return invalid();
  return Object.freeze({
    caseReference: parseComplianceReference(raw.caseReference),
    revisionReference: parseComplianceReference(raw.revisionReference),
    scope: parseComplianceScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    caseType: oneOf(raw.caseType, complianceCaseTypes),
    severity,
    lifecycle,
    ownerReference,
    deadlineAt,
    deadlineTimezone,
    primaryScope: createComplianceRelatedScope(raw.primaryScope),
    supportingScopes: unique(raw.supportingScopes, createComplianceRelatedScope, 20),
    requirementVersionReferences,
    openedAt,
    openedByActorReference: parseComplianceReference(raw.openedByActorReference),
    cancellationReasonCode,
    closedAt,
  });
}
export function createComplianceContainmentRecord(value: unknown): ComplianceContainmentRecord {
  const raw = exact(value, [
    "containmentReference",
    "caseReference",
    "scope",
    "sequence",
    "action",
    "hardBlock",
    "targetScope",
    "status",
    "ownerActionReference",
    "releaseVerificationReference",
    "requestedAt",
    "occurredAt",
    "actorReference",
  ]);
  const status = oneOf(raw.status, [
    "Requested",
    "Applied",
    "Rejected",
    "Failed",
    "Released",
  ] as const);
  const ownerActionReference =
    raw.ownerActionReference === null ? null : parseComplianceReference(raw.ownerActionReference);
  const releaseVerificationReference =
    raw.releaseVerificationReference === null
      ? null
      : parseComplianceReference(raw.releaseVerificationReference);
  if (
    typeof raw.hardBlock !== "boolean" ||
    (status === "Requested") !== (ownerActionReference === null) ||
    (status === "Released") !== (releaseVerificationReference !== null)
  )
    return invalid();
  const requestedAt = parseComplianceInstant(raw.requestedAt);
  const occurredAt = parseComplianceInstant(raw.occurredAt);
  if (Date.parse(occurredAt) < Date.parse(requestedAt)) return invalid();
  return Object.freeze({
    containmentReference: parseComplianceReference(raw.containmentReference),
    caseReference: parseComplianceReference(raw.caseReference),
    scope: parseComplianceScope(raw.scope),
    sequence: positive(raw.sequence),
    action: oneOf(raw.action, containmentActions),
    hardBlock: raw.hardBlock,
    targetScope: createComplianceRelatedScope(raw.targetScope),
    status,
    ownerActionReference,
    releaseVerificationReference,
    requestedAt,
    occurredAt,
    actorReference: parseComplianceReference(raw.actorReference),
  });
}
export function createRegulatoryNotificationRecord(value: unknown): RegulatoryNotificationRecord {
  const raw = exact(value, [
    "notificationReference",
    "caseReference",
    "scope",
    "sequence",
    "authorityReference",
    "requirementVersionReference",
    "deadlineAt",
    "status",
    "submissionReference",
    "basisCode",
    "occurredAt",
    "actorReference",
  ]);
  const status = oneOf(raw.status, regulatoryNotificationStatuses);
  const submissionReference =
    raw.submissionReference === null ? null : parseComplianceReference(raw.submissionReference);
  const basisCode = raw.basisCode === null ? null : parseComplianceCode(raw.basisCode);
  const submitted = ["Submitted", "Acknowledged", "RejectedReturned", "Completed"].includes(status);
  if (
    submitted !== (submissionReference !== null) ||
    (status === "NotRequired") !== (basisCode !== null)
  )
    return invalid();
  return Object.freeze({
    notificationReference: parseComplianceReference(raw.notificationReference),
    caseReference: parseComplianceReference(raw.caseReference),
    scope: parseComplianceScope(raw.scope),
    sequence: positive(raw.sequence),
    authorityReference: parseComplianceReference(raw.authorityReference),
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    deadlineAt: parseComplianceInstant(raw.deadlineAt),
    status,
    submissionReference,
    basisCode,
    occurredAt: parseComplianceInstant(raw.occurredAt),
    actorReference: parseComplianceReference(raw.actorReference),
  });
}
