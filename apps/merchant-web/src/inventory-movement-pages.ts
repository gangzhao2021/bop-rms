export type InventoryMovementClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class InventoryMovementClientError extends Error {
  constructor(readonly code: InventoryMovementClientErrorCode) {
    super("Inventory Movement view is unavailable");
    this.name = "InventoryMovementClientError";
  }
}

export type InventoryMovementScreenId =
  "INV-MOVEMENT-LIST" | "INV-MOVEMENT-DETAIL" | "INV-ITEM-STOCK-HISTORY";

export interface InventoryMovementRow {
  readonly movementReference: string;
  readonly movementType:
    | "Receive"
    | "Reserve"
    | "Release"
    | "Consume"
    | "Waste"
    | "Transfer"
    | "Adjustment"
    | "CountAdjustment"
    | "Correction";
  readonly itemReference: string;
  readonly itemName: string;
  readonly internalCode: string;
  readonly quantityDelta: string;
  readonly unitCode: string;
  readonly baseQuantityDelta: string;
  readonly baseUnitCode: string;
  readonly conversionMultiplier: string;
  readonly sourceScopeLabel: string | null;
  readonly destinationScopeLabel: string | null;
  readonly lotReference: string | null;
  readonly expiryDate: string | null;
  readonly businessSourceType: string;
  readonly businessSourceReference: string;
  readonly reasonCode: string;
  readonly performedByDisplay: string;
  readonly occurredAt: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly ledgerVersion: number;
  readonly auditReference: string;
  readonly correctsMovementReference: string | null;
  readonly correctedByMovementReference: string | null;
  readonly correctable: boolean;
}

export interface InventoryMovementView {
  readonly screenId: InventoryMovementScreenId;
  readonly projectionName: "inventory_movement_explorer_v1";
  readonly projectionVersion: 1;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  };
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly selectedMovementReference: string | null;
  readonly selectedItemReference: string | null;
  readonly movements: readonly InventoryMovementRow[];
}

export interface InventoryMovementProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const date = /^\d{4}-\d{2}-\d{2}$/u;
const signedDecimal = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const controlled = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const safeText = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;

function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new InventoryMovementClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryMovementClientError("Unavailable");
  return value;
}

function nullableReference(value: unknown): string | null {
  return value === null ? null : reference(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safeText.test(value))
    throw new InventoryMovementClientError("Unavailable");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function code(value: unknown): string {
  if (typeof value !== "string" || !controlled.test(value))
    throw new InventoryMovementClientError("Unavailable");
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== "string" || !signedDecimal.test(value))
    throw new InventoryMovementClientError("Unavailable");
  return value;
}

function utc(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryMovementClientError("Unavailable");
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryMovementClientError("Unavailable");
  return value as T;
}

