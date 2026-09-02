import type {
  StockTransferAction,
  StockTransferCommand,
  StockTransferCommandRecord,
  StockTransferDetailProjection,
  StockTransferListProjection,
} from "../contracts/stock-transfer.js";
import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryReference,
} from "../domain/inventory-item.js";
import {
  approveStockTransfer,
  cancelStockTransferRemaining,
  closeStockTransfer,
  createStockTransfer,
  dispatchStockTransfer,
  receiveStockTransfer,
  reportStockTransferDiscrepancy,
  reviseStockTransfer,
  StockTransferError,
  submitStockTransfer,
  type StockTransferAggregate,
} from "../domain/stock-transfer.js";
import {
  parseStockMovementFact,
  parseStockScope,
  StockMovementError,
  type MovementStockScope,
} from "../domain/stock-movement.js";
import type { StockTransferPorts } from "./ports/stock-transfer-ports.js";

const actions: readonly StockTransferAction[] = [
  "Create",
  "Revise",
  "Submit",
  "Approve",
  "Dispatch",
  "Receive",
  "ReportDiscrepancy",
  "CancelRemaining",
  "Close",
];
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const searchPattern = /^[^\p{Cc}\p{Cf}<>{}$]{1,80}$/u;
const decimalScale = 1_000_000n;

function fail(code: StockTransferError["code"]): never {
  throw new StockTransferError(code);
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return fail("STOCK_TRANSFER_INVALID");
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("STOCK_TRANSFER_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof StockTransferError) throw error;
    return fail("STOCK_TRANSFER_INVALID");
  }
}
function ref(value: unknown): InventoryReference {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_TRANSFER_INVALID");
    throw error;
  }
}
function nullableRef(value: unknown): InventoryReference | null {
  return value === null ? null : ref(value);
}
function instant(value: unknown) {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_TRANSFER_INVALID");
    throw error;
  }
}
function scope(value: unknown): MovementStockScope {
  try {
    return parseStockScope(value);
  } catch (error) {
    if (error instanceof StockMovementError) return fail("STOCK_TRANSFER_INVALID");
    throw error;
  }
}
function sameScope(left: MovementStockScope, right: MovementStockScope): boolean {
  return left.scopeType === right.scopeType && left.scopeReference === right.scopeReference;
}
function code(value: unknown, pattern = codePattern): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail("STOCK_TRANSFER_INVALID");
  return value;
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("STOCK_TRANSFER_INVALID");
  return value as number;
}
function quantity(value: unknown): string {
  try {
    const result = parseInventoryDecimal(value);
    if (result === "0" || /^0\.0+$/u.test(result)) throw new Error();
    return result;
  } catch {
    return fail("STOCK_TRANSFER_INVALID");
  }
}
function fixed(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
}
function converted(quantityValue: string, multiplier: string, negative: boolean): string {
  const product = fixed(quantityValue) * fixed(multiplier);
  if (product % decimalScale !== 0n) return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
  const digits = (product / decimalScale).toString().padStart(7, "0");
  const fraction = digits.slice(-6).replace(/0+$/u, "");
  return `${negative ? "-" : ""}${digits.slice(0, -6)}${fraction ? `.${fraction}` : ""}`;
}
function parseRequestedLines(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    return fail("STOCK_TRANSFER_INVALID");
  return Object.freeze(
    value.map((entry) => {
      const raw = exact(entry, ["itemReference", "lotReference", "requestedQuantity", "unitCode"]);
      return Object.freeze({
        itemReference: ref(raw.itemReference),
        lotReference: nullableRef(raw.lotReference),
        requestedQuantity: quantity(raw.requestedQuantity),
        unitCode: code(raw.unitCode, unitPattern),
      });
    }),
  );
}
function parseQuantities(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    return fail("STOCK_TRANSFER_INVALID");
  const rows = value.map((entry) => {
    const raw = exact(entry, ["lineReference", "quantity"]);
    return Object.freeze({
      lineReference: ref(raw.lineReference),
      quantity: quantity(raw.quantity),
    });
  });
  if (new Set(rows.map((row) => row.lineReference)).size !== rows.length)
    return fail("STOCK_TRANSFER_INVALID");
  return Object.freeze(rows);
}
function parsePayload(action: StockTransferAction, value: unknown) {
  const base = ["sourceScope", "destinationScope"];
  const fields: Record<StockTransferAction, readonly string[]> = {
    Create: [...base, "ownerReference", "lines"],
    Revise: [...base, "transferReference", "expectedVersion", "reasonCode", "lines"],
    Submit: [...base, "transferReference", "expectedVersion"],
    Approve: [...base, "transferReference", "expectedVersion", "reasonCode"],
    Dispatch: [...base, "transferReference", "expectedVersion", "quantities"],
    Receive: [...base, "transferReference", "expectedVersion", "quantities"],
    ReportDiscrepancy: [
      ...base,
      "transferReference",
      "expectedVersion",
      "reasonCode",
      "quantities",
    ],
    CancelRemaining: [...base, "transferReference", "expectedVersion", "reasonCode"],
    Close: [...base, "transferReference", "expectedVersion", "reasonCode"],
  };
  const raw = exact(value, fields[action]);
  const sourceScope = scope(raw.sourceScope);
  const destinationScope = scope(raw.destinationScope);
  if (sameScope(sourceScope, destinationScope)) return fail("STOCK_TRANSFER_INVALID");
  if (action === "Create") {
    ref(raw.ownerReference);
    parseRequestedLines(raw.lines);
  } else {
    ref(raw.transferReference);
    version(raw.expectedVersion);
  }
  if (action === "Revise") {
    code(raw.reasonCode);
    parseRequestedLines(raw.lines);
  }
  if (["Approve", "ReportDiscrepancy", "CancelRemaining", "Close"].includes(action))
    code(raw.reasonCode);
  if (action === "Dispatch" || action === "Receive" || action === "ReportDiscrepancy")
    parseQuantities(raw.quantities);
  return Object.freeze(raw);
}

