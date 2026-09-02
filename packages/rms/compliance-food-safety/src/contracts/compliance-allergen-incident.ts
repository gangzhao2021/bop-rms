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

export const allergenSourceClassifications = [
  "Contains",
  "CrossContactPossible",
  "Unverified",
] as const;
export type AllergenSourceClassification = (typeof allergenSourceClassifications)[number];
export const allergenEvidenceStatuses = [
  "Current",
  "Expired",
  "Conflicting",
  "Unverified",
] as const;
export type AllergenEvidenceStatus = (typeof allergenEvidenceStatuses)[number];
export const allergenReviewStatuses = ["Pending", "Approved", "Rejected", "Invalidated"] as const;
export type AllergenReviewStatus = (typeof allergenReviewStatuses)[number];
export interface AllergenSourceAssertion {
  readonly allergenReference: ComplianceReference;
  readonly classification: AllergenSourceClassification;
  readonly sourceVersionReference: ComplianceReference;
  readonly evidenceReference: ComplianceReference;
  readonly evidenceStatus: AllergenEvidenceStatus;
  readonly validUntil: string;
}
export interface AllergenControlReview {
  readonly reviewReference: ComplianceReference;
  readonly revision: number;
  readonly scope: ComplianceScope;
  readonly subjectKind: "Ingredient" | "Recipe" | "SellablePath";
  readonly subjectReference: ComplianceReference;
  readonly configurationDigest: string;
  readonly allergenPolicyVersionReference: ComplianceReference;
  readonly recipeVersionReferences: readonly ComplianceReference[];
  readonly sourceAssertions: readonly AllergenSourceAssertion[];
  readonly reviewStatus: AllergenReviewStatus;
  readonly reviewerReference: ComplianceReference | null;
  readonly reviewedAt: string | null;
  readonly invalidatedBySourceVersionReference: ComplianceReference | null;
  readonly publicationBlockOutcomeReference: ComplianceReference | null;
  readonly paymentBlockOutcomeReference: ComplianceReference | null;
  readonly allergenFreeClaim: false;
  readonly requirementVersionReference: ComplianceReference;
  readonly severity: FindingSeverity;
  readonly recordedAt: string;
}

export const foodSafetyIncidentTypes = [
  "SuspectedFoodborneIllness",
  "AllergenExposure",
  "Contamination",
  "ForeignObject",
  "TemperatureAbuse",
  "PestSanitationFailure",
  "Mislabeling",
  "RegulatoryComplaint",
  "EmployeeHealthRisk",
  "Other",
] as const;
export type FoodSafetyIncidentType = (typeof foodSafetyIncidentTypes)[number];
export const foodSafetyIncidentStatuses = [
  "Reported",
  "Contained",
  "Investigating",
  "CorrectiveAction",
  "Verification",
  "Closed",
  "Cancelled",
] as const;
export type FoodSafetyIncidentStatus = (typeof foodSafetyIncidentStatuses)[number];
export interface FoodSafetyIncidentRecord {
  readonly incidentReference: ComplianceReference;
  readonly revision: number;
  readonly caseReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly incidentType: FoodSafetyIncidentType;
  readonly severity: FindingSeverity;
  readonly status: FoodSafetyIncidentStatus;
  readonly occurredAt: string;
  readonly reportedAt: string;
  readonly reporterReference: ComplianceReference;
  readonly productReference: ComplianceReference | null;
  readonly orderReference: ComplianceReference | null;
  readonly lotReference: ComplianceReference | null;
  readonly employeeReference: ComplianceReference | null;
  readonly allegationSnapshotReference: ComplianceReference | null;
  readonly healthSnapshotReference: ComplianceReference | null;
  readonly configurationSnapshotDigest: string | null;
  readonly recipeSnapshotDigest: string | null;
  readonly handlingSnapshotDigest: string | null;
  readonly containmentOutcomeReferences: readonly ComplianceReference[];
  readonly evidenceReferences: readonly ComplianceReference[];
  readonly notificationReference: ComplianceReference | null;
  readonly investigationReference: ComplianceReference | null;
  readonly outcomeCode: ComplianceCode | null;
  readonly verificationReference: ComplianceReference | null;
  readonly availabilityBlockOutcomeReference: ComplianceReference | null;
  readonly paymentBlockOutcomeReference: ComplianceReference | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly accessClass: "Restricted";
  readonly recordedAt: string;
}

