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

export type StockWasteStatus =
  "Validated" | "Submitted" | "Approved" | "Rejected" | "Cancelled" | "Posted";
export type WasteSourceType = "Inventory" | "Kitchen" | "FoodSafetyIncident";
export type WasteApprovalRequirement = "Required" | "NotRequired";
export interface WasteCostSummary {
  readonly minorUnits: string;
  readonly currencyCode: string;
  readonly valuationReference: InventoryReference;
}

export interface StockWasteDecision {
  readonly decision: "Submitted" | "Approved" | "Rejected" | "Cancelled";
  readonly actorReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly reasonCode: string;
}

export interface StockWasteAggregate {
  readonly wasteReference: InventoryReference;
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
  readonly sourceType: WasteSourceType;
  readonly sourceReference: InventoryReference | null;
  readonly evidenceReferences: readonly InventoryReference[];
  readonly approvalRequirement: WasteApprovalRequirement;
  readonly approvalPolicyReference: InventoryReference;
  readonly costSummary: WasteCostSummary | null;
  readonly currentOnHand: SignedInventoryDecimal | "0";
  readonly currentReserved: InventoryDecimal;
  readonly currentAvailable: SignedInventoryDecimal | "0";
  readonly currentInTransit: InventoryDecimal;
  readonly projectedOnHand: SignedInventoryDecimal | "0";
  readonly projectedAvailable: SignedInventoryDecimal | "0";
  readonly balanceVersion: number;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly warnings: readonly string[];
  readonly status: StockWasteStatus;
  readonly submittedBy: InventoryReference | null;
  readonly approvedBy: InventoryReference | null;
  readonly movementReference: InventoryReference | null;
  readonly decisions: readonly StockWasteDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly createdBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
  readonly updatedBy: InventoryReference;
}

export class StockWasteError extends Error {
  constructor(
    readonly code:
      | "STOCK_WASTE_INVALID"
      | "STOCK_WASTE_PERMISSION_DENIED"
      | "STOCK_WASTE_NOT_FOUND"
      | "STOCK_WASTE_CONFLICT"
      | "STOCK_WASTE_STATE_CONFLICT"
      | "STOCK_WASTE_SEGREGATION_REQUIRED"
      | "STOCK_WASTE_BLOCKED"
      | "STOCK_WASTE_IDEMPOTENCY_CONFLICT"
      | "STOCK_WASTE_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Stock Waste operation failed");
    this.name = "StockWasteError";
  }
}

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const scale = 1_000_000n;

