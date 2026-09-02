import {
  parseReportingCode,
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  parseReportingScope,
  type ReportingCode,
  type ReportingDigest,
  type ReportingReference,
  type ReportingScope,
} from "./report-definition.js";

export type DataQualityCheckKind =
  | "Completeness"
  | "Uniqueness"
  | "ReferentialIntegrity"
  | "ValidRange"
  | "Timeliness"
  | "Reconciliation"
  | "SchemaCompatibility"
  | "CurrencyTimezoneConsistency";
export type DataQualitySeverity = "Info" | "Warning" | "Error" | "Critical";
export type ReconciliationControl =
  | "OrderItemTotal"
  | "PaymentLedger"
  | "InventoryLedger"
  | "PurchaseOrderReceipt"
  | "LoyaltyLedger"
  | "OutputAttempt";

export interface DataQualityCheckSnapshot {
  readonly checkReference: ReportingReference;
  readonly checkVersionReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: ReportingDigest;
  readonly lifecycle: "Active" | "Archived";
  readonly kind: DataQualityCheckKind;
  readonly datasetVersionReference: ReportingReference;
  readonly partitionCode: ReportingCode;
  readonly ruleCode: ReportingCode;
  readonly expectationCode: ReportingCode;
  readonly defaultSeverity: DataQualitySeverity;
  readonly ownerReference: ReportingReference;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly createdByActorReference: ReportingReference;
}

export interface DataQualityResultSnapshot {
  readonly resultReference: ReportingReference;
  readonly executionReference: ReportingReference;
  readonly checkReference: ReportingReference;
  readonly checkVersionReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly datasetVersionReference: ReportingReference;
  readonly partitionCode: ReportingCode;
  readonly outcome: "Pass" | "Fail";
  readonly severity: DataQualitySeverity;
  readonly expectedObservationCode: ReportingCode;
  readonly actualObservationCode: ReportingCode;
  readonly publicationDisposition: "ContinueFormalReporting" | "BlockFormalReporting";
  readonly affectedFrom: string;
  readonly affectedUntil: string;
  readonly detectedAt: string;
}

export interface DataQualityIssueActionSnapshot {
  readonly actionReference: ReportingReference;
  readonly resultReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly sequence: number;
  readonly action: "Acknowledge" | "Assign" | "OpenIncident" | "RequestBackfill" | "Resolve";
  readonly ownerReference: ReportingReference | null;
  readonly incidentReference: ReportingReference | null;
  readonly backfillRequestReference: ReportingReference | null;
  readonly rerunResultReference: ReportingReference | null;
  readonly resolutionCode: ReportingCode | null;
  readonly occurredAt: string;
  readonly actorReference: ReportingReference;
}

export interface ReconciliationRunSnapshot {
  readonly runReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly control: ReconciliationControl;
  readonly periodFrom: string;
  readonly periodUntil: string;
  readonly leftObservationReference: ReportingReference;
  readonly rightObservationReference: ReportingReference;
  readonly expectedValue: string;
  readonly actualValue: string;
  readonly differenceValue: string;
  readonly unitCode: ReportingCode;
  readonly outcome: "Matched" | "Difference";
  readonly detectedAt: string;
}

export interface ReconciliationExceptionSnapshot {
  readonly exceptionReference: ReportingReference;
  readonly runReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly sequence: number;
  readonly status: "Open" | "Investigating" | "Resolved";
  readonly ownerReference: ReportingReference | null;
  readonly investigationCode: ReportingCode | null;
  readonly resolutionCode: ReportingCode | null;
  readonly resolutionRerunReference: ReportingReference | null;
  readonly occurredAt: string;
  readonly actorReference: ReportingReference;
}

