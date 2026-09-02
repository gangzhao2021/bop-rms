export type ReportRunHistoryErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ReportRunHistoryError extends Error {
  constructor(readonly code: ReportRunHistoryErrorCode) {
    super("Report Run history unavailable");
    this.name = "ReportRunHistoryError";
  }
}
export interface ReportRunHistoryView {
  readonly screenId: "RPT-RUN-HISTORY";
  readonly queryName: "reporting_report_run_history_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly permissions: {
    readonly mayRerun: boolean;
    readonly mayCancel: boolean;
    readonly mayDownload: boolean;
    readonly mayRevoke: boolean;
    readonly mayViewError: boolean;
  };
  readonly filters: {
    readonly runReference: string | null;
    readonly reportReference: string | null;
    readonly status: ReportRunItem["status"] | null;
    readonly dateFrom: string | null;
    readonly dateTo: string | null;
    readonly requesterReference: string | null;
    readonly triggerKind: ReportRunItem["triggerKind"] | null;
  };
  readonly runs: readonly ReportRunItem[];
}
export interface ReportRunItem {
  readonly runReference: string;
  readonly reportReference: string;
  readonly reportVersionReference: string;
  readonly reportNameCode: string;
  readonly scopeLabel: string;
  readonly parameterSnapshotDigest: string;
  readonly status:
    "Queued" | "Running" | "Completed" | "CompletedWithWarning" | "Failed" | "Cancelled";
  readonly rowCount: number | null;
  readonly dataAsOf: string | null;
  readonly generatedAt: string | null;
  readonly durationMilliseconds: number | null;
  readonly triggerKind: "Manual" | "Scheduled";
  readonly requesterReference: string;
  readonly errorCode: string | null;
  readonly artifact: {
    readonly revisionReference: string;
    readonly format: "Csv" | "Spreadsheet" | "Pdf";
    readonly expiresAt: string;
    readonly revoked: boolean;
  } | null;
}
export interface ReportRunHistoryClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const safeText = /^[^<>{}$\p{Cc}\p{Cf}]{1,160}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const fail = (): never => {
  throw new ReportRunHistoryError("Unavailable");
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
const reference = (value: unknown) =>
  typeof value === "string" && uuid.test(value) ? value : fail();
const coded = (value: unknown) => (typeof value === "string" && code.test(value) ? value : fail());
const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value && safeText.test(value) ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const count = (value: unknown, maximum: number) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum
    ? (value as number)
    : fail();
const status = (value: unknown) =>
  oneOf(value, [
    "Queued",
    "Running",
    "Completed",
    "CompletedWithWarning",
    "Failed",
    "Cancelled",
  ] as const);
const trigger = (value: unknown) => oneOf(value, ["Manual", "Scheduled"] as const);

export function parseReportRunHistoryView(value: unknown): ReportRunHistoryView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "permissions",
    "filters",
    "runs",
  ]);
  if (
    raw.screenId !== "RPT-RUN-HISTORY" ||
    raw.queryName !== "reporting_report_run_history_v1" ||
    raw.queryVersion !== 1 ||
    !Array.isArray(raw.runs) ||
    raw.runs.length > 500
  )
    fail();
  const permissionsRaw = object(raw.permissions, [
    "mayRerun",
    "mayCancel",
    "mayDownload",
    "mayRevoke",
    "mayViewError",
  ]);
  const filtersRaw = object(raw.filters, [
    "runReference",
    "reportReference",
    "status",
    "dateFrom",
    "dateTo",
    "requesterReference",
    "triggerKind",
  ]);
  const parseDate = (date: unknown) =>
    typeof date === "string" && datePattern.test(date) ? date : fail();
  const runs = Object.freeze(
    (raw.runs as unknown[]).map((value) => {
      const item = object(value, [
        "runReference",
        "reportReference",
        "reportVersionReference",
        "reportNameCode",
        "scopeLabel",
        "parameterSnapshotDigest",
        "status",
        "rowCount",
        "dataAsOf",
        "generatedAt",
        "durationMilliseconds",
        "triggerKind",
        "requesterReference",
        "errorCode",
        "artifact",
      ]);
      const artifact =
        item.artifact === null
          ? null
          : (() => {
              const value = object(item.artifact, [
                "revisionReference",
                "format",
                "expiresAt",
                "revoked",
              ]);
              return Object.freeze({
                revisionReference: reference(value.revisionReference),
                format: oneOf(value.format, ["Csv", "Spreadsheet", "Pdf"] as const),
                expiresAt: instant(value.expiresAt),
                revoked: bool(value.revoked),
              });
            })();
      const parsedStatus = status(item.status);
      const parsedError = nullable(item.errorCode, coded);
      if (
        (parsedStatus === "Failed" || parsedStatus === "CompletedWithWarning") !==
        (parsedError !== null)
      )
        fail();
      return Object.freeze({
        runReference: reference(item.runReference),
        reportReference: reference(item.reportReference),
        reportVersionReference: reference(item.reportVersionReference),
        reportNameCode: coded(item.reportNameCode),
        scopeLabel: text(item.scopeLabel),
        parameterSnapshotDigest:
          typeof item.parameterSnapshotDigest === "string" &&
          digest.test(item.parameterSnapshotDigest)
            ? item.parameterSnapshotDigest
            : fail(),
        status: parsedStatus,
        rowCount: item.rowCount === null ? null : count(item.rowCount, 100_000),
        dataAsOf: nullable(item.dataAsOf, instant),
        generatedAt: nullable(item.generatedAt, instant),
        durationMilliseconds:
          item.durationMilliseconds === null ? null : count(item.durationMilliseconds, 86_400_000),
        triggerKind: trigger(item.triggerKind),
        requesterReference: reference(item.requesterReference),
        errorCode: parsedError,
        artifact,
      });
    }),
  );
  return Object.freeze({
    screenId: "RPT-RUN-HISTORY",
    queryName: "reporting_report_run_history_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    permissions: Object.freeze({
      mayRerun: bool(permissionsRaw.mayRerun),
      mayCancel: bool(permissionsRaw.mayCancel),
      mayDownload: bool(permissionsRaw.mayDownload),
      mayRevoke: bool(permissionsRaw.mayRevoke),
      mayViewError: bool(permissionsRaw.mayViewError),
    }),
    filters: Object.freeze({
      runReference: nullable(filtersRaw.runReference, reference),
      reportReference: nullable(filtersRaw.reportReference, reference),
      status: nullable(filtersRaw.status, status),
      dateFrom: nullable(filtersRaw.dateFrom, parseDate),
      dateTo: nullable(filtersRaw.dateTo, parseDate),
      requesterReference: nullable(filtersRaw.requesterReference, reference),
      triggerKind: nullable(filtersRaw.triggerKind, trigger),
    }),
    runs,
  });
}
export const unavailableReportRunHistoryClient: ReportRunHistoryClient = Object.freeze({
  load: async () => {
    throw new ReportRunHistoryError("Unavailable");
  },
});
