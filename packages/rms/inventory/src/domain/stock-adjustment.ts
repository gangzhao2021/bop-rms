import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryDecimal,
  type InventoryInstant,
  type InventoryReference,
  type NegativeStockPolicy,
} from "./inventory-item.js";
import {
  parseSignedInventoryDecimal,
  type MovementStockScope,
  type SignedInventoryDecimal,
  StockMovementError,
} from "./stock-movement.js";

export type StockAdjustmentStatus =
  "Validated" | "Submitted" | "Approved" | "Rejected" | "Cancelled" | "Posted";

export interface StockAdjustmentDecision {
  readonly decision: "Submitted" | "Approved" | "Rejected" | "Cancelled";
  readonly actorReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly reasonCode: string;
}

export interface StockAdjustmentAggregate {
  readonly adjustmentReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: MovementStockScope;
  readonly itemReference: InventoryReference;
  readonly lotReference: InventoryReference | null;
  readonly expiryDate: string | null;
  readonly locationReference: InventoryReference;
  readonly quantityDelta: SignedInventoryDecimal;
  readonly unitCode: string;
  readonly baseQuantityDelta: SignedInventoryDecimal;
  readonly baseUnitCode: string;
  readonly conversionMultiplier: InventoryDecimal;
  readonly reasonCode: string;
  readonly evidenceReferences: readonly InventoryReference[];
  readonly currentOnHand: SignedInventoryDecimal | "0";
  readonly currentReserved: InventoryDecimal;
  readonly currentAvailable: SignedInventoryDecimal | "0";
  readonly currentInTransit: InventoryDecimal;
  readonly projectedOnHand: SignedInventoryDecimal | "0";
  readonly projectedAvailable: SignedInventoryDecimal | "0";
  readonly balanceVersion: number;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly warnings: readonly string[];
  readonly status: StockAdjustmentStatus;
  readonly submittedBy: InventoryReference | null;
  readonly approvedBy: InventoryReference | null;
  readonly movementReference: InventoryReference | null;
  readonly decisions: readonly StockAdjustmentDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly createdBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
  readonly updatedBy: InventoryReference;
}

export class StockAdjustmentError extends Error {
  constructor(
    readonly code:
      | "STOCK_ADJUSTMENT_INVALID"
      | "STOCK_ADJUSTMENT_PERMISSION_DENIED"
      | "STOCK_ADJUSTMENT_NOT_FOUND"
      | "STOCK_ADJUSTMENT_CONFLICT"
      | "STOCK_ADJUSTMENT_STATE_CONFLICT"
      | "STOCK_ADJUSTMENT_SEGREGATION_REQUIRED"
      | "STOCK_ADJUSTMENT_BLOCKED"
      | "STOCK_ADJUSTMENT_IDEMPOTENCY_CONFLICT"
      | "STOCK_ADJUSTMENT_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Stock Adjustment operation failed");
    this.name = "StockAdjustmentError";
  }
}

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const scale = 1_000_000n;

function invalid(): never {
  throw new StockAdjustmentError("STOCK_ADJUSTMENT_INVALID");
}

