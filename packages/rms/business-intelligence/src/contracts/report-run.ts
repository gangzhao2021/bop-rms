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

export type ReportRunStatus =
  "Queued" | "Running" | "Completed" | "CompletedWithWarning" | "Failed" | "Cancelled";
export type ReportArtifactFormat = "Csv" | "Spreadsheet" | "Pdf";
export type ReportDataClassification = "Public" | "Internal" | "Confidential" | "Restricted";

export interface ReportRunSnapshot {
  readonly runReference: ReportingReference;
  readonly reportReference: ReportingReference;
  readonly reportVersionReference: ReportingReference;
  readonly metricVersionReferences: readonly ReportingReference[];
  readonly scope: ReportingScope;
  readonly parameterSnapshotDigest: ReportingDigest;
  readonly triggerKind: "Manual" | "Scheduled";
  readonly scheduleVersionReference: ReportingReference | null;
  readonly triggeredByActorReference: ReportingReference;
  readonly rerunOfRunReference: ReportingReference | null;
  readonly queuedAt: string;
}

export interface ReportRunStateSnapshot {
  readonly stateReference: ReportingReference;
  readonly runReference: ReportingReference;
  readonly sequence: number;
  readonly status: ReportRunStatus;
  readonly occurredAt: string;
  readonly actorReference: ReportingReference;
  readonly dataAsOf: string | null;
  readonly projectionCheckpoint: ReportingCode | null;
  readonly generatedAt: string | null;
  readonly durationMilliseconds: number | null;
  readonly rowCount: number | null;
  readonly summaryDigest: ReportingDigest | null;
  readonly errorCode: ReportingCode | null;
}

export interface ReportArtifactRevisionSnapshot {
  readonly artifactReference: ReportingReference;
  readonly revisionReference: ReportingReference;
  readonly runReference: ReportingReference;
  readonly revisionNumber: number;
  readonly outputAssetReference: ReportingReference;
  readonly format: ReportArtifactFormat;
  readonly classification: ReportDataClassification;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly createdByActorReference: ReportingReference;
}

export interface ReportArtifactRevocationSnapshot {
  readonly revocationReference: ReportingReference;
  readonly artifactReference: ReportingReference;
  readonly revisionReference: ReportingReference;
  readonly reasonCode: ReportingCode;
  readonly revokedAt: string;
  readonly revokedByActorReference: ReportingReference;
}

const fail = (): never => {
  throw new Error("Report Run input is invalid");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  if (Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return fail();
  return value as number;
};
const nonNegative = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    return fail();
  return value as number;
};
const nullable = <T>(value: unknown, parse: (item: unknown) => T): T | null =>
  value === null ? null : parse(value);
const references = (value: unknown): readonly ReportingReference[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) return fail();
  const parsed = value.map(parseReportingReference);
  if (new Set(parsed).size !== parsed.length) return fail();
  return Object.freeze(parsed);
};

export function createReportRunSnapshot(value: unknown): ReportRunSnapshot {
  const raw = exact(value, [
    "runReference",
    "reportReference",
    "reportVersionReference",
    "metricVersionReferences",
    "scope",
    "parameterSnapshotDigest",
    "triggerKind",
    "scheduleVersionReference",
    "triggeredByActorReference",
    "rerunOfRunReference",
    "queuedAt",
  ]);
  if (raw.triggerKind !== "Manual" && raw.triggerKind !== "Scheduled") return fail();
  const scheduleVersionReference = nullable(raw.scheduleVersionReference, parseReportingReference);
  if ((raw.triggerKind === "Scheduled") !== (scheduleVersionReference !== null)) return fail();
  const runReference = parseReportingReference(raw.runReference);
  const rerunOfRunReference = nullable(raw.rerunOfRunReference, parseReportingReference);
  if (rerunOfRunReference === runReference) return fail();
  return Object.freeze({
    runReference,
    reportReference: parseReportingReference(raw.reportReference),
    reportVersionReference: parseReportingReference(raw.reportVersionReference),
    metricVersionReferences: references(raw.metricVersionReferences),
    scope: parseReportingScope(raw.scope),
    parameterSnapshotDigest: parseReportingDigest(raw.parameterSnapshotDigest),
    triggerKind: raw.triggerKind,
    scheduleVersionReference,
    triggeredByActorReference: parseReportingReference(raw.triggeredByActorReference),
    rerunOfRunReference,
    queuedAt: parseReportingInstant(raw.queuedAt),
  });
}

