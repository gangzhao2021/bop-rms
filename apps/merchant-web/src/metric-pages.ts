export type MetricPageErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class MetricPageError extends Error {
  constructor(readonly code: MetricPageErrorCode) {
    super("Metric catalog unavailable");
    this.name = "MetricPageError";
  }
}
export type MetricLifecycle = "Draft" | "InReview" | "Certified" | "Deprecated" | "Archived";
export interface MetricCatalogItem {
  readonly metricReference: string;
  readonly stableCode: string;
  readonly versionReference: string;
  readonly versionNumber: number;
  readonly displayNameCode: string;
  readonly businessDefinitionCode: string;
  readonly ownerDomainCode: string;
  readonly businessOwnerReference: string;
  readonly lifecycle: MetricLifecycle;
  readonly grainCode: string;
  readonly lineageStatus: "Pending" | "Valid" | "Warning" | "Invalid";
  readonly dataFreshnessSeconds: number;
  readonly dataQualityStatus: "Pending" | "Pass" | "Warning" | "Failed";
  readonly effectiveFrom: string;
  readonly replacementMetricReference: string | null;
}
export interface MetricCatalogView {
  readonly screenId: "BI-METRIC-CATALOG";
  readonly queryName: "reporting_metric_catalog_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly permissions: {
    readonly mayCreate: boolean;
    readonly mayCompare: boolean;
    readonly mayValidate: boolean;
    readonly maySubmit: boolean;
    readonly mayCertify: boolean;
    readonly mayDeprecate: boolean;
  };
  readonly filters: {
    readonly nameOrCode: string | null;
    readonly domainCode: string | null;
    readonly lifecycle: MetricLifecycle | null;
    readonly ownerReference: string | null;
    readonly certified: boolean | null;
  };
  readonly metrics: readonly MetricCatalogItem[];
}
export interface MetricDetailView {
  readonly screenId: "BI-METRIC-DETAIL";
  readonly queryName: "reporting_metric_detail_v1";
  readonly queryVersion: 1;
  readonly generatedAt: string;
  readonly metric: MetricCatalogItem & {
    readonly formulaReference: string;
    readonly baseFactReference: string;
    readonly allowedDimensionCodes: readonly string[];
    readonly requiredFilterCodes: readonly string[];
    readonly timeSemantics: "BusinessDate" | "OccurredAt" | "CompletedAt";
    readonly timezone: string;
    readonly currencySemantics: "None" | "OriginalCurrency" | "SingleCurrency" | "VersionedFx";
    readonly currencyCode: string | null;
    readonly inclusionRuleCodes: readonly string[];
    readonly exclusionRuleCodes: readonly string[];
    readonly nullPolicy: "Exclude" | "TreatAsZero" | "Fail";
    readonly exampleCodes: readonly string[];
    readonly datasetVersionReferences: readonly string[];
    readonly transformationVersionReferences: readonly string[];
    readonly queryExpressionReference: string;
    readonly dependencyMetricVersionReferences: readonly string[];
    readonly lastSuccessfulBuildAt: string | null;
    readonly history: readonly {
      readonly versionReference: string;
      readonly versionNumber: number;
      readonly lifecycle: MetricLifecycle;
      readonly effectiveFrom: string;
    }[];
  };
  readonly permissions: {
    readonly mayOpenSource: boolean;
    readonly mayOpenDependentReports: boolean;
    readonly mayCreateRevision: boolean;
    readonly mayRunValidation: boolean;
  };
}
export interface MetricCatalogClient {
  load(): Promise<unknown>;
}
export interface MetricDetailClient {
  load(metricReference: string): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z][A-Z0-9_.:-]{0,63}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const timezonePattern = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;
const fail = (): never => {
  throw new MetricPageError("Unavailable");
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
const code = (value: unknown) =>
  typeof value === "string" && codePattern.test(value) ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const bool = (value: unknown) => (typeof value === "boolean" ? value : fail());
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= maximum
    ? (value as number)
    : fail();
const nullable = <T>(value: unknown, parse: (item: unknown) => T) =>
  value === null ? null : parse(value);
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const lifecycle = (value: unknown) =>
  oneOf(value, ["Draft", "InReview", "Certified", "Deprecated", "Archived"] as const);
function unique<T>(value: unknown, parse: (item: unknown) => T, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) return fail();
  const result = value.map(parse);
  if (new Set(result).size !== result.length) return fail();
  return Object.freeze(result);
}
const nullableSearch = (value: unknown) =>
  value === null
    ? null
    : typeof value === "string" && /^[A-Za-z0-9 _.:-]{1,80}$/u.test(value)
      ? value
      : fail();

