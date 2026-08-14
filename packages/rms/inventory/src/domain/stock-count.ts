import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryDecimal,
  type InventoryInstant,
  type InventoryReference,
} from "./inventory-item.js";
import { type MovementStockScope } from "./stock-movement.js";

export type StockCountType = "Full" | "Cycle" | "Spot";
export type StockCountStatus =
  "Draft" | "Assigned" | "InProgress" | "Submitted" | "Approved" | "Cancelled" | "Posted";
export type StockCountVariance = string & { readonly __stockCountVariance: unique symbol };

export interface StockCountLine {
  readonly lineReference: InventoryReference;
  readonly itemReference: InventoryReference;
  readonly lotReference: InventoryReference | null;
  readonly locationReference: InventoryReference;
  readonly unitCode: string;
  readonly expectedQuantity: InventoryDecimal;
  readonly countedQuantity: InventoryDecimal | null;
  readonly variance: StockCountVariance | null;
  readonly varianceReasonCode: string | null;
  readonly recountNumber: number;
  readonly balanceVersion: number;
  readonly movementReference: InventoryReference | null;
}

export interface StockCountDecision {
  readonly decision: "Submitted" | "Approved" | "Rejected" | "Cancelled";
  readonly actorReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly reasonCode: string;
}

export interface StockCountAggregate {
  readonly countReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: MovementStockScope;
  readonly countType: StockCountType;
  readonly expectedQuantityVisibility: "BlindUntilSubmit" | "Visible";
  readonly movementControl: "FreezeMovements" | "SnapshotOnly";
  readonly approvalPolicy: "Segregated" | "SelfAllowed";
  readonly snapshotReference: InventoryReference;
  readonly snapshotCapturedAt: InventoryInstant;
  readonly assigneeReference: InventoryReference | null;
  readonly dueAt: InventoryInstant | null;
  readonly status: StockCountStatus;
  readonly lines: readonly StockCountLine[];
  readonly submittedBy: InventoryReference | null;
  readonly approvedBy: InventoryReference | null;
  readonly decisions: readonly StockCountDecision[];
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly createdBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
  readonly updatedBy: InventoryReference;
}

export class StockCountError extends Error {
  constructor(
    readonly code:
      | "STOCK_COUNT_INVALID"
      | "STOCK_COUNT_PERMISSION_DENIED"
      | "STOCK_COUNT_NOT_FOUND"
      | "STOCK_COUNT_CONFLICT"
      | "STOCK_COUNT_STATE_CONFLICT"
      | "STOCK_COUNT_INCOMPLETE"
      | "STOCK_COUNT_SEGREGATION_REQUIRED"
      | "STOCK_COUNT_IDEMPOTENCY_CONFLICT"
      | "STOCK_COUNT_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Stock Count operation failed");
    this.name = "StockCountError";
  }
}

const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const reasonPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

