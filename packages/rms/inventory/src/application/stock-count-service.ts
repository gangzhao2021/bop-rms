import type {
  StockCountAction,
  StockCountCommand,
  StockCountCommandRecord,
  StockCountPermission,
  StockCountProjection,
  StockCountQuery,
  StockCountReadModel,
} from "../contracts/stock-count.js";
import {
  InventoryItemError,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryReference,
} from "../domain/inventory-item.js";
import {
  assignStockCount,
  cancelStockCount,
  createStockCount,
  decideStockCount,
  markStockCountPosted,
  parseStockCountQuantity,
  saveStockCountLine,
  startStockCount,
  StockCountError,
  submitStockCount,
  type StockCountAggregate,
  type StockCountLine,
  type StockCountType,
} from "../domain/stock-count.js";
import {
  parseStockMovementFact,
  parseStockScope,
  StockMovementError,
  type MovementStockScope,
  type StockMovementFact,
} from "../domain/stock-movement.js";
import type { StockCountPorts } from "./ports/stock-count-ports.js";

const actions: readonly StockCountAction[] = [
  "Create",
  "Assign",
  "Start",
  "SaveLine",
  "Submit",
  "Approve",
  "Reject",
  "Cancel",
  "Post",
];
const permissions: Record<StockCountAction, StockCountPermission> = {
  Create: "inventory.count.manage",
  Assign: "inventory.count.manage",
  Start: "inventory.count.execute",
  SaveLine: "inventory.count.execute",
  Submit: "inventory.count.execute",
  Approve: "inventory.count.approve",
  Reject: "inventory.count.approve",
  Cancel: "inventory.count.manage",
  Post: "inventory.count.post",
};
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const reasonPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const statuses: readonly StockCountAggregate["status"][] = [
  "Draft",
  "Assigned",
  "InProgress",
  "Submitted",
  "Approved",
  "Cancelled",
  "Posted",
];

function fail(code: StockCountError["code"]): never {
  throw new StockCountError(code);
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
      return fail("STOCK_COUNT_INVALID");
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("STOCK_COUNT_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof StockCountError) throw error;
    return fail("STOCK_COUNT_INVALID");
  }
}

function reference(value: unknown) {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_COUNT_INVALID");
    throw error;
  }
}

function instant(value: unknown) {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_COUNT_INVALID");
    throw error;
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("STOCK_COUNT_INVALID");
  return value as number;
}

function reason(value: unknown): string {
  if (typeof value !== "string" || !reasonPattern.test(value)) return fail("STOCK_COUNT_INVALID");
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("STOCK_COUNT_INVALID");
  return value as T;
}

function nullableReference(value: unknown) {
  return value === null ? null : reference(value);
}

function nullableInstant(value: unknown) {
  return value === null ? null : instant(value);
}

function stockScope(value: unknown): MovementStockScope {
  try {
    return parseStockScope(value);
  } catch (error) {
    if (error instanceof StockMovementError) return fail("STOCK_COUNT_INVALID");
    throw error;
  }
}

function parsePayload(action: StockCountAction, value: unknown): Readonly<Record<string, unknown>> {
  const fields: Record<StockCountAction, readonly string[]> = {
    Create: [
      "stockScope",
      "countType",
      "expectedQuantityVisibility",
      "movementControl",
      "approvalPolicy",
      "assigneeReference",
      "dueAt",
    ],
    Assign: ["countReference", "expectedVersion", "assigneeReference"],
    Start: ["countReference", "expectedVersion"],
    SaveLine: [
      "countReference",
      "expectedVersion",
      "lineReference",
      "countedQuantity",
      "unitCode",
      "varianceReasonCode",
    ],
    Submit: ["countReference", "expectedVersion"],
    Approve: ["countReference", "expectedVersion", "reasonCode"],
    Reject: ["countReference", "expectedVersion", "reasonCode"],
    Cancel: ["countReference", "expectedVersion", "reasonCode"],
    Post: ["countReference", "expectedVersion"],
  };
  const raw = exact(value, fields[action]);
  if (action === "Create") {
    stockScope(raw.stockScope);
    oneOf(raw.countType, ["Full", "Cycle", "Spot"]);
    oneOf(raw.expectedQuantityVisibility, ["BlindUntilSubmit", "Visible"]);
    oneOf(raw.movementControl, ["FreezeMovements", "SnapshotOnly"]);
    oneOf(raw.approvalPolicy, ["Segregated", "SelfAllowed"]);
    nullableReference(raw.assigneeReference);
    nullableInstant(raw.dueAt);
  } else {
    reference(raw.countReference);
    version(raw.expectedVersion);
  }
  if (action === "Assign") reference(raw.assigneeReference);
  if (action === "SaveLine") {
    reference(raw.lineReference);
    parseStockCountQuantity(raw.countedQuantity);
    if (typeof raw.unitCode !== "string" || !unitPattern.test(raw.unitCode))
      return fail("STOCK_COUNT_INVALID");
    if (raw.varianceReasonCode !== null) reason(raw.varianceReasonCode);
  }
  if (["Approve", "Reject", "Cancel"].includes(action)) reason(raw.reasonCode);
  return Object.freeze(raw);
}

