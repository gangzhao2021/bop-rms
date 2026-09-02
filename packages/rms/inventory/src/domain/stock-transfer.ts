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
import type { MovementStockScope } from "./stock-movement.js";

export type StockTransferStatus =
  | "Draft"
  | "Submitted"
  | "Approved"
  | "PartiallyDispatched"
  | "InTransit"
  | "PartiallyReceived"
  | "Received"
  | "Exception"
  | "Cancelled"
  | "Closed";

export interface StockTransferLine {
  readonly lineReference: InventoryReference;
  readonly itemReference: InventoryReference;
  readonly lotReference: InventoryReference | null;
  readonly expiryDate: string | null;
  readonly requestedQuantity: InventoryDecimal;
  readonly unitCode: string;
  readonly baseRequestedQuantity: InventoryDecimal;
  readonly baseUnitCode: string;
  readonly conversionMultiplier: InventoryDecimal;
  readonly dispatchedQuantity: InventoryDecimal | "0";
  readonly receivedQuantity: InventoryDecimal | "0";
  readonly inTransitQuantity: InventoryDecimal | "0";
  readonly discrepancyQuantity: InventoryDecimal | "0";
  readonly cancelledQuantity: InventoryDecimal | "0";
  readonly sourceBalanceVersion: number;
  readonly sourceOnHand: InventoryDecimal | "0";
  readonly sourceReserved: InventoryDecimal | "0";
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly warnings: readonly string[];
}

export interface StockTransferRevision {
  readonly revision: number;
  readonly actorReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly reasonCode: string;
  readonly lines: readonly StockTransferLine[];
}

export interface StockTransferTimelineEntry {
  readonly action:
    | "Created"
    | "Revised"
    | "Submitted"
    | "Approved"
    | "Dispatched"
    | "Received"
    | "DiscrepancyReported"
    | "RemainingCancelled"
    | "Closed";
  readonly actorReference: InventoryReference;
  readonly occurredAt: InventoryInstant;
  readonly reasonCode: string;
}

export interface StockTransferAggregate {
  readonly transferReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly sourceScope: MovementStockScope;
  readonly destinationScope: MovementStockScope;
  readonly ownerReference: InventoryReference;
  readonly status: StockTransferStatus;
  readonly lines: readonly StockTransferLine[];
  readonly revisions: readonly StockTransferRevision[];
  readonly timeline: readonly StockTransferTimelineEntry[];
  readonly submittedBy: InventoryReference | null;
  readonly approvedBy: InventoryReference | null;
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly updatedAt: InventoryInstant;
}

export class StockTransferError extends Error {
  constructor(
    readonly code:
      | "STOCK_TRANSFER_INVALID"
      | "STOCK_TRANSFER_PERMISSION_DENIED"
      | "STOCK_TRANSFER_NOT_FOUND"
      | "STOCK_TRANSFER_CONFLICT"
      | "STOCK_TRANSFER_STATE_CONFLICT"
      | "STOCK_TRANSFER_SEGREGATION_REQUIRED"
      | "STOCK_TRANSFER_BLOCKED"
      | "STOCK_TRANSFER_IDEMPOTENCY_CONFLICT"
      | "STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Stock Transfer operation failed");
    this.name = "StockTransferError";
  }
}

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const scale = 1_000_000n;

