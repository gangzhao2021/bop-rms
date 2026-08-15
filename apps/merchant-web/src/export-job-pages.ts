export type ExportJobPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Expired"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ExportJobPageError extends Error {
  constructor(readonly code: ExportJobPageErrorCode) {
    super("Export center is unavailable");
    this.name = "ExportJobPageError";
  }
}
export interface ExportJobItemView {
  readonly jobReference: string;
  readonly sourceScreen: string;
  readonly sourceView: string;
  readonly scope: string;
  readonly filterSummary: string;
  readonly classification: "Public" | "Internal" | "Confidential" | "Restricted";
  readonly format: "Csv" | "CanonicalJson";
  readonly status:
    "Queued" | "Running" | "Completed" | "Failed" | "Cancelled" | "Revoked" | "Expired";
  readonly rowCount: number | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly grantState: "Unavailable" | "Ready" | "Consumed" | "Revoked" | "Expired";
  readonly mayCancel: boolean;
  readonly mayDownload: boolean;
  readonly mayRevoke: boolean;
}
export interface ExportJobPageView {
  readonly screenId: "EXPORT-JOB-LIST";
  readonly sourceAsOf: string;
  readonly freshness: "Fresh" | "Stale";
  readonly completeness: "Complete" | "Partial";
  readonly jobs: readonly ExportJobItemView[];
  readonly mayCreate: boolean;
}
export interface ExportJobPageClient {
  loadExports(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u;
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    throw new Error("EXPORT_JOB_PAGE_INVALID");
  return value as Record<string, unknown>;
}
const text = (value: unknown) => {
  if (typeof value !== "string" || !safe.test(value)) throw new Error("EXPORT_JOB_PAGE_INVALID");
  return value;
};
const time = (value: unknown) => {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error("EXPORT_JOB_PAGE_INVALID");
  return value;
};
function job(value: unknown): ExportJobItemView {
  const input = closed(value, [
    "jobReference",
    "sourceScreen",
    "sourceView",
    "scope",
    "filterSummary",
    "classification",
    "format",
    "status",
    "rowCount",
    "requestedBy",
    "requestedAt",
    "expiresAt",
    "grantState",
    "mayCancel",
    "mayDownload",
    "mayRevoke",
  ]);
  if (
    typeof input.jobReference !== "string" ||
    !uuid.test(input.jobReference) ||
    !["Public", "Internal", "Confidential", "Restricted"].includes(String(input.classification)) ||
    !["Csv", "CanonicalJson"].includes(String(input.format)) ||
    !["Queued", "Running", "Completed", "Failed", "Cancelled", "Revoked", "Expired"].includes(
      String(input.status),
    ) ||
    !["Unavailable", "Ready", "Consumed", "Revoked", "Expired"].includes(
      String(input.grantState),
    ) ||
    (input.rowCount !== null &&
      (!Number.isSafeInteger(input.rowCount) ||
        (input.rowCount as number) < 0 ||
        (input.rowCount as number) > 100_000)) ||
    typeof input.mayCancel !== "boolean" ||
    typeof input.mayDownload !== "boolean" ||
    typeof input.mayRevoke !== "boolean"
  )
    throw new Error("EXPORT_JOB_PAGE_INVALID");
  if (
    input.mayDownload &&
    (input.status !== "Completed" || input.grantState !== "Ready" || input.expiresAt === null)
  )
    throw new Error("EXPORT_JOB_PAGE_INVALID");
  return Object.freeze({
    jobReference: input.jobReference,
    sourceScreen: text(input.sourceScreen),
    sourceView: text(input.sourceView),
    scope: text(input.scope),
    filterSummary: text(input.filterSummary),
    classification: input.classification,
    format: input.format,
    status: input.status,
    rowCount: input.rowCount,
    requestedBy: text(input.requestedBy),
    requestedAt: time(input.requestedAt),
    expiresAt: input.expiresAt === null ? null : time(input.expiresAt),
    grantState: input.grantState,
    mayCancel: input.mayCancel,
    mayDownload: input.mayDownload,
    mayRevoke: input.mayRevoke,
  }) as ExportJobItemView;
}
export function parseExportJobPageView(value: unknown): ExportJobPageView {
  const input = closed(value, [
    "screenId",
    "sourceAsOf",
    "freshness",
    "completeness",
    "jobs",
    "mayCreate",
  ]);
  if (
    input.screenId !== "EXPORT-JOB-LIST" ||
    !["Fresh", "Stale"].includes(String(input.freshness)) ||
    !["Complete", "Partial"].includes(String(input.completeness)) ||
    !Array.isArray(input.jobs) ||
    typeof input.mayCreate !== "boolean"
  )
    throw new Error("EXPORT_JOB_PAGE_INVALID");
  const jobs = Object.freeze(input.jobs.map(job));
  if (new Set(jobs.map((item) => item.jobReference)).size !== jobs.length)
    throw new Error("EXPORT_JOB_PAGE_INVALID");
  return Object.freeze({ ...input, sourceAsOf: time(input.sourceAsOf), jobs }) as ExportJobPageView;
}
export const unavailableExportJobPageClient: ExportJobPageClient = {
  loadExports: async () => {
    throw new ExportJobPageError("Unavailable");
  },
};