export function parseStockCountCommand(value: unknown): StockCountCommand {
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
    raw.purpose !== "StockCountManagement" ||
    typeof raw.action !== "string" ||
    !actions.includes(raw.action as StockCountAction)
  )
    return fail("STOCK_COUNT_INVALID");
  const action = raw.action as StockCountAction;
  if (raw.permission !== permissions[action]) return fail("STOCK_COUNT_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "StockCountManagement",
    permission: permissions[action],
    operationReference: reference(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: parsePayload(action, raw.payload),
  });
}

export function parseStockCountQuery(value: unknown): StockCountQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "countReference",
    "statuses",
    "assigneeReference",
    "hasVariance",
    "overdueAt",
    "limit",
  ]);
  if (
    raw.purpose !== "StockCountRead" ||
    raw.permission !== "inventory.count.read" ||
    !Array.isArray(raw.statuses) ||
    raw.statuses.length > statuses.length ||
    raw.statuses.some(
      (entry, index) =>
        typeof entry !== "string" ||
        !statuses.includes(entry as StockCountAggregate["status"]) ||
        (raw.statuses as unknown[]).indexOf(entry) !== index,
    ) ||
    (raw.hasVariance !== null && typeof raw.hasVariance !== "boolean") ||
    !Number.isSafeInteger(raw.limit) ||
    (raw.limit as number) < 1 ||
    (raw.limit as number) > 200
  )
    return fail("STOCK_COUNT_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "StockCountRead",
    permission: "inventory.count.read",
    stockScope: stockScope(raw.stockScope),
    countReference: nullableReference(raw.countReference),
    statuses: Object.freeze(raw.statuses as StockCountAggregate["status"][]),
    assigneeReference: nullableReference(raw.assigneeReference),
    hasVariance: raw.hasVariance as boolean | null,
    overdueAt: nullableInstant(raw.overdueAt),
    limit: raw.limit as number,
  });
}

function sameCountScope(count: StockCountAggregate, query: StockCountQuery): boolean {
  return (
    count.stockScope.scopeType === query.stockScope.scopeType &&
    count.stockScope.scopeReference === query.stockScope.scopeReference
  );
}

function hasVariance(count: StockCountAggregate): boolean {
  return count.lines.some((line) => line.variance !== null && line.variance !== "0");
}

function sanitizeCount(count: StockCountAggregate, mayViewExpected: boolean): StockCountReadModel {
  const revealExpected =
    mayViewExpected ||
    count.expectedQuantityVisibility === "Visible" ||
    ["Submitted", "Approved", "Posted"].includes(count.status);
  return Object.freeze({
    countReference: count.countReference,
    stockScope: count.stockScope,
    countType: count.countType,
    status: count.status,
    expectedQuantityVisibility: count.expectedQuantityVisibility,
    movementControl: count.movementControl,
    approvalPolicy: count.approvalPolicy,
    snapshotReference: count.snapshotReference,
    snapshotCapturedAt: count.snapshotCapturedAt,
    assigneeReference: count.assigneeReference,
    submittedBy: count.submittedBy,
    approvedBy: count.approvedBy,
    dueAt: count.dueAt,
    aggregateVersion: count.aggregateVersion,
    lines: Object.freeze(
      count.lines.map((line) =>
        Object.freeze({
          lineReference: line.lineReference,
          itemReference: line.itemReference,
          lotReference: line.lotReference,
          locationReference: line.locationReference,
          unitCode: line.unitCode,
          expectedQuantity: revealExpected ? line.expectedQuantity : null,
          countedQuantity: line.countedQuantity,
          variance: revealExpected ? line.variance : null,
          varianceReasonCode: revealExpected ? line.varianceReasonCode : null,
          recountNumber: line.recountNumber,
          movementReference: line.movementReference,
        }),
      ),
    ),
  });
}

