export type ComplianceQualificationPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceQualificationPageError extends Error {
  constructor(readonly code: ComplianceQualificationPageErrorCode) {
    super("Compliance qualifications unavailable");
    this.name = "ComplianceQualificationPageError";
  }
}
export interface ComplianceQualificationClient {
  load(): Promise<unknown>;
}
export type QualificationStatus =
  | "Draft"
  | "PendingVerification"
  | "Active"
  | "Expiring"
  | "Expired"
  | "Suspended"
  | "Revoked"
  | "Closed";
export interface ComplianceQualificationView {
  readonly screenId: "CMP-QUALIFICATION";
  readonly queryName: "compliance_qualification_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayAddVerifiedRecord: boolean;
    readonly mayReview: boolean;
    readonly maySuspendEligibility: boolean;
    readonly mayRequestRenewal: boolean;
  };
  readonly filters: {
    readonly subjectReference: string | null;
    readonly subjectKind: "Permit" | "Employee" | "Supplier" | "Device" | null;
    readonly qualificationTypeCode: string | null;
    readonly status: QualificationStatus | null;
    readonly expiryDisposition: "Current" | "InRenewalWindow" | "Expired" | null;
    readonly storeReference: string | null;
    readonly requirementVersionReference: string | null;
  };
  readonly records: readonly {
    readonly qualificationReference: string;
    readonly revision: number;
    readonly storeReference: string | null;
    readonly subjectKind: "Permit" | "Employee" | "Supplier" | "Device";
    readonly subjectReference: string;
    readonly subjectCode: string;
    readonly owner: "Compliance" | "Procurement" | "Device";
    readonly ownerRecordReference: string | null;
    readonly ownerRecordVersion: number | null;
    readonly qualificationTypeCode: string;
    readonly jurisdictionCode: string;
    readonly issuerReference: string;
    readonly effectiveFrom: string;
    readonly expiresAt: string;
    readonly status: QualificationStatus;
    readonly verificationResult: "Pending" | "Verified" | "Rejected" | "Unverified";
    readonly verifiedAt: string | null;
    readonly verifiedByReference: string | null;
    readonly evidenceReference: string;
    readonly requirementVersionReference: string;
    readonly eligibilityOutcomeReference: string | null;
    readonly renewalTaskReference: string | null;
    readonly severity: "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
  }[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceQualificationPageError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    fail();
  const keys = Reflect.ownKeys(value as object);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const coded = (value: unknown) => (typeof value === "string" && code.test(value) ? value : fail());
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const subjectKinds = ["Permit", "Employee", "Supplier", "Device"] as const;
const statuses = [
  "Draft",
  "PendingVerification",
  "Active",
  "Expiring",
  "Expired",
  "Suspended",
  "Revoked",
  "Closed",
] as const;
const verifiedStatuses: readonly QualificationStatus[] = [
  "Active",
  "Expiring",
  "Expired",
  "Suspended",
];
const verificationResults = ["Pending", "Verified", "Rejected", "Unverified"] as const;
function record(value: unknown): ComplianceQualificationView["records"][number] {
  const raw = object(value, [
    "qualificationReference",
    "revision",
    "storeReference",
    "subjectKind",
    "subjectReference",
    "subjectCode",
    "owner",
    "ownerRecordReference",
    "ownerRecordVersion",
    "qualificationTypeCode",
    "jurisdictionCode",
    "issuerReference",
    "effectiveFrom",
    "expiresAt",
    "status",
    "verificationResult",
    "verifiedAt",
    "verifiedByReference",
    "evidenceReference",
    "requirementVersionReference",
    "eligibilityOutcomeReference",
    "renewalTaskReference",
    "severity",
  ]);
  const subjectKind = oneOf(raw.subjectKind, subjectKinds);
  const owner = oneOf(raw.owner, ["Compliance", "Procurement", "Device"] as const);
  const ownerRecordReference = nullable(raw.ownerRecordReference, reference);
  const ownerRecordVersion =
    raw.ownerRecordVersion === null ? null : positive(raw.ownerRecordVersion);
  const status = oneOf(raw.status, statuses);
  const verificationResult = oneOf(raw.verificationResult, verificationResults);
  const verifiedAt = nullable(raw.verifiedAt, instant);
  const verifiedByReference = nullable(raw.verifiedByReference, reference);
  const effectiveFrom = instant(raw.effectiveFrom);
  const expiresAt = instant(raw.expiresAt);
  if (
    Date.parse(effectiveFrom) >= Date.parse(expiresAt) ||
    (ownerRecordReference === null) !== (ownerRecordVersion === null) ||
    (verifiedAt === null) !== (verifiedByReference === null) ||
    (verificationResult === "Verified") !== (verifiedAt !== null) ||
    (verifiedStatuses.includes(status) && verificationResult !== "Verified") ||
    (status === "Draft" && verificationResult === "Verified") ||
    (status === "PendingVerification" && verificationResult === "Verified") ||
    (verificationResult === "Rejected" && status !== "Revoked" && status !== "Closed")
  )
    fail();
  if (
    subjectKind === "Permit" || subjectKind === "Employee"
      ? owner !== "Compliance" || ownerRecordReference !== null
      : subjectKind === "Supplier"
        ? owner !== "Procurement" || ownerRecordReference === null
        : owner !== "Device" || ownerRecordReference === null
  )
    fail();
  return Object.freeze({
    qualificationReference: reference(raw.qualificationReference),
    revision: positive(raw.revision),
    storeReference: nullable(raw.storeReference, reference),
    subjectKind,
    subjectReference: reference(raw.subjectReference),
    subjectCode: coded(raw.subjectCode),
    owner,
    ownerRecordReference,
    ownerRecordVersion,
    qualificationTypeCode: coded(raw.qualificationTypeCode),
    jurisdictionCode: coded(raw.jurisdictionCode),
    issuerReference: reference(raw.issuerReference),
    effectiveFrom,
    expiresAt,
    status,
    verificationResult,
    verifiedAt,
    verifiedByReference,
    evidenceReference: reference(raw.evidenceReference),
    requirementVersionReference: reference(raw.requirementVersionReference),
    eligibilityOutcomeReference: nullable(raw.eligibilityOutcomeReference, reference),
    renewalTaskReference: nullable(raw.renewalTaskReference, reference),
    severity: oneOf(raw.severity, [
      "Observation",
      "Minor",
      "Major",
      "Critical",
      "ImmediateDanger",
    ] as const),
  });
}
export function parseComplianceQualificationView(value: unknown): ComplianceQualificationView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "filters",
    "records",
  ]);
  if (
    raw.screenId !== "CMP-QUALIFICATION" ||
    raw.queryName !== "compliance_qualification_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) fail();
  const permissions = object(raw.permissions, [
    "mayAddVerifiedRecord",
    "mayReview",
    "maySuspendEligibility",
    "mayRequestRenewal",
  ]);
  const filters = object(raw.filters, [
    "subjectReference",
    "subjectKind",
    "qualificationTypeCode",
    "status",
    "expiryDisposition",
    "storeReference",
    "requirementVersionReference",
  ]);
  const rawRecords = raw.records;
  if (!Array.isArray(rawRecords)) return fail();
  if (rawRecords.length > 500) return fail();
  const records = Object.freeze(rawRecords.map((item: unknown) => record(item)));
  if (new Set(records.map((item) => item.qualificationReference)).size !== records.length) fail();
  return Object.freeze({
    screenId: "CMP-QUALIFICATION",
    queryName: "compliance_qualification_v1",
    queryVersion: 1,
    generatedAt,
    sourceAsOf,
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayAddVerifiedRecord: bool(permissions.mayAddVerifiedRecord),
      mayReview: bool(permissions.mayReview),
      maySuspendEligibility: bool(permissions.maySuspendEligibility),
      mayRequestRenewal: bool(permissions.mayRequestRenewal),
    }),
    filters: Object.freeze({
      subjectReference: nullable(filters.subjectReference, reference),
      subjectKind: nullable(filters.subjectKind, (item) => oneOf(item, subjectKinds)),
      qualificationTypeCode: nullable(filters.qualificationTypeCode, coded),
      status: nullable(filters.status, (item) => oneOf(item, statuses)),
      expiryDisposition: nullable(filters.expiryDisposition, (item) =>
        oneOf(item, ["Current", "InRenewalWindow", "Expired"] as const),
      ),
      storeReference: nullable(filters.storeReference, reference),
      requirementVersionReference: nullable(filters.requirementVersionReference, reference),
    }),
    records,
  });
}
export const unavailableComplianceQualificationClient: ComplianceQualificationClient =
  Object.freeze({
    async load() {
      throw new ComplianceQualificationPageError("Unavailable");
    },
  });