const invalid = (): never => {
  throw new Error("DATA_QUALITY_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype) return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : invalid();
const nullableReference = (value: unknown) =>
  value === null ? null : parseReportingReference(value);
const nullableCode = (value: unknown) => (value === null ? null : parseReportingCode(value));
const decimal = (value: unknown): string =>
  typeof value === "string" && /^-?(?:0|[1-9][0-9]{0,20})(?:\.[0-9]{1,9})?$/u.test(value)
    ? value
    : invalid();

export function createDataQualityCheckSnapshot(value: unknown): DataQualityCheckSnapshot {
  const raw = exact(value, [
    "checkReference",
    "checkVersionReference",
    "scope",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "kind",
    "datasetVersionReference",
    "partitionCode",
    "ruleCode",
    "expectationCode",
    "defaultSeverity",
    "ownerReference",
    "effectiveFrom",
    "effectiveUntil",
    "createdAt",
    "createdByActorReference",
  ]);
  const effectiveFrom = parseReportingInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseReportingInstant(raw.effectiveUntil);
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom)) invalid();
  return Object.freeze({
    checkReference: parseReportingReference(raw.checkReference),
    checkVersionReference: parseReportingReference(raw.checkVersionReference),
    scope: parseReportingScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    versionNumber: positive(raw.versionNumber),
    snapshotDigest: parseReportingDigest(raw.snapshotDigest),
    lifecycle: oneOf(raw.lifecycle, ["Active", "Archived"] as const),
    kind: oneOf(raw.kind, [
      "Completeness",
      "Uniqueness",
      "ReferentialIntegrity",
      "ValidRange",
      "Timeliness",
      "Reconciliation",
      "SchemaCompatibility",
      "CurrencyTimezoneConsistency",
    ] as const),
    datasetVersionReference: parseReportingReference(raw.datasetVersionReference),
    partitionCode: parseReportingCode(raw.partitionCode),
    ruleCode: parseReportingCode(raw.ruleCode),
    expectationCode: parseReportingCode(raw.expectationCode),
    defaultSeverity: oneOf(raw.defaultSeverity, ["Info", "Warning", "Error", "Critical"] as const),
    ownerReference: parseReportingReference(raw.ownerReference),
    effectiveFrom,
    effectiveUntil,
    createdAt: parseReportingInstant(raw.createdAt),
    createdByActorReference: parseReportingReference(raw.createdByActorReference),
  });
}

export function createDataQualityResultSnapshot(value: unknown): DataQualityResultSnapshot {
  const raw = exact(value, [
    "resultReference",
    "executionReference",
    "checkReference",
    "checkVersionReference",
    "scope",
    "datasetVersionReference",
    "partitionCode",
    "outcome",
    "severity",
    "expectedObservationCode",
    "actualObservationCode",
    "publicationDisposition",
    "affectedFrom",
    "affectedUntil",
    "detectedAt",
  ]);
  const outcome = oneOf(raw.outcome, ["Pass", "Fail"] as const);
  const severity = oneOf(raw.severity, ["Info", "Warning", "Error", "Critical"] as const);
  const disposition = oneOf(raw.publicationDisposition, [
    "ContinueFormalReporting",
    "BlockFormalReporting",
  ] as const);
  if ((disposition === "BlockFormalReporting") !== (outcome === "Fail" && severity === "Critical"))
    invalid();
  const affectedFrom = parseReportingInstant(raw.affectedFrom);
  const affectedUntil = parseReportingInstant(raw.affectedUntil);
  if (Date.parse(affectedUntil) <= Date.parse(affectedFrom)) invalid();
  return Object.freeze({
    resultReference: parseReportingReference(raw.resultReference),
    executionReference: parseReportingReference(raw.executionReference),
    checkReference: parseReportingReference(raw.checkReference),
    checkVersionReference: parseReportingReference(raw.checkVersionReference),
    scope: parseReportingScope(raw.scope),
    datasetVersionReference: parseReportingReference(raw.datasetVersionReference),
    partitionCode: parseReportingCode(raw.partitionCode),
    outcome,
    severity,
    expectedObservationCode: parseReportingCode(raw.expectedObservationCode),
    actualObservationCode: parseReportingCode(raw.actualObservationCode),
    publicationDisposition: disposition,
    affectedFrom,
    affectedUntil,
    detectedAt: parseReportingInstant(raw.detectedAt),
  });
}