export async function queryStockCounts(
  value: unknown,
  ports: StockCountPorts,
): Promise<StockCountProjection> {
  const query = parseStockCountQuery(value);
  let authorization;
  try {
    authorization = await ports.authorization.authorize({
      tenantReference: query.tenantReference,
      brandReference: query.brandReference,
      actorReference: query.actorReference,
      purpose: query.purpose,
      permission: query.permission,
      action: query.countReference ? "Detail" : "List",
    });
  } catch {
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  }
  if (!authorization?.authorized) return fail("STOCK_COUNT_PERMISSION_DENIED");
  const mayViewExpected = authorization.mayViewExpected === true;
  if (query.hasVariance !== null && !mayViewExpected) return fail("STOCK_COUNT_PERMISSION_DENIED");
  try {
    const result = await ports.projection.query(query);
    if (
      result.projectionName !== "inventory_count_workbench_v1" ||
      result.projectionVersion !== 1 ||
      !["Current", "Stale", "Rebuilding"].includes(result.freshness) ||
      typeof result.partial !== "boolean" ||
      result.counts.length > query.limit ||
      result.stockScope.scopeType !== query.stockScope.scopeType ||
      result.stockScope.scopeReference !== query.stockScope.scopeReference
    )
      return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
    if (
      result.counts.some(
        (count) =>
          count.tenantReference !== query.tenantReference ||
          count.brandReference !== query.brandReference ||
          !sameCountScope(count, query) ||
          (query.countReference !== null && count.countReference !== query.countReference) ||
          (query.statuses.length > 0 && !query.statuses.includes(count.status)) ||
          (query.assigneeReference !== null &&
            count.assigneeReference !== query.assigneeReference) ||
          (query.hasVariance !== null && hasVariance(count) !== query.hasVariance) ||
          (query.overdueAt !== null &&
            (count.dueAt === null ||
              Date.parse(count.dueAt) >= Date.parse(query.overdueAt) ||
              ["Cancelled", "Posted"].includes(count.status))),
      )
    )
      return fail("STOCK_COUNT_PERMISSION_DENIED");
    return Object.freeze({
      projectionName: "inventory_count_workbench_v1",
      projectionVersion: 1,
      stockScope: query.stockScope,
      asOfUtc: instant(result.asOfUtc),
      freshness: result.freshness,
      partial: result.partial,
      counts: Object.freeze(result.counts.map((count) => sanitizeCount(count, mayViewExpected))),
    });
  } catch (error) {
    if (error instanceof StockCountError) throw error;
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  }
}

function parseSnapshot(value: unknown, command: StockCountCommand) {
  const raw = exact(value, ["snapshotReference", "capturedAt", "stockScope", "lines"]);
  const capturedStockScope = stockScope(raw.stockScope);
  const requested = stockScope(command.payload.stockScope);
  if (
    capturedStockScope.scopeType !== requested.scopeType ||
    capturedStockScope.scopeReference !== requested.scopeReference ||
    !Array.isArray(raw.lines) ||
    raw.lines.length < 1 ||
    raw.lines.length > 500
  )
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  const lines: StockCountLine[] = raw.lines.map((value) => {
    const line = exact(value, [
      "lineReference",
      "itemReference",
      "lotReference",
      "locationReference",
      "unitCode",
      "expectedQuantity",
      "balanceVersion",
    ]);
    if (typeof line.unitCode !== "string" || !unitPattern.test(line.unitCode))
      return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
    return Object.freeze({
      lineReference: reference(line.lineReference),
      itemReference: reference(line.itemReference),
      lotReference: nullableReference(line.lotReference),
      locationReference: reference(line.locationReference),
      unitCode: line.unitCode,
      expectedQuantity: parseStockCountQuantity(line.expectedQuantity),
      countedQuantity: null,
      variance: null,
      varianceReasonCode: null,
      recountNumber: 0,
      balanceVersion: version(line.balanceVersion),
      movementReference: null,
    });
  });
  return Object.freeze({
    snapshotReference: reference(raw.snapshotReference),
    capturedAt: instant(raw.capturedAt),
    stockScope: capturedStockScope,
    lines: Object.freeze(lines),
  });
}

function countReference(command: StockCountCommand): InventoryReference {
  return reference(command.payload.countReference);
}