function movement(value: unknown): InventoryMovementRow {
  const raw = object(value, [
    "movementReference",
    "movementType",
    "itemReference",
    "itemName",
    "internalCode",
    "quantityDelta",
    "unitCode",
    "baseQuantityDelta",
    "baseUnitCode",
    "conversionMultiplier",
    "sourceScopeLabel",
    "destinationScopeLabel",
    "lotReference",
    "expiryDate",
    "businessSourceType",
    "businessSourceReference",
    "reasonCode",
    "performedByDisplay",
    "occurredAt",
    "balanceBefore",
    "balanceAfter",
    "ledgerVersion",
    "auditReference",
    "correctsMovementReference",
    "correctedByMovementReference",
    "correctable",
  ]);
  if (
    (raw.expiryDate !== null &&
      (typeof raw.expiryDate !== "string" ||
        !date.test(raw.expiryDate) ||
        !Number.isFinite(Date.parse(`${raw.expiryDate}T00:00:00.000Z`)) ||
        new Date(Date.parse(`${raw.expiryDate}T00:00:00.000Z`)).toISOString().slice(0, 10) !==
          raw.expiryDate)) ||
    !Number.isSafeInteger(raw.ledgerVersion) ||
    (raw.ledgerVersion as number) < 1 ||
    typeof raw.correctable !== "boolean" ||
    (raw.sourceScopeLabel === null && raw.destinationScopeLabel === null)
  )
    throw new InventoryMovementClientError("Unavailable");
  const movementType = oneOf(raw.movementType, [
    "Receive",
    "Reserve",
    "Release",
    "Consume",
    "Waste",
    "Transfer",
    "Adjustment",
    "CountAdjustment",
    "Correction",
  ]);
  const correctsMovementReference = nullableReference(raw.correctsMovementReference);
  const sourceScopeLabel = nullableText(raw.sourceScopeLabel);
  const destinationScopeLabel = nullableText(raw.destinationScopeLabel);
  const quantityDelta = decimal(raw.quantityDelta);
  const baseQuantityDelta = decimal(raw.baseQuantityDelta);
  const conversionMultiplier = decimal(raw.conversionMultiplier);
  if (
    (movementType === "Correction") !== (correctsMovementReference !== null) ||
    (movementType === "Transfer") !==
      (sourceScopeLabel !== null && destinationScopeLabel !== null) ||
    (movementType !== "Transfer" && sourceScopeLabel !== null && destinationScopeLabel !== null) ||
    quantityDelta.startsWith("-") !== baseQuantityDelta.startsWith("-") ||
    conversionMultiplier.startsWith("-") ||
    /^0(?:\.0+)?$/u.test(conversionMultiplier) ||
    (raw.correctable === true &&
      !["Receive", "Consume", "Waste", "Adjustment", "CountAdjustment"].includes(movementType))
  )
    throw new InventoryMovementClientError("Unavailable");
  return Object.freeze({
    movementReference: reference(raw.movementReference),
    movementType,
    itemReference: reference(raw.itemReference),
    itemName: text(raw.itemName),
    internalCode: code(raw.internalCode),
    quantityDelta,
    unitCode: code(raw.unitCode),
    baseQuantityDelta,
    baseUnitCode: code(raw.baseUnitCode),
    conversionMultiplier,
    sourceScopeLabel,
    destinationScopeLabel,
    lotReference: nullableReference(raw.lotReference),
    expiryDate: raw.expiryDate as string | null,
    businessSourceType: code(raw.businessSourceType),
    businessSourceReference: reference(raw.businessSourceReference),
    reasonCode: code(raw.reasonCode),
    performedByDisplay: text(raw.performedByDisplay),
    occurredAt: utc(raw.occurredAt),
    balanceBefore: decimal(raw.balanceBefore),
    balanceAfter: decimal(raw.balanceAfter),
    ledgerVersion: raw.ledgerVersion as number,
    auditReference: reference(raw.auditReference),
    correctsMovementReference,
    correctedByMovementReference: nullableReference(raw.correctedByMovementReference),
    correctable: raw.correctable,
  });
}

export function parseInventoryMovementView(value: unknown): InventoryMovementView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "selectedMovementReference",
    "selectedItemReference",
    "movements",
  ]);
  if (
    raw.projectionName !== "inventory_movement_explorer_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.movements) ||
    raw.movements.length > 200
  )
    throw new InventoryMovementClientError("Unavailable");
  const screenId = oneOf(raw.screenId, [
    "INV-MOVEMENT-LIST",
    "INV-MOVEMENT-DETAIL",
    "INV-ITEM-STOCK-HISTORY",
  ]);
  const stockScopeRaw = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  const stockScope = Object.freeze({
    scopeType: oneOf(stockScopeRaw.scopeType, ["Store", "StockSite", "Location"]),
    scopeReference: reference(stockScopeRaw.scopeReference),
    scopeLabel: text(stockScopeRaw.scopeLabel),
  });
  const movements = Object.freeze(raw.movements.map(movement));
  const selectedMovementReference = nullableReference(raw.selectedMovementReference);
  const selectedItemReference = nullableReference(raw.selectedItemReference);
  if (
    (screenId === "INV-MOVEMENT-DETAIL" &&
      (!selectedMovementReference ||
        !movements.some((row) => row.movementReference === selectedMovementReference))) ||
    (screenId === "INV-ITEM-STOCK-HISTORY" &&
      (!selectedItemReference ||
        movements.some((row) => row.itemReference !== selectedItemReference)))
  )
    throw new InventoryMovementClientError("Unavailable");
  return Object.freeze({
    screenId,
    projectionName: "inventory_movement_explorer_v1",
    projectionVersion: 1,
    stockScope,
    asOfUtc: utc(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    selectedMovementReference,
    selectedItemReference,
    movements,
  });
}

export const unavailableInventoryMovementClient: InventoryMovementProjectionClient = Object.freeze({
  async load() {
    throw new InventoryMovementClientError("Unavailable");
  },
});
