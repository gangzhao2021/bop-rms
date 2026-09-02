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

export type ExportFormat = "Csv" | "CanonicalJson";
export type ExportClassification = "Public" | "Internal" | "Confidential" | "Restricted";
export type ExportJobStatus = "Queued" | "Running" | "Completed" | "Failed" | "Cancelled";
export interface ExportJobSnapshot {
  readonly jobReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly sourceScreenId: ReportingCode;
  readonly sourceViewReference: ReportingReference;
  readonly sourceProjection: ReportingCode;
  readonly sourceCheckpoint: ReportingCode;
  readonly filterSnapshotDigest: ReportingDigest;
  readonly columnSnapshotDigest: ReportingDigest;
  readonly selectedFieldKeys: readonly ReportingCode[];
  readonly format: ExportFormat;
  readonly classification: ExportClassification;
  readonly purposeCode: ReportingCode;
  readonly requestedByActorReference: ReportingReference;
  readonly requestedAt: string;
}
export interface ExportJobStateSnapshot {
  readonly stateReference: ReportingReference;
  readonly jobReference: ReportingReference;
  readonly sequence: number;
  readonly status: ExportJobStatus;
  readonly occurredAt: string;
  readonly actorReference: ReportingReference;
  readonly rowCount: number | null;
  readonly artifactByteCount: number | null;
  readonly errorCode: ReportingCode | null;
}
export interface ExportArtifactSnapshot {
  readonly artifactReference: ReportingReference;
  readonly jobReference: ReportingReference;
  readonly objectEvidenceReference: ReportingReference;
  readonly checksum: ReportingDigest;
  readonly format: ExportFormat;
  readonly classification: ExportClassification;
  readonly encrypted: true;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}
