import {
  parseBrandReference,
  parseCanonicalInstant,
  type BrandReference,
  type CanonicalInstant,
} from "../domain/brand-store.js";

export const platformTenantAdministrationErrorCodes = [
  "PLATFORM_TENANT_INPUT_INVALID",
  "PLATFORM_TENANT_PERMISSION_DENIED",
  "PLATFORM_TENANT_PURPOSE_INVALID",
  "PLATFORM_TENANT_MFA_REQUIRED",
  "PLATFORM_TENANT_NOT_FOUND",
  "PLATFORM_TENANT_VERSION_CONFLICT",
  "PLATFORM_TENANT_LIFECYCLE_CONFLICT",
  "PLATFORM_TENANT_APPROVAL_INVALID",
  "PLATFORM_TENANT_EVIDENCE_INVALID",
  "PLATFORM_TENANT_REFERENCE_INVALID",
  "PLATFORM_TENANT_IDEMPOTENCY_CONFLICT",
  "PLATFORM_TENANT_DEPENDENCY_UNAVAILABLE",
] as const;
export type PlatformTenantAdministrationErrorCode =
  (typeof platformTenantAdministrationErrorCodes)[number];
const messages: Readonly<Record<PlatformTenantAdministrationErrorCode, string>> = {
  PLATFORM_TENANT_INPUT_INVALID: "platform tenant input is invalid",
  PLATFORM_TENANT_PERMISSION_DENIED: "platform tenant permission is denied",
  PLATFORM_TENANT_PURPOSE_INVALID: "platform tenant purpose is invalid",
  PLATFORM_TENANT_MFA_REQUIRED: "recent MFA is required",
  PLATFORM_TENANT_NOT_FOUND: "platform tenant is not found",
  PLATFORM_TENANT_VERSION_CONFLICT: "platform tenant version conflicts",
  PLATFORM_TENANT_LIFECYCLE_CONFLICT: "platform tenant lifecycle conflicts",
  PLATFORM_TENANT_APPROVAL_INVALID: "platform tenant approval is invalid",
  PLATFORM_TENANT_EVIDENCE_INVALID: "platform tenant evidence is invalid",
  PLATFORM_TENANT_REFERENCE_INVALID: "platform tenant reference is invalid",
  PLATFORM_TENANT_IDEMPOTENCY_CONFLICT: "platform tenant operation conflicts",
  PLATFORM_TENANT_DEPENDENCY_UNAVAILABLE: "platform tenant dependency is unavailable",
};
export class PlatformTenantAdministrationError extends Error {
  constructor(readonly code: PlatformTenantAdministrationErrorCode) {
    super(messages[code]);
    this.name = "PlatformTenantAdministrationError";
  }
}
export type PlatformTenantReference = string & {
  readonly __platformTenantReference: unique symbol;
};
export type PlatformTenantVersion = number & { readonly __platformTenantVersion: unique symbol };
export const platformTenantStatuses = [
  "Draft",
  "PendingApproval",
  "Approved",
  "Active",
  "SuspensionPending",
  "Suspended",
  "RestorePending",
] as const;
export type PlatformTenantStatus = (typeof platformTenantStatuses)[number];
export const platformTenantEnvironments = ["NonProduction", "Production"] as const;
export type PlatformTenantEnvironment = (typeof platformTenantEnvironments)[number];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u,
  region = /^[A-Z]{2}(?:-[A-Z0-9]{2,12}){1,3}$/u;
