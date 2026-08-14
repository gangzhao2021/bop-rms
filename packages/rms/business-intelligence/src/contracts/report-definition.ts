export type ReportingReference = string & { readonly __reportingReference: unique symbol };
export type ReportingDigest = string & { readonly __reportingDigest: unique symbol };
export type ReportingCode = string & { readonly __reportingCode: unique symbol };

export type ReportLifecycle = "Draft" | "InReview" | "Published" | "Archived";
export type CertificationStatus = "Draft" | "InReview" | "Certified";
export type ReportFormat = "Csv" | "Json";

export interface ReportingScope {
  readonly tenantReference: ReportingReference;
  readonly brandReference: ReportingReference;
  readonly storeReference: ReportingReference | null;
}

export interface ReportFilter {
  readonly dimensionCode: ReportingCode;
  readonly operator: "Equal" | "In" | "Between";
  readonly valueCodes: readonly ReportingCode[];
}

export interface ReportSort {
  readonly fieldCode: ReportingCode;
  readonly direction: "Ascending" | "Descending";
}

export interface ReportDefinitionSnapshot {
  readonly reportReference: ReportingReference;
  readonly versionReference: ReportingReference;
  readonly stableCode: ReportingCode;
  readonly scope: ReportingScope;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: ReportingDigest;
  readonly lifecycle: ReportLifecycle;
  readonly certificationStatus: CertificationStatus;
  readonly reportNameCode: ReportingCode;
  readonly purposeCode: ReportingCode;
  readonly ownerReference: ReportingReference;
  readonly datasetVersionReferences: readonly ReportingReference[];
  readonly metricVersionReferences: readonly ReportingReference[];
  readonly dimensionCodes: readonly ReportingCode[];
  readonly filters: readonly ReportFilter[];
  readonly sorts: readonly ReportSort[];
  readonly visualization: "Table" | "Bar" | "Line" | "Kpi";
  readonly rowLimit: number;
  readonly defaultTimeRange: "BusinessDate" | "Rolling7Days" | "Rolling30Days" | "Parameter";
  readonly timezone: string;
  readonly dataFreshnessSeconds: number;
  readonly scopePolicy: "Brand" | "Store";
  readonly audience: "Manager" | "Analyst" | "ReportAdmin";
  readonly exportFormats: readonly ReportFormat[];
  readonly exportRowLimit: number;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly createdByActorReference: ReportingReference;
}

export interface ReportScheduleSnapshot {
  readonly scheduleReference: ReportingReference;
  readonly scheduleVersionReference: ReportingReference;
  readonly reportReference: ReportingReference;
  readonly reportVersionReference: ReportingReference;
  readonly scope: ReportingScope;
  readonly versionNumber: number;
  readonly status: "Active" | "Paused" | "Archived";
  readonly cadence: "Daily" | "Weekly" | "Monthly";
  readonly localTime: string;
  readonly timezone: string;
  readonly format: ReportFormat;
  readonly recipientScopeReference: ReportingReference;
  readonly createdAt: string;
  readonly createdByActorReference: ReportingReference;
}

export type ReportingContractErrorCode =
  "REPORTING_INPUT_INVALID" | "REPORTING_SCOPE_INVALID" | "REPORTING_LIFECYCLE_INVALID";

export class ReportingContractError extends Error {
  constructor(readonly code: ReportingContractErrorCode) {
    super("Reporting input is invalid");
    this.name = "ReportingContractError";
  }
}

const fail = (code: ReportingContractErrorCode = "REPORTING_INPUT_INVALID"): never => {
  throw new ReportingContractError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const code = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const timezonePattern = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  if (Object.getPrototypeOf(value) !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !keys.includes(field)) ||
    keys.some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return fail();
  return value as Record<string, unknown>;
}

