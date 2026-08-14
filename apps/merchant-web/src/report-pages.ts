export type ReportPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class ReportPageError extends Error {
  constructor(readonly code: ReportPageErrorCode) {
    super("Reporting page unavailable");
    this.name = "ReportPageError";
  }
}

export interface ReportCatalogView {
  readonly screenId: "RPT-REPORT-CATALOG";
  readonly queryName: "reporting_report_catalog_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly scopeLabel: string;
  readonly filters: {
    readonly nameCode: string | null;
    readonly domain: string | null;
    readonly certifiedOnly: boolean;
    readonly ownerReference: string | null;
    readonly scheduledOnly: boolean;
  };
  readonly permissions: {
    readonly mayCreate: boolean;
    readonly mayEdit: boolean;
    readonly mayCertify: boolean;
    readonly maySchedule: boolean;
  };
  readonly reports: readonly {
    readonly reportReference: string;
    readonly nameCode: string;
    readonly domain: string;
    readonly certificationStatus: "Draft" | "InReview" | "Certified";
    readonly ownerReference: string;
    readonly scope: "Brand" | "Store";
    readonly lastRunAt: string | null;
    readonly scheduleStatus: "NotScheduled" | "Active" | "Paused";
    readonly editTarget: string;
  }[];
}

export interface ReportBuilderView {
  readonly screenId: "RPT-REPORT-BUILDER";
  readonly queryName: "reporting_report_builder_v1";
  readonly queryVersion: 1;
  readonly reportReference: string;
  readonly aggregateVersion: number;
  readonly versionReference: string;
  readonly nameCode: string;
  readonly lifecycle: "Draft" | "InReview" | "Published" | "Archived";
  readonly certificationStatus: "Draft" | "InReview" | "Certified";
  readonly datasetVersionReferences: readonly string[];
  readonly metricVersionReferences: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: readonly {
    readonly fieldCode: string;
    readonly operator: "Equal" | "In" | "Between";
    readonly valueCodes: readonly string[];
  }[];
  readonly sorts: readonly {
    readonly fieldCode: string;
    readonly direction: "Ascending" | "Descending";
  }[];
  readonly visualization: "Table" | "Bar" | "Line" | "Kpi";
  readonly rowLimit: number;
  readonly scopePolicy: "Brand" | "Store";
  readonly schedule: {
    readonly status: "None" | "Active" | "Paused";
    readonly cadence: "Daily" | "Weekly" | "Monthly" | null;
    readonly format: "Csv" | "Json" | null;
  };
  readonly validation: {
    readonly status: "NotRun" | "Passed" | "Failed";
    readonly checkedAt: string | null;
  };
  readonly preview: {
    readonly status: "NotRun" | "Ready" | "Failed";
    readonly rowCount: number | null;
    readonly generatedAt: string | null;
  };
  readonly permissions: {
    readonly mayEdit: boolean;
    readonly maySubmitReview: boolean;
    readonly mayCertify: boolean;
    readonly maySchedule: boolean;
  };
}

export interface ReportCatalogClient {
  load(): Promise<unknown>;
}
export interface ReportBuilderClient {
  load(reportReference: string): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const safeText = /^[^<>{}$\p{Cc}\p{Cf}]{1,160}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (): never => {
  throw new ReportPageError("Unavailable");
};
const object = (value: unknown, fields: readonly string[]) => {
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
};
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
const nullableInstant = (value: unknown) => (value === null ? null : instant(value));
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const positive = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail();
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail();
const references = (value: unknown) =>
  Array.isArray(value) && value.length <= 100 ? Object.freeze(value.map(reference)) : fail();
const codes = (value: unknown) =>
  Array.isArray(value) && value.length <= 100 ? Object.freeze(value.map(coded)) : fail();

export function parseReportCatalogView(value: unknown): ReportCatalogView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "scopeLabel",
    "filters",
    "permissions",
    "reports",
  ]);
  if (
    raw.screenId !== "RPT-REPORT-CATALOG" ||
    raw.queryName !== "reporting_report_catalog_v1" ||
    raw.queryVersion !== 1 ||
    !Array.isArray(raw.reports) ||
    raw.reports.length > 500
  )
    fail();
  const filterRaw = object(raw.filters, [
    "nameCode",
    "domain",
    "certifiedOnly",
    "ownerReference",
    "scheduledOnly",
  ]);
  const permissionRaw = object(raw.permissions, [
    "mayCreate",
    "mayEdit",
    "mayCertify",
    "maySchedule",
  ]);
  const permissions = Object.freeze({
    mayCreate: bool(permissionRaw.mayCreate),
    mayEdit: bool(permissionRaw.mayEdit),
    mayCertify: bool(permissionRaw.mayCertify),
    maySchedule: bool(permissionRaw.maySchedule),
  });
  const reports = Object.freeze(
    (raw.reports as unknown[]).map((value) => {
      const item = object(value, [
        "reportReference",
        "nameCode",
        "domain",
        "certificationStatus",
        "ownerReference",
        "scope",
        "lastRunAt",
        "scheduleStatus",
      ]);
      const reportReference = reference(item.reportReference);
      return Object.freeze({
        reportReference,
        nameCode: coded(item.nameCode),
        domain: coded(item.domain),
        certificationStatus: oneOf(item.certificationStatus, [
          "Draft",
          "InReview",
          "Certified",
        ] as const),
        ownerReference: reference(item.ownerReference),
        scope: oneOf(item.scope, ["Brand", "Store"] as const),
        lastRunAt: nullableInstant(item.lastRunAt),
        scheduleStatus: oneOf(item.scheduleStatus, ["NotScheduled", "Active", "Paused"] as const),
        editTarget: `/app/reports/${reportReference}/edit`,
      });
    }),
  );
  return Object.freeze({
    screenId: "RPT-REPORT-CATALOG",
    queryName: "reporting_report_catalog_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    scopeLabel: text(raw.scopeLabel),
    filters: Object.freeze({
      nameCode: filterRaw.nameCode === null ? null : coded(filterRaw.nameCode),
      domain: filterRaw.domain === null ? null : coded(filterRaw.domain),
      certifiedOnly: bool(filterRaw.certifiedOnly),
      ownerReference:
        filterRaw.ownerReference === null ? null : reference(filterRaw.ownerReference),
      scheduledOnly: bool(filterRaw.scheduledOnly),
    }),
    permissions,
    reports,
  });
}