export interface ExportAccessGrantSnapshot {
  readonly grantReference: ReportingReference;
  readonly artifactReference: ReportingReference;
  readonly actorReference: ReportingReference;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface ExportGrantConsumptionSnapshot {
  readonly consumptionReference: ReportingReference;
  readonly grantReference: ReportingReference;
  readonly artifactReference: ReportingReference;
  readonly actorReference: ReportingReference;
  readonly consumedAt: string;
}
export interface ExportRevocationSnapshot {
  readonly revocationReference: ReportingReference;
  readonly jobReference: ReportingReference;
  readonly artifactReference: ReportingReference | null;
  readonly reasonCode: ReportingCode;
  readonly revokedByActorReference: ReportingReference;
  readonly revokedAt: string;
}
export class ExportJobContractError extends Error {
  constructor(readonly code: "EXPORT_JOB_INPUT_INVALID" | "EXPORT_JOB_LIMIT_EXCEEDED") {
    super(
      code === "EXPORT_JOB_LIMIT_EXCEEDED" ? "export limit exceeded" : "export input is invalid",
    );
    this.name = "ExportJobContractError";
  }
}
const fail = (code: ExportJobContractError["code"] = "EXPORT_JOB_INPUT_INVALID"): never => {
  throw new ExportJobContractError(code);
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return fail();
  return value as Record<string, unknown>;
}
const count = (value: unknown, maximum: number) => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    return fail("EXPORT_JOB_LIMIT_EXCEEDED");
  return value as number;
};
const classification = (value: unknown): ExportClassification => {
  if (!(["Public", "Internal", "Confidential", "Restricted"] as const).includes(value as never))
    return fail();
  return value as ExportClassification;
};
const format = (value: unknown): ExportFormat => {
  if (value !== "Csv" && value !== "CanonicalJson") return fail();
  return value;
};
export function createExportJobSnapshot(value: unknown): ExportJobSnapshot {
  const raw = exact(value, [
    "jobReference",
    "scope",
    "sourceScreenId",
    "sourceViewReference",
    "sourceProjection",
    "sourceCheckpoint",
    "filterSnapshotDigest",
    "columnSnapshotDigest",
    "selectedFieldKeys",
    "format",
    "classification",
    "purposeCode",
    "requestedByActorReference",
    "requestedAt",
  ]);
  if (
    !Array.isArray(raw.selectedFieldKeys) ||
    raw.selectedFieldKeys.length < 1 ||
    raw.selectedFieldKeys.length > 200
  )
    return fail();
  const selectedFieldKeys = Object.freeze(raw.selectedFieldKeys.map(parseReportingCode).sort());
  if (new Set(selectedFieldKeys).size !== selectedFieldKeys.length) return fail();
  return Object.freeze({
    jobReference: parseReportingReference(raw.jobReference),
    scope: parseReportingScope(raw.scope),
    sourceScreenId: parseReportingCode(raw.sourceScreenId),
    sourceViewReference: parseReportingReference(raw.sourceViewReference),
    sourceProjection: parseReportingCode(raw.sourceProjection),
    sourceCheckpoint: parseReportingCode(raw.sourceCheckpoint),
    filterSnapshotDigest: parseReportingDigest(raw.filterSnapshotDigest),
    columnSnapshotDigest: parseReportingDigest(raw.columnSnapshotDigest),
    selectedFieldKeys,
    format: format(raw.format),
    classification: classification(raw.classification),
    purposeCode: parseReportingCode(raw.purposeCode),
    requestedByActorReference: parseReportingReference(raw.requestedByActorReference),
    requestedAt: parseReportingInstant(raw.requestedAt),
  });
}
export function createExportJobStateSnapshot(value: unknown): ExportJobStateSnapshot {
  const raw = exact(value, [
    "stateReference",
    "jobReference",
    "sequence",
    "status",
    "occurredAt",
    "actorReference",
    "rowCount",
    "artifactByteCount",
    "errorCode",
  ]);
  if (
    !(["Queued", "Running", "Completed", "Failed", "Cancelled"] as const).includes(
      raw.status as never,
    ) ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 1
  )
    return fail();
  const rowCount = raw.rowCount === null ? null : count(raw.rowCount, 100_000),
    artifactByteCount =
      raw.artifactByteCount === null ? null : count(raw.artifactByteCount, 100 * 1024 * 1024),
    errorCode = raw.errorCode === null ? null : parseReportingCode(raw.errorCode);
  const completed = raw.status === "Completed";
  if (
    completed !== (rowCount !== null && artifactByteCount !== null) ||
    (raw.status === "Failed") !== (errorCode !== null) ||
    (!completed &&
      raw.status !== "Failed" &&
      (rowCount !== null || artifactByteCount !== null || errorCode !== null))
  )
    return fail();
  return Object.freeze({
    stateReference: parseReportingReference(raw.stateReference),
    jobReference: parseReportingReference(raw.jobReference),
    sequence: raw.sequence as number,
    status: raw.status as ExportJobStatus,
    occurredAt: parseReportingInstant(raw.occurredAt),
    actorReference: parseReportingReference(raw.actorReference),
    rowCount,
    artifactByteCount,
    errorCode,
  });
}
export function createExportArtifactSnapshot(value: unknown): ExportArtifactSnapshot {
  const raw = exact(value, [
    "artifactReference",
    "jobReference",
    "objectEvidenceReference",
    "checksum",
    "format",
    "classification",
    "encrypted",
    "rowCount",
    "byteCount",
    "createdAt",
    "expiresAt",
  ]);
  if (raw.encrypted !== true) return fail();
  const createdAt = parseReportingInstant(raw.createdAt),
    expiresAt = parseReportingInstant(raw.expiresAt);
  if (
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(expiresAt) - Date.parse(createdAt) > 86_400_000
  )
    return fail("EXPORT_JOB_LIMIT_EXCEEDED");
  return Object.freeze({
    artifactReference: parseReportingReference(raw.artifactReference),
    jobReference: parseReportingReference(raw.jobReference),
    objectEvidenceReference: parseReportingReference(raw.objectEvidenceReference),
    checksum: parseReportingDigest(raw.checksum),
    format: format(raw.format),
    classification: classification(raw.classification),
    encrypted: true,
    rowCount: count(raw.rowCount, 100_000),
    byteCount: count(raw.byteCount, 100 * 1024 * 1024),
    createdAt,
    expiresAt,
  });
}
export function createExportAccessGrantSnapshot(value: unknown): ExportAccessGrantSnapshot {
  const raw = exact(value, [
      "grantReference",
      "artifactReference",
      "actorReference",
      "issuedAt",
      "expiresAt",
    ]),
    issuedAt = parseReportingInstant(raw.issuedAt),
    expiresAt = parseReportingInstant(raw.expiresAt);
  if (
    Date.parse(expiresAt) <= Date.parse(issuedAt) ||
    Date.parse(expiresAt) - Date.parse(issuedAt) > 300_000
  )
    return fail();
  return Object.freeze({
    grantReference: parseReportingReference(raw.grantReference),
    artifactReference: parseReportingReference(raw.artifactReference),
    actorReference: parseReportingReference(raw.actorReference),
    issuedAt,
    expiresAt,
  });
}
export function createExportGrantConsumptionSnapshot(
  value: unknown,
): ExportGrantConsumptionSnapshot {
  const raw = exact(value, [
    "consumptionReference",
    "grantReference",
    "artifactReference",
    "actorReference",
    "consumedAt",
  ]);
  return Object.freeze({
    consumptionReference: parseReportingReference(raw.consumptionReference),
    grantReference: parseReportingReference(raw.grantReference),
    artifactReference: parseReportingReference(raw.artifactReference),
    actorReference: parseReportingReference(raw.actorReference),
    consumedAt: parseReportingInstant(raw.consumedAt),
  });
}
export function createExportRevocationSnapshot(value: unknown): ExportRevocationSnapshot {
  const raw = exact(value, [
    "revocationReference",
    "jobReference",
    "artifactReference",
    "reasonCode",
    "revokedByActorReference",
    "revokedAt",
  ]);
  return Object.freeze({
    revocationReference: parseReportingReference(raw.revocationReference),
    jobReference: parseReportingReference(raw.jobReference),
    artifactReference:
      raw.artifactReference === null ? null : parseReportingReference(raw.artifactReference),
    reasonCode: parseReportingCode(raw.reasonCode),
    revokedByActorReference: parseReportingReference(raw.revokedByActorReference),
    revokedAt: parseReportingInstant(raw.revokedAt),
  });
}
export function protectCsvTextCell(value: string): string {
  if (/^[=+\-@\t\r]/u.test(value)) return `'${value}`;
  return value;
}
