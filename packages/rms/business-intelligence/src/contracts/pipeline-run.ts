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

export type PipelineExecutionKind =
  "Load" | "Retry" | "PipelineCorrection" | "Backfill" | "Rebuild";
export type PipelineRunStatus =
  "Queued" | "Running" | "Succeeded" | "SucceededWithWarning" | "Failed" | "Cancelled";
export type BackfillLifecycle =
  "Requested" | "Approved" | "Rejected" | "Running" | "Completed" | "Failed" | "Cancelled";

export interface PipelineRunSnapshot {
  readonly runReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly pipelineReference: ReportingReference;
  readonly pipelineVersionReference: ReportingReference;
  readonly transformationVersionReference: ReportingReference;
  readonly inputCheckpointReference: ReportingReference;
  readonly outputDatasetVersionReference: ReportingReference;
  readonly outputPartitionCode: ReportingCode;
  readonly environmentCode: ReportingCode;
  readonly logicalBatchDigest: ReportingDigest;
  readonly executionKind: PipelineExecutionKind;
  readonly replay: boolean;
  readonly retryOfRunReference: ReportingReference | null;
  readonly backfillRequestVersionReference: ReportingReference | null;
  readonly correctionReasonCode: ReportingCode | null;
  readonly correctionCodeVersionReference: ReportingReference | null;
  readonly preReconciliationRunReference: ReportingReference | null;
  readonly queuedAt: string;
  readonly requestedByActorReference: ReportingReference;
}

export interface PipelineRunStateSnapshot {
  readonly stateReference: ReportingReference;
  readonly runReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly sequence: number;
  readonly status: PipelineRunStatus;
  readonly watermarkOccurredAt: string | null;
  readonly recordsRead: string | null;
  readonly recordsWritten: string | null;
  readonly recordsLate: string | null;
  readonly recordsRejected: string | null;
  readonly dataQualityResultReference: ReportingReference | null;
  readonly postReconciliationRunReference: ReportingReference | null;
  readonly errorReference: ReportingReference | null;
  readonly occurredAt: string;
  readonly actorReference: ReportingReference;
}

export interface BackfillRequestSnapshot {
  readonly requestReference: ReportingReference;
  readonly requestVersionReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: ReportingDigest;
  readonly lifecycle: BackfillLifecycle;
  readonly pipelineReference: ReportingReference;
  readonly pipelineVersionReference: ReportingReference;
  readonly transformationVersionReference: ReportingReference;
  readonly outputDatasetVersionReference: ReportingReference;
  readonly outputPartitionCode: ReportingCode;
  readonly rangeFrom: string;
  readonly rangeUntil: string;
  readonly reasonCode: ReportingCode;
  readonly requestedAt: string;
  readonly requestedByActorReference: ReportingReference;
  readonly decidedAt: string | null;
  readonly decidedByActorReference: ReportingReference | null;
  readonly boundRunReference: ReportingReference | null;
  readonly recordedAt: string;
  readonly recordedByActorReference: ReportingReference;
}

const invalid = (): never => {
  throw new Error("PIPELINE_RUN_INPUT_INVALID");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : invalid();
const nullableReference = (value: unknown) =>
  value === null ? null : parseReportingReference(value);
const nullableCode = (value: unknown) => (value === null ? null : parseReportingCode(value));
const nullableInstant = (value: unknown) => (value === null ? null : parseReportingInstant(value));
const positive = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : invalid();
const count = (value: unknown) =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,29})$/u.test(value) ? value : invalid();
const nullableCount = (value: unknown) => (value === null ? null : count(value));

