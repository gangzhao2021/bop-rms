import {
  parseReportingCode,
  parseReportingDigest,
  parseReportingInstant,
  parseReportingReference,
  parseReportingScope,
  parseReportingTimezone,
  type ReportingCode,
  type ReportingDigest,
  type ReportingReference,
  type ReportingScope,
} from "./report-definition.js";

export type MetricLifecycle = "Draft" | "InReview" | "Certified" | "Deprecated" | "Archived";
export type MetricCertificationStatus = "Draft" | "InReview" | "Certified" | "Deprecated";

export interface MetricLineageSnapshot {
  readonly datasetVersionReferences: readonly ReportingReference[];
  readonly transformationVersionReferences: readonly ReportingReference[];
  readonly queryExpressionReference: ReportingReference;
  readonly dependencyMetricVersionReferences: readonly ReportingReference[];
  readonly lastSuccessfulBuildAt: string | null;
  readonly dataFreshnessSeconds: number;
  readonly dataQualityStatus: "Pending" | "Pass" | "Warning" | "Failed";
}

export interface MetricDefinitionSnapshot {
  readonly metricReference: ReportingReference;
  readonly versionReference: ReportingReference;
  readonly stableCode: ReportingCode;
  readonly scope: ReportingScope;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: ReportingDigest;
  readonly lifecycle: MetricLifecycle;
  readonly certificationStatus: MetricCertificationStatus;
  readonly ownerDomainCode: ReportingCode;
  readonly businessOwnerReference: ReportingReference;
  readonly displayNameCode: ReportingCode;
  readonly businessDefinitionCode: ReportingCode;
  readonly formulaReference: ReportingReference;
  readonly baseFactReference: ReportingReference;
  readonly grainCode: ReportingCode;
  readonly allowedDimensionCodes: readonly ReportingCode[];
  readonly requiredFilterCodes: readonly ReportingCode[];
  readonly timeSemantics: "BusinessDate" | "OccurredAt" | "CompletedAt";
  readonly timezone: string;
  readonly currencySemantics: "None" | "OriginalCurrency" | "SingleCurrency" | "VersionedFx";
  readonly currencyCode: string | null;
  readonly inclusionRuleCodes: readonly ReportingCode[];
  readonly exclusionRuleCodes: readonly ReportingCode[];
  readonly nullPolicy: "Exclude" | "TreatAsZero" | "Fail";
  readonly lineage: MetricLineageSnapshot;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly replacementMetricReference: ReportingReference | null;
  readonly createdAt: string;
  readonly createdByActorReference: ReportingReference;
}

const invalid = (): never => {
  throw new Error("METRIC_DEFINITION_INPUT_INVALID");
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
function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}
function unique<T>(value: unknown, parser: (item: unknown) => T, minimum = 0): readonly T[] {
  if (!Array.isArray(value) || value.length < minimum) return invalid();
  const parsed = value.map(parser);
  if (new Set(parsed).size !== parsed.length) return invalid();
  return Object.freeze(parsed);
}

export function createMetricLineageSnapshot(value: unknown): MetricLineageSnapshot {
  const raw = exact(value, [
    "datasetVersionReferences",
    "transformationVersionReferences",
    "queryExpressionReference",
    "dependencyMetricVersionReferences",
    "lastSuccessfulBuildAt",
    "dataFreshnessSeconds",
    "dataQualityStatus",
  ]);
  if (!(
    raw.dataQualityStatus === "Pending" ||
    raw.dataQualityStatus === "Pass" ||
    raw.dataQualityStatus === "Warning" ||
    raw.dataQualityStatus === "Failed"
  ))
    return invalid();
  return Object.freeze({
    datasetVersionReferences: unique(raw.datasetVersionReferences, parseReportingReference, 1),
    transformationVersionReferences: unique(
      raw.transformationVersionReferences,
      parseReportingReference,
      1,
    ),
    queryExpressionReference: parseReportingReference(raw.queryExpressionReference),
    dependencyMetricVersionReferences: unique(
      raw.dependencyMetricVersionReferences,
      parseReportingReference,
    ),
    lastSuccessfulBuildAt:
      raw.lastSuccessfulBuildAt === null ? null : parseReportingInstant(raw.lastSuccessfulBuildAt),
    dataFreshnessSeconds: positive(raw.dataFreshnessSeconds, 604_800),
    dataQualityStatus: raw.dataQualityStatus,
  });
}

