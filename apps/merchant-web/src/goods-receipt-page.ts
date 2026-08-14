export type GoodsReceiptClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "ValidationFailed"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class GoodsReceiptClientError extends Error {
  constructor(readonly code: GoodsReceiptClientErrorCode) {
    super("Goods Receipt is unavailable");
    this.name = "GoodsReceiptClientError";
  }
}
export interface GoodsReceiptView {
  readonly screenId: "INV-GOODS-RECEIPT";
  readonly projectionName: "inventory_goods_receipt_v1";
  readonly projectionVersion: 1;
  readonly brandLabel: string;
  readonly stockSiteLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayReceive: boolean;
    readonly mayOverride: boolean;
    readonly mayViewCost: boolean;
    readonly mayViewEvidence: boolean;
    readonly mayViewTemperature: boolean;
  };
  readonly draft: null | {
    readonly goodsReceiptReference: string;
    readonly supplierReference: string;
    readonly supplierSummary: string;
    readonly purchaseOrderReference: string;
    readonly purchaseOrderVersion: number;
    readonly purchaseOrderRevisionNumber: number;
    readonly issuedSnapshotReference: string;
    readonly receivedAt: string;
    readonly lines: readonly {
      readonly receiptLineReference: string;
      readonly purchaseOrderLineReference: string;
      readonly inventoryItemReference: string;
      readonly itemSummary: string;
      readonly barcode: string | null;
      readonly orderedQuantity: string;
      readonly priorAcceptedQuantity: string;
      readonly deliveredQuantity: string;
      readonly acceptedQuantity: string;
      readonly rejectedQuantity: string;
      readonly damagedQuantity: string;
      readonly purchaseUnit: string;
      readonly baseUnit: string;
      readonly conversionMultiplier: string;
      readonly lotCode: string | null;
      readonly expiryDate: string | null;
      readonly locationSummary: string;
      readonly qualityDisposition: "Accepted" | "Quarantined" | "Rejected";
      readonly temperatureReading: string | null;
      readonly temperatureUnit: "C" | "F" | null;
      readonly evidenceCount: number | null;
      readonly overReceiptPolicy: "Block" | "ManagerOverride" | "AllowWithinTolerance";
      readonly toleranceQuantity: string;
      readonly overrideReasonCode: string | null;
      readonly discrepancyRequired: boolean;
      readonly unitCost: string | null;
    }[];
  };
}
export interface GoodsReceiptProjectionClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u;
const fail = (): never => {
  throw new GoodsReceiptClientError("Unavailable");
};
function object(value: unknown, fields: readonly string[]) {
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
}
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
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
const integer = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && (value as number) >= minimum ? (value as number) : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
export function parseGoodsReceiptView(value: unknown): GoodsReceiptView {
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
    "draft",
  ]);
  if (
    raw.screenId !== "INV-GOODS-RECEIPT" ||
    raw.projectionName !== "inventory_goods_receipt_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean"
  )
    fail();
  const permissionRaw = object(raw.permissions, [
    "mayReceive",
    "mayOverride",
    "mayViewCost",
    "mayViewEvidence",
    "mayViewTemperature",
  ]);
  if (Object.values(permissionRaw).some((entry) => typeof entry !== "boolean")) fail();
  const permissions = permissionRaw as unknown as GoodsReceiptView["permissions"];
  let draft: GoodsReceiptView["draft"] = null;
  if (raw.draft !== null) {
    const item = object(raw.draft, [
      "goodsReceiptReference",
      "supplierReference",
      "supplierSummary",
      "purchaseOrderReference",
      "purchaseOrderVersion",
      "purchaseOrderRevisionNumber",
      "issuedSnapshotReference",
      "receivedAt",
      "lines",
    ]);
    const inputLines = item.lines;
    if (!Array.isArray(inputLines)) return fail();
    if (inputLines.length > 500) return fail();
    const lines = Object.freeze(
      inputLines.map((entry: unknown) => {
        const line = object(entry, [
          "receiptLineReference",
          "purchaseOrderLineReference",
          "inventoryItemReference",
          "itemSummary",
          "barcode",
          "orderedQuantity",
          "priorAcceptedQuantity",
          "deliveredQuantity",
          "acceptedQuantity",
          "rejectedQuantity",
          "damagedQuantity",
          "purchaseUnit",
          "baseUnit",
          "conversionMultiplier",
          "lotCode",
          "expiryDate",
          "locationSummary",
          "qualityDisposition",
          "temperatureReading",
          "temperatureUnit",
          "evidenceCount",
          "overReceiptPolicy",
          "toleranceQuantity",
          "overrideReasonCode",
          "discrepancyRequired",
          "unitCost",
        ]);
        const temperatureReading = nullableDecimal(line.temperatureReading);
        const temperatureUnit =
          line.temperatureUnit === null ? null : oneOf(line.temperatureUnit, ["C", "F"]);
        const evidenceCount = line.evidenceCount === null ? null : integer(line.evidenceCount);
        const unitCost = nullableDecimal(line.unitCost);
        if (
          (!permissions.mayViewTemperature &&
            (temperatureReading !== null || temperatureUnit !== null)) ||
          (!permissions.mayViewEvidence && evidenceCount !== null) ||
          (!permissions.mayViewCost && unitCost !== null) ||
          (temperatureReading === null) !== (temperatureUnit === null) ||
          typeof line.discrepancyRequired !== "boolean"
        )
          fail();
        return Object.freeze({
          receiptLineReference: ref(line.receiptLineReference),
          purchaseOrderLineReference: ref(line.purchaseOrderLineReference),
          inventoryItemReference: ref(line.inventoryItemReference),
          itemSummary: text(line.itemSummary),
          barcode: nullableText(line.barcode),
          orderedQuantity: decimal(line.orderedQuantity),
          priorAcceptedQuantity: decimal(line.priorAcceptedQuantity),
          deliveredQuantity: decimal(line.deliveredQuantity),
          acceptedQuantity: decimal(line.acceptedQuantity),
          rejectedQuantity: decimal(line.rejectedQuantity),
          damagedQuantity: decimal(line.damagedQuantity),
          purchaseUnit: text(line.purchaseUnit),
          baseUnit: text(line.baseUnit),
          conversionMultiplier: decimal(line.conversionMultiplier),
          lotCode: nullableText(line.lotCode),
          expiryDate: nullableText(line.expiryDate),
          locationSummary: text(line.locationSummary),
          qualityDisposition: oneOf(line.qualityDisposition, [
            "Accepted",
            "Quarantined",
            "Rejected",
          ]),
          temperatureReading,
          temperatureUnit,
          evidenceCount,
          overReceiptPolicy: oneOf(line.overReceiptPolicy, [
            "Block",
            "ManagerOverride",
            "AllowWithinTolerance",
          ]),
          toleranceQuantity: decimal(line.toleranceQuantity),
          overrideReasonCode: nullableText(line.overrideReasonCode),
          discrepancyRequired: line.discrepancyRequired as boolean,
          unitCost,
        });
      }),
    );
    draft = Object.freeze({
      goodsReceiptReference: ref(item.goodsReceiptReference),
      supplierReference: ref(item.supplierReference),
      supplierSummary: text(item.supplierSummary),
      purchaseOrderReference: ref(item.purchaseOrderReference),
      purchaseOrderVersion: integer(item.purchaseOrderVersion, 1),
      purchaseOrderRevisionNumber: integer(item.purchaseOrderRevisionNumber, 1),
      issuedSnapshotReference: ref(item.issuedSnapshotReference),
      receivedAt: instant(item.receivedAt),
      lines,
    });
  }
  return Object.freeze({
    screenId: "INV-GOODS-RECEIPT",
    projectionName: "inventory_goods_receipt_v1",
    projectionVersion: 1,
    brandLabel: text(raw.brandLabel),
    stockSiteLabel: text(raw.stockSiteLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial as boolean,
    permissions,
    draft,
  });
}
export const unavailableGoodsReceiptClient: GoodsReceiptProjectionClient = {
  load: async () => {
    throw new GoodsReceiptClientError("Unavailable");
  },
};
