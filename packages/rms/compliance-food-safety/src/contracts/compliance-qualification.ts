import {
  parseComplianceCode,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceCode,
  type ComplianceReference,
  type ComplianceScope,
  type FindingSeverity,
} from "./compliance-dashboard.js";

export const qualificationSubjectKinds = ["Permit", "Employee", "Supplier", "Device"] as const;
export type QualificationSubjectKind = (typeof qualificationSubjectKinds)[number];
export const qualificationStatuses = [
  "Draft",
  "PendingVerification",
  "Active",
  "Expiring",
  "Expired",
  "Suspended",
  "Revoked",
  "Closed",
] as const;
export type QualificationStatus = (typeof qualificationStatuses)[number];
export const qualificationVerificationResults = [
  "Pending",
  "Verified",
  "Rejected",
  "Unverified",
] as const;
export type QualificationVerificationResult = (typeof qualificationVerificationResults)[number];
export type QualificationRecordOwner = "Compliance" | "Procurement" | "Device";

export interface ComplianceQualificationRecord {
  readonly qualificationReference: ComplianceReference;
  readonly revision: number;
  readonly scope: ComplianceScope;
  readonly subjectKind: QualificationSubjectKind;
  readonly subjectReference: ComplianceReference;
  readonly owner: QualificationRecordOwner;
  readonly ownerRecordReference: ComplianceReference | null;
  readonly ownerRecordVersion: number | null;
  readonly qualificationTypeCode: ComplianceCode;
  readonly jurisdictionCode: ComplianceCode;
  readonly issuerReference: ComplianceReference;
  readonly numberReference: ComplianceReference;
  readonly authorityReference: ComplianceReference | null;
  readonly holderLegalEntityReference: ComplianceReference | null;
  readonly membershipReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly evidenceReference: ComplianceReference;
  readonly issuedAt: string | null;
  readonly effectiveFrom: string;
  readonly expiresAt: string;
  readonly renewalWindowStartsAt: string;
  readonly status: QualificationStatus;
  readonly verificationResult: QualificationVerificationResult;
  readonly verifiedAt: string | null;
  readonly verifiedByReference: ComplianceReference | null;
  readonly eligibilityOutcomeReference: ComplianceReference | null;
  readonly renewalTaskReference: ComplianceReference | null;
  readonly severity: FindingSeverity;
  readonly recordedAt: string;
}

export type QualificationContractErrorCode =
  "QUALIFICATION_INPUT_INVALID" | "QUALIFICATION_SCOPE_INVALID";
