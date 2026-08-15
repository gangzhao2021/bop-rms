import {
  parseAssignmentReference,
  parseEvidenceReference,
  parseOperatingEntityReference,
  type AssignmentReference,
  type BusinessFunction,
  type EvidenceReference,
  type OperatingEntityLifecycle,
  type OperatingEntityReference,
} from "../domain/operating-entity.js";
import {
  parseBrandReference,
  parseCanonicalInstant,
  parseOrganizationVersion,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type OrganizationVersion,
  type StoreReference,
} from "@bop/tenant";

export class OperatingEntityAdministrationError extends Error {
  constructor(readonly code: "ENTITY_ADMIN_INPUT_INVALID" | "ENTITY_ADMIN_STATE_INVALID") {
    super("Operating Entity administration input is invalid");
    this.name = "OperatingEntityAdministrationError";
  }
}
const fail = (
  code: "ENTITY_ADMIN_INPUT_INVALID" | "ENTITY_ADMIN_STATE_INVALID" = "ENTITY_ADMIN_INPUT_INVALID",
): never => {
  throw new OperatingEntityAdministrationError(code);
};
function exact(value: unknown, fields: readonly string[]) {
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
const ref = (value: unknown) => parseEvidenceReference(value);
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    ? value
    : fail();
const nullableText = (value: unknown, max: number) => (value === null ? null : text(value, max));
const instant = (value: unknown) => parseCanonicalInstant(value);
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const uniqueRefs = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 50) return fail();
  const result = value.map(ref);
  return new Set(result).size === result.length ? Object.freeze(result) : fail();
};

export interface OperatingEntityProfileVersion {
  readonly profileVersionReference: EvidenceReference;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly profileVersion: OrganizationVersion;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly jurisdictionCode: "CA-ON";
  readonly registrationReference: EvidenceReference | null;
  readonly taxRegistrationReference: EvidenceReference | null;
  readonly registeredAddressReference: EvidenceReference | null;
  readonly billingIdentityReference: EvidenceReference | null;
  readonly settlementReference: EvidenceReference | null;
  readonly evidenceReferences: readonly EvidenceReference[];
  readonly recordedByReference: EvidenceReference;
  readonly recordedAt: CanonicalInstant;
  readonly dataClassification: "RestrictedReferenceMetadata";
}

export function createOperatingEntityProfileVersion(value: unknown): OperatingEntityProfileVersion {
  const raw = exact(value, [
    "profileVersionReference",
    "operatingEntityReference",
    "profileVersion",
    "legalName",
    "tradeName",
    "jurisdictionCode",
    "registrationReference",
    "taxRegistrationReference",
    "registeredAddressReference",
    "billingIdentityReference",
    "settlementReference",
    "evidenceReferences",
    "recordedByReference",
    "recordedAt",
    "dataClassification",
  ]);
  if (raw.jurisdictionCode !== "CA-ON" || raw.dataClassification !== "RestrictedReferenceMetadata")
    return fail();
  return Object.freeze({
    profileVersionReference: ref(raw.profileVersionReference),
    operatingEntityReference: parseOperatingEntityReference(raw.operatingEntityReference),
    profileVersion: parseOrganizationVersion(raw.profileVersion),
    legalName: text(raw.legalName, 200),
    tradeName: nullableText(raw.tradeName, 200),
    jurisdictionCode: "CA-ON",
    registrationReference: nullableRef(raw.registrationReference),
    taxRegistrationReference: nullableRef(raw.taxRegistrationReference),
    registeredAddressReference: nullableRef(raw.registeredAddressReference),
    billingIdentityReference: nullableRef(raw.billingIdentityReference),
    settlementReference: nullableRef(raw.settlementReference),
    evidenceReferences: uniqueRefs(raw.evidenceReferences),
    recordedByReference: ref(raw.recordedByReference),
    recordedAt: instant(raw.recordedAt),
    dataClassification: "RestrictedReferenceMetadata",
  });
}