function invalid(): never {
  throw new StockWasteError("STOCK_WASTE_INVALID");
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

export function calculateWasteBaseDelta(
  quantity: InventoryDecimal,
  conversionMultiplier: InventoryDecimal,
): SignedInventoryDecimal {
  const product = fixed(quantity) * fixed(conversionMultiplier);
  if (product % scale !== 0n) return invalid();
  const result = format(-(product / scale));
  if (result === "0") return invalid();
  return result;
}

function decision(
  kind: StockWasteDecision["decision"],
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  reasonCode: string,
): StockWasteDecision {
  return Object.freeze({
    decision: kind,
    actorReference,
    occurredAt,
    reasonCode: controlled(reasonCode, codePattern),
  });
}

function checkVersion(waste: StockWasteAggregate, expectedVersion: number): void {
  if (waste.aggregateVersion !== expectedVersion) throw new StockWasteError("STOCK_WASTE_CONFLICT");
}

function update(
  waste: StockWasteAggregate,
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  change: Partial<StockWasteAggregate>,
): StockWasteAggregate {
  return Object.freeze({
    ...waste,
    ...change,
    aggregateVersion: waste.aggregateVersion + 1,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function createValidatedStockWaste(input: {
  readonly wasteReference: unknown;
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
  readonly sourceType: WasteSourceType;
  readonly sourceReference: unknown;
  readonly evidenceReferences: readonly unknown[];
  readonly approvalRequirement: WasteApprovalRequirement;
  readonly approvalPolicyReference: unknown;
  readonly costSummary: WasteCostSummary | null;
  readonly currentOnHand: unknown;
  readonly currentReserved: unknown;
  readonly currentAvailable: unknown;
  readonly currentInTransit: unknown;
  readonly balanceVersion: number;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly negativeOverrideAuthorized: boolean;
  readonly actorReference: unknown;
  readonly occurredAt: unknown;
}): StockWasteAggregate {
  const wasteReference = reference(input.wasteReference);
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
  const quantity = decimal(input.quantityDelta);
  if (quantity === "0" || /^0\.0+$/u.test(quantity)) return invalid();
  const quantityDelta = `-${quantity}` as SignedInventoryDecimal;
  const currentOnHand = input.currentOnHand === "0" ? ("0" as const) : signed(input.currentOnHand);
  const currentReserved = decimal(input.currentReserved);
  const currentAvailable =
    input.currentAvailable === "0" ? ("0" as const) : signed(input.currentAvailable);
  const currentInTransit = decimal(input.currentInTransit);
  const conversionMultiplier = decimal(input.conversionMultiplier);
  const unitCode = controlled(input.unitCode, unitPattern);
  const baseUnitCode = controlled(input.baseUnitCode, unitPattern);
  const reasonCode = controlled(input.reasonCode, codePattern);
  const sourceReference = input.sourceReference === null ? null : reference(input.sourceReference);
  if (
    !["Inventory", "Kitchen", "FoodSafetyIncident"].includes(input.sourceType) ||
    (input.sourceType === "Inventory") !== (sourceReference === null) ||
    !["Required", "NotRequired"].includes(input.approvalRequirement)
  )
    return invalid();
  const approvalPolicyReference = reference(input.approvalPolicyReference);
  const costSummary =
    input.costSummary === null
      ? null
      : Object.freeze({
          minorUnits: controlled(input.costSummary.minorUnits, /^(?:0|[1-9][0-9]{0,18})$/u),
          currencyCode: controlled(input.costSummary.currencyCode, /^[A-Z]{3}$/u),
          valuationReference: reference(input.costSummary.valuationReference),
        });
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
  const baseQuantityDelta = calculateWasteBaseDelta(quantity, conversionMultiplier);
  const projectedOnHand = format(fixed(currentOnHand) + fixed(baseQuantityDelta));
  const projectedAvailable = format(fixed(currentAvailable) + fixed(baseQuantityDelta));
  if (fixed(currentOnHand) - fixed(currentReserved) !== fixed(currentAvailable)) return invalid();
  if (fixed(projectedOnHand) < 0n) {
    if (input.negativeStockPolicy === "Block") throw new StockWasteError("STOCK_WASTE_BLOCKED");
    if (input.negativeStockPolicy === "ManagerOverride" && !input.negativeOverrideAuthorized)
      throw new StockWasteError("STOCK_WASTE_PERMISSION_DENIED");
  }
  const warnings = Object.freeze(fixed(projectedOnHand) < 0n ? ["NEGATIVE_STOCK"] : []);
  return Object.freeze({
    wasteReference,
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
    sourceType: input.sourceType,
    sourceReference,
    evidenceReferences,
    approvalRequirement: input.approvalRequirement,
    approvalPolicyReference,
    costSummary,
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

export function submitStockWaste(
  waste: StockWasteAggregate,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockWasteAggregate {
  checkVersion(waste, expectedVersion);
  if (waste.status !== "Validated") throw new StockWasteError("STOCK_WASTE_STATE_CONFLICT");
  const actorReference = reference(actorReferenceValue);
  const occurredAt = instant(occurredAtValue);
  const status = waste.approvalRequirement === "Required" ? "Submitted" : "Approved";
  return update(waste, actorReference, occurredAt, {
    status,
    submittedBy: actorReference,
    approvedBy: status === "Approved" ? actorReference : null,
    decisions: Object.freeze([
      ...waste.decisions,
      decision("Submitted", actorReference, occurredAt, "WASTE_SUBMITTED"),
      ...(status === "Approved"
        ? [decision("Approved", actorReference, occurredAt, "POLICY_APPROVAL_NOT_REQUIRED")]
        : []),
    ]),
  });
}

export function decideStockWaste(
  waste: StockWasteAggregate,
  input: {
    readonly decision: "Approve" | "Reject";
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly reasonCode: string;
  },
): StockWasteAggregate {
  checkVersion(waste, input.expectedVersion);
  if (waste.status !== "Submitted") throw new StockWasteError("STOCK_WASTE_STATE_CONFLICT");
  if (waste.approvalRequirement !== "Required")
    throw new StockWasteError("STOCK_WASTE_STATE_CONFLICT");
  const actorReference = reference(input.actorReference);
  if (waste.submittedBy === actorReference)
    throw new StockWasteError("STOCK_WASTE_SEGREGATION_REQUIRED");
  const occurredAt = instant(input.occurredAt);
  const approved = input.decision === "Approve";
  return update(waste, actorReference, occurredAt, {
    status: approved ? "Approved" : "Rejected",
    approvedBy: approved ? actorReference : null,
    decisions: Object.freeze([
      ...waste.decisions,
      decision(approved ? "Approved" : "Rejected", actorReference, occurredAt, input.reasonCode),
    ]),
  });
}

export function cancelStockWaste(
  waste: StockWasteAggregate,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
  reasonCode: string,
): StockWasteAggregate {
  checkVersion(waste, expectedVersion);
  if (waste.status !== "Validated" && waste.status !== "Submitted")
    throw new StockWasteError("STOCK_WASTE_STATE_CONFLICT");
  const actorReference = reference(actorReferenceValue);
  const occurredAt = instant(occurredAtValue);
  return update(waste, actorReference, occurredAt, {
    status: "Cancelled",
    decisions: Object.freeze([
      ...waste.decisions,
      decision("Cancelled", actorReference, occurredAt, reasonCode),
    ]),
  });
}

export function markStockWastePosted(
  waste: StockWasteAggregate,
  movementReferenceValue: unknown,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockWasteAggregate {
  checkVersion(waste, expectedVersion);
  if (waste.status !== "Approved") throw new StockWasteError("STOCK_WASTE_STATE_CONFLICT");
  return update(waste, reference(actorReferenceValue), instant(occurredAtValue), {
    status: "Posted",
    movementReference: reference(movementReferenceValue),
  });
}
