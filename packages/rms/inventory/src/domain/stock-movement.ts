import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryDecimal,
  type InventoryInstant,
  type InventoryReference,
} from "./inventory-item.js";

export type StockScopeType = "Store" | "StockSite" | "Location";
export type StockMovementType =
  | "Receive"
  | "Reserve"
  | "Release"
  | "Consume"
  | "Waste"
  | "Transfer"
  | "CountAdjustment"
  | "Correction";
export type SignedInventoryDecimal = string & { readonly __signedInventoryDecimal: unique symbol };

export interface MovementStockScope {
  readonly scopeType: StockScopeType;
  readonly scopeReference: InventoryReference;
}

export interface StockBalanceSnapshot {
  readonly onHand: InventoryDecimal;
  readonly reserved: InventoryDecimal;
  readonly available: SignedInventoryDecimal;
  readonly inTransit: InventoryDecimal;
  readonly unitCode: string;
  readonly ledgerVersion: number;
}

export interface StockMovementFact {
  readonly movementReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly itemReference: InventoryReference;
  readonly movementType: StockMovementType;
  readonly quantityDelta: SignedInventoryDecimal;
  readonly unitCode: string;
  readonly baseQuantityDelta: SignedInventoryDecimal;
  readonly baseUnitCode: string;
  readonly conversionMultiplier: InventoryDecimal;
  readonly sourceScope: MovementStockScope | null;
  readonly destinationScope: MovementStockScope | null;
  readonly lotReference: InventoryReference | null;
  readonly expiryDate: string | null;
  readonly businessSourceType: string;
  readonly businessSourceReference: InventoryReference;
  readonly reasonCode: string;
  readonly performedBy: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly before: StockBalanceSnapshot;
  readonly after: StockBalanceSnapshot;
  readonly auditReference: InventoryReference;
  readonly correctsMovementReference: InventoryReference | null;
}

export class StockMovementError extends Error {
  constructor(
    readonly code:
      | "STOCK_MOVEMENT_INVALID"
      | "STOCK_SCOPE_REQUIRED"
      | "STOCK_MOVEMENT_PERMISSION_DENIED"
      | "STOCK_MOVEMENT_NOT_FOUND"
      | "STOCK_MOVEMENT_NOT_CORRECTABLE"
      | "STOCK_MOVEMENT_ALREADY_CORRECTED"
      | "STOCK_MOVEMENT_IDEMPOTENCY_CONFLICT"
      | "STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Stock Movement operation failed");
    this.name = "StockMovementError";
  }
}

const signedDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function invalid(): never {
  throw new StockMovementError("STOCK_MOVEMENT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof StockMovementError || error instanceof InventoryItemError) throw error;
    return invalid();
  }
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}

