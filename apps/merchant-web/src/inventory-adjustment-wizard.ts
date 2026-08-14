export type InventoryAdjustmentClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class InventoryAdjustmentClientError extends Error {
  constructor(readonly code: InventoryAdjustmentClientErrorCode) {
    super("Inventory Adjustment Wizard is unavailable");
    this.name = "InventoryAdjustmentClientError";
  }
}

export interface InventoryAdjustmentView {
  readonly screenId: "INV-ADJUSTMENT-WIZARD";
  readonly projectionName: "inventory_adjustment_wizard_v1";
  readonly projectionVersion: 1;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  };
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly adjustment: {
    readonly adjustmentReference: string | null;
    readonly itemReference: string;
    readonly itemName: string;
    readonly internalCode: string;
    readonly lotReference: string | null;
    readonly expiryDate: string | null;
    readonly locationReference: string;
    readonly locationLabel: string;
    readonly quantityDelta: string | null;
    readonly unitCode: string;
    readonly baseQuantityDelta: string | null;
    readonly baseUnitCode: string;
    readonly conversionMultiplier: string;
    readonly reasonCode: string | null;
    readonly evidenceReferences: readonly string[] | null;
    readonly currentOnHand: string;
    readonly currentReserved: string;
    readonly currentAvailable: string;
    readonly currentInTransit: string;
    readonly projectedOnHand: string | null;
    readonly projectedAvailable: string | null;
    readonly balanceVersion: number;
    readonly negativeStockPolicy: "Block" | "ManagerOverride" | "AllowWithWarning";
    readonly warnings: readonly string[];
    readonly status:
      "Draft" | "Validated" | "Submitted" | "Approved" | "Rejected" | "Cancelled" | "Posted";
    readonly submittedByDisplay: string | null;
    readonly approvedByDisplay: string | null;
    readonly movementReference: string | null;
    readonly aggregateVersion: number | null;
  };
}

export interface InventoryAdjustmentProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const date = /^\d{4}-\d{2}-\d{2}$/u;
const signed = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const positive = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;

function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new InventoryAdjustmentClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryAdjustmentClientError("Unavailable");
  return value;
}

function nullableReference(value: unknown) {
  return value === null ? null : reference(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new InventoryAdjustmentClientError("Unavailable");
  return value;
}

function nullableText(value: unknown) {
  return value === null ? null : text(value);
}

function code(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value))
    throw new InventoryAdjustmentClientError("Unavailable");
  return value;
}

function nullableCode(value: unknown) {
  return value === null ? null : code(value);
}

function quantity(value: unknown, pattern = signed): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new InventoryAdjustmentClientError("Unavailable");
  return value;
}

function nullableQuantity(value: unknown) {
  return value === null ? null : quantity(value);
}

function utc(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryAdjustmentClientError("Unavailable");
  return value;
}

function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !date.test(value) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    throw new InventoryAdjustmentClientError("Unavailable");
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryAdjustmentClientError("Unavailable");
  return value as T;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new InventoryAdjustmentClientError("Unavailable");
  return value as number;
}

