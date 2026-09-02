export type ComplianceAllergenIncidentPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceAllergenIncidentPageError extends Error {
  constructor(readonly code: ComplianceAllergenIncidentPageErrorCode) {
    super("Compliance allergen or incident page unavailable");
    this.name = "ComplianceAllergenIncidentPageError";
  }
}
export interface ComplianceAllergenIncidentClient {
  load(): Promise<unknown>;
}
type Severity = "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
type ReviewStatus = "Pending" | "Approved" | "Rejected" | "Invalidated";
type EvidenceStatus = "Current" | "Expired" | "Conflicting" | "Unverified";
export interface ComplianceAllergenReviewView {
  readonly screenId: "CMP-ALLERGEN-REVIEW";
  readonly queryName: "compliance_allergen_review_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayReview: boolean;
    readonly mayApprove: boolean;
    readonly mayInvalidate: boolean;
    readonly mayEnforceBlocks: boolean;
    readonly mayOpenIncident: boolean;
  };
  readonly filters: {
    readonly subjectReference: string | null;
    readonly subjectKind: "Ingredient" | "Recipe" | "SellablePath" | null;
    readonly allergenReference: string | null;
    readonly reviewStatus: ReviewStatus | null;
    readonly evidenceStatus: EvidenceStatus | null;
    readonly storeReference: string | null;
  };
  readonly records: readonly {
    readonly reviewReference: string;
    readonly revision: number;
    readonly subjectKind: "Ingredient" | "Recipe" | "SellablePath";
    readonly subjectReference: string;
    readonly subjectCode: string;
    readonly configurationDigest: string;
    readonly allergenPolicyVersionReference: string;
    readonly recipeVersionReferenceCount: string;
    readonly assertions: readonly {
      readonly allergenReference: string;
      readonly classification: "Contains" | "CrossContactPossible" | "Unverified";
      readonly evidenceStatus: EvidenceStatus;
      readonly validUntil: string;
    }[];
    readonly reviewStatus: ReviewStatus;
    readonly reviewerReference: string | null;
    readonly reviewedAt: string | null;
    readonly severity: Severity;
    readonly requirementVersionReference: string;
    readonly publicationBlockOutcomeReference: string | null;
    readonly paymentBlockOutcomeReference: string | null;
    readonly allergenFreeClaim: false;
  }[];
}
type IncidentStatus =
  | "Reported"
  | "Contained"
  | "Investigating"
  | "CorrectiveAction"
  | "Verification"
  | "Closed"
  | "Cancelled";