function reference(value: unknown): InventoryReference {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

function instant(value: unknown): InventoryInstant {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

function decimal(value: unknown): InventoryDecimal {
  try {
    return parseInventoryDecimal(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

function signed(value: unknown): SignedInventoryDecimal {
  try {
    return parseSignedInventoryDecimal(value);
  } catch (error) {
    if (error instanceof StockMovementError) return invalid();
    throw error;
  }
}

function controlled(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
}

function fixed(value: string): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const result = BigInt(`${whole}${fraction.padEnd(6, "0")}`);
  return negative ? -result : result;
}

function format(value: bigint): SignedInventoryDecimal | "0" {
  if (value === 0n) return "0";
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(7, "0");
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}` as SignedInventoryDecimal;
}

export function calculateAdjustmentBaseDelta(
  quantityDelta: SignedInventoryDecimal,
  conversionMultiplier: InventoryDecimal,
): SignedInventoryDecimal {
  const product = fixed(quantityDelta) * fixed(conversionMultiplier);
  if (product % scale !== 0n) return invalid();
  const result = format(product / scale);
  if (result === "0") return invalid();
  return result;
}

function decision(
  kind: StockAdjustmentDecision["decision"],
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  reasonCode: string,
): StockAdjustmentDecision {
  return Object.freeze({
    decision: kind,
    actorReference,
    occurredAt,
    reasonCode: controlled(reasonCode, codePattern),
  });
}

function checkVersion(adjustment: StockAdjustmentAggregate, expectedVersion: number): void {
  if (adjustment.aggregateVersion !== expectedVersion)
    throw new StockAdjustmentError("STOCK_ADJUSTMENT_CONFLICT");
}

function update(
  adjustment: StockAdjustmentAggregate,
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  change: Partial<StockAdjustmentAggregate>,
): StockAdjustmentAggregate {
  return Object.freeze({
    ...adjustment,
    ...change,
    aggregateVersion: adjustment.aggregateVersion + 1,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function createValidatedStockAdjustment(input: {
  readonly adjustmentReference: unknown;
  readonly tenantReference: unknown;
  readonly brandReference: unknown;
  readonly stockScope: MovementStockScope;
  readonly itemReference: unknown;
  readonly lotReference: unknown;
  readonly expiryDate: unknown;
  readonly locationReference: unknown;
  readonly quantityDelta: unknown;
  readonly unitCode: unknown;
  readonly baseUnitCode: unknown;
  readonly conversionMultiplier: unknown;
  readonly reasonCode: unknown;
  readonly evidenceReferences: readonly unknown[];
  readonly currentOnHand: unknown;
  readonly currentReserved: unknown;
  readonly currentAvailable: unknown;
  readonly currentInTransit: unknown;
  readonly balanceVersion: number;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly negativeOverrideAuthorized: boolean;
  readonly actorReference: unknown;
  readonly occurredAt: unknown;
}): StockAdjustmentAggregate {
  const adjustmentReference = reference(input.adjustmentReference);
  const tenantReference = reference(input.tenantReference);
  const brandReference = reference(input.brandReference);
  const itemReference = reference(input.itemReference);
  const lotReference = input.lotReference === null ? null : reference(input.lotReference);
  if (
    input.expiryDate !== null &&
    (typeof input.expiryDate !== "string" ||
      !datePattern.test(input.expiryDate) ||
      Number.isNaN(Date.parse(`${input.expiryDate}T00:00:00.000Z`)) ||
      new Date(Date.parse(`${input.expiryDate}T00:00:00.000Z`)).toISOString().slice(0, 10) !==
        input.expiryDate)
  )
    return invalid();
  const locationReference = reference(input.locationReference);
  const actorReference = reference(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const quantityDelta = signed(input.quantityDelta);
  const currentOnHand = input.currentOnHand === "0" ? ("0" as const) : signed(input.currentOnHand);
  const currentReserved = decimal(input.currentReserved);
  const currentAvailable =
    input.currentAvailable === "0" ? ("0" as const) : signed(input.currentAvailable);
  const currentInTransit = decimal(input.currentInTransit);
  const conversionMultiplier = decimal(input.conversionMultiplier);
  const unitCode = controlled(input.unitCode, unitPattern);
  const baseUnitCode = controlled(input.baseUnitCode, unitPattern);
  const reasonCode = controlled(input.reasonCode, codePattern);
  if (
    conversionMultiplier === "0" ||
    /^0\.0+$/u.test(conversionMultiplier) ||
    !Number.isSafeInteger(input.balanceVersion) ||
    input.balanceVersion < 1 ||
    input.evidenceReferences.length < 1 ||
    input.evidenceReferences.length > 20 ||
    (input.stockScope.scopeType === "Location" &&
      input.stockScope.scopeReference !== locationReference)
  )
    return invalid();
  const evidenceReferences = Object.freeze(input.evidenceReferences.map(reference));
  if (new Set(evidenceReferences).size !== evidenceReferences.length) return invalid();
  const baseQuantityDelta = calculateAdjustmentBaseDelta(quantityDelta, conversionMultiplier);
  const projectedOnHand = format(fixed(currentOnHand) + fixed(baseQuantityDelta));
  const projectedAvailable = format(fixed(currentAvailable) + fixed(baseQuantityDelta));
  if (fixed(currentOnHand) - fixed(currentReserved) !== fixed(currentAvailable)) return invalid();
  if (fixed(projectedOnHand) < 0n) {
    if (input.negativeStockPolicy === "Block")
      throw new StockAdjustmentError("STOCK_ADJUSTMENT_BLOCKED");
    if (input.negativeStockPolicy === "ManagerOverride" && !input.negativeOverrideAuthorized)
      throw new StockAdjustmentError("STOCK_ADJUSTMENT_PERMISSION_DENIED");
  }
  const warnings = Object.freeze(fixed(projectedOnHand) < 0n ? ["NEGATIVE_STOCK"] : []);
  return Object.freeze({
    adjustmentReference,
    tenantReference,
    brandReference,
    stockScope: input.stockScope,
    itemReference,
    lotReference,
    expiryDate: input.expiryDate as string | null,
    locationReference,
    quantityDelta,
    unitCode,
    baseQuantityDelta,
    baseUnitCode,
    conversionMultiplier,
    reasonCode,
    evidenceReferences,
    currentOnHand,
    currentReserved,
    currentAvailable,
    currentInTransit,
    projectedOnHand,
    projectedAvailable,
    balanceVersion: input.balanceVersion,
    negativeStockPolicy: input.negativeStockPolicy,
    warnings,
    status: "Validated",
    submittedBy: null,
    approvedBy: null,
    movementReference: null,
    decisions: Object.freeze([]),
    aggregateVersion: 1,
    createdAt: occurredAt,
    createdBy: actorReference,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function submitStockAdjustment(
  adjustment: StockAdjustmentAggregate,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockAdjustmentAggregate {
  checkVersion(adjustment, expectedVersion);
  if (adjustment.status !== "Validated")
    throw new StockAdjustmentError("STOCK_ADJUSTMENT_STATE_CONFLICT");
  const actorReference = reference(actorReferenceValue);
  const occurredAt = instant(occurredAtValue);
  return update(adjustment, actorReference, occurredAt, {
    status: "Submitted",
    submittedBy: actorReference,
    decisions: Object.freeze([
      ...adjustment.decisions,
      decision("Submitted", actorReference, occurredAt, "ADJUSTMENT_SUBMITTED"),
    ]),
  });
}

export function decideStockAdjustment(
  adjustment: StockAdjustmentAggregate,
  input: {
    readonly decision: "Approve" | "Reject";
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly reasonCode: string;
  },
): StockAdjustmentAggregate {
  checkVersion(adjustment, input.expectedVersion);
  if (adjustment.status !== "Submitted")
    throw new StockAdjustmentError("STOCK_ADJUSTMENT_STATE_CONFLICT");
  const actorReference = reference(input.actorReference);
  if (adjustment.submittedBy === actorReference)
    throw new StockAdjustmentError("STOCK_ADJUSTMENT_SEGREGATION_REQUIRED");
  const occurredAt = instant(input.occurredAt);
  const approved = input.decision === "Approve";
  return update(adjustment, actorReference, occurredAt, {
    status: approved ? "Approved" : "Rejected",
    approvedBy: approved ? actorReference : null,
    decisions: Object.freeze([
      ...adjustment.decisions,
      decision(approved ? "Approved" : "Rejected", actorReference, occurredAt, input.reasonCode),
    ]),
  });
}

export function cancelStockAdjustment(
  adjustment: StockAdjustmentAggregate,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
  reasonCode: string,
): StockAdjustmentAggregate {
  checkVersion(adjustment, expectedVersion);
  if (adjustment.status !== "Validated" && adjustment.status !== "Submitted")
    throw new StockAdjustmentError("STOCK_ADJUSTMENT_STATE_CONFLICT");
  const actorReference = reference(actorReferenceValue);
  const occurredAt = instant(occurredAtValue);
  return update(adjustment, actorReference, occurredAt, {
    status: "Cancelled",
    decisions: Object.freeze([
      ...adjustment.decisions,
      decision("Cancelled", actorReference, occurredAt, reasonCode),
    ]),
  });
}

export function markStockAdjustmentPosted(
  adjustment: StockAdjustmentAggregate,
  movementReferenceValue: unknown,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockAdjustmentAggregate {
  checkVersion(adjustment, expectedVersion);
  if (adjustment.status !== "Approved")
    throw new StockAdjustmentError("STOCK_ADJUSTMENT_STATE_CONFLICT");
  return update(adjustment, reference(actorReferenceValue), instant(occurredAtValue), {
    status: "Posted",
    movementReference: reference(movementReferenceValue),
  });
}