export class QualificationContractError extends Error {
  constructor(readonly code: QualificationContractErrorCode) {
    super("Compliance qualification input is invalid");
    this.name = "QualificationContractError";
  }
}
const fail = (code: QualificationContractErrorCode = "QUALIFICATION_INPUT_INVALID"): never => {
  throw new QualificationContractError(code);
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const revision = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const nullableReference = (value: unknown): ComplianceReference | null =>
  value === null ? null : parseComplianceReference(value);
const nullableInstant = (value: unknown): string | null =>
  value === null ? null : parseComplianceInstant(value);

export function createComplianceQualificationRecord(value: unknown): ComplianceQualificationRecord {
  const raw = exact(value, [
    "qualificationReference",
    "revision",
    "scope",
    "subjectKind",
    "subjectReference",
    "owner",
    "ownerRecordReference",
    "ownerRecordVersion",
    "qualificationTypeCode",
    "jurisdictionCode",
    "issuerReference",
    "numberReference",
    "authorityReference",
    "holderLegalEntityReference",
    "membershipReference",
    "requirementVersionReference",
    "evidenceReference",
    "issuedAt",
    "effectiveFrom",
    "expiresAt",
    "renewalWindowStartsAt",
    "status",
    "verificationResult",
    "verifiedAt",
    "verifiedByReference",
    "eligibilityOutcomeReference",
    "renewalTaskReference",
    "severity",
    "recordedAt",
  ]);
  const subjectKind = oneOf(raw.subjectKind, qualificationSubjectKinds);
  const owner = oneOf(raw.owner, ["Compliance", "Procurement", "Device"] as const);
  const status = oneOf(raw.status, qualificationStatuses);
  const verificationResult = oneOf(raw.verificationResult, qualificationVerificationResults);
  const ownerRecordReference = nullableReference(raw.ownerRecordReference);
  const ownerRecordVersion =
    raw.ownerRecordVersion === null ? null : revision(raw.ownerRecordVersion);
  const authorityReference = nullableReference(raw.authorityReference);
  const holderLegalEntityReference = nullableReference(raw.holderLegalEntityReference);
  const membershipReference = nullableReference(raw.membershipReference);
  const issuedAt = nullableInstant(raw.issuedAt);
  const effectiveFrom = parseComplianceInstant(raw.effectiveFrom);
  const expiresAt = parseComplianceInstant(raw.expiresAt);
  const renewalWindowStartsAt = parseComplianceInstant(raw.renewalWindowStartsAt);
  const verifiedAt = nullableInstant(raw.verifiedAt);
  const verifiedByReference = nullableReference(raw.verifiedByReference);
  if (
    (ownerRecordReference === null) !== (ownerRecordVersion === null) ||
    (verifiedAt === null) !== (verifiedByReference === null) ||
    Date.parse(effectiveFrom) >= Date.parse(expiresAt) ||
    Date.parse(renewalWindowStartsAt) < Date.parse(effectiveFrom) ||
    Date.parse(renewalWindowStartsAt) >= Date.parse(expiresAt) ||
    (issuedAt !== null && Date.parse(issuedAt) > Date.parse(effectiveFrom))
  )
    return fail();
  if (
    subjectKind === "Permit"
      ? owner !== "Compliance" ||
        authorityReference === null ||
        holderLegalEntityReference === null ||
        membershipReference !== null ||
        ownerRecordReference !== null
      : authorityReference !== null || holderLegalEntityReference !== null
  )
    return fail("QUALIFICATION_SCOPE_INVALID");
  if (
    subjectKind === "Employee"
      ? owner !== "Compliance" || membershipReference === null || ownerRecordReference !== null
      : membershipReference !== null
  )
    return fail("QUALIFICATION_SCOPE_INVALID");
  if (
    subjectKind === "Supplier"
      ? owner !== "Procurement" || ownerRecordReference === null
      : subjectKind === "Device"
        ? owner !== "Device" || ownerRecordReference === null
        : false
  )
    return fail("QUALIFICATION_SCOPE_INVALID");
  const verifiedStatuses: readonly QualificationStatus[] = [
    "Active",
    "Expiring",
    "Expired",
    "Suspended",
  ];
  if (
    (verifiedStatuses.includes(status) &&
      (verificationResult !== "Verified" || verifiedAt === null)) ||
    (status === "Draft" && verificationResult === "Verified") ||
    (status === "PendingVerification" && verificationResult === "Verified") ||
    (verificationResult === "Rejected" && status !== "Revoked" && status !== "Closed") ||
    (verificationResult === "Verified" && verifiedAt === null) ||
    (verificationResult !== "Verified" && verifiedAt !== null)
  )
    return fail();
  return Object.freeze({
    qualificationReference: parseComplianceReference(raw.qualificationReference),
    revision: revision(raw.revision),
    scope: parseComplianceScope(raw.scope),
    subjectKind,
    subjectReference: parseComplianceReference(raw.subjectReference),
    owner,
    ownerRecordReference,
    ownerRecordVersion,
    qualificationTypeCode: parseComplianceCode(raw.qualificationTypeCode),
    jurisdictionCode: parseComplianceCode(raw.jurisdictionCode),
    issuerReference: parseComplianceReference(raw.issuerReference),
    numberReference: parseComplianceReference(raw.numberReference),
    authorityReference,
    holderLegalEntityReference,
    membershipReference,
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    evidenceReference: parseComplianceReference(raw.evidenceReference),
    issuedAt,
    effectiveFrom,
    expiresAt,
    renewalWindowStartsAt,
    status,
    verificationResult,
    verifiedAt,
    verifiedByReference,
    eligibilityOutcomeReference: nullableReference(raw.eligibilityOutcomeReference),
    renewalTaskReference: nullableReference(raw.renewalTaskReference),
    severity: oneOf(raw.severity, [
      "Observation",
      "Minor",
      "Major",
      "Critical",
      "ImmediateDanger",
    ] as const),
    recordedAt: parseComplianceInstant(raw.recordedAt),
  });
}