export function createMetricDefinitionSnapshot(value: unknown): MetricDefinitionSnapshot {
  const raw = exact(value, [
    "metricReference",
    "versionReference",
    "stableCode",
    "scope",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "certificationStatus",
    "ownerDomainCode",
    "businessOwnerReference",
    "displayNameCode",
    "businessDefinitionCode",
    "formulaReference",
    "baseFactReference",
    "grainCode",
    "allowedDimensionCodes",
    "requiredFilterCodes",
    "timeSemantics",
    "timezone",
    "currencySemantics",
    "currencyCode",
    "inclusionRuleCodes",
    "exclusionRuleCodes",
    "nullPolicy",
    "lineage",
    "effectiveFrom",
    "effectiveUntil",
    "replacementMetricReference",
    "createdAt",
    "createdByActorReference",
  ]);
  if (
    !(["Draft", "InReview", "Certified", "Deprecated", "Archived"] as const).includes(
      raw.lifecycle as never,
    ) ||
    !(["Draft", "InReview", "Certified", "Deprecated"] as const).includes(
      raw.certificationStatus as never,
    ) ||
    !(["BusinessDate", "OccurredAt", "CompletedAt"] as const).includes(
      raw.timeSemantics as never,
    ) ||
    !(["None", "OriginalCurrency", "SingleCurrency", "VersionedFx"] as const).includes(
      raw.currencySemantics as never,
    ) ||
    !(["Exclude", "TreatAsZero", "Fail"] as const).includes(raw.nullPolicy as never)
  )
    return invalid();
  if (
    (raw.lifecycle === "Draft") !== (raw.certificationStatus === "Draft") ||
    (raw.lifecycle === "InReview") !== (raw.certificationStatus === "InReview") ||
    (raw.lifecycle === "Certified") !== (raw.certificationStatus === "Certified") ||
    (raw.lifecycle === "Deprecated") !== (raw.certificationStatus === "Deprecated") ||
    (raw.lifecycle === "Archived" && raw.certificationStatus === "InReview")
  )
    return invalid();
  const currencyCode =
    raw.currencyCode === null
      ? null
      : typeof raw.currencyCode === "string" && /^[A-Z]{3}$/u.test(raw.currencyCode)
        ? raw.currencyCode
        : invalid();
  if ((raw.currencySemantics === "SingleCurrency") !== (currencyCode !== null)) return invalid();
  const effectiveFrom = parseReportingInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseReportingInstant(raw.effectiveUntil);
  if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
    return invalid();
  const replacement =
    raw.replacementMetricReference === null
      ? null
      : parseReportingReference(raw.replacementMetricReference);
  if (replacement !== null && raw.lifecycle !== "Deprecated" && raw.lifecycle !== "Archived")
    return invalid();
  const lineage = createMetricLineageSnapshot(raw.lineage);
  if (
    raw.lifecycle === "Certified" &&
    (lineage.lastSuccessfulBuildAt === null || lineage.dataQualityStatus !== "Pass")
  )
    return invalid();
  const dimensions = unique(raw.allowedDimensionCodes, parseReportingCode, 1);
  const filters = unique(raw.requiredFilterCodes, parseReportingCode);
  if (filters.some((item) => !dimensions.includes(item))) return invalid();
  return Object.freeze({
    metricReference: parseReportingReference(raw.metricReference),
    versionReference: parseReportingReference(raw.versionReference),
    stableCode: parseReportingCode(raw.stableCode),
    scope: parseReportingScope(raw.scope),
    aggregateVersion: positive(raw.aggregateVersion),
    versionNumber: positive(raw.versionNumber),
    snapshotDigest: parseReportingDigest(raw.snapshotDigest),
    lifecycle: raw.lifecycle,
    certificationStatus: raw.certificationStatus,
    ownerDomainCode: parseReportingCode(raw.ownerDomainCode),
    businessOwnerReference: parseReportingReference(raw.businessOwnerReference),
    displayNameCode: parseReportingCode(raw.displayNameCode),
    businessDefinitionCode: parseReportingCode(raw.businessDefinitionCode),
    formulaReference: parseReportingReference(raw.formulaReference),
    baseFactReference: parseReportingReference(raw.baseFactReference),
    grainCode: parseReportingCode(raw.grainCode),
    allowedDimensionCodes: dimensions,
    requiredFilterCodes: filters,
    timeSemantics: raw.timeSemantics,
    timezone: parseReportingTimezone(raw.timezone),
    currencySemantics: raw.currencySemantics,
    currencyCode,
    inclusionRuleCodes: unique(raw.inclusionRuleCodes, parseReportingCode),
    exclusionRuleCodes: unique(raw.exclusionRuleCodes, parseReportingCode),
    nullPolicy: raw.nullPolicy,
    lineage,
    effectiveFrom,
    effectiveUntil,
    replacementMetricReference: replacement,
    createdAt: parseReportingInstant(raw.createdAt),
    createdByActorReference: parseReportingReference(raw.createdByActorReference),
  }) as MetricDefinitionSnapshot;
}
