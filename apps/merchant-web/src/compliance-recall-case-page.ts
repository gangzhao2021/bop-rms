export type ComplianceRecallPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ComplianceRecallPageError extends Error {
  constructor(readonly code: ComplianceRecallPageErrorCode) {
    super("Compliance Recall page unavailable");
    this.name = "ComplianceRecallPageError";
  }
}
export interface ComplianceRecallClient {
  load(): Promise<unknown>;
}
type Status =
  | "ScopeAssessment"
  | "Containment"
  | "Notification"
  | "Disposition"
  | "Verification"
  | "Closed"
  | "Cancelled";
type Severity = "Observation" | "Minor" | "Major" | "Critical" | "ImmediateDanger";
export interface ComplianceRecallView {
  readonly screenId: "RECALL-CASE";
  readonly queryName: "compliance_recall_case_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly sourceAsOf: string;
  readonly freshness: "Current" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly permissions: {
    readonly mayCalculateScope: boolean;
    readonly mayEnforceContainment: boolean;
    readonly mayCreateTasks: boolean;
    readonly mayResolveNotice: boolean;
    readonly mayRecordDisposition: boolean;
    readonly mayVerifyClosure: boolean;
  };
  readonly recall: {
    readonly recallReference: string;
    readonly revision: number;
    readonly caseReference: string;
    readonly recallType: "Recall" | "Withdrawal";
    readonly sourceKind:
      "ExternalAuthorityNotice" | "SupplierNotice" | "InternalFinding" | "FoodSafetyIncident";
    readonly sourceReference: string;
    readonly sourceSnapshotDigest: string;
    readonly severity: Severity;
    readonly status: Status;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
    readonly affectedScope: null | {
      readonly traceRunReference: string;
      readonly supplierReferences: readonly string[];
      readonly inventoryItemReferences: readonly string[];
      readonly lotReferences: readonly string[];
      readonly batchReferences: readonly string[];
      readonly productReferences: readonly string[];
      readonly skuReferences: readonly string[];
      readonly storeReferences: readonly string[];
      readonly expectedNodeCount: string;
      readonly tracedNodeCount: string;
      readonly gapCount: string;
      readonly customerOrderCount: string;
      readonly fulfillmentCount: string;
      readonly coverage: "Complete" | "Partial";
      readonly calculatedAt: string;
    };
    readonly containmentOutcomeReferences: readonly string[];
    readonly taskOutcomeReference: string | null;
    readonly noticeRequirement: "Required" | "NotRequired";
    readonly noticeDecisionReference: string | null;
    readonly noticeApprovalReference: string | null;
    readonly notificationOutcomeReference: string | null;
    readonly dispositions: readonly {
      readonly dispositionReference: string;
      readonly subjectKind: "InventoryItem" | "Lot" | "Batch" | "Product" | "SKU";
      readonly subjectReference: string;
      readonly decision: "Hold" | "Release" | "Return" | "Dispose" | "Withdraw";
      readonly ownerOutcomeReference: string;
      readonly decidedAt: string;
    }[];
    readonly verification: null | {
      readonly verificationReference: string;
      readonly result: "Passed" | "Failed" | "UnableToVerify";
      readonly verifiedAt: string;
    };
    readonly requirementVersionReference: string;
  };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const countPattern = /^(?:0|[1-9][0-9]{0,29})$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ComplianceRecallPageError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
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
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const nullableReference = (value: unknown) => (value === null ? null : reference(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const count = (value: unknown) =>
  typeof value === "string" && countPattern.test(value) ? value : fail();
const digest = (value: unknown) =>
  typeof value === "string" && digestPattern.test(value) ? value : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
function references(value: unknown, maximum = 500) {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  const parsed = Object.freeze(value.map(reference));
  return new Set(parsed).size === parsed.length ? parsed : fail();
}
function scope(value: unknown) {
  if (value === null) return null;
  const raw = object(value, [
    "traceRunReference",
    "supplierReferences",
    "inventoryItemReferences",
    "lotReferences",
    "batchReferences",
    "productReferences",
    "skuReferences",
    "storeReferences",
    "expectedNodeCount",
    "tracedNodeCount",
    "gapCount",
    "customerOrderCount",
    "fulfillmentCount",
    "coverage",
    "calculatedAt",
  ]);
  const expectedNodeCount = count(raw.expectedNodeCount);
  const tracedNodeCount = count(raw.tracedNodeCount);
  const gapCount = count(raw.gapCount);
  const coverage = oneOf(raw.coverage, ["Complete", "Partial"] as const);
  if (
    BigInt(expectedNodeCount) !== BigInt(tracedNodeCount) + BigInt(gapCount) ||
    (coverage === "Complete") !== (gapCount === "0")
  )
    return fail();
  return Object.freeze({
    traceRunReference: reference(raw.traceRunReference),
    supplierReferences: references(raw.supplierReferences),
    inventoryItemReferences: references(raw.inventoryItemReferences),
    lotReferences: references(raw.lotReferences),
    batchReferences: references(raw.batchReferences),
    productReferences: references(raw.productReferences),
    skuReferences: references(raw.skuReferences),
    storeReferences: references(raw.storeReferences),
    expectedNodeCount,
    tracedNodeCount,
    gapCount,
    customerOrderCount: count(raw.customerOrderCount),
    fulfillmentCount: count(raw.fulfillmentCount),
    coverage,
    calculatedAt: instant(raw.calculatedAt),
  });
}
function disposition(value: unknown): ComplianceRecallView["recall"]["dispositions"][number] {
  const raw = object(value, [
    "dispositionReference",
    "subjectKind",
    "subjectReference",
    "decision",
    "ownerOutcomeReference",
    "decidedAt",
  ]);
  return Object.freeze({
    dispositionReference: reference(raw.dispositionReference),
    subjectKind: oneOf(raw.subjectKind, [
      "InventoryItem",
      "Lot",
      "Batch",
      "Product",
      "SKU",
    ] as const),
    subjectReference: reference(raw.subjectReference),
    decision: oneOf(raw.decision, ["Hold", "Release", "Return", "Dispose", "Withdraw"] as const),
    ownerOutcomeReference: reference(raw.ownerOutcomeReference),
    decidedAt: instant(raw.decidedAt),
  });
}
function verification(value: unknown) {
  if (value === null) return null;
  const raw = object(value, ["verificationReference", "result", "verifiedAt"]);
  return Object.freeze({
    verificationReference: reference(raw.verificationReference),
    result: oneOf(raw.result, ["Passed", "Failed", "UnableToVerify"] as const),
    verifiedAt: instant(raw.verifiedAt),
  });
}
export function parseComplianceRecallView(value: unknown): ComplianceRecallView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "sourceAsOf",
    "freshness",
    "completeness",
    "permissions",
    "recall",
  ]);
  if (
    raw.screenId !== "RECALL-CASE" ||
    raw.queryName !== "compliance_recall_case_v1" ||
    raw.queryVersion !== 1
  )
    return fail();
  const generatedAt = instant(raw.generatedAt);
  const sourceAsOf = instant(raw.sourceAsOf);
  if (Date.parse(sourceAsOf) > Date.parse(generatedAt)) return fail();
  const permissions = object(raw.permissions, [
    "mayCalculateScope",
    "mayEnforceContainment",
    "mayCreateTasks",
    "mayResolveNotice",
    "mayRecordDisposition",
    "mayVerifyClosure",
  ]);
  const item = object(raw.recall, [
    "recallReference",
    "revision",
    "caseReference",
    "recallType",
    "sourceKind",
    "sourceReference",
    "sourceSnapshotDigest",
    "severity",
    "status",
    "effectiveFrom",
    "effectiveTo",
    "affectedScope",
    "containmentOutcomeReferences",
    "taskOutcomeReference",
    "noticeRequirement",
    "noticeDecisionReference",
    "noticeApprovalReference",
    "notificationOutcomeReference",
    "dispositions",
    "verification",
    "requirementVersionReference",
  ]);
  const status = oneOf(item.status, [
    "ScopeAssessment",
    "Containment",
    "Notification",
    "Disposition",
    "Verification",
    "Closed",
    "Cancelled",
  ] as const);
  const affectedScope = scope(item.affectedScope);
  const containmentOutcomeReferences = references(item.containmentOutcomeReferences, 5);
  const noticeRequirement = oneOf(item.noticeRequirement, ["Required", "NotRequired"] as const);
  const noticeDecisionReference = nullableReference(item.noticeDecisionReference);
  const noticeApprovalReference = nullableReference(item.noticeApprovalReference);
  const notificationOutcomeReference = nullableReference(item.notificationOutcomeReference);
  if (!Array.isArray(item.dispositions) || item.dispositions.length > 500) return fail();
  const dispositions = Object.freeze(item.dispositions.map(disposition));
  const verified = verification(item.verification);
  const hasContainment = containmentOutcomeReferences.length === 5;
  const hasNotice =
    noticeDecisionReference !== null &&
    (noticeRequirement === "Required"
      ? noticeApprovalReference !== null && notificationOutcomeReference !== null
      : noticeApprovalReference === null && notificationOutcomeReference === null);
  if (
    (status === "ScopeAssessment" ? affectedScope !== null : affectedScope === null) ||
    ((["Notification", "Disposition", "Verification", "Closed"] as const).includes(
      status as never,
    ) &&
      !hasContainment) ||
    ((["Disposition", "Verification", "Closed"] as const).includes(status as never) &&
      !hasNotice) ||
    ((["Verification", "Closed"] as const).includes(status as never) && dispositions.length < 1) ||
    (status === "Closed" &&
      (affectedScope?.coverage !== "Complete" || verified?.result !== "Passed")) ||
    (status !== "Closed" && verified?.result === "Passed") ||
    new Set(dispositions.map((entry) => entry.dispositionReference)).size !== dispositions.length
  )
    return fail();
  return Object.freeze({
    screenId: "RECALL-CASE",
    queryName: "compliance_recall_case_v1",
    queryVersion: 1,
    generatedAt,
    sourceAsOf,
    freshness: oneOf(raw.freshness, ["Current", "Stale"] as const),
    completeness: oneOf(raw.completeness, ["Complete", "Partial"] as const),
    permissions: Object.freeze({
      mayCalculateScope: bool(permissions.mayCalculateScope),
      mayEnforceContainment: bool(permissions.mayEnforceContainment),
      mayCreateTasks: bool(permissions.mayCreateTasks),
      mayResolveNotice: bool(permissions.mayResolveNotice),
      mayRecordDisposition: bool(permissions.mayRecordDisposition),
      mayVerifyClosure: bool(permissions.mayVerifyClosure),
    }),
    recall: Object.freeze({
      recallReference: reference(item.recallReference),
      revision: positive(item.revision),
      caseReference: reference(item.caseReference),
      recallType: oneOf(item.recallType, ["Recall", "Withdrawal"] as const),
      sourceKind: oneOf(item.sourceKind, [
        "ExternalAuthorityNotice",
        "SupplierNotice",
        "InternalFinding",
        "FoodSafetyIncident",
      ] as const),
      sourceReference: reference(item.sourceReference),
      sourceSnapshotDigest: digest(item.sourceSnapshotDigest),
      severity: oneOf(item.severity, [
        "Observation",
        "Minor",
        "Major",
        "Critical",
        "ImmediateDanger",
      ] as const),
      status,
      effectiveFrom: instant(item.effectiveFrom),
      effectiveTo: nullableInstant(item.effectiveTo),
      affectedScope,
      containmentOutcomeReferences,
      taskOutcomeReference: nullableReference(item.taskOutcomeReference),
      noticeRequirement,
      noticeDecisionReference,
      noticeApprovalReference,
      notificationOutcomeReference,
      dispositions,
      verification: verified,
      requirementVersionReference: reference(item.requirementVersionReference),
    }),
  });
}
export const unavailableComplianceRecallClient: ComplianceRecallClient = {
  async load() {
    throw new ComplianceRecallPageError("Unavailable");
  },
};
