import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryDecimal,
  type InventoryInstant,
  type InventoryReference,
} from "./inventory-item.js";
import type { MovementStockScope } from "./stock-movement.js";

export type LotHoldStatus = "Available" | "Quarantined";
export type LotHoldDecisionKind = "Quarantined" | "Released";

export interface LotHoldDecision {
  readonly decision: LotHoldDecisionKind;
  readonly reasonCode: string;
  readonly complianceDecisionReference: InventoryReference;
  readonly onHand: InventoryDecimal;
  readonly reserved: InventoryDecimal;
  readonly balanceVersion: number;
  readonly actorReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
}

export interface LotHoldAggregate {
  readonly holdReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: MovementStockScope;
  readonly locationReference: InventoryReference;
  readonly itemReference: InventoryReference;
  readonly lotReference: InventoryReference;
  readonly expiryDate: string | null;
  readonly onHand: InventoryDecimal;
  readonly reserved: InventoryDecimal;
  readonly balanceVersion: number;
  readonly status: LotHoldStatus;
  readonly decisions: readonly LotHoldDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly createdBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
  readonly updatedBy: InventoryReference;
}

export class LotHoldError extends Error {
  constructor(
    readonly code:
      | "LOT_HOLD_INVALID"
      | "LOT_HOLD_PERMISSION_DENIED"
      | "LOT_HOLD_NOT_FOUND"
      | "LOT_HOLD_CONFLICT"
      | "LOT_HOLD_STATE_CONFLICT"
      | "LOT_HOLD_IDEMPOTENCY_CONFLICT"
      | "LOT_HOLD_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Lot hold operation failed");
    this.name = "LotHoldError";
  }
}

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function invalid(): never {
  throw new LotHoldError("LOT_HOLD_INVALID");
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

function date(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    return invalid();
  return value;
}

function code(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value)) return invalid();
  return value;
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
  return value as number;
}

function scope(value: MovementStockScope): MovementStockScope {
  if (!value || !["Store", "StockSite", "Location"].includes(value.scopeType)) return invalid();
  return Object.freeze({
    scopeType: value.scopeType,
    scopeReference: reference(value.scopeReference),
  });
}

function decide(
  decision: LotHoldDecisionKind,
  reasonCode: unknown,
  complianceDecisionReference: unknown,
  onHand: unknown,
  reserved: unknown,
  balanceVersion: unknown,
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
): LotHoldDecision {
  return Object.freeze({
    decision,
    reasonCode: code(reasonCode),
    complianceDecisionReference: reference(complianceDecisionReference),
    onHand: decimal(onHand),
    reserved: decimal(reserved),
    balanceVersion: version(balanceVersion),
    actorReference,
    occurredAt,
  });
}

function update(
  aggregate: LotHoldAggregate,
  status: LotHoldStatus,
  decision: LotHoldDecision,
): LotHoldAggregate {
  return Object.freeze({
    ...aggregate,
    status,
    onHand: decision.onHand,
    reserved: decision.reserved,
    balanceVersion: decision.balanceVersion,
    decisions: Object.freeze([...aggregate.decisions, decision]),
    aggregateVersion: aggregate.aggregateVersion + 1,
    updatedAt: decision.occurredAt,
    updatedBy: decision.actorReference,
  });
}

export function createLotHold(input: {
  readonly holdReference: unknown;
  readonly tenantReference: unknown;
  readonly brandReference: unknown;
  readonly stockScope: MovementStockScope;
  readonly locationReference: unknown;
  readonly itemReference: unknown;
  readonly lotReference: unknown;
  readonly expiryDate: unknown;
  readonly onHand: unknown;
  readonly reserved: unknown;
  readonly balanceVersion: unknown;
  readonly reasonCode: unknown;
  readonly complianceDecisionReference: unknown;
  readonly actorReference: unknown;
  readonly occurredAt: unknown;
}): LotHoldAggregate {
  const actorReference = reference(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const decision = decide(
    "Quarantined",
    input.reasonCode,
    input.complianceDecisionReference,
    input.onHand,
    input.reserved,
    input.balanceVersion,
    actorReference,
    occurredAt,
  );
  const stockScope = scope(input.stockScope);
  const locationReference = reference(input.locationReference);
  if (stockScope.scopeType === "Location" && stockScope.scopeReference !== locationReference)
    return invalid();
  return Object.freeze({
    holdReference: reference(input.holdReference),
    tenantReference: reference(input.tenantReference),
    brandReference: reference(input.brandReference),
    stockScope,
    locationReference,
    itemReference: reference(input.itemReference),
    lotReference: reference(input.lotReference),
    expiryDate: date(input.expiryDate),
    onHand: decimal(input.onHand),
    reserved: decimal(input.reserved),
    balanceVersion: version(input.balanceVersion),
    status: "Quarantined",
    decisions: Object.freeze([decision]),
    aggregateVersion: 1,
    createdAt: occurredAt,
    createdBy: actorReference,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function quarantineLot(
  aggregate: LotHoldAggregate,
  input: {
    readonly expectedVersion: unknown;
    readonly reasonCode: unknown;
    readonly complianceDecisionReference: unknown;
    readonly onHand: unknown;
    readonly reserved: unknown;
    readonly balanceVersion: unknown;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
  },
): LotHoldAggregate {
  if (aggregate.aggregateVersion !== version(input.expectedVersion))
    throw new LotHoldError("LOT_HOLD_CONFLICT");
  if (aggregate.status === "Quarantined") throw new LotHoldError("LOT_HOLD_STATE_CONFLICT");
  const actorReference = reference(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  return update(
    aggregate,
    "Quarantined",
    decide(
      "Quarantined",
      input.reasonCode,
      input.complianceDecisionReference,
      input.onHand,
      input.reserved,
      input.balanceVersion,
      actorReference,
      occurredAt,
    ),
  );
}

export function releaseLot(
  aggregate: LotHoldAggregate,
  input: {
    readonly expectedVersion: unknown;
    readonly reasonCode: unknown;
    readonly complianceDecisionReference: unknown;
    readonly onHand: unknown;
    readonly reserved: unknown;
    readonly balanceVersion: unknown;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
  },
): LotHoldAggregate {
  if (aggregate.aggregateVersion !== version(input.expectedVersion))
    throw new LotHoldError("LOT_HOLD_CONFLICT");
  if (aggregate.status !== "Quarantined") throw new LotHoldError("LOT_HOLD_STATE_CONFLICT");
  const actorReference = reference(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  return update(
    aggregate,
    "Available",
    decide(
      "Released",
      input.reasonCode,
      input.complianceDecisionReference,
      input.onHand,
      input.reserved,
      input.balanceVersion,
      actorReference,
      occurredAt,
    ),
  );
}