function controlled(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function inventoryReference(value: unknown): InventoryReference {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

function inventoryInstant(value: unknown): InventoryInstant {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

function inventoryDecimal(value: unknown): InventoryDecimal {
  try {
    return parseInventoryDecimal(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

export function parseSignedInventoryDecimal(value: unknown): SignedInventoryDecimal {
  if (
    typeof value !== "string" ||
    !signedDecimalPattern.test(value) ||
    value === "0" ||
    value === "-0" ||
    /^-?0\.0+$/u.test(value)
  )
    return invalid();
  return value as SignedInventoryDecimal;
}

export function negateInventoryDecimal(value: SignedInventoryDecimal): SignedInventoryDecimal {
  return (value.startsWith("-") ? value.slice(1) : `-${value}`) as SignedInventoryDecimal;
}

export function parseStockScope(value: unknown): MovementStockScope {
  const raw = exact(value, ["scopeType", "scopeReference"]);
  return Object.freeze({
    scopeType: oneOf(raw.scopeType, ["Store", "StockSite", "Location"]),
    scopeReference: inventoryReference(raw.scopeReference),
  });
}

function nullableScope(value: unknown): MovementStockScope | null {
  return value === null ? null : parseStockScope(value);
}

function snapshot(value: unknown): StockBalanceSnapshot {
  const raw = exact(value, [
    "onHand",
    "reserved",
    "available",
    "inTransit",
    "unitCode",
    "ledgerVersion",
  ]);
  return Object.freeze({
    onHand: inventoryDecimal(raw.onHand),
    reserved: inventoryDecimal(raw.reserved),
    available:
      raw.available === "0"
        ? ("0" as SignedInventoryDecimal)
        : parseSignedInventoryDecimal(raw.available),
    inTransit: inventoryDecimal(raw.inTransit),
    unitCode: controlled(raw.unitCode, unitPattern),
    ledgerVersion: version(raw.ledgerVersion),
  });
}

function nullableReference(value: unknown): InventoryReference | null {
  return value === null ? null : inventoryReference(value);
}

export function parseStockMovementFact(value: unknown): StockMovementFact {
  const raw = exact(value, [
    "movementReference",
    "tenantReference",
    "brandReference",
    "itemReference",
    "movementType",
    "quantityDelta",
    "unitCode",
    "baseQuantityDelta",
    "baseUnitCode",
    "conversionMultiplier",
    "sourceScope",
    "destinationScope",
    "lotReference",
    "expiryDate",
    "businessSourceType",
    "businessSourceReference",
    "reasonCode",
    "performedBy",
    "occurredAt",
    "before",
    "after",
    "auditReference",
    "correctsMovementReference",
  ]);
  const movementType = oneOf(raw.movementType, [
    "Receive",
    "Reserve",
    "Release",
    "Consume",
    "Waste",
    "Transfer",
    "CountAdjustment",
    "Correction",
  ]);
  const sourceScope = nullableScope(raw.sourceScope);
  const destinationScope = nullableScope(raw.destinationScope);
  if (
    (!sourceScope && !destinationScope) ||
    (movementType === "Transfer" && (!sourceScope || !destinationScope)) ||
    (movementType !== "Transfer" && sourceScope && destinationScope)
  )
    return invalid();
  if (
    raw.expiryDate !== null &&
    (typeof raw.expiryDate !== "string" ||
      !datePattern.test(raw.expiryDate) ||
      Number.isNaN(Date.parse(`${raw.expiryDate}T00:00:00.000Z`)) ||
      new Date(Date.parse(`${raw.expiryDate}T00:00:00.000Z`)).toISOString().slice(0, 10) !==
        raw.expiryDate)
  )
    return invalid();
  const correctsMovementReference = nullableReference(raw.correctsMovementReference);
  if ((movementType === "Correction") !== (correctsMovementReference !== null)) return invalid();
  const before = snapshot(raw.before);
  const after = snapshot(raw.after);
  const quantityDelta = parseSignedInventoryDecimal(raw.quantityDelta);
  const baseQuantityDelta = parseSignedInventoryDecimal(raw.baseQuantityDelta);
  const conversionMultiplier = inventoryDecimal(raw.conversionMultiplier);
  if (
    before.unitCode !== after.unitCode ||
    after.ledgerVersion <= before.ledgerVersion ||
    conversionMultiplier === "0" ||
    /^0\.0+$/u.test(conversionMultiplier) ||
    quantityDelta.startsWith("-") !== baseQuantityDelta.startsWith("-")
  )
    return invalid();
  return Object.freeze({
    movementReference: inventoryReference(raw.movementReference),
    tenantReference: inventoryReference(raw.tenantReference),
    brandReference: inventoryReference(raw.brandReference),
    itemReference: inventoryReference(raw.itemReference),
    movementType,
    quantityDelta,
    unitCode: controlled(raw.unitCode, unitPattern),
    baseQuantityDelta,
    baseUnitCode: controlled(raw.baseUnitCode, unitPattern),
    conversionMultiplier,
    sourceScope,
    destinationScope,
    lotReference: nullableReference(raw.lotReference),
    expiryDate: raw.expiryDate as string | null,
    businessSourceType: controlled(raw.businessSourceType, codePattern),
    businessSourceReference: inventoryReference(raw.businessSourceReference),
    reasonCode: controlled(raw.reasonCode, codePattern),
    performedBy: inventoryReference(raw.performedBy),
    occurredAt: inventoryInstant(raw.occurredAt),
    before,
    after,
    auditReference: inventoryReference(raw.auditReference),
    correctsMovementReference,
  });
}
