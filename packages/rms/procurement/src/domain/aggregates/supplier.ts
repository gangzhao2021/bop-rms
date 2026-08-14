import { deriveEffectiveStatus, type EffectivePeriodValue } from "@bop/effective-period";

export type SupplierReference = string & { readonly __supplierReference: unique symbol };
export type SupplierInstant = string & { readonly __supplierInstant: unique symbol };
export type SupplierStatus = "Draft" | "Active" | "Suspended" | "Inactive" | "Archived";
export type QualificationReviewStatus = "Pending" | "Approved" | "Rejected";
export type QualificationScopeKind = "Supplier" | "Offering" | "ItemCategory";

export interface SupplierContact {
  readonly contactReference: SupplierReference;
  readonly roleCode: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
}
export interface SupplierAddress {
  readonly addressReference: SupplierReference;
  readonly addressType: "Registered" | "Ordering" | "Remittance" | "Shipping";
  readonly addressSummary: string;
  readonly countryCode: string;
  readonly regionCode: string;
}
export interface SupplierQualificationVersion {
  readonly qualificationVersionReference: SupplierReference;
  readonly version: number;
  readonly qualificationType: string;
  readonly jurisdiction: string;
  readonly certificateNumber: string;
  readonly issuer: string;
  readonly effectivePeriod: EffectivePeriodValue;
  readonly documentReference: SupplierReference;
  readonly reviewStatus: QualificationReviewStatus;
  readonly scopeKind: QualificationScopeKind;
  readonly scopeReference: SupplierReference;
  readonly reviewedBy: SupplierReference | null;
  readonly reviewedAt: SupplierInstant | null;
  readonly createdBy: SupplierReference;
  readonly createdAt: SupplierInstant;
}
export interface SupplierQualification {
  readonly qualificationReference: SupplierReference;
  readonly versions: readonly SupplierQualificationVersion[];
}
export interface SupplierDecision {
  readonly action:
    | "Created"
    | "Updated"
    | "Activated"
    | "Suspended"
    | "Deactivated"
    | "Archived"
    | "RestoredToInactive"
    | "QualificationVersionAdded"
    | "QualificationReviewed";
  readonly reasonCode: string | null;
  readonly approvalReference: SupplierReference | null;
  readonly actorReference: SupplierReference;
  readonly occurredAt: SupplierInstant;
}
export interface SupplierAggregate {
  readonly supplierReference: SupplierReference;
  readonly tenantReference: SupplierReference;
  readonly brandReference: SupplierReference;
  readonly supplierCode: string;
  readonly legalName: string;
  readonly displayName: string;
  readonly supplierType: string;
  readonly taxRegistrationReference: SupplierReference | null;
  readonly contacts: readonly SupplierContact[];
  readonly addresses: readonly SupplierAddress[];
  readonly qualifications: readonly SupplierQualification[];
  readonly status: SupplierStatus;
  readonly decisions: readonly SupplierDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: SupplierInstant;
  readonly updatedAt: SupplierInstant;
}

export type SupplierErrorCode =
  | "SUPPLIER_INVALID"
  | "SUPPLIER_CONFLICT"
  | "SUPPLIER_STATE_CONFLICT"
  | "SUPPLIER_NOT_FOUND"
  | "SUPPLIER_PERMISSION_DENIED"
  | "SUPPLIER_IDEMPOTENCY_CONFLICT"
  | "SUPPLIER_DEPENDENCY_UNAVAILABLE"
  | "SUPPLIER_QUALIFICATION_BLOCKED";
export class SupplierError extends Error {
  constructor(readonly code: SupplierErrorCode) {
    super("Supplier operation unavailable");
    this.name = "SupplierError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const supplierCodePattern = /^[A-Z0-9][A-Z0-9_-]{1,31}$/u;
const countryPattern = /^[A-Z]{2}$/u;
const regionPattern = /^[A-Z0-9][A-Z0-9-]{0,15}$/u;
const safeText = /^[^\p{Cc}\p{Cf}<>{}$]{1,160}$/u;
const emailPattern = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,190}$/u;
const phonePattern = /^\+[1-9][0-9]{6,14}$/u;
const invalid = (): never => {
  throw new SupplierError("SUPPLIER_INVALID");
};
export function parseSupplierReference(value: unknown): SupplierReference {
  if (typeof value !== "string" || !uuid.test(value)) return invalid();
  return value as SupplierReference;
}
export function parseSupplierInstant(value: unknown): SupplierInstant {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return invalid();
  return value as SupplierInstant;
}
function code(value: unknown, pattern = codePattern): string {
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safeText.test(value))
    return invalid();
  return value;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}
