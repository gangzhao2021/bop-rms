export type SupplierPerformanceClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class SupplierPerformanceClientError extends Error {
  constructor(readonly code: SupplierPerformanceClientErrorCode) {
    super("Supplier Performance unavailable");
    this.name = "SupplierPerformanceClientError";
  }
}
interface Rate {
  readonly numerator: string;
  readonly denominator: string;
  readonly percent: string | null;
}
export interface SupplierPerformanceView {
  readonly screenId: "SUP-PERFORMANCE";
  readonly projectionName: "procurement_supplier_performance_v1";
  readonly projectionVersion: 1;
  readonly definitionVersion: 1;
  readonly brandLabel: string;
  readonly stockSiteLabel: string;
  readonly periodFromUtc: string;
  readonly periodToUtc: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayDrillFacts: boolean;
    readonly mayViewPriceVariance: boolean;
    readonly mayViewManualAssessments: boolean;
    readonly mayExport: boolean;
    readonly mayOpenReviewTask: boolean;
  };
  readonly rows: readonly {
    readonly supplierReference: string;
    readonly supplierSummary: string;
    readonly offeringReference: string | null;
    readonly stockSiteReference: string;
    readonly onTimeDelivery: Rate;
    readonly fillRate: Rate;
    readonly acceptedQuality: Rate;
    readonly overFrequency: Rate;
    readonly shortFrequency: Rate;
    readonly rejectedFrequency: Rate;
    readonly damagedFrequency: Rate;
    readonly acknowledgementResponseSeconds: string | null;
    readonly declineCancellationRate: Rate;
    readonly purchasePriceVarianceAmount: string | null;
    readonly currency: string | null;
    readonly sourceFactCount: number;
    readonly incompleteFactCount: number;
    readonly factReferences: readonly string[] | null;
    readonly manualAssessments:
      | readonly {
          readonly assessmentReference: string;
          readonly ratingCode: string;
          readonly occurredAt: string;
        }[]
      | null;
  }[];
}
export interface SupplierPerformanceProjectionClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const fail = (): never => {
  throw new SupplierPerformanceClientError("Unavailable");
};
const object = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
};
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim() === value &&
  /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u.test(value)
    ? value
    : fail();
const decimal = (value: unknown) =>
  typeof value === "string" && decimalPattern.test(value) ? value : fail();
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const rate = (value: unknown): Rate => {
  const raw = object(value, ["numerator", "denominator", "percent"]);
  return Object.freeze({
    numerator: decimal(raw.numerator),
    denominator: decimal(raw.denominator),
    percent: raw.percent === null ? null : decimal(raw.percent),
  });
};
export function parseSupplierPerformanceView(value: unknown): SupplierPerformanceView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "definitionVersion",
    "brandLabel",
    "stockSiteLabel",
    "periodFromUtc",
    "periodToUtc",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
  ]);
  if (
    raw.screenId !== "SUP-PERFORMANCE" ||
    raw.projectionName !== "procurement_supplier_performance_v1" ||
    raw.projectionVersion !== 1 ||
    raw.definitionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200
  )
    fail();
  const p = object(raw.permissions, [
    "mayDrillFacts",
    "mayViewPriceVariance",
    "mayViewManualAssessments",
    "mayExport",
    "mayOpenReviewTask",
  ]);
  if (Object.values(p).some((entry) => typeof entry !== "boolean")) fail();
  const permissions = p as unknown as SupplierPerformanceView["permissions"];
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((entry) => {
      const row = object(entry, [
        "supplierReference",
        "supplierSummary",
        "offeringReference",
        "stockSiteReference",
        "onTimeDelivery",
        "fillRate",
        "acceptedQuality",
        "overFrequency",
        "shortFrequency",
        "rejectedFrequency",
        "damagedFrequency",
        "acknowledgementResponseSeconds",
        "declineCancellationRate",
        "purchasePriceVarianceAmount",
        "currency",
        "sourceFactCount",
        "incompleteFactCount",
        "factReferences",
        "manualAssessments",
      ]);
      if (
        (!permissions.mayDrillFacts && row.factReferences !== null) ||
        (!permissions.mayViewPriceVariance &&
          (row.purchasePriceVarianceAmount !== null || row.currency !== null)) ||
        (!permissions.mayViewManualAssessments && row.manualAssessments !== null) ||
        (row.factReferences !== null && !Array.isArray(row.factReferences)) ||
        (row.manualAssessments !== null && !Array.isArray(row.manualAssessments))
      )
        fail();
      const factReferences =
        row.factReferences === null
          ? null
          : Object.freeze((row.factReferences as unknown[]).map(ref));
      const manualAssessments =
        row.manualAssessments === null
          ? null
          : Object.freeze(
              (row.manualAssessments as unknown[]).map((entry) => {
                const item = object(entry, ["assessmentReference", "ratingCode", "occurredAt"]);
                return Object.freeze({
                  assessmentReference: ref(item.assessmentReference),
                  ratingCode: text(item.ratingCode),
                  occurredAt: instant(item.occurredAt),
                });
              }),
            );
      return Object.freeze({
        supplierReference: ref(row.supplierReference),
        supplierSummary: text(row.supplierSummary),
        offeringReference: row.offeringReference === null ? null : ref(row.offeringReference),
        stockSiteReference: ref(row.stockSiteReference),
        onTimeDelivery: rate(row.onTimeDelivery),
        fillRate: rate(row.fillRate),
        acceptedQuality: rate(row.acceptedQuality),
        overFrequency: rate(row.overFrequency),
        shortFrequency: rate(row.shortFrequency),
        rejectedFrequency: rate(row.rejectedFrequency),
        damagedFrequency: rate(row.damagedFrequency),
        acknowledgementResponseSeconds:
          row.acknowledgementResponseSeconds === null
            ? null
            : decimal(row.acknowledgementResponseSeconds),
        declineCancellationRate: rate(row.declineCancellationRate),
        purchasePriceVarianceAmount:
          row.purchasePriceVarianceAmount === null
            ? null
            : decimal(row.purchasePriceVarianceAmount),
        currency: row.currency === null ? null : text(row.currency),
        sourceFactCount: integer(row.sourceFactCount),
        incompleteFactCount: integer(row.incompleteFactCount),
        factReferences,
        manualAssessments,
      });
    }),
  );
  const periodFromUtc = instant(raw.periodFromUtc),
    periodToUtc = instant(raw.periodToUtc);
  if (periodFromUtc >= periodToUtc) fail();
  return Object.freeze({
    screenId: "SUP-PERFORMANCE",
    projectionName: "procurement_supplier_performance_v1",
    projectionVersion: 1,
    definitionVersion: 1,
    brandLabel: text(raw.brandLabel),
    stockSiteLabel: text(raw.stockSiteLabel),
    periodFromUtc,
    periodToUtc,
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    permissions,
    rows,
  });
}
export const unavailableSupplierPerformanceClient: SupplierPerformanceProjectionClient = {
  load: async () => {
    throw new SupplierPerformanceClientError("Unavailable");
  },
};