export function createReportRunStateSnapshot(value: unknown): ReportRunStateSnapshot {
  const raw = exact(value, [
    "stateReference",
    "runReference",
    "sequence",
    "status",
    "occurredAt",
    "actorReference",
    "dataAsOf",
    "projectionCheckpoint",
    "generatedAt",
    "durationMilliseconds",
    "rowCount",
    "summaryDigest",
    "errorCode",
  ]);
  if (
    !(
      ["Queued", "Running", "Completed", "CompletedWithWarning", "Failed", "Cancelled"] as const
    ).includes(raw.status as never)
  )
    return fail();
  const result = {
    stateReference: parseReportingReference(raw.stateReference),
    runReference: parseReportingReference(raw.runReference),
    sequence: positive(raw.sequence),
    status: raw.status,
    occurredAt: parseReportingInstant(raw.occurredAt),
    actorReference: parseReportingReference(raw.actorReference),
    dataAsOf: nullable(raw.dataAsOf, parseReportingInstant),
    projectionCheckpoint: nullable(raw.projectionCheckpoint, parseReportingCode),
    generatedAt: nullable(raw.generatedAt, parseReportingInstant),
    durationMilliseconds:
      raw.durationMilliseconds === null ? null : nonNegative(raw.durationMilliseconds, 86_400_000),
    rowCount: raw.rowCount === null ? null : nonNegative(raw.rowCount, 100_000),
    summaryDigest: nullable(raw.summaryDigest, parseReportingDigest),
    errorCode: nullable(raw.errorCode, parseReportingCode),
  } as const;
  const hasResult =
    result.dataAsOf !== null &&
    result.projectionCheckpoint !== null &&
    result.generatedAt !== null &&
    result.durationMilliseconds !== null &&
    result.rowCount !== null &&
    result.summaryDigest !== null;
  if (
    ((result.status === "Queued" || result.status === "Running" || result.status === "Cancelled") &&
      (hasResult ||
        result.dataAsOf !== null ||
        result.projectionCheckpoint !== null ||
        result.generatedAt !== null ||
        result.durationMilliseconds !== null ||
        result.rowCount !== null ||
        result.summaryDigest !== null)) ||
    (result.status === "Completed" && (!hasResult || result.errorCode !== null)) ||
    (result.status === "CompletedWithWarning" && (!hasResult || result.errorCode === null)) ||
    (result.status === "Failed" &&
      (result.generatedAt === null ||
        result.durationMilliseconds === null ||
        result.errorCode === null)) ||
    ((result.status === "Queued" || result.status === "Running") && result.errorCode !== null)
  )
    return fail();
  return Object.freeze(result) as ReportRunStateSnapshot;
}

export function createReportArtifactRevisionSnapshot(
  value: unknown,
): ReportArtifactRevisionSnapshot {
  const raw = exact(value, [
    "artifactReference",
    "revisionReference",
    "runReference",
    "revisionNumber",
    "outputAssetReference",
    "format",
    "classification",
    "createdAt",
    "expiresAt",
    "createdByActorReference",
  ]);
  if (!(["Csv", "Spreadsheet", "Pdf"] as const).includes(raw.format as never)) return fail();
  if (
    !(["Public", "Internal", "Confidential", "Restricted"] as const).includes(
      raw.classification as never,
    )
  )
    return fail();
  const createdAt = parseReportingInstant(raw.createdAt);
  const expiresAt = parseReportingInstant(raw.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) return fail();
  return Object.freeze({
    artifactReference: parseReportingReference(raw.artifactReference),
    revisionReference: parseReportingReference(raw.revisionReference),
    runReference: parseReportingReference(raw.runReference),
    revisionNumber: positive(raw.revisionNumber),
    outputAssetReference: parseReportingReference(raw.outputAssetReference),
    format: raw.format,
    classification: raw.classification,
    createdAt,
    expiresAt,
    createdByActorReference: parseReportingReference(raw.createdByActorReference),
  }) as ReportArtifactRevisionSnapshot;
}

export function createReportArtifactRevocationSnapshot(
  value: unknown,
): ReportArtifactRevocationSnapshot {
  const raw = exact(value, [
    "revocationReference",
    "artifactReference",
    "revisionReference",
    "reasonCode",
    "revokedAt",
    "revokedByActorReference",
  ]);
  return Object.freeze({
    revocationReference: parseReportingReference(raw.revocationReference),
    artifactReference: parseReportingReference(raw.artifactReference),
    revisionReference: parseReportingReference(raw.revisionReference),
    reasonCode: parseReportingCode(raw.reasonCode),
    revokedAt: parseReportingInstant(raw.revokedAt),
    revokedByActorReference: parseReportingReference(raw.revokedByActorReference),
  });
}