export function parseStockTransferCommand(value: unknown): StockTransferCommand {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "action",
    "payload",
  ]);
  if (
    raw.purpose !== "StockTransferManagement" ||
    typeof raw.action !== "string" ||
    !actions.includes(raw.action as StockTransferAction)
  )
    return fail("STOCK_TRANSFER_INVALID");
  const action = raw.action as StockTransferAction;
  const permission =
    action === "Approve" ? "inventory.transfer.approve" : "inventory.transfer.execute";
  if (raw.permission !== permission) return fail("STOCK_TRANSFER_INVALID");
  return Object.freeze({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "StockTransferManagement",
    permission,
    operationReference: ref(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: parsePayload(action, raw.payload),
  });
}

async function authorize(command: StockTransferCommand, ports: StockTransferPorts): Promise<void> {
  try {
    const result = await ports.authorization.authorize({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      purpose: command.purpose,
      permission: command.permission,
      action: command.action,
      sourceScope: scope(command.payload.sourceScope),
      destinationScope: scope(command.payload.destinationScope),
    });
    if (!result?.authorized) return fail("STOCK_TRANSFER_PERMISSION_DENIED");
  } catch (error) {
    if (error instanceof StockTransferError) throw error;
    return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
  }
}

function transferRef(command: StockTransferCommand): InventoryReference {
  return ref(command.payload.transferReference);
}
function validateLoaded(command: StockTransferCommand, transfer: StockTransferAggregate): void {
  if (
    transfer.tenantReference !== command.tenantReference ||
    transfer.brandReference !== command.brandReference ||
    transfer.transferReference !== transferRef(command) ||
    !sameScope(transfer.sourceScope, scope(command.payload.sourceScope)) ||
    !sameScope(transfer.destinationScope, scope(command.payload.destinationScope))
  )
    return fail("STOCK_TRANSFER_PERMISSION_DENIED");
}