async function authorize(command: StockCountCommand, ports: StockCountPorts): Promise<void> {
  let result;
  try {
    result = await ports.authorization.authorize({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      purpose: command.purpose,
      permission: command.permission,
      action: command.action,
    });
  } catch {
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  }
  if (!result?.authorized) return fail("STOCK_COUNT_PERMISSION_DENIED");
}

async function apply(
  command: StockCountCommand,
  before: StockCountAggregate | null,
  ports: StockCountPorts,
): Promise<StockCountAggregate> {
  const payload = command.payload;
  if (command.action === "Create") {
    const snapshot = parseSnapshot(await ports.snapshot.capture(command), command);
    return createStockCount({
      countReference: ports.references.generate("StockCount"),
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      stockScope: snapshot.stockScope,
      countType: payload.countType as StockCountType,
      expectedQuantityVisibility: payload.expectedQuantityVisibility as
        "BlindUntilSubmit" | "Visible",
      movementControl: payload.movementControl as "FreezeMovements" | "SnapshotOnly",
      approvalPolicy: payload.approvalPolicy as "Segregated" | "SelfAllowed",
      snapshotReference: snapshot.snapshotReference,
      snapshotCapturedAt: snapshot.capturedAt,
      assigneeReference: payload.assigneeReference,
      dueAt: payload.dueAt,
      lines: snapshot.lines,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    });
  }
  if (!before) return fail("STOCK_COUNT_NOT_FOUND");
  if (
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference ||
    before.countReference !== countReference(command)
  )
    return fail("STOCK_COUNT_PERMISSION_DENIED");
  const expectedVersion = version(payload.expectedVersion);
  if (command.action === "Assign")
    return assignStockCount(
      before,
      payload.assigneeReference,
      expectedVersion,
      command.actorReference,
      command.occurredAt,
    );
  if (command.action === "Start")
    return startStockCount(before, expectedVersion, command.actorReference, command.occurredAt);
  if (command.action === "SaveLine")
    return saveStockCountLine(before, {
      lineReference: payload.lineReference,
      countedQuantity: payload.countedQuantity,
      unitCode: payload.unitCode,
      varianceReasonCode: payload.varianceReasonCode,
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    });
  if (command.action === "Submit")
    return submitStockCount(before, expectedVersion, command.actorReference, command.occurredAt);
  if (command.action === "Approve" || command.action === "Reject")
    return decideStockCount(before, {
      decision: command.action,
      reasonCode: reason(payload.reasonCode),
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    });
  if (command.action === "Cancel")
    return cancelStockCount(before, {
      reasonCode: reason(payload.reasonCode),
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    });
  return before;
}

function validateReplay(
  prior: StockCountCommandRecord,
  command: StockCountCommand,
  intentHash: string,
  ports: StockCountPorts,
): StockCountCommandRecord {
  if (
    prior.operationReference !== command.operationReference ||
    prior.action !== command.action ||
    prior.command.tenantReference !== command.tenantReference ||
    prior.command.brandReference !== command.brandReference ||
    prior.command.actorReference !== command.actorReference ||
    JSON.stringify(prior.command) !== JSON.stringify(command) ||
    !hashPattern.test(prior.intentHash) ||
    !ports.references.equals(prior.intentHash, intentHash)
  )
    return fail("STOCK_COUNT_IDEMPOTENCY_CONFLICT");
  return prior;
}

function sameScope(movement: StockMovementFact, line: StockCountLine): boolean {
  const expected = {
    scopeType: "Location",
    scopeReference: line.locationReference,
  } as const;
  const scope = line.variance?.startsWith("-") ? movement.sourceScope : movement.destinationScope;
  const opposite = line.variance?.startsWith("-")
    ? movement.destinationScope
    : movement.sourceScope;
  return (
    opposite === null &&
    scope?.scopeType === expected.scopeType &&
    scope.scopeReference === expected.scopeReference
  );
}

