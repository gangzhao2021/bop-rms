import { parseCanonicalInstant, type CanonicalInstant } from "@bop/identity";

export const supportCaseErrorCodes = [
  "SUPPORT_CASE_INPUT_INVALID",
  "SUPPORT_CASE_PERMISSION_DENIED",
  "SUPPORT_CASE_PURPOSE_INVALID",
  "SUPPORT_CASE_MFA_REQUIRED",
  "SUPPORT_CASE_VERSION_CONFLICT",
  "SUPPORT_CASE_LIFECYCLE_CONFLICT",
  "SUPPORT_CASE_EVIDENCE_INVALID",
  "SUPPORT_CASE_APPROVAL_INVALID",
  "SUPPORT_CASE_SCOPE_INVALID",
  "SUPPORT_CASE_GRANT_INVALID",
  "SUPPORT_CASE_GRANT_EXPIRED",
  "SUPPORT_CASE_GRANT_REVOKED",
  "SUPPORT_CASE_IDEMPOTENCY_CONFLICT",
  "SUPPORT_CASE_DEPENDENCY_UNAVAILABLE",
] as const;
export type SupportCaseErrorCode = (typeof supportCaseErrorCodes)[number];
export class SupportCaseError extends Error {
  constructor(readonly code: SupportCaseErrorCode) {
    super("support case operation is unavailable");
    this.name = "SupportCaseError";
  }
}
export type SupportCaseReference = string & { readonly __supportCaseReference: unique symbol };
export type SupportCaseVersionNumber = number & { readonly __supportCaseVersion: unique symbol };
export const supportCaseStatuses = [
  "Open",
  "Assigned",
  "AccessPendingApproval",
  "AccessGranted",
  "Revoked",
  "Closed",
] as const;
export type SupportCaseStatus = (typeof supportCaseStatuses)[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u,
  permission = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,7}$/u;