function invalid(): never {
  throw new StockTransferError("STOCK_TRANSFER_INVALID");
}
function ref(value: unknown): InventoryReference {
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
function decimal(value: unknown, allowZero = false): InventoryDecimal | "0" {
  try {
    const parsed = parseInventoryDecimal(value);
    if (!allowZero && (parsed === "0" || /^0\.0+$/u.test(parsed))) return invalid();
    return parsed;
  } catch (error) {
    if (error instanceof InventoryItemError) return invalid();
    throw error;
  }
}
function fixed(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
}
function format(value: bigint): InventoryDecimal | "0" {
  if (value < 0n) return invalid();
  if (value === 0n) return "0";
  const digits = value.toString().padStart(7, "0");
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${digits.slice(0, -6)}${fraction ? `.${fraction}` : ""}` as InventoryDecimal;
}
function code(value: unknown, pattern = codePattern): string {
  if (typeof value !== "string" || !pattern.test(value)) return invalid();
  return value;
}
function sameScope(left: MovementStockScope, right: MovementStockScope): boolean {
  return left.scopeType === right.scopeType && left.scopeReference === right.scopeReference;
}
function checkVersion(transfer: StockTransferAggregate, expectedVersion: number): void {
  if (transfer.aggregateVersion !== expectedVersion)
    throw new StockTransferError("STOCK_TRANSFER_CONFLICT");
}
function event(
  action: StockTransferTimelineEntry["action"],
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  reasonCode: string,
): StockTransferTimelineEntry {
  return Object.freeze({ action, actorReference, occurredAt, reasonCode: code(reasonCode) });
}
function update(
  transfer: StockTransferAggregate,
  actorReference: InventoryReference,
  occurredAt: InventoryInstant,
  action: StockTransferTimelineEntry["action"],
  reasonCode: string,
  change: Partial<StockTransferAggregate>,
): StockTransferAggregate {
  return Object.freeze({
    ...transfer,
    ...change,
    timeline: Object.freeze([
      ...transfer.timeline,
      event(action, actorReference, occurredAt, reasonCode),
    ]),
    aggregateVersion: transfer.aggregateVersion + 1,
    updatedAt: occurredAt,
  });
}

export function createStockTransfer(input: {
  readonly transferReference: unknown;
  readonly tenantReference: unknown;
  readonly brandReference: unknown;
  readonly sourceScope: MovementStockScope;
  readonly destinationScope: MovementStockScope;
  readonly ownerReference: unknown;
  readonly actorReference: unknown;
  readonly occurredAt: unknown;
  readonly lines: readonly Readonly<Record<string, unknown>>[];
}): StockTransferAggregate {
  if (
    sameScope(input.sourceScope, input.destinationScope) ||
    input.lines.length < 1 ||
    input.lines.length > 100
  )
    return invalid();
  const actorReference = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const lines = Object.freeze(input.lines.map(parseLine));
  if (new Set(lines.map((line) => line.lineReference)).size !== lines.length) return invalid();
  const initial = event("Created", actorReference, occurredAt, "TRANSFER_CREATED");
  return Object.freeze({
    transferReference: ref(input.transferReference),
    tenantReference: ref(input.tenantReference),
    brandReference: ref(input.brandReference),
    sourceScope: input.sourceScope,
    destinationScope: input.destinationScope,
    ownerReference: ref(input.ownerReference),
    status: "Draft",
    lines,
    revisions: Object.freeze([
      Object.freeze({
        revision: 1,
        actorReference,
        occurredAt,
        reasonCode: "TRANSFER_CREATED",
        lines,
      }),
    ]),
    timeline: Object.freeze([initial]),
    submittedBy: null,
    approvedBy: null,
    aggregateVersion: 1,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

function parseLine(value: Readonly<Record<string, unknown>>): StockTransferLine {
  const requestedQuantity = decimal(value.requestedQuantity) as InventoryDecimal;
  const conversionMultiplier = decimal(value.conversionMultiplier) as InventoryDecimal;
  const product = fixed(requestedQuantity) * fixed(conversionMultiplier);
  if (product % scale !== 0n) return invalid();
  const sourceOnHand = decimal(value.sourceOnHand, true);
  const sourceReserved = decimal(value.sourceReserved, true);
  const available = fixed(sourceOnHand) - fixed(sourceReserved);
  const negative = available < fixed(format(product / scale));
  if (negative) {
    if (value.negativeStockPolicy === "Block")
      throw new StockTransferError("STOCK_TRANSFER_BLOCKED");
    if (
      value.negativeStockPolicy === "ManagerOverride" &&
      value.negativeOverrideAuthorized !== true
    )
      throw new StockTransferError("STOCK_TRANSFER_PERMISSION_DENIED");
  }
  if (!["Block", "ManagerOverride", "AllowWithWarning"].includes(String(value.negativeStockPolicy)))
    return invalid();
  const expiryDate = value.expiryDate;
  if (
    expiryDate !== null &&
    (typeof expiryDate !== "string" ||
      !datePattern.test(expiryDate) ||
      new Date(Date.parse(`${expiryDate}T00:00:00.000Z`)).toISOString().slice(0, 10) !== expiryDate)
  )
    return invalid();
  if (
    !Number.isSafeInteger(value.sourceBalanceVersion) ||
    (value.sourceBalanceVersion as number) < 1
  )
    return invalid();
  return Object.freeze({
    lineReference: ref(value.lineReference),
    itemReference: ref(value.itemReference),
    lotReference: value.lotReference === null ? null : ref(value.lotReference),
    expiryDate: expiryDate as string | null,
    requestedQuantity,
    unitCode: code(value.unitCode, unitPattern),
    baseRequestedQuantity: format(product / scale) as InventoryDecimal,
    baseUnitCode: code(value.baseUnitCode, unitPattern),
    conversionMultiplier,
    dispatchedQuantity: "0",
    receivedQuantity: "0",
    inTransitQuantity: "0",
    discrepancyQuantity: "0",
    cancelledQuantity: "0",
    sourceBalanceVersion: value.sourceBalanceVersion as number,
    sourceOnHand,
    sourceReserved,
    negativeStockPolicy: value.negativeStockPolicy as NegativeStockPolicy,
    warnings: Object.freeze(
      negative
        ? [
            value.negativeStockPolicy === "ManagerOverride"
              ? "NEGATIVE_STOCK_OVERRIDE"
              : "NEGATIVE_STOCK",
          ]
        : [],
    ),
  });
}

export function reviseStockTransfer(
  transfer: StockTransferAggregate,
  input: {
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly reasonCode: string;
    readonly lines: readonly Readonly<Record<string, unknown>>[];
  },
): StockTransferAggregate {
  checkVersion(transfer, input.expectedVersion);
  if (transfer.status !== "Draft") throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const actorReference = ref(input.actorReference);
  const occurredAt = instant(input.occurredAt);
  const lines = Object.freeze(input.lines.map(parseLine));
  if (
    lines.length < 1 ||
    lines.length > 100 ||
    new Set(lines.map((line) => line.lineReference)).size !== lines.length
  )
    return invalid();
  const revision = Object.freeze({
    revision: transfer.revisions.length + 1,
    actorReference,
    occurredAt,
    reasonCode: code(input.reasonCode),
    lines,
  });
  return update(transfer, actorReference, occurredAt, "Revised", input.reasonCode, {
    lines,
    revisions: Object.freeze([...transfer.revisions, revision]),
  });
}

export function submitStockTransfer(
  transfer: StockTransferAggregate,
  expectedVersion: number,
  actorValue: unknown,
  atValue: unknown,
): StockTransferAggregate {
  checkVersion(transfer, expectedVersion);
  if (transfer.status !== "Draft") throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const actor = ref(actorValue);
  const at = instant(atValue);
  return update(transfer, actor, at, "Submitted", "TRANSFER_SUBMITTED", {
    status: "Submitted",
    submittedBy: actor,
  });
}

export function approveStockTransfer(
  transfer: StockTransferAggregate,
  expectedVersion: number,
  actorValue: unknown,
  atValue: unknown,
  reasonCode: string,
): StockTransferAggregate {
  checkVersion(transfer, expectedVersion);
  if (transfer.status !== "Submitted")
    throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const actor = ref(actorValue);
  if (actor === transfer.submittedBy)
    throw new StockTransferError("STOCK_TRANSFER_SEGREGATION_REQUIRED");
  const at = instant(atValue);
  return update(transfer, actor, at, "Approved", reasonCode, {
    status: "Approved",
    approvedBy: actor,
  });
}

function applyQuantities(
  transfer: StockTransferAggregate,
  quantities: readonly { readonly lineReference: unknown; readonly quantity: unknown }[],
  kind: "Dispatch" | "Receive",
): readonly StockTransferLine[] {
  if (quantities.length < 1 || quantities.length > transfer.lines.length) return invalid();
  const parsed = new Map<InventoryReference, bigint>();
  for (const input of quantities) {
    const lineReference = ref(input.lineReference);
    if (parsed.has(lineReference)) return invalid();
    parsed.set(lineReference, fixed(decimal(input.quantity) as InventoryDecimal));
  }
  return Object.freeze(
    transfer.lines.map((line) => {
      const delta = parsed.get(line.lineReference) ?? 0n;
      if (delta === 0n) return line;
      const dispatched = fixed(line.dispatchedQuantity);
      const received = fixed(line.receivedQuantity);
      const requested = fixed(line.requestedQuantity);
      if (kind === "Dispatch") {
        if (dispatched + delta > requested) throw new StockTransferError("STOCK_TRANSFER_BLOCKED");
        return Object.freeze({
          ...line,
          dispatchedQuantity: format(dispatched + delta),
          inTransitQuantity: format(dispatched + delta - received),
        });
      }
      if (received + delta > dispatched) throw new StockTransferError("STOCK_TRANSFER_BLOCKED");
      return Object.freeze({
        ...line,
        receivedQuantity: format(received + delta),
        inTransitQuantity: format(dispatched - received - delta),
      });
    }),
  );
}

export function dispatchStockTransfer(
  transfer: StockTransferAggregate,
  input: {
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly quantities: readonly { readonly lineReference: unknown; readonly quantity: unknown }[];
  },
): StockTransferAggregate {
  checkVersion(transfer, input.expectedVersion);
  if (!["Approved", "PartiallyDispatched"].includes(transfer.status))
    throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const lines = applyQuantities(transfer, input.quantities, "Dispatch");
  const complete = lines.every(
    (line) => fixed(line.dispatchedQuantity) === fixed(line.requestedQuantity),
  );
  const actor = ref(input.actorReference);
  const at = instant(input.occurredAt);
  return update(transfer, actor, at, "Dispatched", "TRANSFER_DISPATCHED", {
    lines,
    status: complete ? "InTransit" : "PartiallyDispatched",
  });
}

export function receiveStockTransfer(
  transfer: StockTransferAggregate,
  input: {
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly quantities: readonly { readonly lineReference: unknown; readonly quantity: unknown }[];
  },
): StockTransferAggregate {
  checkVersion(transfer, input.expectedVersion);
  if (!["PartiallyDispatched", "InTransit", "PartiallyReceived"].includes(transfer.status))
    throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const lines = applyQuantities(transfer, input.quantities, "Receive");
  const allRequested = lines.every(
    (line) => fixed(line.receivedQuantity) === fixed(line.requestedQuantity),
  );
  const anyTransit = lines.some((line) => fixed(line.inTransitQuantity) > 0n);
  const actor = ref(input.actorReference);
  const at = instant(input.occurredAt);
  return update(transfer, actor, at, "Received", "TRANSFER_RECEIVED", {
    lines,
    status: allRequested ? "Received" : anyTransit ? "PartiallyReceived" : "PartiallyDispatched",
  });
}

export function reportStockTransferDiscrepancy(
  transfer: StockTransferAggregate,
  input: {
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly reasonCode: string;
    readonly quantities: readonly { readonly lineReference: unknown; readonly quantity: unknown }[];
  },
): StockTransferAggregate {
  checkVersion(transfer, input.expectedVersion);
  if (
    !["PartiallyReceived", "Received", "PartiallyDispatched", "InTransit"].includes(transfer.status)
  )
    throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  if (input.quantities.length < 1 || input.quantities.length > transfer.lines.length)
    return invalid();
  const quantities = new Map<InventoryReference, bigint>();
  for (const row of input.quantities) {
    const lineReference = ref(row.lineReference);
    if (quantities.has(lineReference)) return invalid();
    quantities.set(lineReference, fixed(decimal(row.quantity) as InventoryDecimal));
  }
  const lines = Object.freeze(
    transfer.lines.map((line) => {
      const discrepancy = quantities.get(line.lineReference) ?? 0n;
      if (discrepancy > fixed(line.inTransitQuantity))
        throw new StockTransferError("STOCK_TRANSFER_BLOCKED");
      return Object.freeze({
        ...line,
        inTransitQuantity: format(fixed(line.inTransitQuantity) - discrepancy),
        discrepancyQuantity: format(fixed(line.discrepancyQuantity) + discrepancy),
      });
    }),
  );
  const actor = ref(input.actorReference);
  const at = instant(input.occurredAt);
  return update(transfer, actor, at, "DiscrepancyReported", input.reasonCode, {
    lines,
    status: "Exception",
  });
}

export function cancelStockTransferRemaining(
  transfer: StockTransferAggregate,
  input: {
    readonly expectedVersion: number;
    readonly actorReference: unknown;
    readonly occurredAt: unknown;
    readonly reasonCode: string;
  },
): StockTransferAggregate {
  checkVersion(transfer, input.expectedVersion);
  if (
    !["Approved", "PartiallyDispatched", "InTransit", "PartiallyReceived", "Exception"].includes(
      transfer.status,
    )
  )
    throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const lines = Object.freeze(
    transfer.lines.map((line) => {
      const remaining = fixed(line.requestedQuantity) - fixed(line.dispatchedQuantity);
      return Object.freeze({ ...line, cancelledQuantity: format(remaining) });
    }),
  );
  if (lines.every((line) => line.cancelledQuantity === "0")) return invalid();
  const actor = ref(input.actorReference);
  const at = instant(input.occurredAt);
  const hasTransit = lines.some((line) => fixed(line.inTransitQuantity) > 0n);
  const hasReceipt = lines.some((line) => fixed(line.receivedQuantity) > 0n);
  return update(transfer, actor, at, "RemainingCancelled", input.reasonCode, {
    lines,
    status: hasTransit ? "PartiallyReceived" : hasReceipt ? "Received" : "Cancelled",
  });
}

export function closeStockTransfer(
  transfer: StockTransferAggregate,
  expectedVersion: number,
  actorValue: unknown,
  atValue: unknown,
  reasonCode: string,
): StockTransferAggregate {
  checkVersion(transfer, expectedVersion);
  if (
    !["Received", "Exception"].includes(transfer.status) ||
    transfer.lines.some((line) => fixed(line.inTransitQuantity) > 0n)
  )
    throw new StockTransferError("STOCK_TRANSFER_STATE_CONFLICT");
  const actor = ref(actorValue);
  const at = instant(atValue);
  return update(transfer, actor, at, "Closed", reasonCode, { status: "Closed" });
}