export function createPipelineRunSnapshot(value: unknown): PipelineRunSnapshot {
  const raw = exact(value, [
    "runReference",
    "scope",
    "pipelineReference",
    "pipelineVersionReference",
    "transformationVersionReference",
    "inputCheckpointReference",
    "outputDatasetVersionReference",
    "outputPartitionCode",
    "environmentCode",
    "logicalBatchDigest",
    "executionKind",
    "replay",
    "retryOfRunReference",
    "backfillRequestVersionReference",
    "correctionReasonCode",
    "correctionCodeVersionReference",
    "preReconciliationRunReference",
    "queuedAt",
    "requestedByActorReference",
  ]);
  const executionKind = oneOf(raw.executionKind, [
    "Load",
    "Retry",
    "PipelineCorrection",
    "Backfill",
    "Rebuild",
  ] as const);
  const replay = typeof raw.replay === "boolean" ? raw.replay : invalid();
  const retryOf = nullableReference(raw.retryOfRunReference);
  const backfill = nullableReference(raw.backfillRequestVersionReference);
  const correctionReason = nullableCode(raw.correctionReasonCode);
  const correctionVersion = nullableReference(raw.correctionCodeVersionReference);
  const preReconciliation = nullableReference(raw.preReconciliationRunReference);
  const hasBackfillIntent = backfill !== null && preReconciliation !== null;
  const hasCorrectionIntent = correctionReason !== null && correctionVersion !== null;
  if (
    (executionKind === "Load") === replay ||
    (executionKind === "Retry") !== (retryOf !== null) ||
    (backfill === null) !== (preReconciliation === null) ||
    (correctionReason === null) !== (correctionVersion === null) ||
    (["Backfill", "Rebuild"].includes(executionKind) && !hasBackfillIntent) ||
    (executionKind === "PipelineCorrection" && !hasCorrectionIntent) ||
    (executionKind !== "Retry" && executionKind !== "PipelineCorrection" && hasCorrectionIntent) ||
    (executionKind !== "Retry" &&
      !["Backfill", "Rebuild"].includes(executionKind) &&
      hasBackfillIntent) ||
    (hasBackfillIntent && hasCorrectionIntent)
  )
    invalid();
  return Object.freeze({
    runReference: parseReportingReference(raw.runReference),
    scope: parseReportingScope(raw.scope),
    pipelineReference: parseReportingReference(raw.pipelineReference),
    pipelineVersionReference: parseReportingReference(raw.pipelineVersionReference),
    transformationVersionReference: parseReportingReference(raw.transformationVersionReference),
    inputCheckpointReference: parseReportingReference(raw.inputCheckpointReference),
    outputDatasetVersionReference: parseReportingReference(raw.outputDatasetVersionReference),
    outputPartitionCode: parseReportingCode(raw.outputPartitionCode),
    environmentCode: parseReportingCode(raw.environmentCode),
    logicalBatchDigest: parseReportingDigest(raw.logicalBatchDigest),
    executionKind,
    replay,
    retryOfRunReference: retryOf,
    backfillRequestVersionReference: backfill,
    correctionReasonCode: correctionReason,
    correctionCodeVersionReference: correctionVersion,
    preReconciliationRunReference: preReconciliation,
    queuedAt: parseReportingInstant(raw.queuedAt),
    requestedByActorReference: parseReportingReference(raw.requestedByActorReference),
  });
}

export function createPipelineRunStateSnapshot(value: unknown): PipelineRunStateSnapshot {
  const raw = exact(value, [
    "stateReference",
    "runReference",
    "scope",
    "sequence",
    "status",
    "watermarkOccurredAt",
    "recordsRead",
    "recordsWritten",
    "recordsLate",
    "recordsRejected",
    "dataQualityResultReference",
    "postReconciliationRunReference",
    "errorReference",
    "occurredAt",
    "actorReference",
  ]);
  const status = oneOf(raw.status, [
    "Queued",
    "Running",
    "Succeeded",
    "SucceededWithWarning",
    "Failed",
    "Cancelled",
  ] as const);
  const terminal = ["Succeeded", "SucceededWithWarning", "Failed", "Cancelled"].includes(status);
  const watermark = nullableInstant(raw.watermarkOccurredAt);
  const recordsRead = nullableCount(raw.recordsRead);
  const recordsWritten = nullableCount(raw.recordsWritten);
  const recordsLate = nullableCount(raw.recordsLate);
  const recordsRejected = nullableCount(raw.recordsRejected);
  const quality = nullableReference(raw.dataQualityResultReference);
  const reconciliation = nullableReference(raw.postReconciliationRunReference);
  const error = nullableReference(raw.errorReference);
  const occurredAt = parseReportingInstant(raw.occurredAt);
  const allCounts =
    recordsRead !== null &&
    recordsWritten !== null &&
    recordsLate !== null &&
    recordsRejected !== null;
  if (
    terminal !== allCounts ||
    (status === "Queued" && watermark !== null) ||
    ["Succeeded", "SucceededWithWarning"].includes(status) !== (quality !== null) ||
    (status === "Failed") !== (error !== null) ||
    (!terminal && (quality !== null || reconciliation !== null || error !== null))
  )
    invalid();
  if (watermark !== null && Date.parse(watermark) > Date.parse(occurredAt)) invalid();
  if (
    allCounts &&
    (BigInt(recordsLate) > BigInt(recordsRead) || BigInt(recordsRejected) > BigInt(recordsRead))
  )
    invalid();
  return Object.freeze({
    stateReference: parseReportingReference(raw.stateReference),
    runReference: parseReportingReference(raw.runReference),
    scope: parseReportingScope(raw.scope),
    sequence: positive(raw.sequence),
    status,
    watermarkOccurredAt: watermark,
    recordsRead,
    recordsWritten,
    recordsLate,
    recordsRejected,
    dataQualityResultReference: quality,
    postReconciliationRunReference: reconciliation,
    errorReference: error,
    occurredAt,
    actorReference: parseReportingReference(raw.actorReference),
  });
}

