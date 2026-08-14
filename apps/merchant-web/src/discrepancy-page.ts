export type DiscrepancyClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "ValidationFailed"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class DiscrepancyClientError extends Error {
  constructor(readonly code: DiscrepancyClientErrorCode) {
    super("Discrepancy view unavailable");
    this.name = "DiscrepancyClientError";
  }
}
export interface DiscrepancyView {
  readonly screenId: "PROC-DISCREPANCY";
  readonly projectionName: "procurement_discrepancy_v1";
  readonly projectionVersion: 1;
  readonly brandLabel: string;
  readonly stockSiteLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayManage: boolean;
    readonly mayWaiveRemainder: boolean;
    readonly mayViewSupplierContact: boolean;
    readonly mayViewEvidence: boolean;
    readonly mayViewCost: boolean;
    readonly mayViewHistory: boolean;
  };
  readonly rows: readonly {
    readonly discrepancyReference: string;
    readonly version: number;
    readonly type: "Short" | "Over" | "Rejected" | "Damaged" | "Quality";
    readonly status:
      "Open" | "Acknowledged" | "InReview" | "ResolutionPending" | "Resolved" | "Closed";
    readonly purchaseOrderReference: string;
    readonly goodsReceiptReference: string;
    readonly supplierReference: string;
    readonly supplierSummary: string;
    readonly itemSummary: string;
    readonly varianceQuantity: string;
    readonly unit: string;
    readonly toleranceQuantity: string;
    readonly withinTolerance: boolean;
    readonly ownerReference: string | null;
    readonly ownerSummary: string | null;
    readonly overdue: boolean;
    readonly supplierContactOutcome: string | null;
    readonly evidenceCount: number | null;
    readonly unitCost: string | null;
    readonly history: readonly { readonly action: string; readonly occurredAt: string }[] | null;
  }[];
}
export interface DiscrepancyProjectionClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u;
const fail = (): never => {
  throw new DiscrepancyClientError("Unavailable");
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
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value && safe.test(value) ? value : fail();
const nullableText = (value: unknown) => (value === null ? null : text(value));
const decimal = (value: unknown) =>
  typeof value === "string" && decimalPattern.test(value) ? value : fail();
const nullableDecimal = (value: unknown) => (value === null ? null : decimal(value));
const instant = (value: unknown) =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const integer = (value: unknown, min = 0) =>
  Number.isSafeInteger(value) && (value as number) >= min ? (value as number) : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
export function parseDiscrepancyView(value: unknown): DiscrepancyView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "brandLabel",
    "stockSiteLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
  ]);
  if (
    raw.screenId !== "PROC-DISCREPANCY" ||
    raw.projectionName !== "procurement_discrepancy_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200
  )
    fail();
  const permissionRaw = object(raw.permissions, [
    "mayManage",
    "mayWaiveRemainder",
    "mayViewSupplierContact",
    "mayViewEvidence",
    "mayViewCost",
    "mayViewHistory",
  ]);
  if (Object.values(permissionRaw).some((entry) => typeof entry !== "boolean")) fail();
  const permissions = permissionRaw as unknown as DiscrepancyView["permissions"];
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((entry) => {
      const row = object(entry, [
        "discrepancyReference",
        "version",
        "type",
        "status",
        "purchaseOrderReference",
        "goodsReceiptReference",
        "supplierReference",
        "supplierSummary",
        "itemSummary",
        "varianceQuantity",
        "unit",
        "toleranceQuantity",
        "withinTolerance",
        "ownerReference",
        "ownerSummary",
        "overdue",
        "supplierContactOutcome",
        "evidenceCount",
        "unitCost",
        "history",
      ]);
      const supplierContactOutcome = nullableText(row.supplierContactOutcome);
      const evidenceCount = row.evidenceCount === null ? null : integer(row.evidenceCount);
      const unitCost = nullableDecimal(row.unitCost);
      if (
        (!permissions.mayViewSupplierContact && supplierContactOutcome !== null) ||
        (!permissions.mayViewEvidence && evidenceCount !== null) ||
        (!permissions.mayViewCost && unitCost !== null) ||
        (!permissions.mayViewHistory && row.history !== null) ||
        typeof row.withinTolerance !== "boolean" ||
        typeof row.overdue !== "boolean" ||
        (!Array.isArray(row.history) && row.history !== null)
      )
        fail();
      const history =
        row.history === null
          ? null
          : Object.freeze(
              (row.history as unknown[]).map((event) => {
                const item = object(event, ["action", "occurredAt"]);
                return Object.freeze({
                  action: text(item.action),
                  occurredAt: instant(item.occurredAt),
                });
              }),
            );
      return Object.freeze({
        discrepancyReference: ref(row.discrepancyReference),
        version: integer(row.version, 1),
        type: oneOf(row.type, ["Short", "Over", "Rejected", "Damaged", "Quality"]),
        status: oneOf(row.status, [
          "Open",
          "Acknowledged",
          "InReview",
          "ResolutionPending",
          "Resolved",
          "Closed",
        ]),
        purchaseOrderReference: ref(row.purchaseOrderReference),
        goodsReceiptReference: ref(row.goodsReceiptReference),
        supplierReference: ref(row.supplierReference),
        supplierSummary: text(row.supplierSummary),
        itemSummary: text(row.itemSummary),
        varianceQuantity: decimal(row.varianceQuantity),
        unit: text(row.unit),
        toleranceQuantity: decimal(row.toleranceQuantity),
        withinTolerance: row.withinTolerance as boolean,
        ownerReference: nullableRef(row.ownerReference),
        ownerSummary: nullableText(row.ownerSummary),
        overdue: row.overdue as boolean,
        supplierContactOutcome,
        evidenceCount,
        unitCost,
        history,
      });
    }),
  );
  return Object.freeze({
    screenId: "PROC-DISCREPANCY",
    projectionName: "procurement_discrepancy_v1",
    projectionVersion: 1,
    brandLabel: text(raw.brandLabel),
    stockSiteLabel: text(raw.stockSiteLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    permissions,
    rows,
  });
}
export const unavailableDiscrepancyClient: DiscrepancyProjectionClient = {
  load: async () => {
    throw new DiscrepancyClientError("Unavailable");
  },
};