function resolvedLines(value: unknown, command: StockTransferCommand) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "sourceScope",
    "destinationScope",
    "lines",
  ]);
  const requested = parseRequestedLines(command.payload.lines);
  if (
    raw.tenantReference !== command.tenantReference ||
    raw.brandReference !== command.brandReference ||
    !sameScope(scope(raw.sourceScope), scope(command.payload.sourceScope)) ||
    !sameScope(scope(raw.destinationScope), scope(command.payload.destinationScope)) ||
    !Array.isArray(raw.lines) ||
    raw.lines.length !== requested.length
  )
    return fail("STOCK_TRANSFER_PERMISSION_DENIED");
  return Object.freeze(
    raw.lines.map((entry, index) => {
      const line = exact(entry, [
        "lineReference",
        "itemReference",
        "lotReference",
        "expiryDate",
        "requestedQuantity",
        "unitCode",
        "baseUnitCode",
        "conversionMultiplier",
        "sourceBalanceVersion",
        "sourceOnHand",
        "sourceReserved",
        "negativeStockPolicy",
        "negativeOverrideAuthorized",
        "itemLifecycle",
        "lotRequirement",
      ]);
      const wanted = requested[index];
      if (!wanted) return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
      if (
        ref(line.itemReference) !== wanted.itemReference ||
        nullableRef(line.lotReference) !== wanted.lotReference ||
        quantity(line.requestedQuantity) !== wanted.requestedQuantity ||
        code(line.unitCode, unitPattern) !== wanted.unitCode ||
        line.itemLifecycle === "Archived" ||
        !["Active", "Inactive"].includes(String(line.itemLifecycle)) ||
        !["NoLot", "LotOptional", "LotRequired", "LotAndExpiryRequired"].includes(
          String(line.lotRequirement),
        ) ||
        (["LotRequired", "LotAndExpiryRequired"].includes(String(line.lotRequirement)) &&
          wanted.lotReference === null) ||
        (line.lotRequirement === "LotAndExpiryRequired" && line.expiryDate === null) ||
        !["Block", "ManagerOverride", "AllowWithWarning"].includes(String(line.negativeStockPolicy))
      )
        return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({
        ...line,
        lineReference: ref(line.lineReference),
        itemReference: wanted.itemReference,
        lotReference: wanted.lotReference,
      });
    }),
  );
}

async function apply(
  command: StockTransferCommand,
  before: StockTransferAggregate | null,
  ports: StockTransferPorts,
): Promise<StockTransferAggregate> {
  if (command.action === "Create" || command.action === "Revise") {
    let lines;
    try {
      lines = resolvedLines(await ports.snapshot.resolve(command), command);
    } catch (error) {
      if (error instanceof StockTransferError && error.code === "STOCK_TRANSFER_PERMISSION_DENIED")
        throw error;
      return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
    }
    if (command.action === "Create")
      return createStockTransfer({
        transferReference: ports.references.generate("StockTransfer"),
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        sourceScope: scope(command.payload.sourceScope),
        destinationScope: scope(command.payload.destinationScope),
        ownerReference: command.payload.ownerReference,
        actorReference: command.actorReference,
        occurredAt: command.occurredAt,
        lines,
      });
    if (!before) return fail("STOCK_TRANSFER_NOT_FOUND");
    validateLoaded(command, before);
    return reviseStockTransfer(before, {
      expectedVersion: version(command.payload.expectedVersion),
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      reasonCode: code(command.payload.reasonCode),
      lines,
    });
  }
  if (!before) return fail("STOCK_TRANSFER_NOT_FOUND");
  validateLoaded(command, before);
  const expectedVersion = version(command.payload.expectedVersion);
  if (command.action === "Submit")
    return submitStockTransfer(before, expectedVersion, command.actorReference, command.occurredAt);
  if (command.action === "Approve")
    return approveStockTransfer(
      before,
      expectedVersion,
      command.actorReference,
      command.occurredAt,
      code(command.payload.reasonCode),
    );
  if (command.action === "Dispatch")
    return dispatchStockTransfer(before, {
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      quantities: parseQuantities(command.payload.quantities),
    });
  if (command.action === "Receive")
    return receiveStockTransfer(before, {
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      quantities: parseQuantities(command.payload.quantities),
    });
  if (command.action === "ReportDiscrepancy")
    return reportStockTransferDiscrepancy(before, {
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      reasonCode: code(command.payload.reasonCode),
      quantities: parseQuantities(command.payload.quantities),
    });
  if (command.action === "CancelRemaining")
    return cancelStockTransferRemaining(before, {
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      reasonCode: code(command.payload.reasonCode),
    });
  return closeStockTransfer(
    before,
    expectedVersion,
    command.actorReference,
    command.occurredAt,
    code(command.payload.reasonCode),
  );
}