const itemFields = [
  "metricReference",
  "stableCode",
  "versionReference",
  "versionNumber",
  "displayNameCode",
  "businessDefinitionCode",
  "ownerDomainCode",
  "businessOwnerReference",
  "lifecycle",
  "grainCode",
  "lineageStatus",
  "dataFreshnessSeconds",
  "dataQualityStatus",
  "effectiveFrom",
  "replacementMetricReference",
] as const;
function parseMetricItem(value: unknown): MetricCatalogItem {
  const raw = object(value, itemFields);
  const state = lifecycle(raw.lifecycle);
  const replacement = nullable(raw.replacementMetricReference, reference);
  if (replacement !== null && state !== "Deprecated" && state !== "Archived") fail();
  return Object.freeze({
    metricReference: reference(raw.metricReference),
    stableCode: code(raw.stableCode),
    versionReference: reference(raw.versionReference),
    versionNumber: positive(raw.versionNumber),
    displayNameCode: code(raw.displayNameCode),
    businessDefinitionCode: code(raw.businessDefinitionCode),
    ownerDomainCode: code(raw.ownerDomainCode),
    businessOwnerReference: reference(raw.businessOwnerReference),
    lifecycle: state,
    grainCode: code(raw.grainCode),
    lineageStatus: oneOf(raw.lineageStatus, ["Pending", "Valid", "Warning", "Invalid"] as const),
    dataFreshnessSeconds: positive(raw.dataFreshnessSeconds, 604_800),
    dataQualityStatus: oneOf(raw.dataQualityStatus, [
      "Pending",
      "Pass",
      "Warning",
      "Failed",
    ] as const),
    effectiveFrom: instant(raw.effectiveFrom),
    replacementMetricReference: replacement,
  });
}

export function parseMetricCatalogView(value: unknown): MetricCatalogView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "permissions",
    "filters",
    "metrics",
  ]);
  if (
    raw.screenId !== "BI-METRIC-CATALOG" ||
    raw.queryName !== "reporting_metric_catalog_v1" ||
    raw.queryVersion !== 1 ||
    !Array.isArray(raw.metrics) ||
    raw.metrics.length > 500
  )
    fail();
  const permissions = object(raw.permissions, [
    "mayCreate",
    "mayCompare",
    "mayValidate",
    "maySubmit",
    "mayCertify",
    "mayDeprecate",
  ]);
  const filters = object(raw.filters, [
    "nameOrCode",
    "domainCode",
    "lifecycle",
    "ownerReference",
    "certified",
  ]);
  return Object.freeze({
    screenId: "BI-METRIC-CATALOG",
    queryName: "reporting_metric_catalog_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    permissions: Object.freeze({
      mayCreate: bool(permissions.mayCreate),
      mayCompare: bool(permissions.mayCompare),
      mayValidate: bool(permissions.mayValidate),
      maySubmit: bool(permissions.maySubmit),
      mayCertify: bool(permissions.mayCertify),
      mayDeprecate: bool(permissions.mayDeprecate),
    }),
    filters: Object.freeze({
      nameOrCode: nullableSearch(filters.nameOrCode),
      domainCode: nullable(filters.domainCode, code),
      lifecycle: nullable(filters.lifecycle, lifecycle),
      ownerReference: nullable(filters.ownerReference, reference),
      certified: filters.certified === null ? null : bool(filters.certified),
    }),
    metrics: Object.freeze((raw.metrics as unknown[]).map(parseMetricItem)),
  });
}