export function createBackfillRequestSnapshot(value: unknown): BackfillRequestSnapshot {
  const raw = exact(value, [
    "requestReference",
    "requestVersionReference",
    "scope",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "pipelineReference",
    "pipelineVersionReference",
    "transformationVersionReference",
    "outputDatasetVersionReference",
    "outputPartitionCode",
    "rangeFrom",
    "rangeUntil",
    "reasonCode",
    "requestedAt",
    "requestedByActorReference",
    "decidedAt",
    "decidedByActorReference",
    "boundRunReference",
    "recordedAt",
    "recordedByActorReference",
  ]);
  const lifecycle = oneOf(raw.lifecycle, [
    "Requested",
    "Approved",
    "Rejected",
    "Running",
    "Completed",
    "Failed",
    "Cancelled",
  ] as const);
  const rangeFrom = parseReportingInstant(raw.rangeFrom);
  const rangeUntil = parseReportingInstant(raw.rangeUntil);
  if (Date.parse(rangeUntil) <= Date.parse(rangeFrom)) invalid();
  const requestedBy = parseReportingReference(raw.requestedByActorReference);
  const requestedAt = parseReportingInstant(raw.requestedAt);
  const recordedAt = parseReportingInstant(raw.recordedAt);
  const decidedAt = nullableInstant(raw.decidedAt);
  const decidedBy = nullableReference(raw.decidedByActorReference);
  const boundRun = nullableReference(raw.boundRunReference);
  const hasDecision = decidedAt !== null && decidedBy !== null;
  const hasBoundRun = boundRun !== null;
  if (
    Date.parse(rangeUntil) > Date.parse(requestedAt) ||
    Date.parse(requestedAt) > Date.parse(recordedAt) ||
    (decidedAt !== null &&
      (Date.parse(decidedAt) < Date.parse(requestedAt) ||
        Date.parse(decidedAt) > Date.parse(recordedAt)))
  )
    invalid();
  if (
    (decidedAt === null) !== (decidedBy === null) ||
    (["Approved", "Rejected", "Running", "Completed", "Failed"].includes(lifecycle) &&
      !hasDecision) ||
    (["Running", "Completed", "Failed"].includes(lifecycle) && !hasBoundRun) ||
    (["Requested", "Approved", "Rejected"].includes(lifecycle) && hasBoundRun) ||
    (lifecycle === "Requested" && hasDecision) ||
    (hasBoundRun && !hasDecision) ||
    (decidedBy !== null && decidedBy === requestedBy)
  )
    invalid();
  return Object.freeze({
    requestReference: parseReportingReference(raw.requestReference),
    requestVersionReference: parseReportingReference(raw.requestVersionReference),
    scope: parseReportingScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    versionNumber: positive(raw.versionNumber),
    snapshotDigest: parseReportingDigest(raw.snapshotDigest),
    lifecycle,
    pipelineReference: parseReportingReference(raw.pipelineReference),
    pipelineVersionReference: parseReportingReference(raw.pipelineVersionReference),
    transformationVersionReference: parseReportingReference(raw.transformationVersionReference),
    outputDatasetVersionReference: parseReportingReference(raw.outputDatasetVersionReference),
    outputPartitionCode: parseReportingCode(raw.outputPartitionCode),
    rangeFrom,
    rangeUntil,
    reasonCode: parseReportingCode(raw.reasonCode),
    requestedAt,
    requestedByActorReference: requestedBy,
    decidedAt,
    decidedByActorReference: decidedBy,
    boundRunReference: boundRun,
    recordedAt,
    recordedByActorReference: parseReportingReference(raw.recordedByActorReference),
  });
}