function validateMovements(
  record: StockTransferCommandRecord,
  command: StockTransferCommand,
  after: StockTransferAggregate,
) {
  const expected =
    command.action === "Dispatch" || command.action === "Receive"
      ? parseQuantities(command.payload.quantities)
      : [];
  if (record.movements.length !== expected.length)
    return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
  return Object.freeze(
    record.movements.map((raw, index) => {
      const movement = parseStockMovementFact(raw);
      const quantityRow = expected[index];
      const line = after.lines.find(
        (candidate) => candidate.lineReference === quantityRow?.lineReference,
      );
      const signedQuantity =
        command.action === "Dispatch" ? `-${quantityRow?.quantity}` : quantityRow?.quantity;
      const baseQuantity = converted(
        quantityRow?.quantity ?? "0",
        line?.conversionMultiplier ?? "0",
        command.action === "Dispatch",
      );
      const expectedReason =
        command.action === "Dispatch" ? "TRANSFER_DISPATCHED" : "TRANSFER_RECEIVED";
      if (
        !line ||
        movement.movementType !== "Transfer" ||
        movement.tenantReference !== command.tenantReference ||
        movement.brandReference !== command.brandReference ||
        movement.itemReference !== line.itemReference ||
        movement.quantityDelta !== signedQuantity ||
        movement.unitCode !== line.unitCode ||
        movement.baseQuantityDelta !== baseQuantity ||
        movement.baseUnitCode !== line.baseUnitCode ||
        movement.conversionMultiplier !== line.conversionMultiplier ||
        movement.lotReference !== line.lotReference ||
        movement.expiryDate !== line.expiryDate ||
        !movement.sourceScope ||
        !sameScope(movement.sourceScope, after.sourceScope) ||
        !movement.destinationScope ||
        !sameScope(movement.destinationScope, after.destinationScope) ||
        movement.businessSourceType !== "STOCK_TRANSFER" ||
        movement.businessSourceReference !== after.transferReference ||
        movement.reasonCode !== expectedReason ||
        movement.performedBy !== command.actorReference ||
        movement.occurredAt !== command.occurredAt ||
        movement.auditReference !== record.audit.auditId ||
        movement.correctsMovementReference !== null
      )
        return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
      return movement;
    }),
  );
}

export async function executeStockTransferCommand(
  value: unknown,
  ports: StockTransferPorts,
): Promise<StockTransferCommandRecord> {
  const command = parseStockTransferCommand(value);
  await authorize(command, ports);
  try {
    const intentHash = ports.references.hashIntent(`StockTransfer:v1:${JSON.stringify(command)}`);
    if (!hashPattern.test(intentHash)) return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
    const prior = await ports.repository.resolveOperation(command.operationReference);
    if (prior) {
      if (
        prior.operationReference !== command.operationReference ||
        prior.action !== command.action ||
        JSON.stringify(prior.command) !== JSON.stringify(command) ||
        !ports.references.equals(prior.intentHash, intentHash)
      )
        return fail("STOCK_TRANSFER_IDEMPOTENCY_CONFLICT");
      return prior;
    }
    const before =
      command.action === "Create" ? null : await ports.repository.load(transferRef(command));
    const after = await apply(command, before, ports);
    const audit = await ports.audit.create({ command, before, after });
    const record = await ports.transaction.commit({ command, before, after, intentHash, audit });
    if (
      record.operationReference !== command.operationReference ||
      record.action !== command.action ||
      record.outcome !== "Applied" ||
      JSON.stringify(record.command) !== JSON.stringify(command) ||
      JSON.stringify(record.transfer) !== JSON.stringify(after) ||
      JSON.stringify(record.audit) !== JSON.stringify(audit) ||
      !ports.references.equals(record.intentHash, intentHash)
    )
      return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
    return Object.freeze({ ...record, movements: validateMovements(record, command, after) });
  } catch (error) {
    if (error instanceof StockTransferError) throw error;
    return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
  }
}

function parseReadBase(value: unknown, fields: readonly string[]) {
  const raw = exact(value, fields);
  if (raw.purpose !== "StockTransferRead" || raw.permission !== "inventory.transfer.read")
    return fail("STOCK_TRANSFER_INVALID");
  return raw;
}
async function authorizeRead(
  raw: Record<string, unknown>,
  action: "List" | "Detail",
  sourceScope: MovementStockScope,
  destinationScope: MovementStockScope,
  ports: StockTransferPorts,
) {
  const result = await ports.authorization.authorize({
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    actorReference: ref(raw.actorReference),
    purpose: "StockTransferRead",
    permission: "inventory.transfer.read",
    action,
    sourceScope,
    destinationScope,
  });
  if (!result?.authorized) return fail("STOCK_TRANSFER_PERMISSION_DENIED");
}