export function parseMetricDetailView(value: unknown): MetricDetailView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "generatedAt",
    "metric",
    "permissions",
  ]);
  if (
    raw.screenId !== "BI-METRIC-DETAIL" ||
    raw.queryName !== "reporting_metric_detail_v1" ||
    raw.queryVersion !== 1
  )
    fail();
  const detailFields = [
    ...itemFields,
    "formulaReference",
    "baseFactReference",
    "allowedDimensionCodes",
    "requiredFilterCodes",
    "timeSemantics",
    "timezone",
    "currencySemantics",
    "currencyCode",
    "inclusionRuleCodes",
    "exclusionRuleCodes",
    "nullPolicy",
    "exampleCodes",
    "datasetVersionReferences",
    "transformationVersionReferences",
    "queryExpressionReference",
    "dependencyMetricVersionReferences",
    "lastSuccessfulBuildAt",
    "history",
  ];
  const metricRaw = object(raw.metric, detailFields);
  const base = parseMetricItem(
    Object.fromEntries(itemFields.map((field) => [field, metricRaw[field]])),
  );
  const timezone =
    typeof metricRaw.timezone === "string" && timezonePattern.test(metricRaw.timezone)
      ? metricRaw.timezone
      : fail();
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(0);
  } catch {
    fail();
  }
  const currencySemantics = oneOf(metricRaw.currencySemantics, [
    "None",
    "OriginalCurrency",
    "SingleCurrency",
    "VersionedFx",
  ] as const);
  const currencyCode =
    metricRaw.currencyCode === null
      ? null
      : typeof metricRaw.currencyCode === "string" && /^[A-Z]{3}$/u.test(metricRaw.currencyCode)
        ? metricRaw.currencyCode
        : fail();
  if ((currencySemantics === "SingleCurrency") !== (currencyCode !== null)) fail();
  const historyRaw = metricRaw.history;
  if (!Array.isArray(historyRaw)) fail();
  const historyEntries = historyRaw as unknown[];
  if (historyEntries.length > 100) fail();
  const history = Object.freeze(
    historyEntries.map((entry: unknown) => {
      const item = object(entry, [
        "versionReference",
        "versionNumber",
        "lifecycle",
        "effectiveFrom",
      ]);
      return Object.freeze({
        versionReference: reference(item.versionReference),
        versionNumber: positive(item.versionNumber),
        lifecycle: lifecycle(item.lifecycle),
        effectiveFrom: instant(item.effectiveFrom),
      });
    }),
  );
  const permissions = object(raw.permissions, [
    "mayOpenSource",
    "mayOpenDependentReports",
    "mayCreateRevision",
    "mayRunValidation",
  ]);
  return Object.freeze({
    screenId: "BI-METRIC-DETAIL",
    queryName: "reporting_metric_detail_v1",
    queryVersion: 1,
    generatedAt: instant(raw.generatedAt),
    metric: Object.freeze({
      ...base,
      formulaReference: reference(metricRaw.formulaReference),
      baseFactReference: reference(metricRaw.baseFactReference),
      allowedDimensionCodes: unique(metricRaw.allowedDimensionCodes, code, 1),
      requiredFilterCodes: unique(metricRaw.requiredFilterCodes, code),
      timeSemantics: oneOf(metricRaw.timeSemantics, [
        "BusinessDate",
        "OccurredAt",
        "CompletedAt",
      ] as const),
      timezone,
      currencySemantics,
      currencyCode,
      inclusionRuleCodes: unique(metricRaw.inclusionRuleCodes, code),
      exclusionRuleCodes: unique(metricRaw.exclusionRuleCodes, code),
      nullPolicy: oneOf(metricRaw.nullPolicy, ["Exclude", "TreatAsZero", "Fail"] as const),
      exampleCodes: unique(metricRaw.exampleCodes, code),
      datasetVersionReferences: unique(metricRaw.datasetVersionReferences, reference, 1),
      transformationVersionReferences: unique(
        metricRaw.transformationVersionReferences,
        reference,
        1,
      ),
      queryExpressionReference: reference(metricRaw.queryExpressionReference),
      dependencyMetricVersionReferences: unique(
        metricRaw.dependencyMetricVersionReferences,
        reference,
      ),
      lastSuccessfulBuildAt: nullable(metricRaw.lastSuccessfulBuildAt, instant),
      history,
    }),
    permissions: Object.freeze({
      mayOpenSource: bool(permissions.mayOpenSource),
      mayOpenDependentReports: bool(permissions.mayOpenDependentReports),
      mayCreateRevision: bool(permissions.mayCreateRevision),
      mayRunValidation: bool(permissions.mayRunValidation),
    }),
  });
}

export const unavailableMetricCatalogClient: MetricCatalogClient = Object.freeze({
  load: async () => {
    throw new MetricPageError("Unavailable");
  },
});
export const unavailableMetricDetailClient: MetricDetailClient = Object.freeze({
  load: async () => {
    throw new MetricPageError("Unavailable");
  },
});