export function createDataQualityIssueActionSnapshot(
  value: unknown,
): DataQualityIssueActionSnapshot {
  const raw = exact(value, [
    "actionReference",
    "resultReference",
    "scope",
    "sequence",
    "action",
    "ownerReference",
    "incidentReference",
    "backfillRequestReference",
    "rerunResultReference",
    "resolutionCode",
    "occurredAt",
    "actorReference",
  ]);
  const action = oneOf(raw.action, [
    "Acknowledge",
    "Assign",
    "OpenIncident",
    "RequestBackfill",
    "Resolve",
  ] as const);
  const ownerReference = nullableReference(raw.ownerReference);
  const incidentReference = nullableReference(raw.incidentReference);
  const backfillRequestReference = nullableReference(raw.backfillRequestReference);
  const rerunResultReference = nullableReference(raw.rerunResultReference);
  const resolutionCode = nullableCode(raw.resolutionCode);
  if (
    (action === "Assign") !== (ownerReference !== null) ||
    (action === "OpenIncident") !== (incidentReference !== null) ||
    (action === "RequestBackfill") !== (backfillRequestReference !== null) ||
    (action === "Resolve") !== (rerunResultReference !== null && resolutionCode !== null)
  )
    invalid();
  return Object.freeze({
    actionReference: parseReportingReference(raw.actionReference),
    resultReference: parseReportingReference(raw.resultReference),
    scope: parseReportingScope(raw.scope),
    sequence: positive(raw.sequence),
    action,
    ownerReference,
    incidentReference,
    backfillRequestReference,
    rerunResultReference,
    resolutionCode,
    occurredAt: parseReportingInstant(raw.occurredAt),
    actorReference: parseReportingReference(raw.actorReference),
  });
}

export function createReconciliationRunSnapshot(value: unknown): ReconciliationRunSnapshot {
  const raw = exact(value, [
    "runReference",
    "scope",
    "control",
    "periodFrom",
    "periodUntil",
    "leftObservationReference",
    "rightObservationReference",
    "expectedValue",
    "actualValue",
    "differenceValue",
    "unitCode",
    "outcome",
    "detectedAt",
  ]);
  const periodFrom = parseReportingInstant(raw.periodFrom);
  const periodUntil = parseReportingInstant(raw.periodUntil);
  if (Date.parse(periodUntil) <= Date.parse(periodFrom)) invalid();
  const differenceValue = decimal(raw.differenceValue);
  const outcome = oneOf(raw.outcome, ["Matched", "Difference"] as const);
  if ((outcome === "Matched") !== /^-?0(?:\.0+)?$/u.test(differenceValue)) invalid();
  return Object.freeze({
    runReference: parseReportingReference(raw.runReference),
    scope: parseReportingScope(raw.scope),
    control: oneOf(raw.control, [
      "OrderItemTotal",
      "PaymentLedger",
      "InventoryLedger",
      "PurchaseOrderReceipt",
      "LoyaltyLedger",
      "OutputAttempt",
    ] as const),
    periodFrom,
    periodUntil,
    leftObservationReference: parseReportingReference(raw.leftObservationReference),
    rightObservationReference: parseReportingReference(raw.rightObservationReference),
    expectedValue: decimal(raw.expectedValue),
    actualValue: decimal(raw.actualValue),
    differenceValue,
    unitCode: parseReportingCode(raw.unitCode),
    outcome,
    detectedAt: parseReportingInstant(raw.detectedAt),
  });
}

export function createReconciliationExceptionSnapshot(
  value: unknown,
): ReconciliationExceptionSnapshot {
  const raw = exact(value, [
    "exceptionReference",
    "runReference",
    "scope",
    "sequence",
    "status",
    "ownerReference",
    "investigationCode",
    "resolutionCode",
    "resolutionRerunReference",
    "occurredAt",
    "actorReference",
  ]);
  const status = oneOf(raw.status, ["Open", "Investigating", "Resolved"] as const);
  const ownerReference = nullableReference(raw.ownerReference);
  const investigationCode = nullableCode(raw.investigationCode);
  const resolutionCode = nullableCode(raw.resolutionCode);
  const resolutionRerunReference = nullableReference(raw.resolutionRerunReference);
  if (
    (status === "Open" &&
      (investigationCode !== null ||
        resolutionCode !== null ||
        resolutionRerunReference !== null)) ||
    (status === "Investigating" &&
      (ownerReference === null ||
        investigationCode === null ||
        resolutionCode !== null ||
        resolutionRerunReference !== null)) ||
    (status === "Resolved" &&
      (ownerReference === null || resolutionCode === null || resolutionRerunReference === null))
  )
    invalid();
  return Object.freeze({
    exceptionReference: parseReportingReference(raw.exceptionReference),
    runReference: parseReportingReference(raw.runReference),
    scope: parseReportingScope(raw.scope),
    sequence: positive(raw.sequence),
    status,
    ownerReference,
    investigationCode,
    resolutionCode,
    resolutionRerunReference,
    occurredAt: parseReportingInstant(raw.occurredAt),
    actorReference: parseReportingReference(raw.actorReference),
  });
}