export async function queryStockTransferList(
  value: unknown,
  ports: StockTransferPorts,
): Promise<StockTransferListProjection> {
  const raw = parseReadBase(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "status",
    "discrepancyOnly",
    "search",
    "limit",
  ]);
  const stockScope = scope(raw.stockScope);
  if (
    raw.status !== null &&
    ![
      "Draft",
      "Submitted",
      "Approved",
      "PartiallyDispatched",
      "InTransit",
      "PartiallyReceived",
      "Received",
      "Exception",
      "Cancelled",
      "Closed",
    ].includes(String(raw.status))
  )
    return fail("STOCK_TRANSFER_INVALID");
  if (
    typeof raw.discrepancyOnly !== "boolean" ||
    (raw.search !== null && (typeof raw.search !== "string" || !searchPattern.test(raw.search))) ||
    !Number.isSafeInteger(raw.limit) ||
    (raw.limit as number) < 1 ||
    (raw.limit as number) > 200
  )
    return fail("STOCK_TRANSFER_INVALID");
  await authorizeRead(raw, "List", stockScope, stockScope, ports);
  try {
    const query = Object.freeze({
      tenantReference: ref(raw.tenantReference),
      brandReference: ref(raw.brandReference),
      actorReference: ref(raw.actorReference),
      purpose: "StockTransferRead" as const,
      permission: "inventory.transfer.read" as const,
      stockScope,
      status: raw.status as StockTransferAggregate["status"] | null,
      discrepancyOnly: raw.discrepancyOnly,
      search: raw.search as string | null,
      limit: raw.limit as number,
    });
    const result = await ports.projection.list(query);
    if (
      result.projectionName !== "inventory_transfer_list_v1" ||
      result.projectionVersion !== 1 ||
      !sameScope(result.stockScope, stockScope) ||
      result.transfers.some(
        (entry) =>
          entry.tenantReference !== query.tenantReference ||
          entry.brandReference !== query.brandReference ||
          (!sameScope(entry.sourceScope, stockScope) &&
            !sameScope(entry.destinationScope, stockScope)),
      )
    )
      return fail("STOCK_TRANSFER_PERMISSION_DENIED");
    return result;
  } catch (error) {
    if (error instanceof StockTransferError) throw error;
    return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
  }
}

export async function queryStockTransferDetail(
  value: unknown,
  ports: StockTransferPorts,
): Promise<StockTransferDetailProjection> {
  const raw = parseReadBase(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "sourceScope",
    "destinationScope",
    "transferReference",
  ]);
  const sourceScope = scope(raw.sourceScope);
  const destinationScope = scope(raw.destinationScope);
  if (sameScope(sourceScope, destinationScope)) return fail("STOCK_TRANSFER_INVALID");
  await authorizeRead(raw, "Detail", sourceScope, destinationScope, ports);
  try {
    const query = Object.freeze({
      tenantReference: ref(raw.tenantReference),
      brandReference: ref(raw.brandReference),
      actorReference: ref(raw.actorReference),
      purpose: "StockTransferRead" as const,
      permission: "inventory.transfer.read" as const,
      sourceScope,
      destinationScope,
      transferReference: ref(raw.transferReference),
    });
    const result = await ports.projection.detail(query);
    if (
      result.projectionName !== "inventory_transfer_detail_v1" ||
      result.projectionVersion !== 1 ||
      !sameScope(result.sourceScope, sourceScope) ||
      !sameScope(result.destinationScope, destinationScope) ||
      result.transfer.transferReference !== query.transferReference ||
      result.transfer.tenantReference !== query.tenantReference ||
      result.transfer.brandReference !== query.brandReference
    )
      return fail("STOCK_TRANSFER_PERMISSION_DENIED");
    return result;
  } catch (error) {
    if (error instanceof StockTransferError) throw error;
    return fail("STOCK_TRANSFER_DEPENDENCY_UNAVAILABLE");
  }
}