function period(value: EffectivePeriodValue): EffectivePeriodValue {
  const start = parseSupplierInstant(value.effectiveFrom);
  const end = value.effectiveUntil === null ? null : parseSupplierInstant(value.effectiveUntil);
  if (end !== null && end <= start) return invalid();
  return Object.freeze({ effectiveFrom: start, effectiveUntil: end });
}
function contact(value: SupplierContact): SupplierContact {
  const email =
    value.email === null ? null : emailPattern.test(value.email) ? value.email : invalid();
  const phone =
    value.phone === null ? null : phonePattern.test(value.phone) ? value.phone : invalid();
  if (email === null && phone === null) return invalid();
  return Object.freeze({
    contactReference: parseSupplierReference(value.contactReference),
    roleCode: code(value.roleCode),
    displayName: text(value.displayName),
    email,
    phone,
  });
}
function address(value: SupplierAddress): SupplierAddress {
  return Object.freeze({
    addressReference: parseSupplierReference(value.addressReference),
    addressType: value.addressType,
    addressSummary: text(value.addressSummary),
    countryCode: code(value.countryCode, countryPattern),
    regionCode: code(value.regionCode, regionPattern),
  });
}
function decision(
  action: SupplierDecision["action"],
  actorReference: unknown,
  occurredAt: unknown,
  reasonCode: unknown = null,
  approvalReference: unknown = null,
): SupplierDecision {
  return Object.freeze({
    action,
    reasonCode: reasonCode === null ? null : code(reasonCode),
    approvalReference:
      approvalReference === null ? null : parseSupplierReference(approvalReference),
    actorReference: parseSupplierReference(actorReference),
    occurredAt: parseSupplierInstant(occurredAt),
  });
}

export function createSupplier(input: {
  supplierReference: unknown;
  tenantReference: unknown;
  brandReference: unknown;
  supplierCode: unknown;
  legalName: unknown;
  displayName: unknown;
  supplierType: unknown;
  taxRegistrationReference: unknown;
  contacts: readonly SupplierContact[];
  addresses: readonly SupplierAddress[];
  actorReference: unknown;
  occurredAt: unknown;
}): SupplierAggregate {
  const at = parseSupplierInstant(input.occurredAt);
  const contacts = Object.freeze(input.contacts.map(contact));
  const addresses = Object.freeze(input.addresses.map(address));
  if (
    new Set(contacts.map((entry) => entry.contactReference)).size !== contacts.length ||
    new Set(addresses.map((entry) => entry.addressReference)).size !== addresses.length
  )
    return invalid();
  return Object.freeze({
    supplierReference: parseSupplierReference(input.supplierReference),
    tenantReference: parseSupplierReference(input.tenantReference),
    brandReference: parseSupplierReference(input.brandReference),
    supplierCode: code(input.supplierCode, supplierCodePattern),
    legalName: text(input.legalName),
    displayName: text(input.displayName),
    supplierType: code(input.supplierType),
    taxRegistrationReference:
      input.taxRegistrationReference === null
        ? null
        : parseSupplierReference(input.taxRegistrationReference),
    contacts,
    addresses,
    qualifications: Object.freeze([]),
    status: "Draft",
    decisions: Object.freeze([decision("Created", input.actorReference, at)]),
    aggregateVersion: 1,
    createdAt: at,
    updatedAt: at,
  });
}