function invalid(): never {
  throw new PlatformTenantAdministrationError("PLATFORM_TENANT_INPUT_INVALID");
}
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
export function parsePlatformTenantReference(value: unknown): PlatformTenantReference {
  if (typeof value !== "string" || !uuid.test(value)) invalid();
  return value as PlatformTenantReference;
}
const reference = parsePlatformTenantReference;
function optionalReference(value: unknown): PlatformTenantReference | null {
  return value === null ? null : reference(value);
}
function exactCode(value: unknown): string {
  if (typeof value !== "string" || !code.test(value)) invalid();
  return value;
}
function version(value: unknown): PlatformTenantVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid();
  return value as PlatformTenantVersion;
}
function references(value: unknown): readonly PlatformTenantReference[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  const result = Object.freeze(value.map(reference));
  if (new Set(result).size !== result.length) invalid();
  return result;
}
export interface PlatformTenantAdministrationVersion {
  readonly versionReference: PlatformTenantReference;
  readonly tenantReference: BrandReference;
  readonly version: PlatformTenantVersion;
  readonly status: PlatformTenantStatus;
  readonly regionCode: string;
  readonly environment: PlatformTenantEnvironment;
  readonly planMetadataReference: PlatformTenantReference;
  readonly capabilityMetadataReferences: readonly PlatformTenantReference[];
  readonly dataPolicyReference: PlatformTenantReference;
  readonly retentionPolicyReference: PlatformTenantReference;
  readonly authoredByReference: PlatformTenantReference;
  readonly approvedByReference: PlatformTenantReference | null;
  readonly approvalEvidenceReference: PlatformTenantReference | null;
  readonly onboardingEvidenceReference: PlatformTenantReference | null;
  readonly impactAssessmentReference: PlatformTenantReference | null;
  readonly supersedesVersionReference: PlatformTenantReference | null;
  readonly reasonCode: string;
  readonly createdAt: CanonicalInstant;
  readonly updatedAt: CanonicalInstant;
  readonly dataClassification: "ConfigurationMetadata";
}
export function createPlatformTenantAdministrationVersion(
  value: unknown,
): PlatformTenantAdministrationVersion {
  const r = closed(value, [
      "versionReference",
      "tenantReference",
      "version",
      "status",
      "regionCode",
      "environment",
      "planMetadataReference",
      "capabilityMetadataReferences",
      "dataPolicyReference",
      "retentionPolicyReference",
      "authoredByReference",
      "approvedByReference",
      "approvalEvidenceReference",
      "onboardingEvidenceReference",
      "impactAssessmentReference",
      "supersedesVersionReference",
      "reasonCode",
      "createdAt",
      "updatedAt",
      "dataClassification",
    ]),
    createdAt = parseCanonicalInstant(r.createdAt),
    updatedAt = parseCanonicalInstant(r.updatedAt);
  if (
    typeof r.status !== "string" ||
    !platformTenantStatuses.includes(r.status as PlatformTenantStatus) ||
    typeof r.environment !== "string" ||
    !platformTenantEnvironments.includes(r.environment as PlatformTenantEnvironment) ||
    typeof r.regionCode !== "string" ||
    !region.test(r.regionCode) ||
    r.dataClassification !== "ConfigurationMetadata" ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  )
    invalid();
  const result: PlatformTenantAdministrationVersion = Object.freeze({
    versionReference: reference(r.versionReference),
    tenantReference: parseBrandReference(r.tenantReference),
    version: version(r.version),
    status: r.status as PlatformTenantStatus,
    regionCode: r.regionCode,
    environment: r.environment as PlatformTenantEnvironment,
    planMetadataReference: reference(r.planMetadataReference),
    capabilityMetadataReferences: references(r.capabilityMetadataReferences),
    dataPolicyReference: reference(r.dataPolicyReference),
    retentionPolicyReference: reference(r.retentionPolicyReference),
    authoredByReference: reference(r.authoredByReference),
    approvedByReference: optionalReference(r.approvedByReference),
    approvalEvidenceReference: optionalReference(r.approvalEvidenceReference),
    onboardingEvidenceReference: optionalReference(r.onboardingEvidenceReference),
    impactAssessmentReference: optionalReference(r.impactAssessmentReference),
    supersedesVersionReference: optionalReference(r.supersedesVersionReference),
    reasonCode: exactCode(r.reasonCode),
    createdAt,
    updatedAt,
    dataClassification: "ConfigurationMetadata",
  });
  if (
    (result.version === 1) !== (result.supersedesVersionReference === null) ||
    (result.approvedByReference === null) !== (result.approvalEvidenceReference === null) ||
    (result.approvedByReference !== null &&
      result.approvedByReference === result.authoredByReference) ||
    (["Approved", "Active", "Suspended", "RestorePending"] as PlatformTenantStatus[]).includes(
      result.status,
    ) !==
      (result.approvedByReference !== null)
  )
    invalid();
  return result;
}
export interface PlatformTenantAdministrationInput {
  readonly operationReference: PlatformTenantReference;
  readonly expectedVersion: number;
  readonly actorReference: PlatformTenantReference;
  readonly purposeCode: string;
  readonly supportCaseReference: PlatformTenantReference;
  readonly auditReference: PlatformTenantReference;
  readonly occurredAt: CanonicalInstant;
  readonly candidate: PlatformTenantAdministrationVersion;
}
export function createPlatformTenantAdministrationInput(
  value: unknown,
): PlatformTenantAdministrationInput {
  const r = closed(value, [
    "operationReference",
    "expectedVersion",
    "actorReference",
    "purposeCode",
    "supportCaseReference",
    "auditReference",
    "occurredAt",
    "candidate",
  ]);
  if (!Number.isSafeInteger(r.expectedVersion) || (r.expectedVersion as number) < 0) invalid();
  return Object.freeze({
    operationReference: reference(r.operationReference),
    expectedVersion: r.expectedVersion as number,
    actorReference: reference(r.actorReference),
    purposeCode: exactCode(r.purposeCode),
    supportCaseReference: reference(r.supportCaseReference),
    auditReference: reference(r.auditReference),
    occurredAt: parseCanonicalInstant(r.occurredAt),
    candidate: createPlatformTenantAdministrationVersion(r.candidate),
  });
}