const invalid = (): never => {
  throw new SupportCaseError("SUPPORT_CASE_INPUT_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    invalid();
  return value as Record<string, unknown>;
}
export function parseSupportCaseReference(value: unknown): SupportCaseReference {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value as SupportCaseReference;
}
const ref = parseSupportCaseReference;
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const exactCode = (value: unknown): string => {
  if (typeof value !== "string" || !code.test(value)) invalid();
  return value as string;
};
const instant = (value: unknown) => {
  try {
    return parseCanonicalInstant(value);
  } catch {
    return invalid();
  }
};
function permissions(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid();
  const items = value as unknown[];
  const result = Object.freeze(
    items.map((item: unknown) => {
      if (typeof item !== "string" || !permission.test(item)) invalid();
      return item as string;
    }),
  );
  if (new Set(result).size !== result.length) invalid();
  return result;
}

export interface SupportCaseVersion {
  readonly versionReference: SupportCaseReference;
  readonly caseReference: SupportCaseReference;
  readonly version: SupportCaseVersionNumber;
  readonly status: SupportCaseStatus;
  readonly tenantReference: SupportCaseReference;
  readonly storeReference: SupportCaseReference | null;
  readonly caseType: string;
  readonly purposeCode: string;
  readonly requesterActorReference: SupportCaseReference;
  readonly requesterVerificationEvidenceReference: SupportCaseReference;
  readonly assignedRoleReference: SupportCaseReference | null;
  readonly dueAt: CanonicalInstant;
  readonly supersedesVersionReference: SupportCaseReference | null;
  readonly reasonCode: string;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
  readonly dataClassification: "ConfidentialMetadata";
}
export function createSupportCaseVersion(value: unknown): SupportCaseVersion {
  const r = closed(value, [
    "versionReference",
    "caseReference",
    "version",
    "status",
    "tenantReference",
    "storeReference",
    "caseType",
    "purposeCode",
    "requesterActorReference",
    "requesterVerificationEvidenceReference",
    "assignedRoleReference",
    "dueAt",
    "supersedesVersionReference",
    "reasonCode",
    "createdAt",
    "updatedAt",
    "dataClassification",
  ]);
  if (
    !Number.isSafeInteger(r.version) ||
    (r.version as number) < 1 ||
    typeof r.status !== "string" ||
    !supportCaseStatuses.includes(r.status as SupportCaseStatus) ||
    r.dataClassification !== "ConfidentialMetadata"
  )
    invalid();
  const result: SupportCaseVersion = Object.freeze({
    versionReference: ref(r.versionReference),
    caseReference: ref(r.caseReference),
    version: r.version as SupportCaseVersionNumber,
    status: r.status as SupportCaseStatus,
    tenantReference: ref(r.tenantReference),
    storeReference: nullableRef(r.storeReference),
    caseType: exactCode(r.caseType),
    purposeCode: exactCode(r.purposeCode),
    requesterActorReference: ref(r.requesterActorReference),
    requesterVerificationEvidenceReference: ref(r.requesterVerificationEvidenceReference),
    assignedRoleReference: nullableRef(r.assignedRoleReference),
    dueAt: instant(r.dueAt),
    supersedesVersionReference: nullableRef(r.supersedesVersionReference),
    reasonCode: exactCode(r.reasonCode),
    createdAt: instant(r.createdAt),
    updatedAt: instant(r.updatedAt),
    dataClassification: "ConfidentialMetadata",
  });
  if (
    (result.version === 1) !== (result.supersedesVersionReference === null) ||
    Date.parse(result.updatedAt) < Date.parse(result.createdAt) ||
    (
      ["Assigned", "AccessPendingApproval", "AccessGranted", "Revoked"] as SupportCaseStatus[]
    ).includes(result.status) !==
      (result.assignedRoleReference !== null)
  )
    invalid();
  return result;
}

export interface DiagnosticAccessGrant {
  readonly grantReference: SupportCaseReference;
  readonly caseReference: SupportCaseReference;
  readonly tenantReference: SupportCaseReference;
  readonly storeReference: SupportCaseReference | null;
  readonly supportActorReference: SupportCaseReference;
  readonly requestedByReference: SupportCaseReference;
  readonly approvedByReference: SupportCaseReference;
  readonly approvalEvidenceReference: SupportCaseReference;
  readonly recentMfaEvidenceReference: SupportCaseReference;
  readonly purposeCode: string;
  readonly delegatedPermissions: readonly string[];
  readonly maskingPolicyReference: SupportCaseReference;
  readonly grantedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly dataClassification: "RestrictedAccessMetadata";
}
export function createDiagnosticAccessGrant(value: unknown): DiagnosticAccessGrant {
  const r = closed(value, [
    "grantReference",
    "caseReference",
    "tenantReference",
    "storeReference",
    "supportActorReference",
    "requestedByReference",
    "approvedByReference",
    "approvalEvidenceReference",
    "recentMfaEvidenceReference",
    "purposeCode",
    "delegatedPermissions",
    "maskingPolicyReference",
    "grantedAt",
    "expiresAt",
    "dataClassification",
  ]);
  const grantedAt = instant(r.grantedAt),
    expiresAt = instant(r.expiresAt);
  if (
    r.dataClassification !== "RestrictedAccessMetadata" ||
    Date.parse(expiresAt) <= Date.parse(grantedAt) ||
    Date.parse(expiresAt) - Date.parse(grantedAt) > 15 * 60_000
  )
    invalid();
  const result: DiagnosticAccessGrant = Object.freeze({
    grantReference: ref(r.grantReference),
    caseReference: ref(r.caseReference),
    tenantReference: ref(r.tenantReference),
    storeReference: nullableRef(r.storeReference),
    supportActorReference: ref(r.supportActorReference),
    requestedByReference: ref(r.requestedByReference),
    approvedByReference: ref(r.approvedByReference),
    approvalEvidenceReference: ref(r.approvalEvidenceReference),
    recentMfaEvidenceReference: ref(r.recentMfaEvidenceReference),
    purposeCode: exactCode(r.purposeCode),
    delegatedPermissions: permissions(r.delegatedPermissions),
    maskingPolicyReference: ref(r.maskingPolicyReference),
    grantedAt,
    expiresAt,
    dataClassification: "RestrictedAccessMetadata",
  });
  if (result.requestedByReference === result.approvedByReference) invalid();
  return result;
}

export interface SupportActionRecord {
  readonly actionReference: SupportCaseReference;
  readonly caseReference: SupportCaseReference;
  readonly grantReference: SupportCaseReference;
  readonly supportActorReference: SupportCaseReference;
  readonly delegatedPermission: string;
  readonly targetType: string;
  readonly targetReference: SupportCaseReference;
  readonly reasonCode: string;
  readonly evidenceReference: SupportCaseReference;
  readonly occurredAt: CanonicalInstant;
  readonly dataClassification: "RestrictedAccessMetadata";
}
export function createSupportActionRecord(value: unknown): SupportActionRecord {
  const r = closed(value, [
    "actionReference",
    "caseReference",
    "grantReference",
    "supportActorReference",
    "delegatedPermission",
    "targetType",
    "targetReference",
    "reasonCode",
    "evidenceReference",
    "occurredAt",
    "dataClassification",
  ]);
  if (
    r.dataClassification !== "RestrictedAccessMetadata" ||
    typeof r.delegatedPermission !== "string" ||
    !permission.test(r.delegatedPermission)
  )
    invalid();
  return Object.freeze({
    actionReference: ref(r.actionReference),
    caseReference: ref(r.caseReference),
    grantReference: ref(r.grantReference),
    supportActorReference: ref(r.supportActorReference),
    delegatedPermission: r.delegatedPermission as string,
    targetType: exactCode(r.targetType),
    targetReference: ref(r.targetReference),
    reasonCode: exactCode(r.reasonCode),
    evidenceReference: ref(r.evidenceReference),
    occurredAt: instant(r.occurredAt),
    dataClassification: "RestrictedAccessMetadata",
  });
}

export interface SupportCaseOperationInput {
  readonly operationReference: SupportCaseReference;
  readonly expectedVersion: number;
  readonly actorReference: SupportCaseReference;
  readonly purposeCode: string;
  readonly auditReference: SupportCaseReference;
  readonly occurredAt: CanonicalInstant;
  readonly candidate: SupportCaseVersion;
  readonly grant: DiagnosticAccessGrant | null;
  readonly action: SupportActionRecord | null;
  readonly grantReference: SupportCaseReference | null;
}
export function createSupportCaseOperationInput(value: unknown): SupportCaseOperationInput {
  const r = closed(value, [
    "operationReference",
    "expectedVersion",
    "actorReference",
    "purposeCode",
    "auditReference",
    "occurredAt",
    "candidate",
    "grant",
    "action",
    "grantReference",
  ]);
  if (!Number.isSafeInteger(r.expectedVersion) || (r.expectedVersion as number) < 0) invalid();
  return Object.freeze({
    operationReference: ref(r.operationReference),
    expectedVersion: r.expectedVersion as number,
    actorReference: ref(r.actorReference),
    purposeCode: exactCode(r.purposeCode),
    auditReference: ref(r.auditReference),
    occurredAt: instant(r.occurredAt),
    candidate: createSupportCaseVersion(r.candidate),
    grant: r.grant === null ? null : createDiagnosticAccessGrant(r.grant),
    action: r.action === null ? null : createSupportActionRecord(r.action),
    grantReference: nullableRef(r.grantReference),
  });
}