function update(
  aggregate: SupplierAggregate,
  expectedVersion: unknown,
  status: SupplierStatus,
  nextDecision: SupplierDecision,
): SupplierAggregate {
  if (aggregate.aggregateVersion !== version(expectedVersion))
    throw new SupplierError("SUPPLIER_CONFLICT");
  return Object.freeze({
    ...aggregate,
    status,
    decisions: Object.freeze([...aggregate.decisions, nextDecision]),
    aggregateVersion: aggregate.aggregateVersion + 1,
    updatedAt: nextDecision.occurredAt,
  });
}
export function transitionSupplier(
  aggregate: SupplierAggregate,
  input: {
    expectedVersion: unknown;
    action: "Activate" | "Suspend" | "Deactivate" | "Archive" | "RestoreToInactive";
    reasonCode: unknown;
    approvalReference: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierAggregate {
  const allowed: Record<typeof input.action, readonly SupplierStatus[]> = {
    Activate: ["Draft", "Suspended", "Inactive"],
    Suspend: ["Active"],
    Deactivate: ["Active", "Suspended"],
    Archive: ["Inactive"],
    RestoreToInactive: ["Archived"],
  };
  if (!allowed[input.action].includes(aggregate.status))
    throw new SupplierError("SUPPLIER_STATE_CONFLICT");
  if (
    (input.action === "Activate" || input.action === "RestoreToInactive") &&
    input.approvalReference === null
  )
    return invalid();
  const status: SupplierStatus =
    input.action === "Activate"
      ? "Active"
      : input.action === "Suspend"
        ? "Suspended"
        : input.action === "Deactivate"
          ? "Inactive"
          : input.action === "Archive"
            ? "Archived"
            : "Inactive";
  const action: SupplierDecision["action"] =
    input.action === "Deactivate"
      ? "Deactivated"
      : input.action === "RestoreToInactive"
        ? "RestoredToInactive"
        : (`${input.action}d` as SupplierDecision["action"]);
  return update(
    aggregate,
    input.expectedVersion,
    status,
    decision(
      action,
      input.actorReference,
      input.occurredAt,
      input.reasonCode,
      input.approvalReference,
    ),
  );
}

export function reviseSupplierIdentity(
  aggregate: SupplierAggregate,
  input: {
    expectedVersion: unknown;
    legalName: unknown;
    displayName: unknown;
    supplierType: unknown;
    taxRegistrationReference: unknown;
    contacts: readonly SupplierContact[];
    addresses: readonly SupplierAddress[];
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierAggregate {
  if (aggregate.status === "Archived") throw new SupplierError("SUPPLIER_STATE_CONFLICT");
  const contacts = Object.freeze(input.contacts.map(contact));
  const addresses = Object.freeze(input.addresses.map(address));
  if (
    new Set(contacts.map((entry) => entry.contactReference)).size !== contacts.length ||
    new Set(addresses.map((entry) => entry.addressReference)).size !== addresses.length
  )
    return invalid();
  const nextDecision = decision(
    "Updated",
    input.actorReference,
    input.occurredAt,
    input.reasonCode,
  );
  const base = update(aggregate, input.expectedVersion, aggregate.status, nextDecision);
  return Object.freeze({
    ...base,
    legalName: text(input.legalName),
    displayName: text(input.displayName),
    supplierType: code(input.supplierType),
    taxRegistrationReference:
      input.taxRegistrationReference === null
        ? null
        : parseSupplierReference(input.taxRegistrationReference),
    contacts,
    addresses,
  });
}

function qualificationVersion(
  input: Omit<SupplierQualificationVersion, "version"> & { version: unknown },
): SupplierQualificationVersion {
  const reviewedBy = input.reviewedBy === null ? null : parseSupplierReference(input.reviewedBy);
  const reviewedAt = input.reviewedAt === null ? null : parseSupplierInstant(input.reviewedAt);
  if ((input.reviewStatus === "Pending") !== (reviewedBy === null && reviewedAt === null))
    return invalid();
  if (input.reviewStatus !== "Pending" && (reviewedBy === null || reviewedAt === null))
    return invalid();
  return Object.freeze({
    qualificationVersionReference: parseSupplierReference(input.qualificationVersionReference),
    version: version(input.version),
    qualificationType: code(input.qualificationType),
    jurisdiction: code(input.jurisdiction),
    certificateNumber: text(input.certificateNumber),
    issuer: text(input.issuer),
    effectivePeriod: period(input.effectivePeriod),
    documentReference: parseSupplierReference(input.documentReference),
    reviewStatus: input.reviewStatus,
    scopeKind: input.scopeKind,
    scopeReference: parseSupplierReference(input.scopeReference),
    reviewedBy,
    reviewedAt,
    createdBy: parseSupplierReference(input.createdBy),
    createdAt: parseSupplierInstant(input.createdAt),
  });
}
export function addQualificationVersion(
  aggregate: SupplierAggregate,
  input: {
    expectedVersion: unknown;
    qualificationReference: unknown;
    qualificationVersionReference: unknown;
    qualificationType: unknown;
    jurisdiction: unknown;
    certificateNumber: unknown;
    issuer: unknown;
    effectivePeriod: EffectivePeriodValue;
    documentReference: unknown;
    scopeKind: QualificationScopeKind;
    scopeReference: unknown;
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierAggregate {
  if (aggregate.status === "Archived") throw new SupplierError("SUPPLIER_STATE_CONFLICT");
  const reference = parseSupplierReference(input.qualificationReference);
  const scopeReference = parseSupplierReference(input.scopeReference);
  if (input.scopeKind === "Supplier" && scopeReference !== aggregate.supplierReference)
    return invalid();
  const existing = aggregate.qualifications.find(
    (entry) => entry.qualificationReference === reference,
  );
  const nextVersion = qualificationVersion({
    qualificationVersionReference: parseSupplierReference(input.qualificationVersionReference),
    version: (existing?.versions.length ?? 0) + 1,
    qualificationType: code(input.qualificationType),
    jurisdiction: code(input.jurisdiction),
    certificateNumber: text(input.certificateNumber),
    issuer: text(input.issuer),
    effectivePeriod: input.effectivePeriod,
    documentReference: parseSupplierReference(input.documentReference),
    reviewStatus: "Pending",
    scopeKind: input.scopeKind,
    scopeReference,
    reviewedBy: null,
    reviewedAt: null,
    createdBy: parseSupplierReference(input.actorReference),
    createdAt: parseSupplierInstant(input.occurredAt),
  });
  if (
    existing &&
    (existing.versions[0]?.qualificationType !== nextVersion.qualificationType ||
      existing.versions[0]?.scopeKind !== nextVersion.scopeKind ||
      existing.versions[0]?.scopeReference !== nextVersion.scopeReference)
  )
    return invalid();
  const qualifications = existing
    ? aggregate.qualifications.map((entry) =>
        entry.qualificationReference === reference
          ? Object.freeze({ ...entry, versions: Object.freeze([...entry.versions, nextVersion]) })
          : entry,
      )
    : [
        ...aggregate.qualifications,
        Object.freeze({
          qualificationReference: reference,
          versions: Object.freeze([nextVersion]),
        }),
      ];
  const base = update(
    aggregate,
    input.expectedVersion,
    aggregate.status,
    decision("QualificationVersionAdded", input.actorReference, input.occurredAt, input.reasonCode),
  );
  return Object.freeze({ ...base, qualifications: Object.freeze(qualifications) });
}

export function reviewQualification(
  aggregate: SupplierAggregate,
  input: {
    expectedVersion: unknown;
    qualificationReference: unknown;
    qualificationVersionReference: unknown;
    decision: "Approved" | "Rejected";
    reasonCode: unknown;
    actorReference: unknown;
    occurredAt: unknown;
  },
): SupplierAggregate {
  const reference = parseSupplierReference(input.qualificationReference);
  const versionReference = parseSupplierReference(input.qualificationVersionReference);
  const qualification = aggregate.qualifications.find(
    (entry) => entry.qualificationReference === reference,
  );
  const target = qualification?.versions.find(
    (entry) => entry.qualificationVersionReference === versionReference,
  );
  if (!target) throw new SupplierError("SUPPLIER_NOT_FOUND");
  if (target.reviewStatus !== "Pending") throw new SupplierError("SUPPLIER_STATE_CONFLICT");
  const reviewed = Object.freeze({
    ...target,
    reviewStatus: input.decision,
    reviewedBy: parseSupplierReference(input.actorReference),
    reviewedAt: parseSupplierInstant(input.occurredAt),
  });
  const qualifications = aggregate.qualifications.map((entry) =>
    entry.qualificationReference === reference
      ? Object.freeze({
          ...entry,
          versions: Object.freeze(
            entry.versions.map((candidate) =>
              candidate.qualificationVersionReference === versionReference ? reviewed : candidate,
            ),
          ),
        })
      : entry,
  );
  const base = update(
    aggregate,
    input.expectedVersion,
    aggregate.status,
    decision("QualificationReviewed", input.actorReference, input.occurredAt, input.reasonCode),
  );
  return Object.freeze({ ...base, qualifications: Object.freeze(qualifications) });
}

export function qualificationStatus(
  value: SupplierQualificationVersion,
  at: SupplierInstant,
): "Pending" | "Rejected" | "Scheduled" | "Effective" | "Expired" {
  if (value.reviewStatus !== "Approved") return value.reviewStatus;
  return deriveEffectiveStatus(value.effectivePeriod, at);
}