export const authorityRoleCodes = ["Director", "Officer", "SigningAuthority"] as const;
export interface OperatingEntityAuthoritySummary {
  readonly authorityVersionReference: EvidenceReference;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly authoritySubjectReference: EvidenceReference;
  readonly authorityRoleCode: (typeof authorityRoleCodes)[number];
  readonly titleCode: string;
  readonly status: "Proposed" | "Active" | "Revoked" | "Expired";
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly restrictedDetailReference: EvidenceReference;
  readonly approvalEvidenceReference: EvidenceReference;
  readonly version: OrganizationVersion;
  readonly recordedAt: CanonicalInstant;
  readonly dataClassification: "RestrictedReferenceMetadata";
}
export function createOperatingEntityAuthoritySummary(
  value: unknown,
): OperatingEntityAuthoritySummary {
  const raw = exact(value, [
    "authorityVersionReference",
    "operatingEntityReference",
    "authoritySubjectReference",
    "authorityRoleCode",
    "titleCode",
    "status",
    "effectiveFrom",
    "effectiveUntil",
    "restrictedDetailReference",
    "approvalEvidenceReference",
    "version",
    "recordedAt",
    "dataClassification",
  ]);
  const effectiveFrom = instant(raw.effectiveFrom);
  const effectiveUntil = nullableInstant(raw.effectiveUntil);
  const status = oneOf(raw.status, ["Proposed", "Active", "Revoked", "Expired"] as const);
  if (
    raw.dataClassification !== "RestrictedReferenceMetadata" ||
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) ||
    (status === "Expired") !== (effectiveUntil !== null)
  )
    return fail("ENTITY_ADMIN_STATE_INVALID");
  return Object.freeze({
    authorityVersionReference: ref(raw.authorityVersionReference),
    operatingEntityReference: parseOperatingEntityReference(raw.operatingEntityReference),
    authoritySubjectReference: ref(raw.authoritySubjectReference),
    authorityRoleCode: oneOf(raw.authorityRoleCode, authorityRoleCodes),
    titleCode: text(raw.titleCode, 64),
    status,
    effectiveFrom,
    effectiveUntil,
    restrictedDetailReference: ref(raw.restrictedDetailReference),
    approvalEvidenceReference: ref(raw.approvalEvidenceReference),
    version: parseOrganizationVersion(raw.version),
    recordedAt: instant(raw.recordedAt),
    dataClassification: "RestrictedReferenceMetadata",
  });
}

export interface OperatingEntityApprovalDecision {
  readonly decisionReference: EvidenceReference;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly entityVersion: OrganizationVersion;
  readonly decision: "Approved" | "Rejected";
  readonly submittedByReference: EvidenceReference;
  readonly decidedByReference: EvidenceReference;
  readonly approvalEvidenceReference: EvidenceReference;
  readonly purposeCode: string;
  readonly decidedAt: CanonicalInstant;
}
export function createOperatingEntityApprovalDecision(
  value: unknown,
): OperatingEntityApprovalDecision {
  const raw = exact(value, [
    "decisionReference",
    "operatingEntityReference",
    "entityVersion",
    "decision",
    "submittedByReference",
    "decidedByReference",
    "approvalEvidenceReference",
    "purposeCode",
    "decidedAt",
  ]);
  const submittedByReference = ref(raw.submittedByReference);
  const decidedByReference = ref(raw.decidedByReference);
  if (submittedByReference === decidedByReference) return fail("ENTITY_ADMIN_STATE_INVALID");
  return Object.freeze({
    decisionReference: ref(raw.decisionReference),
    operatingEntityReference: parseOperatingEntityReference(raw.operatingEntityReference),
    entityVersion: parseOrganizationVersion(raw.entityVersion),
    decision: oneOf(raw.decision, ["Approved", "Rejected"] as const),
    submittedByReference,
    decidedByReference,
    approvalEvidenceReference: ref(raw.approvalEvidenceReference),
    purposeCode: text(raw.purposeCode, 64),
    decidedAt: instant(raw.decidedAt),
  });
}