function adjustment(value: unknown): InventoryAdjustmentView["adjustment"] {
  const raw = object(value, [
    "adjustmentReference",
    "itemReference",
    "itemName",
    "internalCode",
    "lotReference",
    "expiryDate",
    "locationReference",
    "locationLabel",
    "quantityDelta",
    "unitCode",
    "baseQuantityDelta",
    "baseUnitCode",
    "conversionMultiplier",
    "reasonCode",
    "evidenceReferences",
    "currentOnHand",
    "currentReserved",
    "currentAvailable",
    "currentInTransit",
    "projectedOnHand",
    "projectedAvailable",
    "balanceVersion",
    "negativeStockPolicy",
    "warnings",
    "status",
    "submittedByDisplay",
    "approvedByDisplay",
    "movementReference",
    "aggregateVersion",
  ]);
  const status = oneOf(raw.status, [
    "Draft",
    "Validated",
    "Submitted",
    "Approved",
    "Rejected",
    "Cancelled",
    "Posted",
  ]);
  const quantityDelta = nullableQuantity(raw.quantityDelta);
  const baseQuantityDelta = nullableQuantity(raw.baseQuantityDelta);
  const adjustmentReference = nullableReference(raw.adjustmentReference);
  const conversionMultiplier = quantity(raw.conversionMultiplier, positive);
  if (
    !Array.isArray(raw.warnings) ||
    raw.warnings.length > 20 ||
    raw.warnings.some((entry) => typeof entry !== "string" || !codePattern.test(entry)) ||
    (raw.evidenceReferences !== null &&
      (!Array.isArray(raw.evidenceReferences) ||
        raw.evidenceReferences.length > 20 ||
        raw.evidenceReferences.some((entry) => typeof entry !== "string" || !uuid.test(entry)))) ||
    (status === "Draft" &&
      (adjustmentReference !== null || quantityDelta !== null || baseQuantityDelta !== null)) ||
    (status !== "Draft" &&
      (adjustmentReference === null ||
        quantityDelta === null ||
        baseQuantityDelta === null ||
        raw.aggregateVersion === null)) ||
    (status === "Posted") !== (raw.movementReference !== null) ||
    /^0(?:\.0+)?$/u.test(conversionMultiplier)
  )
    throw new InventoryAdjustmentClientError("Unavailable");
  return Object.freeze({
    adjustmentReference,
    itemReference: reference(raw.itemReference),
    itemName: text(raw.itemName),
    internalCode: code(raw.internalCode),
    lotReference: nullableReference(raw.lotReference),
    expiryDate: nullableDate(raw.expiryDate),
    locationReference: reference(raw.locationReference),
    locationLabel: text(raw.locationLabel),
    quantityDelta,
    unitCode: code(raw.unitCode),
    baseQuantityDelta,
    baseUnitCode: code(raw.baseUnitCode),
    conversionMultiplier,
    reasonCode: nullableCode(raw.reasonCode),
    evidenceReferences:
      raw.evidenceReferences === null
        ? null
        : Object.freeze((raw.evidenceReferences as unknown[]).map(reference)),
    currentOnHand: quantity(raw.currentOnHand),
    currentReserved: quantity(raw.currentReserved, positive),
    currentAvailable: quantity(raw.currentAvailable),
    currentInTransit: quantity(raw.currentInTransit, positive),
    projectedOnHand: nullableQuantity(raw.projectedOnHand),
    projectedAvailable: nullableQuantity(raw.projectedAvailable),
    balanceVersion: positiveInteger(raw.balanceVersion),
    negativeStockPolicy: oneOf(raw.negativeStockPolicy, [
      "Block",
      "ManagerOverride",
      "AllowWithWarning",
    ]),
    warnings: Object.freeze(raw.warnings as string[]),
    status,
    submittedByDisplay: nullableText(raw.submittedByDisplay),
    approvedByDisplay: nullableText(raw.approvedByDisplay),
    movementReference: nullableReference(raw.movementReference),
    aggregateVersion: raw.aggregateVersion === null ? null : positiveInteger(raw.aggregateVersion),
  });
}

export function parseInventoryAdjustmentView(value: unknown): InventoryAdjustmentView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "adjustment",
  ]);
  if (
    raw.screenId !== "INV-ADJUSTMENT-WIZARD" ||
    raw.projectionName !== "inventory_adjustment_wizard_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean"
  )
    throw new InventoryAdjustmentClientError("Unavailable");
  const stockScope = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  return Object.freeze({
    screenId: "INV-ADJUSTMENT-WIZARD",
    projectionName: "inventory_adjustment_wizard_v1",
    projectionVersion: 1,
    stockScope: Object.freeze({
      scopeType: oneOf(stockScope.scopeType, ["Store", "StockSite", "Location"]),
      scopeReference: reference(stockScope.scopeReference),
      scopeLabel: text(stockScope.scopeLabel),
    }),
    asOfUtc: utc(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    adjustment: adjustment(raw.adjustment),
  });
}

export const unavailableInventoryAdjustmentClient: InventoryAdjustmentProjectionClient =
  Object.freeze({
    async load() {
      throw new InventoryAdjustmentClientError("Unavailable");
    },
  });