export class ComplianceAllergenIncidentContractError extends Error {
  constructor() {
    super("Compliance allergen or incident input is invalid");
    this.name = "ComplianceAllergenIncidentContractError";
  }
}
const fail = (): never => {
  throw new ComplianceAllergenIncidentContractError();
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
const positive = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
const nullableReference = (value: unknown): ComplianceReference | null =>
  value === null ? null : parseComplianceReference(value);
const nullableDigest = (value: unknown): string | null => (value === null ? null : digest(value));
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
function digest(value: unknown): string {
  return typeof value === "string" && digestPattern.test(value) ? value : fail();
}
function references(
  value: unknown,
  minimum: number,
  maximum: number,
): readonly ComplianceReference[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return fail();
  const parsed = value.map(parseComplianceReference);
  if (
    new Set(parsed).size !== parsed.length ||
    parsed.some((item, index) => index > 0 && item <= (parsed[index - 1] ?? item))
  )
    return fail();
  return Object.freeze(parsed);
}
function sourceAssertion(value: unknown): AllergenSourceAssertion {
  const raw = exact(value, [
    "allergenReference",
    "classification",
    "sourceVersionReference",
    "evidenceReference",
    "evidenceStatus",
    "validUntil",
  ]);
  return Object.freeze({
    allergenReference: parseComplianceReference(raw.allergenReference),
    classification: oneOf(raw.classification, allergenSourceClassifications),
    sourceVersionReference: parseComplianceReference(raw.sourceVersionReference),
    evidenceReference: parseComplianceReference(raw.evidenceReference),
    evidenceStatus: oneOf(raw.evidenceStatus, allergenEvidenceStatuses),
    validUntil: parseComplianceInstant(raw.validUntil),
  });
}
export function createAllergenControlReview(value: unknown): AllergenControlReview {
  const raw = exact(value, [
    "reviewReference",
    "revision",
    "scope",
    "subjectKind",
    "subjectReference",
    "configurationDigest",
    "allergenPolicyVersionReference",
    "recipeVersionReferences",
    "sourceAssertions",
    "reviewStatus",
    "reviewerReference",
    "reviewedAt",
    "invalidatedBySourceVersionReference",
    "publicationBlockOutcomeReference",
    "paymentBlockOutcomeReference",
    "allergenFreeClaim",
    "requirementVersionReference",
    "severity",
    "recordedAt",
  ]);
  if (
    !Array.isArray(raw.sourceAssertions) ||
    raw.sourceAssertions.length < 1 ||
    raw.sourceAssertions.length > 64
  )
    return fail();
  const sourceAssertions = Object.freeze(raw.sourceAssertions.map(sourceAssertion));
  if (
    new Set(sourceAssertions.map((item) => item.allergenReference)).size !==
      sourceAssertions.length ||
    sourceAssertions.some(
      (item, index) =>
        index > 0 &&
        item.allergenReference <=
          (sourceAssertions[index - 1]?.allergenReference ?? item.allergenReference),
    )
  )
    return fail();
  const reviewStatus = oneOf(raw.reviewStatus, allergenReviewStatuses);
  const reviewerReference = nullableReference(raw.reviewerReference);
  const reviewedAt = raw.reviewedAt === null ? null : parseComplianceInstant(raw.reviewedAt);
  const invalidatedBySourceVersionReference = nullableReference(
    raw.invalidatedBySourceVersionReference,
  );
  const severity = oneOf(raw.severity, findingSeverities);
  const recordedAt = parseComplianceInstant(raw.recordedAt);
  const unsafe = sourceAssertions.some(
    (item) =>
      item.classification === "Unverified" ||
      item.evidenceStatus !== "Current" ||
      (reviewedAt !== null && Date.parse(item.validUntil) <= Date.parse(reviewedAt)),
  );
  if (
    (reviewerReference === null) !== (reviewedAt === null) ||
    (reviewStatus === "Pending" && reviewerReference !== null) ||
    (reviewStatus !== "Pending" && reviewerReference === null) ||
    (reviewStatus === "Approved" && unsafe) ||
    (reviewStatus === "Invalidated") !== (invalidatedBySourceVersionReference !== null) ||
    (raw.publicationBlockOutcomeReference === null) !==
      (raw.paymentBlockOutcomeReference === null) ||
    (reviewedAt !== null && Date.parse(reviewedAt) > Date.parse(recordedAt)) ||
    ((reviewStatus === "Rejected" || reviewStatus === "Invalidated") &&
      severity !== "Critical" &&
      severity !== "ImmediateDanger") ||
    raw.allergenFreeClaim !== false
  )
    return fail();
  return Object.freeze({
    reviewReference: parseComplianceReference(raw.reviewReference),
    revision: positive(raw.revision),
    scope: parseComplianceScope(raw.scope),
    subjectKind: oneOf(raw.subjectKind, ["Ingredient", "Recipe", "SellablePath"] as const),
    subjectReference: parseComplianceReference(raw.subjectReference),
    configurationDigest: digest(raw.configurationDigest),
    allergenPolicyVersionReference: parseComplianceReference(raw.allergenPolicyVersionReference),
    recipeVersionReferences: references(raw.recipeVersionReferences, 0, 64),
    sourceAssertions,
    reviewStatus,
    reviewerReference,
    reviewedAt,
    invalidatedBySourceVersionReference,
    publicationBlockOutcomeReference: nullableReference(raw.publicationBlockOutcomeReference),
    paymentBlockOutcomeReference: nullableReference(raw.paymentBlockOutcomeReference),
    allergenFreeClaim: false,
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    severity,
    recordedAt,
  });
}

export function createFoodSafetyIncidentRecord(value: unknown): FoodSafetyIncidentRecord {
  const raw = exact(value, [
    "incidentReference",
    "revision",
    "caseReference",
    "scope",
    "incidentType",
    "severity",
    "status",
    "occurredAt",
    "reportedAt",
    "reporterReference",
    "productReference",
    "orderReference",
    "lotReference",
    "employeeReference",
    "allegationSnapshotReference",
    "healthSnapshotReference",
    "configurationSnapshotDigest",
    "recipeSnapshotDigest",
    "handlingSnapshotDigest",
    "containmentOutcomeReferences",
    "evidenceReferences",
    "notificationReference",
    "investigationReference",
    "outcomeCode",
    "verificationReference",
    "availabilityBlockOutcomeReference",
    "paymentBlockOutcomeReference",
    "requirementVersionReference",
    "accessClass",
    "recordedAt",
  ]);
  const incidentType = oneOf(raw.incidentType, foodSafetyIncidentTypes);
  const severity = oneOf(raw.severity, findingSeverities);
  const status = oneOf(raw.status, foodSafetyIncidentStatuses);
  const occurredAt = parseComplianceInstant(raw.occurredAt);
  const reportedAt = parseComplianceInstant(raw.reportedAt);
  const configurationSnapshotDigest = nullableDigest(raw.configurationSnapshotDigest);
  const recipeSnapshotDigest = nullableDigest(raw.recipeSnapshotDigest);
  const handlingSnapshotDigest = nullableDigest(raw.handlingSnapshotDigest);
  const outcomeCode = raw.outcomeCode === null ? null : parseComplianceCode(raw.outcomeCode);
  const verificationReference = nullableReference(raw.verificationReference);
  const containmentOutcomeReferences = references(raw.containmentOutcomeReferences, 0, 32);
  if (
    Date.parse(occurredAt) > Date.parse(reportedAt) ||
    Date.parse(reportedAt) > Date.parse(parseComplianceInstant(raw.recordedAt)) ||
    raw.accessClass !== "Restricted" ||
    (incidentType === "EmployeeHealthRisk" && raw.healthSnapshotReference === null) ||
    (incidentType === "AllergenExposure" &&
      (configurationSnapshotDigest === null ||
        recipeSnapshotDigest === null ||
        handlingSnapshotDigest === null)) ||
    (status === "Closed" &&
      (outcomeCode === null ||
        verificationReference === null ||
        ((severity === "ImmediateDanger" || severity === "Critical") &&
          containmentOutcomeReferences.length === 0))) ||
    (status !== "Closed" && outcomeCode !== null) ||
    (raw.availabilityBlockOutcomeReference === null) !== (raw.paymentBlockOutcomeReference === null)
  )
    return fail();
  return Object.freeze({
    incidentReference: parseComplianceReference(raw.incidentReference),
    revision: positive(raw.revision),
    caseReference: parseComplianceReference(raw.caseReference),
    scope: parseComplianceScope(raw.scope),
    incidentType,
    severity,
    status,
    occurredAt,
    reportedAt,
    reporterReference: parseComplianceReference(raw.reporterReference),
    productReference: nullableReference(raw.productReference),
    orderReference: nullableReference(raw.orderReference),
    lotReference: nullableReference(raw.lotReference),
    employeeReference: nullableReference(raw.employeeReference),
    allegationSnapshotReference: nullableReference(raw.allegationSnapshotReference),
    healthSnapshotReference: nullableReference(raw.healthSnapshotReference),
    configurationSnapshotDigest,
    recipeSnapshotDigest,
    handlingSnapshotDigest,
    containmentOutcomeReferences,
    evidenceReferences: references(raw.evidenceReferences, 1, 64),
    notificationReference: nullableReference(raw.notificationReference),
    investigationReference: nullableReference(raw.investigationReference),
    outcomeCode,
    verificationReference,
    availabilityBlockOutcomeReference: nullableReference(raw.availabilityBlockOutcomeReference),
    paymentBlockOutcomeReference: nullableReference(raw.paymentBlockOutcomeReference),
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    accessClass: "Restricted",
    recordedAt: parseComplianceInstant(raw.recordedAt),
  });
}