export function parseReportBuilderView(value: unknown): ReportBuilderView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "reportReference",
    "aggregateVersion",
    "versionReference",
    "nameCode",
    "lifecycle",
    "certificationStatus",
    "datasetVersionReferences",
    "metricVersionReferences",
    "dimensions",
    "filters",
    "sorts",
    "visualization",
    "rowLimit",
    "scopePolicy",
    "schedule",
    "validation",
    "preview",
    "permissions",
  ]);
  if (
    raw.screenId !== "RPT-REPORT-BUILDER" ||
    raw.queryName !== "reporting_report_builder_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  if (
    !Array.isArray(raw.filters) ||
    raw.filters.length > 100 ||
    !Array.isArray(raw.sorts) ||
    raw.sorts.length > 100
  )
    fail();
  const filters = Object.freeze(
    (raw.filters as unknown[]).map((value) => {
      const item = object(value, ["fieldCode", "operator", "valueCodes"]);
      return Object.freeze({
        fieldCode: coded(item.fieldCode),
        operator: oneOf(item.operator, ["Equal", "In", "Between"] as const),
        valueCodes: codes(item.valueCodes),
      });
    }),
  );
  const sorts = Object.freeze(
    (raw.sorts as unknown[]).map((value) => {
      const item = object(value, ["fieldCode", "direction"]);
      return Object.freeze({
        fieldCode: coded(item.fieldCode),
        direction: oneOf(item.direction, ["Ascending", "Descending"] as const),
      });
    }),
  );
  const scheduleRaw = object(raw.schedule, ["status", "cadence", "format"]);
  const validationRaw = object(raw.validation, ["status", "checkedAt"]);
  const previewRaw = object(raw.preview, ["status", "rowCount", "generatedAt"]);
  const permissionRaw = object(raw.permissions, [
    "mayEdit",
    "maySubmitReview",
    "mayCertify",
    "maySchedule",
  ]);
  const rowCount = previewRaw.rowCount === null ? null : count(previewRaw.rowCount);
  return Object.freeze({
    screenId: "RPT-REPORT-BUILDER",
    queryName: "reporting_report_builder_v1",
    queryVersion: 1,
    reportReference: reference(raw.reportReference),
    aggregateVersion: positive(raw.aggregateVersion),
    versionReference: reference(raw.versionReference),
    nameCode: coded(raw.nameCode),
    lifecycle: oneOf(raw.lifecycle, ["Draft", "InReview", "Published", "Archived"] as const),
    certificationStatus: oneOf(raw.certificationStatus, [
      "Draft",
      "InReview",
      "Certified",
    ] as const),
    datasetVersionReferences: references(raw.datasetVersionReferences),
    metricVersionReferences: references(raw.metricVersionReferences),
    dimensions: codes(raw.dimensions),
    filters,
    sorts,
    visualization: oneOf(raw.visualization, ["Table", "Bar", "Line", "Kpi"] as const),
    rowLimit: positive(raw.rowLimit),
    scopePolicy: oneOf(raw.scopePolicy, ["Brand", "Store"] as const),
    schedule: Object.freeze({
      status: oneOf(scheduleRaw.status, ["None", "Active", "Paused"] as const),
      cadence:
        scheduleRaw.cadence === null
          ? null
          : oneOf(scheduleRaw.cadence, ["Daily", "Weekly", "Monthly"] as const),
      format:
        scheduleRaw.format === null ? null : oneOf(scheduleRaw.format, ["Csv", "Json"] as const),
    }),
    validation: Object.freeze({
      status: oneOf(validationRaw.status, ["NotRun", "Passed", "Failed"] as const),
      checkedAt: nullableInstant(validationRaw.checkedAt),
    }),
    preview: Object.freeze({
      status: oneOf(previewRaw.status, ["NotRun", "Ready", "Failed"] as const),
      rowCount,
      generatedAt: nullableInstant(previewRaw.generatedAt),
    }),
    permissions: Object.freeze({
      mayEdit: bool(permissionRaw.mayEdit),
      maySubmitReview: bool(permissionRaw.maySubmitReview),
      mayCertify: bool(permissionRaw.mayCertify),
      maySchedule: bool(permissionRaw.maySchedule),
    }),
  });
}

export const unavailableReportCatalogClient: ReportCatalogClient = Object.freeze({
  load: async () => {
    throw new ReportPageError("Unavailable");
  },
});
export const unavailableReportBuilderClient: ReportBuilderClient = Object.freeze({
  load: async () => {
    throw new ReportPageError("Unavailable");
  },
});