export function parseReportingReference(value: unknown): ReportingReference {
  if (typeof value !== "string" || !uuid.test(value)) return fail();
  return value as ReportingReference;
}
export function parseReportingDigest(value: unknown): ReportingDigest {
  if (typeof value !== "string" || !digest.test(value)) return fail();
  return value as ReportingDigest;
}
export function parseReportingCode(value: unknown): ReportingCode {
  if (typeof value !== "string" || !code.test(value)) return fail();
  return value as ReportingCode;
}
export function parseReportingInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail();
  return value;
}
export function parseReportingTimezone(value: unknown): string {
  if (typeof value !== "string" || !timezonePattern.test(value)) return fail();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
  } catch {
    return fail();
  }
  return value;
}
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return fail();
  return value as number;
}
function unique<T>(value: unknown, parse: (item: unknown) => T, minimum = 0): readonly T[] {
  if (!Array.isArray(value) || value.length < minimum) return fail();
  const parsed = value.map(parse);
  if (new Set(parsed).size !== parsed.length) return fail();
  return Object.freeze(parsed);
}

export function parseReportingScope(value: unknown): ReportingScope {
  const raw = exact(value, ["tenantReference", "brandReference", "storeReference"]);
  return Object.freeze({
    tenantReference: parseReportingReference(raw.tenantReference),
    brandReference: parseReportingReference(raw.brandReference),
    storeReference:
      raw.storeReference === null ? null : parseReportingReference(raw.storeReference),
  });
}

function parseFilter(value: unknown): ReportFilter {
  const raw = exact(value, ["dimensionCode", "operator", "valueCodes"]);
  if (!(["Equal", "In", "Between"] as const).includes(raw.operator as never)) return fail();
  const values = unique(raw.valueCodes, parseReportingCode, 1);
  if (
    (raw.operator === "Equal" && values.length !== 1) ||
    (raw.operator === "Between" && values.length !== 2) ||
    (raw.operator === "In" && values.length > 50)
  )
    return fail();
  return Object.freeze({
    dimensionCode: parseReportingCode(raw.dimensionCode),
    operator: raw.operator,
    valueCodes: values,
  }) as ReportFilter;
}
function parseSort(value: unknown): ReportSort {
  const raw = exact(value, ["fieldCode", "direction"]);
  if (raw.direction !== "Ascending" && raw.direction !== "Descending") return fail();
  return Object.freeze({
    fieldCode: parseReportingCode(raw.fieldCode),
    direction: raw.direction,
  });
}

