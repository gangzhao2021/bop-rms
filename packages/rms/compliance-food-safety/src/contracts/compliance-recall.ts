import {
  findingSeverities,
  parseComplianceInstant,
  parseComplianceReference,
  parseComplianceScope,
  type ComplianceReference,
  type ComplianceScope,
  type FindingSeverity,
} from "./compliance-dashboard.js";

export type RecallType = "Recall" | "Withdrawal";
export type RecallSourceKind =
  "ExternalAuthorityNotice" | "SupplierNotice" | "InternalFinding" | "FoodSafetyIncident";
export const recallStatuses = [
  "ScopeAssessment",
  "Containment",
  "Notification",
  "Disposition",
  "Verification",
  "Closed",
  "Cancelled",
] as const;
export type RecallStatus = (typeof recallStatuses)[number];
export interface RecallAffectedScope {
  readonly traceRunReference: ComplianceReference;
  readonly supplierReferences: readonly ComplianceReference[];
  readonly inventoryItemReferences: readonly ComplianceReference[];
  readonly lotReferences: readonly ComplianceReference[];
  readonly batchReferences: readonly ComplianceReference[];
  readonly productReferences: readonly ComplianceReference[];
  readonly skuReferences: readonly ComplianceReference[];
  readonly storeReferences: readonly ComplianceReference[];
  readonly expectedNodeCount: string;
  readonly tracedNodeCount: string;
  readonly gapCount: string;
  readonly customerOrderCount: string;
  readonly fulfillmentCount: string;
  readonly coverage: "Complete" | "Partial";
  readonly calculatedAt: string;
}
export interface RecallContainmentOutcomes {
  readonly inventoryHoldOutcomeReference: ComplianceReference;
  readonly transferBlockOutcomeReference: ComplianceReference;
  readonly availabilityBlockOutcomeReference: ComplianceReference;
  readonly orderingBlockOutcomeReference: ComplianceReference;
  readonly procurementBlockOutcomeReference: ComplianceReference;
  readonly enforcedAt: string;
}
export interface RecallNoticeOutcomes {
  readonly decisionReference: ComplianceReference;
  readonly approvalReference: ComplianceReference | null;
  readonly notificationOutcomeReference: ComplianceReference | null;
  readonly resolvedAt: string;
}
export interface RecallDisposition {
  readonly dispositionReference: ComplianceReference;
  readonly subjectKind: "InventoryItem" | "Lot" | "Batch" | "Product" | "SKU";
  readonly subjectReference: ComplianceReference;
  readonly decision: "Hold" | "Release" | "Return" | "Dispose" | "Withdraw";
  readonly ownerOutcomeReference: ComplianceReference;
  readonly decidedBy: ComplianceReference;
  readonly decidedAt: string;
}
export interface RecallVerification {
  readonly verificationReference: ComplianceReference;
  readonly result: "Passed" | "Failed" | "UnableToVerify";
  readonly verifiedBy: ComplianceReference;
  readonly verifiedAt: string;
}
export interface RecallRecord {
  readonly recallReference: ComplianceReference;
  readonly revision: number;
  readonly caseReference: ComplianceReference;
  readonly scope: ComplianceScope;
  readonly recallType: RecallType;
  readonly sourceKind: RecallSourceKind;
  readonly sourceReference: ComplianceReference;
  readonly sourceSnapshotDigest: string;
  readonly severity: FindingSeverity;
  readonly status: RecallStatus;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly affectedScope: RecallAffectedScope | null;
  readonly containmentOutcomes: RecallContainmentOutcomes | null;
  readonly taskOutcomeReference: ComplianceReference | null;
  readonly noticeRequirement: "Required" | "NotRequired";
  readonly noticeOutcomes: RecallNoticeOutcomes | null;
  readonly dispositions: readonly RecallDisposition[];
  readonly verification: RecallVerification | null;
  readonly requirementVersionReference: ComplianceReference;
  readonly recordedAt: string;
}