export interface BusinessFunctionAssignmentRequest {
  readonly assignmentReference: AssignmentReference;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly businessFunction: BusinessFunction;
  readonly effectiveFrom: CanonicalInstant;
  readonly effectiveUntil: CanonicalInstant | null;
  readonly approvalEvidenceReference: EvidenceReference;
  readonly requestedByReference: EvidenceReference;
  readonly approvedByReference: EvidenceReference;
  readonly version: OrganizationVersion;
  readonly recordedAt: CanonicalInstant;
}
const businessFunctions = [
  "SalesReceiptIssuer",
  "TaxRegistrant",
  "PaymentSettlementOwner",
  "ProcurementBuyer",
  "LicenseHolder",
  "Employer",
] as const;
export function createBusinessFunctionAssignmentRequest(
  value: unknown,
): BusinessFunctionAssignmentRequest {
  const raw = exact(value, [
    "assignmentReference",
    "operatingEntityReference",
    "brandReference",
    "storeReference",
    "businessFunction",
    "effectiveFrom",
    "effectiveUntil",
    "approvalEvidenceReference",
    "requestedByReference",
    "approvedByReference",
    "version",
    "recordedAt",
  ]);
  const effectiveFrom = instant(raw.effectiveFrom);
  const effectiveUntil = nullableInstant(raw.effectiveUntil);
  const requestedByReference = ref(raw.requestedByReference);
  const approvedByReference = ref(raw.approvedByReference);
  if (
    requestedByReference === approvedByReference ||
    (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
  )
    return fail("ENTITY_ADMIN_STATE_INVALID");
  return Object.freeze({
    assignmentReference: parseAssignmentReference(raw.assignmentReference),
    operatingEntityReference: parseOperatingEntityReference(raw.operatingEntityReference),
    brandReference: parseBrandReference(raw.brandReference),
    storeReference: raw.storeReference === null ? null : parseStoreReference(raw.storeReference),
    businessFunction: oneOf(raw.businessFunction, businessFunctions),
    effectiveFrom,
    effectiveUntil,
    approvalEvidenceReference: ref(raw.approvalEvidenceReference),
    requestedByReference,
    approvedByReference,
    version: parseOrganizationVersion(raw.version),
    recordedAt: instant(raw.recordedAt),
  });
}

export interface RestrictedRevealGrant {
  readonly grantReference: EvidenceReference;
  readonly operatingEntityReference: OperatingEntityReference;
  readonly actorReference: EvidenceReference;
  readonly purposeCode: string;
  readonly recentMfaValidatedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly mayRevealRestrictedReferences: boolean;
}
export function createRestrictedRevealGrant(value: unknown): RestrictedRevealGrant {
  const raw = exact(value, [
    "grantReference",
    "operatingEntityReference",
    "actorReference",
    "purposeCode",
    "recentMfaValidatedAt",
    "expiresAt",
    "mayRevealRestrictedReferences",
  ]);
  const recentMfaValidatedAt = instant(raw.recentMfaValidatedAt);
  const expiresAt = instant(raw.expiresAt);
  if (
    Date.parse(expiresAt) !== Date.parse(recentMfaValidatedAt) + 15 * 60_000 ||
    !bool(raw.mayRevealRestrictedReferences)
  )
    return fail("ENTITY_ADMIN_STATE_INVALID");
  return Object.freeze({
    grantReference: ref(raw.grantReference),
    operatingEntityReference: parseOperatingEntityReference(raw.operatingEntityReference),
    actorReference: ref(raw.actorReference),
    purposeCode: text(raw.purposeCode, 64),
    recentMfaValidatedAt,
    expiresAt,
    mayRevealRestrictedReferences: true,
  });
}

export interface OperatingEntityAdministrationSnapshot {
  readonly operatingEntityReference: OperatingEntityReference;
  readonly aggregateVersion: OrganizationVersion;
  readonly lifecycle: OperatingEntityLifecycle;
  readonly profile: OperatingEntityProfileVersion;
  readonly approvalDecision: OperatingEntityApprovalDecision | null;
  readonly auditSummaryReference: EvidenceReference;
  readonly updatedAt: CanonicalInstant;
}
