export type PipelineRunErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class PipelineRunPageError extends Error {
  constructor(readonly code: PipelineRunErrorCode) {
    super("Pipeline Runs unavailable");
    this.name = "PipelineRunPageError";
  }
}
export interface PipelineRunView {
  readonly screenId: "BI-PIPELINE-RUN";
  readonly queryName: "reporting_pipeline_run_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly permissions: {
    readonly mayRetry: boolean;
    readonly mayRequestBackfill: boolean;
    readonly mayApproveBackfill: boolean;
    readonly mayOpenIncident: boolean;
  };
  readonly filters: {
    readonly pipelineReference: string | null;
    readonly runReference: string | null;
    readonly status: PipelineRunItem["status"] | null;
    readonly environmentCode: string | null;
    readonly dateFrom: string | null;
    readonly dateTo: string | null;
  };
  readonly runs: readonly PipelineRunItem[];
}
export interface PipelineRunItem {
  readonly runReference: string;
  readonly pipelineReference: string;
  readonly pipelineVersionReference: string;
  readonly transformationVersionReference: string;
  readonly inputCheckpointReference: string;
  readonly outputDatasetVersionReference: string;
  readonly outputPartitionCode: string;
  readonly environmentCode: string;
  readonly executionKind: "Load" | "Retry" | "PipelineCorrection" | "Backfill" | "Rebuild";
  readonly status:
    "Queued" | "Running" | "Succeeded" | "SucceededWithWarning" | "Failed" | "Cancelled";
  readonly watermarkOccurredAt: string | null;
  readonly recordsLate: string | null;
  readonly recordsRejected: string | null;
  readonly durationMilliseconds: number | null;
  readonly dataQualityResultReference: string | null;
  readonly preReconciliationRunReference: string | null;
  readonly postReconciliationRunReference: string | null;
  readonly backfillRequestVersionReference: string | null;
  readonly errorCode: string | null;
}
export interface PipelineRunClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const countPattern = /^(?:0|[1-9][0-9]{0,29})$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const fail = (): never => {
  throw new PipelineRunPageError("Unavailable");
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
const status = (value: unknown) =>
  oneOf(value, [
    "Queued",
    "Running",
    "Succeeded",
    "SucceededWithWarning",
    "Failed",
    "Cancelled",
  ] as const);
const executionKind = (value: unknown) =>
  oneOf(value, ["Load", "Retry", "PipelineCorrection", "Backfill", "Rebuild"] as const);

export function parsePipelineRunView(value: unknown): PipelineRunView {
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
    raw.screenId !== "BI-PIPELINE-RUN" ||
    raw.queryName !== "reporting_pipeline_run_v1" ||
    raw.queryVersion !== 1 ||
    !Array.isArray(raw.runs) ||
    raw.runs.length > 500
  )
    fail();
  const permission = object(raw.permissions, [
    "mayRetry",
    "mayRequestBackfill",
    "mayApproveBackfill",
    "mayOpenIncident",
  ]);
  const filter = object(raw.filters, [
    "pipelineReference",
    "runReference",
    "status",
    "environmentCode",
    "dateFrom",
    "dateTo",
  ]);
  const parseDate = (item: unknown) =>
    typeof item === "string" && datePattern.test(item) ? item : fail();
  const runs = Object.freeze(
    (raw.runs as unknown[]).map((item) => {
      const run = object(item, [
        "runReference",
        "pipelineReference",
        "pipelineVersionReference",
        "transformationVersionReference",
        "inputCheckpointReference",
        "outputDatasetVersionReference",
        "outputPartitionCode",
        "environmentCode",
        "executionKind",
        "status",
        "watermarkOccurredAt",
        "recordsLate",
        "recordsRejected",
        "durationMilliseconds",
        "dataQualityResultReference",
        "preReconciliationRunReference",
        "postReconciliationRunReference",
        "backfillRequestVersionReference",
        "errorCode",
      ]);
      const parsedStatus = status(run.status);
      const errorCode = nullable(run.errorCode, coded);
      if ((parsedStatus === "Failed") !== (errorCode !== null)) fail();
      const parsedCount = (count: unknown) =>
        typeof count === "string" && countPattern.test(count) ? count : fail();
      const duration = run.durationMilliseconds;
      if (
        duration !== null &&
        (!Number.isSafeInteger(duration) ||
          (duration as number) < 0 ||
          (duration as number) > 604800000)
      )
        fail();
      return Object.freeze({
        runReference: reference(run.runReference),
        pipelineReference: reference(run.pipelineReference),
        pipelineVersionReference: reference(run.pipelineVersionReference),
        transformationVersionReference: reference(run.transformationVersionReference),
        inputCheckpointReference: reference(run.inputCheckpointReference),
        outputDatasetVersionReference: reference(run.outputDatasetVersionReference),
        outputPartitionCode: coded(run.outputPartitionCode),
        environmentCode: coded(run.environmentCode),
        executionKind: executionKind(run.executionKind),
        status: parsedStatus,
        watermarkOccurredAt: nullable(run.watermarkOccurredAt, instant),
        recordsLate: nullable(run.recordsLate, parsedCount),
        recordsRejected: nullable(run.recordsRejected, parsedCount),
        durationMilliseconds: duration as number | null,
        dataQualityResultReference: nullable(run.dataQualityResultReference, reference),
        preReconciliationRunReference: nullable(run.preReconciliationRunReference, reference),
        postReconciliationRunReference: nullable(run.postReconciliationRunReference, reference),
        backfillRequestVersionReference: nullable(run.backfillRequestVersionReference, reference),
        errorCode,
      });
    }),
  );
  return Object.freeze({
    screenId: "BI-PIPELINE-RUN",
    queryName: "reporting_pipeline_run_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    permissions: Object.freeze({
      mayRetry: bool(permission.mayRetry),
      mayRequestBackfill: bool(permission.mayRequestBackfill),
      mayApproveBackfill: bool(permission.mayApproveBackfill),
      mayOpenIncident: bool(permission.mayOpenIncident),
    }),
    filters: Object.freeze({
      pipelineReference: nullable(filter.pipelineReference, reference),
      runReference: nullable(filter.runReference, reference),
      status: nullable(filter.status, status),
      environmentCode: nullable(filter.environmentCode, coded),
      dateFrom: nullable(filter.dateFrom, parseDate),
      dateTo: nullable(filter.dateTo, parseDate),
    }),
    runs,
  });
}
export const unavailablePipelineRunClient: PipelineRunClient = Object.freeze({
  load: async () => {
    throw new PipelineRunPageError("Unavailable");
  },
});