export function createReportDefinitionSnapshot(value: unknown): ReportDefinitionSnapshot {
  const raw = exact(value, [
    "reportReference",
    "versionReference",
    "stableCode",
    "scope",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "certificationStatus",
    "reportNameCode",
    "purposeCode",
    "ownerReference",
    "datasetVersionReferences",
    "metricVersionReferences",
    "dimensionCodes",
    "filters",
    "sorts",
    "visualization",
    "rowLimit",
    "defaultTimeRange",
    "timezone",
    "dataFreshnessSeconds",
    "scopePolicy",
    "audience",
    "exportFormats",
    "exportRowLimit",
    "effectiveFrom",
    "effectiveUntil",
    "createdAt",
    "createdByActorReference",
  ]);
  if (
    !(["Draft", "InReview", "Published", "Archived"] as const).includes(raw.lifecycle as never) ||
    !(["Draft", "InReview", "Certified"] as const).includes(raw.certificationStatus as never) ||
    !(["Table", "Bar", "Line", "Kpi"] as const).includes(raw.visualization as never) ||
    !(["BusinessDate", "Rolling7Days", "Rolling30Days", "Parameter"] as const).includes(
      raw.defaultTimeRange as never,
    ) ||
    !(["Brand", "Store"] as const).includes(raw.scopePolicy as never) ||
    !(["Manager", "Analyst", "ReportAdmin"] as const).includes(raw.audience as never)
  )
    return fail();
  const scope = parseReportingScope(raw.scope);
  if ((raw.scopePolicy === "Store") !== (scope.storeReference !== null))
    return fail("REPORTING_SCOPE_INVALID");
  if (
    (raw.lifecycle === "Draft") !== (raw.certificationStatus === "Draft") ||
    (raw.lifecycle === "InReview") !== (raw.certificationStatus === "InReview") ||
    (raw.lifecycle === "Published") !== (raw.certificationStatus === "Certified") ||
    (raw.lifecycle === "Archived" && raw.certificationStatus === "InReview")
  )
    return fail("REPORTING_LIFECYCLE_INVALID");
  const effectiveFrom = parseReportingInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseReportingInstant(raw.effectiveUntil);
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
    return fail();
  const dimensions = unique(raw.dimensionCodes, parseReportingCode);
  const filters = unique(raw.filters, parseFilter);
  const sorts = unique(raw.sorts, parseSort);
  const dimensionSet = new Set(dimensions);
  if (filters.some((item) => !dimensionSet.has(item.dimensionCode)) || sorts.length > 5)
    return fail();
  const formats = unique(raw.exportFormats, (item) => {
    if (item !== "Csv" && item !== "Json") return fail();
    return item;
  });
  const rowLimit = positive(raw.rowLimit, 100_000);
  const exportRowLimit = positive(raw.exportRowLimit, 100_000);
  if (formats.length === 0 && exportRowLimit !== rowLimit) return fail();
  return Object.freeze({
    reportReference: parseReportingReference(raw.reportReference),
    versionReference: parseReportingReference(raw.versionReference),
    stableCode: parseReportingCode(raw.stableCode),
    scope,
    aggregateVersion: positive(raw.aggregateVersion),
    versionNumber: positive(raw.versionNumber),
    snapshotDigest: parseReportingDigest(raw.snapshotDigest),
    lifecycle: raw.lifecycle,
    certificationStatus: raw.certificationStatus,
    reportNameCode: parseReportingCode(raw.reportNameCode),
    purposeCode: parseReportingCode(raw.purposeCode),
    ownerReference: parseReportingReference(raw.ownerReference),
    datasetVersionReferences: unique(raw.datasetVersionReferences, parseReportingReference, 1),
    metricVersionReferences: unique(raw.metricVersionReferences, parseReportingReference, 1),
    dimensionCodes: dimensions,
    filters,
    sorts,
    visualization: raw.visualization,
    rowLimit,
    defaultTimeRange: raw.defaultTimeRange,
    timezone: parseReportingTimezone(raw.timezone),
    dataFreshnessSeconds: positive(raw.dataFreshnessSeconds, 86_400),
    scopePolicy: raw.scopePolicy,
    audience: raw.audience,
    exportFormats: formats,
    exportRowLimit,
    effectiveFrom,
    effectiveUntil,
    createdAt: parseReportingInstant(raw.createdAt),
    createdByActorReference: parseReportingReference(raw.createdByActorReference),
  }) as ReportDefinitionSnapshot;
}

export function createReportScheduleSnapshot(value: unknown): ReportScheduleSnapshot {
  const raw = exact(value, [
    "scheduleReference",
    "scheduleVersionReference",
    "reportReference",
    "reportVersionReference",
    "scope",
    "versionNumber",
    "status",
    "cadence",
    "localTime",
    "timezone",
    "format",
    "recipientScopeReference",
    "createdAt",
    "createdByActorReference",
  ]);
  if (
    !(["Active", "Paused", "Archived"] as const).includes(raw.status as never) ||
    !(["Daily", "Weekly", "Monthly"] as const).includes(raw.cadence as never) ||
    (raw.format !== "Csv" && raw.format !== "Json") ||
    typeof raw.localTime !== "string" ||
    !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(raw.localTime)
  )
    return fail();
  return Object.freeze({
    scheduleReference: parseReportingReference(raw.scheduleReference),
    scheduleVersionReference: parseReportingReference(raw.scheduleVersionReference),
    reportReference: parseReportingReference(raw.reportReference),
    reportVersionReference: parseReportingReference(raw.reportVersionReference),
    scope: parseReportingScope(raw.scope),
    versionNumber: positive(raw.versionNumber),
    status: raw.status,
    cadence: raw.cadence,
    localTime: raw.localTime,
    timezone: parseReportingTimezone(raw.timezone),
    format: raw.format,
    recipientScopeReference: parseReportingReference(raw.recipientScopeReference),
    createdAt: parseReportingInstant(raw.createdAt),
    createdByActorReference: parseReportingReference(raw.createdByActorReference),
  }) as ReportScheduleSnapshot;
}