function invalid(): never {
  throw new StockCountError("STOCK_COUNT_INVALID");
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

export function parseStockCountQuantity(value: unknown): InventoryDecimal {
  try {
    return parseInventoryDecimal(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}

function fixed(value: InventoryDecimal): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
}

function format(value: bigint): StockCountVariance {
  if (value === 0n) return "0" as StockCountVariance;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(7, "0");
  const whole = digits.slice(0, -6);
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}` as StockCountVariance;
}

export function calculateStockCountVariance(
  expected: InventoryDecimal,
  counted: InventoryDecimal,
): StockCountVariance {
  return format(fixed(counted) - fixed(expected));
}

function checkVersion(count: StockCountAggregate, expectedVersion: number): void {
  if (count.aggregateVersion !== expectedVersion) throw new StockCountError("STOCK_COUNT_CONFLICT");
}

function update(
  count: StockCountAggregate,
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  change: Partial<StockCountAggregate>,
): StockCountAggregate {
  return Object.freeze({
    ...count,
    ...change,
    aggregateVersion: count.aggregateVersion + 1,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function createStockCount(input: {
  readonly countReference: unknown;
  readonly tenantReference: unknown;
  readonly brandReference: unknown;
  readonly stockScope: MovementStockScope;
  readonly countType: StockCountType;
  readonly expectedQuantityVisibility: "BlindUntilSubmit" | "Visible";
  readonly movementControl: "FreezeMovements" | "SnapshotOnly";
  readonly approvalPolicy: "Segregated" | "SelfAllowed";
  readonly snapshotReference: unknown;
  readonly snapshotCapturedAt: unknown;
  readonly assigneeReference: unknown;
  readonly dueAt: unknown;
  readonly lines: readonly StockCountLine[];
  readonly actorReference: unknown;
  readonly occurredAt: unknown;
}): StockCountAggregate {
  if (input.lines.length < 1 || input.lines.length > 500) return invalid();
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  for (const line of input.lines) {
    const coordinate = `${line.itemReference}:${line.lotReference ?? "none"}:${line.locationReference}`;
    if (
      ids.has(line.lineReference) ||
      coordinates.has(coordinate) ||
      !unitPattern.test(line.unitCode) ||
      line.countedQuantity !== null ||
      line.variance !== null ||
      line.varianceReasonCode !== null ||
      line.recountNumber !== 0 ||
      line.movementReference !== null ||
      (input.stockScope.scopeType === "Location" &&
        line.locationReference !== input.stockScope.scopeReference)
    )
      return invalid();
    ids.add(line.lineReference);
    coordinates.add(coordinate);
  }
  const actorReference = reference(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const assigneeReference =
    input.assigneeReference === null ? null : reference(input.assigneeReference);
  const dueAt = input.dueAt === null ? null : instant(input.dueAt);
  if (dueAt && Date.parse(dueAt) <= Date.parse(occurredAt)) return invalid();
  return Object.freeze({
    countReference: reference(input.countReference),
    tenantReference: reference(input.tenantReference),
    brandReference: reference(input.brandReference),
    stockScope: input.stockScope,
    countType: input.countType,
    expectedQuantityVisibility: input.expectedQuantityVisibility,
    movementControl: input.movementControl,
    approvalPolicy: input.approvalPolicy,
    snapshotReference: reference(input.snapshotReference),
    snapshotCapturedAt: instant(input.snapshotCapturedAt),
    assigneeReference,
    dueAt,
    status: assigneeReference ? "Assigned" : "Draft",
    lines: Object.freeze([...input.lines]),
    submittedBy: null,
    approvedBy: null,
    decisions: Object.freeze([]),
    aggregateVersion: 1,
    createdAt: occurredAt,
    createdBy: actorReference,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function assignStockCount(
  count: StockCountAggregate,
  assigneeReference: unknown,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockCountAggregate {
  checkVersion(count, expectedVersion);
  if (!["Draft", "Assigned"].includes(count.status))
    throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  return update(count, reference(actorReferenceValue), instant(occurredAtValue), {
    assigneeReference: reference(assigneeReference),
    status: "Assigned",
  });
}

export function startStockCount(
  count: StockCountAggregate,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockCountAggregate {
  checkVersion(count, expectedVersion);
  const actorReference = reference(actorReferenceValue);
  if (count.status !== "Assigned" || count.assigneeReference !== actorReference)
    throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  return update(count, actorReference, instant(occurredAtValue), { status: "InProgress" });
}

export function saveStockCountLine(
  count: StockCountAggregate,
  input: {
    readonly lineReference: unknown;
    readonly countedQuantity: unknown;
    readonly unitCode: unknown;
    readonly varianceReasonCode: unknown;
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
  },
): StockCountAggregate {
  checkVersion(count, input.expectedVersion);
  const actorReference = reference(input.actorReference);
  if (count.status !== "InProgress" || count.assigneeReference !== actorReference)
    throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  const lineReference = reference(input.lineReference);
  const target = count.lines.find((line) => line.lineReference === lineReference);
  if (!target || input.unitCode !== target.unitCode) return invalid();
  const countedQuantity = parseStockCountQuantity(input.countedQuantity);
  const variance = calculateStockCountVariance(target.expectedQuantity, countedQuantity);
  const varianceReasonCode =
    input.varianceReasonCode === null
      ? null
      : typeof input.varianceReasonCode === "string" && reasonPattern.test(input.varianceReasonCode)
        ? input.varianceReasonCode
        : invalid();
  const lines = count.lines.map((line) =>
    line.lineReference === lineReference
      ? Object.freeze({
          ...line,
          countedQuantity,
          variance,
          varianceReasonCode,
          recountNumber:
            line.countedQuantity === null ? line.recountNumber : line.recountNumber + 1,
        })
      : line,
  );
  return update(count, actorReference, instant(input.occurredAt), {
    lines: Object.freeze(lines),
  });
}

function decision(
  kind: StockCountDecision["decision"],
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  reasonCode: string,
): StockCountDecision {
  if (!reasonPattern.test(reasonCode)) return invalid();
  return Object.freeze({ decision: kind, actorReference, occurredAt, reasonCode });
}

export function submitStockCount(
  count: StockCountAggregate,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockCountAggregate {
  checkVersion(count, expectedVersion);
  const actorReference = reference(actorReferenceValue);
  if (count.status !== "InProgress" || count.assigneeReference !== actorReference)
    throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  if (
    count.lines.some(
      (line) =>
        line.countedQuantity === null ||
        line.variance === null ||
        (line.variance !== "0" && line.varianceReasonCode === null),
    )
  )
    throw new StockCountError("STOCK_COUNT_INCOMPLETE");
  const occurredAt = instant(occurredAtValue);
  return update(count, actorReference, occurredAt, {
    status: "Submitted",
    submittedBy: actorReference,
    decisions: Object.freeze([
      ...count.decisions,
      decision("Submitted", actorReference, occurredAt, "COUNT_SUBMITTED"),
    ]),
  });
}

export function decideStockCount(
  count: StockCountAggregate,
  input: {
    readonly decision: "Approve" | "Reject";
    readonly reasonCode: string;
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
  },
): StockCountAggregate {
  checkVersion(count, input.expectedVersion);
  const actorReference = reference(input.actorReference);
  if (count.status !== "Submitted") throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  if (count.approvalPolicy === "Segregated" && count.submittedBy === actorReference)
    throw new StockCountError("STOCK_COUNT_SEGREGATION_REQUIRED");
  const occurredAt = instant(input.occurredAt);
  const approved = input.decision === "Approve";
  return update(count, actorReference, occurredAt, {
    status: approved ? "Approved" : "InProgress",
    approvedBy: approved ? actorReference : null,
    decisions: Object.freeze([
      ...count.decisions,
      decision(approved ? "Approved" : "Rejected", actorReference, occurredAt, input.reasonCode),
    ]),
  });
}

export function cancelStockCount(
  count: StockCountAggregate,
  input: {
    readonly reasonCode: string;
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
  },
): StockCountAggregate {
  checkVersion(count, input.expectedVersion);
  if (!["Draft", "Assigned", "InProgress"].includes(count.status))
    throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  const actorReference = reference(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  return update(count, actorReference, occurredAt, {
    status: "Cancelled",
    decisions: Object.freeze([
      ...count.decisions,
      decision("Cancelled", actorReference, occurredAt, input.reasonCode),
    ]),
  });
}

export function markStockCountPosted(
  count: StockCountAggregate,
  movementReferences: ReadonlyMap<InventoryReference, InventoryReference>,
  expectedVersion: number,
  actorReferenceValue: unknown,
  occurredAtValue: unknown,
): StockCountAggregate {
  checkVersion(count, expectedVersion);
  if (count.status !== "Approved") throw new StockCountError("STOCK_COUNT_STATE_CONFLICT");
  const required = count.lines.filter((line) => line.variance !== "0");
  if (
    movementReferences.size !== required.length ||
    required.some((line) => !movementReferences.has(line.lineReference))
  )
    return invalid();
  const lines = count.lines.map((line) =>
    Object.freeze({
      ...line,
      movementReference: movementReferences.get(line.lineReference) ?? null,
    }),
  );
  return update(count, reference(actorReferenceValue), instant(occurredAtValue), {
    status: "Posted",
    lines: Object.freeze(lines),
  });
}