function validatePostedRecord(
  record: StockCountCommandRecord,
  before: StockCountAggregate,
  command: StockCountCommand,
  intentHash: string,
  audit: StockCountCommandRecord["audit"],
  ports: StockCountPorts,
): StockCountCommandRecord {
  const required = before.lines.filter((line) => line.variance !== "0");
  if (
    record.operationReference !== command.operationReference ||
    record.action !== "Post" ||
    record.count.status !== "Posted" ||
    record.count.aggregateVersion !== before.aggregateVersion + 1 ||
    record.movements.length !== required.length ||
    record.outcome !== "Applied" ||
    JSON.stringify(record.command) !== JSON.stringify(command) ||
    JSON.stringify(record.audit) !== JSON.stringify(audit) ||
    !ports.references.equals(record.intentHash, intentHash)
  )
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  const movements = Object.freeze(record.movements.map(parseStockMovementFact));
  const movementReferences = new Map<InventoryReference, InventoryReference>();
  const usedMovementReferences = new Set<InventoryReference>();
  for (const line of required) {
    const movement = movements.find(
      (candidate) =>
        candidate.itemReference === line.itemReference &&
        candidate.lotReference === line.lotReference &&
        candidate.reasonCode === line.varianceReasonCode &&
        sameScope(candidate, line),
    );
    if (
      !movement ||
      movementReferences.has(line.lineReference) ||
      usedMovementReferences.has(movement.movementReference) ||
      movement.movementType !== "CountAdjustment" ||
      movement.tenantReference !== command.tenantReference ||
      movement.brandReference !== command.brandReference ||
      String(movement.quantityDelta) !== String(line.variance) ||
      String(movement.baseQuantityDelta) !== String(line.variance) ||
      movement.unitCode !== line.unitCode ||
      movement.baseUnitCode !== line.unitCode ||
      movement.conversionMultiplier !== "1" ||
      movement.businessSourceType !== "STOCK_COUNT" ||
      movement.businessSourceReference !== before.countReference ||
      movement.performedBy !== command.actorReference ||
      movement.occurredAt !== command.occurredAt ||
      movement.auditReference !== record.audit.auditId ||
      movement.correctsMovementReference !== null ||
      movement.before.ledgerVersion !== line.balanceVersion
    )
      return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
    movementReferences.set(line.lineReference, movement.movementReference);
    usedMovementReferences.add(movement.movementReference);
  }
  const expected = markStockCountPosted(
    before,
    movementReferences,
    version(command.payload.expectedVersion),
    command.actorReference,
    command.occurredAt,
  );
  if (JSON.stringify(record.count) !== JSON.stringify(expected))
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({ ...record, count: expected, movements });
}

export async function executeStockCountCommand(
  value: unknown,
  ports: StockCountPorts,
): Promise<StockCountCommandRecord> {
  const command = parseStockCountCommand(value);
  await authorize(command, ports);
  try {
    const intentHash = ports.references.hashIntent(`StockCount:v1:${JSON.stringify(command)}`);
    if (!hashPattern.test(intentHash)) return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
    const prior = await ports.repository.resolveOperation(command.operationReference);
    if (prior) return validateReplay(prior, command, intentHash, ports);
    const before =
      command.action === "Create" ? null : await ports.repository.load(countReference(command));
    if (command.action === "Post") {
      if (!before) return fail("STOCK_COUNT_NOT_FOUND");
      if (
        before.tenantReference !== command.tenantReference ||
        before.brandReference !== command.brandReference
      )
        return fail("STOCK_COUNT_PERMISSION_DENIED");
      if (before.aggregateVersion !== version(command.payload.expectedVersion))
        return fail("STOCK_COUNT_CONFLICT");
      if (before.status !== "Approved") return fail("STOCK_COUNT_STATE_CONFLICT");
      const audit = await ports.audit.create({ command, before, after: null });
      return validatePostedRecord(
        await ports.posting.commit({ command, before, intentHash, audit }),
        before,
        command,
        intentHash,
        audit,
        ports,
      );
    }
    const after = await apply(command, before, ports);
    const audit = await ports.audit.create({ command, before, after });
    const record = await ports.repository.commit(
      Object.freeze({
        operationReference: command.operationReference,
        intentHash,
        action: command.action,
        command,
        count: after,
        movements: Object.freeze([]),
        audit,
        outcome: "Applied",
      }),
    );
    if (
      record.operationReference !== command.operationReference ||
      record.action !== command.action ||
      !ports.references.equals(record.intentHash, intentHash) ||
      record.count.countReference !== after.countReference ||
      record.count.aggregateVersion !== after.aggregateVersion ||
      JSON.stringify(record.count) !== JSON.stringify(after) ||
      JSON.stringify(record.command) !== JSON.stringify(command) ||
      JSON.stringify(record.audit) !== JSON.stringify(audit) ||
      record.outcome !== "Applied" ||
      record.movements.length !== 0
    )
      return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
    return record;
  } catch (error) {
    if (error instanceof StockCountError) throw error;
    return fail("STOCK_COUNT_DEPENDENCY_UNAVAILABLE");
  }
}