export interface ComplianceIncidentView {
  readonly screenId: "CMP-INCIDENT";
  readonly queryName: "compliance_incident_detail_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayEnforceBlocks: boolean;
    readonly mayAssign: boolean;
    readonly mayRecordNotificationDecision: boolean;
    readonly mayLinkCases: boolean;
    readonly mayCloseAfterVerification: boolean;
  };
  readonly incident: {
    readonly incidentReference: string;
    readonly revision: number;
    readonly caseReference: string;
    readonly incidentType: string;
    readonly severity: Severity;
    readonly status: IncidentStatus;
    readonly occurredAt: string;
    readonly reportedAt: string;
    readonly productReference: string | null;
    readonly orderReference: string | null;
    readonly lotReference: string | null;
    readonly employeeScopePresent: boolean;
    readonly restrictedSnapshotReferenceCount: string;
    readonly evidenceReferenceCount: string;
    readonly containmentOutcomeReferences: readonly string[];
    readonly notificationReference: string | null;
    readonly investigationReference: string | null;
    readonly outcomeCode: string | null;
    readonly verificationReference: string | null;
    readonly availabilityBlockOutcomeReference: string | null;
    readonly paymentBlockOutcomeReference: string | null;
    readonly requirementVersionReference: string;
    readonly accessClass: "Restricted";
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const count = /^(?:0|[1-9][0-9]{0,29})$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceAllergenIncidentPageError("Unavailable");
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
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const coded = (value: unknown) => (typeof value === "string" && code.test(value) ? value : fail());
const decimalCount = (value: unknown) =>
  typeof value === "string" && count.test(value) ? value : fail();
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const digest = (value: unknown) =>
  typeof value === "string" && digestPattern.test(value) ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const severities = ["Observation", "Minor", "Major", "Critical", "ImmediateDanger"] as const;
const reviewStatuses = ["Pending", "Approved", "Rejected", "Invalidated"] as const;
const evidenceStatuses = ["Current", "Expired", "Conflicting", "Unverified"] as const;
function common(raw: Record<string, unknown>) {
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) fail();
  return {
    generatedAt,
    sourceAsOf,
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
  };
}
function assertion(value: unknown) {
  const raw = object(value, [
    "allergenReference",
    "classification",
    "evidenceStatus",
    "validUntil",
  ]);
  return Object.freeze({
    allergenReference: reference(raw.allergenReference),
    classification: oneOf(raw.classification, [
      "Contains",
      "CrossContactPossible",
      "Unverified",
    ] as const),
    evidenceStatus: oneOf(raw.evidenceStatus, evidenceStatuses),
    validUntil: instant(raw.validUntil),
  });
}
function reviewRow(value: unknown): ComplianceAllergenReviewView["records"][number] {
  const raw = object(value, [
    "reviewReference",
    "revision",
    "subjectKind",
    "subjectReference",
    "subjectCode",
    "configurationDigest",
    "allergenPolicyVersionReference",
    "recipeVersionReferenceCount",
    "assertions",
    "reviewStatus",
    "reviewerReference",
    "reviewedAt",
    "severity",
    "requirementVersionReference",
    "publicationBlockOutcomeReference",
    "paymentBlockOutcomeReference",
    "allergenFreeClaim",
  ]);
  const rawAssertions = raw.assertions;
  if (!Array.isArray(rawAssertions)) return fail();
  if (rawAssertions.length < 1 || rawAssertions.length > 64) return fail();
  const assertions = Object.freeze(rawAssertions.map((item: unknown) => assertion(item)));
  if (new Set(assertions.map((item) => item.allergenReference)).size !== assertions.length) fail();
  const reviewStatus = oneOf(raw.reviewStatus, reviewStatuses);
  const reviewerReference = nullable(raw.reviewerReference, reference);
  const reviewedAt = nullable(raw.reviewedAt, instant);
  const blocks = [raw.publicationBlockOutcomeReference, raw.paymentBlockOutcomeReference];
  if (
    (reviewerReference === null) !== (reviewedAt === null) ||
    (reviewStatus === "Pending" && reviewerReference !== null) ||
    (reviewStatus === "Approved" &&
      assertions.some(
        (item) =>
          item.classification === "Unverified" ||
          item.evidenceStatus !== "Current" ||
          Date.parse(item.validUntil) <= Date.parse(reviewedAt ?? "9999-01-01T00:00:00.000Z"),
      )) ||
    (blocks[0] === null) !== (blocks[1] === null) ||
    raw.allergenFreeClaim !== false
  )
    fail();
  return Object.freeze({
    reviewReference: reference(raw.reviewReference),
    revision: positive(raw.revision),
    subjectKind: oneOf(raw.subjectKind, ["Ingredient", "Recipe", "SellablePath"] as const),
    subjectReference: reference(raw.subjectReference),
    subjectCode: coded(raw.subjectCode),
    configurationDigest: digest(raw.configurationDigest),
    allergenPolicyVersionReference: reference(raw.allergenPolicyVersionReference),
    recipeVersionReferenceCount: decimalCount(raw.recipeVersionReferenceCount),
    assertions,
    reviewStatus,
    reviewerReference,
    reviewedAt,
    severity: oneOf(raw.severity, severities),
    requirementVersionReference: reference(raw.requirementVersionReference),
    publicationBlockOutcomeReference: nullable(raw.publicationBlockOutcomeReference, reference),
    paymentBlockOutcomeReference: nullable(raw.paymentBlockOutcomeReference, reference),
    allergenFreeClaim: false,
  });
}
export function parseComplianceAllergenReviewView(value: unknown): ComplianceAllergenReviewView {
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
    raw.screenId !== "CMP-ALLERGEN-REVIEW" ||
    raw.queryName !== "compliance_allergen_review_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const p = object(raw.permissions, [
    "mayReview",
    "mayApprove",
    "mayInvalidate",
    "mayEnforceBlocks",
    "mayOpenIncident",
  ]);
  const f = object(raw.filters, [
    "subjectReference",
    "subjectKind",
    "allergenReference",
    "reviewStatus",
    "evidenceStatus",
    "storeReference",
  ]);
  if (!Array.isArray(raw.records) || raw.records.length > 500) return fail();
  const records = Object.freeze(raw.records.map(reviewRow));
  if (new Set(records.map((item) => item.reviewReference)).size !== records.length) fail();
  return Object.freeze({
    screenId: "CMP-ALLERGEN-REVIEW",
    queryName: "compliance_allergen_review_v1",
    queryVersion: 1,
    ...common(raw),
    permissions: Object.freeze({
      mayReview: bool(p.mayReview),
      mayApprove: bool(p.mayApprove),
      mayInvalidate: bool(p.mayInvalidate),
      mayEnforceBlocks: bool(p.mayEnforceBlocks),
      mayOpenIncident: bool(p.mayOpenIncident),
    }),
    filters: Object.freeze({
      subjectReference: nullable(f.subjectReference, reference),
      subjectKind: nullable(f.subjectKind, (item) =>
        oneOf(item, ["Ingredient", "Recipe", "SellablePath"] as const),
      ),
      allergenReference: nullable(f.allergenReference, reference),
      reviewStatus: nullable(f.reviewStatus, (item) => oneOf(item, reviewStatuses)),
      evidenceStatus: nullable(f.evidenceStatus, (item) => oneOf(item, evidenceStatuses)),
      storeReference: nullable(f.storeReference, reference),
    }),
    records,
  });
}
export function parseComplianceIncidentView(value: unknown): ComplianceIncidentView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "incident",
  ]);
  if (
    raw.screenId !== "CMP-INCIDENT" ||
    raw.queryName !== "compliance_incident_detail_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const p = object(raw.permissions, [
    "mayEnforceBlocks",
    "mayAssign",
    "mayRecordNotificationDecision",
    "mayLinkCases",
    "mayCloseAfterVerification",
  ]);
  const i = object(raw.incident, [
    "incidentReference",
    "revision",
    "caseReference",
    "incidentType",
    "severity",
    "status",
    "occurredAt",
    "reportedAt",
    "productReference",
    "orderReference",
    "lotReference",
    "employeeScopePresent",
    "restrictedSnapshotReferenceCount",
    "evidenceReferenceCount",
    "containmentOutcomeReferences",
    "notificationReference",
    "investigationReference",
    "outcomeCode",
    "verificationReference",
    "availabilityBlockOutcomeReference",
    "paymentBlockOutcomeReference",
    "requirementVersionReference",
    "accessClass",
  ]);
  const occurredAt = instant(i.occurredAt);
  const reportedAt = instant(i.reportedAt);
  if (Date.parse(occurredAt) > Date.parse(reportedAt) || i.accessClass !== "Restricted") fail();
  const rawContainment = i.containmentOutcomeReferences;
  if (!Array.isArray(rawContainment)) return fail();
  if (rawContainment.length > 32) return fail();
  const containmentOutcomeReferences = Object.freeze(
    rawContainment.map((item: unknown) => reference(item)),
  );
  if (new Set(containmentOutcomeReferences).size !== containmentOutcomeReferences.length) fail();
  const status = oneOf(i.status, [
    "Reported",
    "Contained",
    "Investigating",
    "CorrectiveAction",
    "Verification",
    "Closed",
    "Cancelled",
  ] as const);
  const outcomeCode = nullable(i.outcomeCode, coded);
  const verificationReference = nullable(i.verificationReference, reference);
  const availabilityBlockOutcomeReference = nullable(
    i.availabilityBlockOutcomeReference,
    reference,
  );
  const paymentBlockOutcomeReference = nullable(i.paymentBlockOutcomeReference, reference);
  if (
    (availabilityBlockOutcomeReference === null) !== (paymentBlockOutcomeReference === null) ||
    (status === "Closed" && (outcomeCode === null || verificationReference === null))
  )
    fail();
  return Object.freeze({
    screenId: "CMP-INCIDENT",
    queryName: "compliance_incident_detail_v1",
    queryVersion: 1,
    ...common(raw),
    permissions: Object.freeze({
      mayEnforceBlocks: bool(p.mayEnforceBlocks),
      mayAssign: bool(p.mayAssign),
      mayRecordNotificationDecision: bool(p.mayRecordNotificationDecision),
      mayLinkCases: bool(p.mayLinkCases),
      mayCloseAfterVerification: bool(p.mayCloseAfterVerification),
    }),
    incident: Object.freeze({
      incidentReference: reference(i.incidentReference),
      revision: positive(i.revision),
      caseReference: reference(i.caseReference),
      incidentType: coded(i.incidentType),
      severity: oneOf(i.severity, severities),
      status,
      occurredAt,
      reportedAt,
      productReference: nullable(i.productReference, reference),
      orderReference: nullable(i.orderReference, reference),
      lotReference: nullable(i.lotReference, reference),
      employeeScopePresent: bool(i.employeeScopePresent),
      restrictedSnapshotReferenceCount: decimalCount(i.restrictedSnapshotReferenceCount),
      evidenceReferenceCount: decimalCount(i.evidenceReferenceCount),
      containmentOutcomeReferences,
      notificationReference: nullable(i.notificationReference, reference),
      investigationReference: nullable(i.investigationReference, reference),
      outcomeCode,
      verificationReference,
      availabilityBlockOutcomeReference,
      paymentBlockOutcomeReference,
      requirementVersionReference: reference(i.requirementVersionReference),
      accessClass: "Restricted",
    }),
  });
}
export const unavailableComplianceAllergenIncidentClient: ComplianceAllergenIncidentClient =
  Object.freeze({
    async load() {
      throw new ComplianceAllergenIncidentPageError("Unavailable");
    },
  });