export type RecallContractErrorCode = "RECALL_INPUT_INVALID" | "RECALL_SCOPE_INVALID";
export class RecallContractError extends Error {
  constructor(readonly code: RecallContractErrorCode) {
    super("Recall input is invalid");
    this.name = "RecallContractError";
  }
}
const fail = (code: RecallContractErrorCode = "RECALL_INPUT_INVALID"): never => {
  throw new RecallContractError(code);
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
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const countPattern = /^(?:0|[1-9][0-9]{0,29})$/u;
const digest = (value: unknown) =>
  typeof value === "string" && digestPattern.test(value) ? value : fail();
const count = (value: unknown) =>
  typeof value === "string" && countPattern.test(value) ? value : fail();
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fail();
function references(value: unknown, maximum = 500): readonly ComplianceReference[] {
  if (!Array.isArray(value) || value.length > maximum) return fail();
  const parsed = Object.freeze(value.map(parseComplianceReference));
  return new Set(parsed).size === parsed.length ? parsed : fail();
}
function affectedScope(value: unknown): RecallAffectedScope {
  const raw = exact(value, [
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
    traceRunReference: parseComplianceReference(raw.traceRunReference),
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
    calculatedAt: parseComplianceInstant(raw.calculatedAt),
  });
}
function containment(value: unknown): RecallContainmentOutcomes {
  const raw = exact(value, [
    "inventoryHoldOutcomeReference",
    "transferBlockOutcomeReference",
    "availabilityBlockOutcomeReference",
    "orderingBlockOutcomeReference",
    "procurementBlockOutcomeReference",
    "enforcedAt",
  ]);
  return Object.freeze({
    inventoryHoldOutcomeReference: parseComplianceReference(raw.inventoryHoldOutcomeReference),
    transferBlockOutcomeReference: parseComplianceReference(raw.transferBlockOutcomeReference),
    availabilityBlockOutcomeReference: parseComplianceReference(
      raw.availabilityBlockOutcomeReference,
    ),
    orderingBlockOutcomeReference: parseComplianceReference(raw.orderingBlockOutcomeReference),
    procurementBlockOutcomeReference: parseComplianceReference(
      raw.procurementBlockOutcomeReference,
    ),
    enforcedAt: parseComplianceInstant(raw.enforcedAt),
  });
}
function notice(
  value: unknown,
  requirement: RecallRecord["noticeRequirement"],
): RecallNoticeOutcomes {
  const raw = exact(value, [
    "decisionReference",
    "approvalReference",
    "notificationOutcomeReference",
    "resolvedAt",
  ]);
  const approvalReference =
    raw.approvalReference === null ? null : parseComplianceReference(raw.approvalReference);
  const notificationOutcomeReference =
    raw.notificationOutcomeReference === null
      ? null
      : parseComplianceReference(raw.notificationOutcomeReference);
  if (
    requirement === "Required"
      ? approvalReference === null || notificationOutcomeReference === null
      : approvalReference !== null || notificationOutcomeReference !== null
  )
    return fail();
  return Object.freeze({
    decisionReference: parseComplianceReference(raw.decisionReference),
    approvalReference,
    notificationOutcomeReference,
    resolvedAt: parseComplianceInstant(raw.resolvedAt),
  });
}
function disposition(value: unknown): RecallDisposition {
  const raw = exact(value, [
    "dispositionReference",
    "subjectKind",
    "subjectReference",
    "decision",
    "ownerOutcomeReference",
    "decidedBy",
    "decidedAt",
  ]);
  return Object.freeze({
    dispositionReference: parseComplianceReference(raw.dispositionReference),
    subjectKind: oneOf(raw.subjectKind, [
      "InventoryItem",
      "Lot",
      "Batch",
      "Product",
      "SKU",
    ] as const),
    subjectReference: parseComplianceReference(raw.subjectReference),
    decision: oneOf(raw.decision, ["Hold", "Release", "Return", "Dispose", "Withdraw"] as const),
    ownerOutcomeReference: parseComplianceReference(raw.ownerOutcomeReference),
    decidedBy: parseComplianceReference(raw.decidedBy),
    decidedAt: parseComplianceInstant(raw.decidedAt),
  });
}
function verification(value: unknown): RecallVerification {
  const raw = exact(value, ["verificationReference", "result", "verifiedBy", "verifiedAt"]);
  return Object.freeze({
    verificationReference: parseComplianceReference(raw.verificationReference),
    result: oneOf(raw.result, ["Passed", "Failed", "UnableToVerify"] as const),
    verifiedBy: parseComplianceReference(raw.verifiedBy),
    verifiedAt: parseComplianceInstant(raw.verifiedAt),
  });
}
export function createRecallRecord(value: unknown): RecallRecord {
  const raw = exact(value, [
    "recallReference",
    "revision",
    "caseReference",
    "scope",
    "recallType",
    "sourceKind",
    "sourceReference",
    "sourceSnapshotDigest",
    "severity",
    "status",
    "effectiveFrom",
    "effectiveTo",
    "affectedScope",
    "containmentOutcomes",
    "taskOutcomeReference",
    "noticeRequirement",
    "noticeOutcomes",
    "dispositions",
    "verification",
    "requirementVersionReference",
    "recordedAt",
  ]);
  const status = oneOf(raw.status, recallStatuses);
  const noticeRequirement = oneOf(raw.noticeRequirement, ["Required", "NotRequired"] as const);
  const effectiveFrom = parseComplianceInstant(raw.effectiveFrom);
  const effectiveTo = raw.effectiveTo === null ? null : parseComplianceInstant(raw.effectiveTo);
  const affected = raw.affectedScope === null ? null : affectedScope(raw.affectedScope);
  const outcomes = raw.containmentOutcomes === null ? null : containment(raw.containmentOutcomes);
  const noticeOutcomes =
    raw.noticeOutcomes === null ? null : notice(raw.noticeOutcomes, noticeRequirement);
  if (!Array.isArray(raw.dispositions) || raw.dispositions.length > 500) return fail();
  const dispositions = Object.freeze(raw.dispositions.map(disposition));
  const verified = raw.verification === null ? null : verification(raw.verification);
  const recordedAt = parseComplianceInstant(raw.recordedAt);
  if (
    (effectiveTo !== null && Date.parse(effectiveFrom) > Date.parse(effectiveTo)) ||
    new Set(dispositions.map((item) => item.dispositionReference)).size !== dispositions.length ||
    (status === "ScopeAssessment"
      ? affected !== null ||
        outcomes !== null ||
        noticeOutcomes !== null ||
        dispositions.length > 0 ||
        verified !== null
      : affected === null) ||
    ((["Notification", "Disposition", "Verification", "Closed"] as const).includes(
      status as never,
    ) &&
      outcomes === null) ||
    ((["Disposition", "Verification", "Closed"] as const).includes(status as never) &&
      noticeOutcomes === null) ||
    ((["Verification", "Closed"] as const).includes(status as never) && dispositions.length < 1) ||
    (status === "Closed" &&
      (affected?.coverage !== "Complete" ||
        verified?.result !== "Passed" ||
        outcomes === null ||
        noticeOutcomes === null ||
        dispositions.length < 1)) ||
    (status !== "Closed" && verified?.result === "Passed") ||
    (affected !== null && Date.parse(affected.calculatedAt) > Date.parse(recordedAt)) ||
    (outcomes !== null && Date.parse(outcomes.enforcedAt) > Date.parse(recordedAt)) ||
    (noticeOutcomes !== null && Date.parse(noticeOutcomes.resolvedAt) > Date.parse(recordedAt)) ||
    dispositions.some((item) => Date.parse(item.decidedAt) > Date.parse(recordedAt)) ||
    (verified !== null && Date.parse(verified.verifiedAt) > Date.parse(recordedAt))
  )
    return fail("RECALL_SCOPE_INVALID");
  return Object.freeze({
    recallReference: parseComplianceReference(raw.recallReference),
    revision: positive(raw.revision),
    caseReference: parseComplianceReference(raw.caseReference),
    scope: parseComplianceScope(raw.scope),
    recallType: oneOf(raw.recallType, ["Recall", "Withdrawal"] as const),
    sourceKind: oneOf(raw.sourceKind, [
      "ExternalAuthorityNotice",
      "SupplierNotice",
      "InternalFinding",
      "FoodSafetyIncident",
    ] as const),
    sourceReference: parseComplianceReference(raw.sourceReference),
    sourceSnapshotDigest: digest(raw.sourceSnapshotDigest),
    severity: oneOf(raw.severity, findingSeverities),
    status,
    effectiveFrom,
    effectiveTo,
    affectedScope: affected,
    containmentOutcomes: outcomes,
    taskOutcomeReference:
      raw.taskOutcomeReference === null ? null : parseComplianceReference(raw.taskOutcomeReference),
    noticeRequirement,
    noticeOutcomes,
    dispositions,
    verification: verified,
    requirementVersionReference: parseComplianceReference(raw.requirementVersionReference),
    recordedAt,
  });
}
