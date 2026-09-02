import type {
  CorrectStockMovementCommand,
  StockMovementCorrectionRecord,
  StockMovementProjection,
  StockMovementQuery,
} from "../contracts/stock-movement.js";
import {
  InventoryItemError,
  parseInventoryInstant,
  parseInventoryReference,
} from "../domain/inventory-item.js";
import {
  negateInventoryDecimal,
  parseStockMovementFact,
  parseStockScope,
  StockMovementError,
  type StockMovementFact,
  type StockMovementType,
  type MovementStockScope,
} from "../domain/stock-movement.js";
import type { StockMovementPorts } from "./ports/stock-movement-ports.js";

const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const reasonPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const searchPattern = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
const movementTypes: readonly StockMovementType[] = [
  "Receive",
  "Reserve",
  "Release",
  "Consume",
  "Waste",
  "Transfer",
  "Adjustment",
  "CountAdjustment",
  "Correction",
];
const correctableTypes: readonly StockMovementType[] = [
  "Receive",
  "Consume",
  "Waste",
  "Adjustment",
  "CountAdjustment",
];

function fail(code: StockMovementError["code"]): never {
  throw new StockMovementError(code);
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
      return fail("STOCK_MOVEMENT_INVALID");
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("STOCK_MOVEMENT_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof StockMovementError) throw error;
    return fail("STOCK_MOVEMENT_INVALID");
  }
}

function reference(value: unknown) {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_MOVEMENT_INVALID");
    throw error;
  }
}

function instant(value: unknown) {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_MOVEMENT_INVALID");
    throw error;
  }
}

function nullableReference(value: unknown) {
  return value === null ? null : reference(value);
}

function nullableInstant(value: unknown) {
  return value === null ? null : instant(value);
}

function safeVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("STOCK_MOVEMENT_INVALID");
  return value as number;
}

function scopeMatches(movement: StockMovementFact, scope: MovementStockScope): boolean {
  return [movement.sourceScope, movement.destinationScope].some(
    (candidate) =>
      candidate?.scopeType === scope.scopeType && candidate.scopeReference === scope.scopeReference,
  );
}

function sameScope(left: MovementStockScope | null, right: MovementStockScope | null): boolean {
  return (
    (left === null && right === null) ||
    (left !== null &&
      right !== null &&
      left.scopeType === right.scopeType &&
      left.scopeReference === right.scopeReference)
  );
}

export function parseStockMovementQuery(value: unknown): StockMovementQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "movementReference",
    "itemReference",
    "movementTypes",
    "lotReference",
    "performedBy",
    "occurredFrom",
    "occurredUntil",
    "corrected",
    "search",
    "limit",
  ]);
  const rawMovementTypes = raw.movementTypes;
  if (
    raw.purpose !== "StockMovementRead" ||
    raw.permission !== "inventory.movement.read" ||
    !Array.isArray(rawMovementTypes) ||
    rawMovementTypes.length > movementTypes.length ||
    rawMovementTypes.some(
      (entry, index) =>
        typeof entry !== "string" ||
        !movementTypes.includes(entry as StockMovementType) ||
        rawMovementTypes.indexOf(entry) !== index,
    ) ||
    (raw.corrected !== null && typeof raw.corrected !== "boolean") ||
    (raw.search !== null &&
      (typeof raw.search !== "string" ||
        raw.search.trim() !== raw.search ||
        !searchPattern.test(raw.search))) ||
    !Number.isSafeInteger(raw.limit) ||
    (raw.limit as number) < 1 ||
    (raw.limit as number) > 200
  )
    return fail("STOCK_MOVEMENT_INVALID");
  const occurredFrom = nullableInstant(raw.occurredFrom);
  const occurredUntil = nullableInstant(raw.occurredUntil);
  if (occurredFrom && occurredUntil && Date.parse(occurredUntil) <= Date.parse(occurredFrom))
    return fail("STOCK_MOVEMENT_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "StockMovementRead",
    permission: "inventory.movement.read",
    stockScope: parseStockScope(raw.stockScope),
    movementReference: nullableReference(raw.movementReference),
    itemReference: nullableReference(raw.itemReference),
    movementTypes: Object.freeze(rawMovementTypes as StockMovementType[]),
    lotReference: nullableReference(raw.lotReference),
    performedBy: nullableReference(raw.performedBy),
    occurredFrom,
    occurredUntil,
    corrected: raw.corrected as boolean | null,
    search: raw.search as string | null,
    limit: raw.limit as number,
  });
}

export function parseCorrectStockMovementCommand(value: unknown): CorrectStockMovementCommand {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "operationReference",
    "occurredAt",
    "stockScope",
    "movementReference",
    "expectedBalanceVersion",
    "reasonCode",
  ]);
  if (
    raw.purpose !== "StockMovementCorrection" ||
    raw.permission !== "inventory.movement.correct" ||
    typeof raw.reasonCode !== "string" ||
    !reasonPattern.test(raw.reasonCode)
  )
    return fail("STOCK_MOVEMENT_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "StockMovementCorrection",
    permission: "inventory.movement.correct",
    operationReference: reference(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    stockScope: parseStockScope(raw.stockScope),
    movementReference: reference(raw.movementReference),
    expectedBalanceVersion: safeVersion(raw.expectedBalanceVersion),
    reasonCode: raw.reasonCode,
  });
}

async function authorize(
  input: {
    readonly tenantReference: StockMovementQuery["tenantReference"];
    readonly brandReference: StockMovementQuery["brandReference"];
    readonly actorReference: StockMovementQuery["actorReference"];
    readonly purpose: "StockMovementRead" | "StockMovementCorrection";
    readonly permission: "inventory.movement.read" | "inventory.movement.correct";
    readonly action: "List" | "Detail" | "Correct";
  },
  ports: StockMovementPorts,
): Promise<void> {
  let result;
  try {
    result = await ports.authorization.authorize(input);
  } catch {
    return fail("STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE");
  }
  if (!result?.authorized) return fail("STOCK_MOVEMENT_PERMISSION_DENIED");
}

function validateProjection(value: unknown, query: StockMovementQuery): StockMovementProjection {
  const raw = exact(value, [
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "movements",
  ]);
  if (
    raw.projectionName !== "inventory_movement_explorer_v1" ||
    raw.projectionVersion !== 1 ||
    !["Current", "Stale", "Rebuilding"].includes(String(raw.freshness)) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.movements) ||
    raw.movements.length > query.limit
  )
    return fail("STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE");
  const stockScope = parseStockScope(raw.stockScope);
  if (
    stockScope.scopeType !== query.stockScope.scopeType ||
    stockScope.scopeReference !== query.stockScope.scopeReference
  )
    return fail("STOCK_MOVEMENT_PERMISSION_DENIED");
  const movements = Object.freeze(
    raw.movements.map((value) => {
      const entry = exact(value, ["movement", "correctedByMovementReference"]);
      return Object.freeze({
        movement: parseStockMovementFact(entry.movement),
        correctedByMovementReference: nullableReference(entry.correctedByMovementReference),
      });
    }),
  );
  if (
    movements.some((entry) => {
      const movement = entry.movement;
      return (
        movement.tenantReference !== query.tenantReference ||
        movement.brandReference !== query.brandReference ||
        !scopeMatches(movement, query.stockScope) ||
        (query.movementReference !== null &&
          movement.movementReference !== query.movementReference) ||
        (query.itemReference !== null && movement.itemReference !== query.itemReference) ||
        (query.movementTypes.length > 0 && !query.movementTypes.includes(movement.movementType)) ||
        (query.lotReference !== null && movement.lotReference !== query.lotReference) ||
        (query.performedBy !== null && movement.performedBy !== query.performedBy) ||
        (query.occurredFrom !== null &&
          Date.parse(movement.occurredAt) < Date.parse(query.occurredFrom)) ||
        (query.occurredUntil !== null &&
          Date.parse(movement.occurredAt) >= Date.parse(query.occurredUntil)) ||
        (query.corrected === true && entry.correctedByMovementReference === null) ||
        (query.corrected === false && entry.correctedByMovementReference !== null)
      );
    })
  )
    return fail("STOCK_MOVEMENT_PERMISSION_DENIED");
  return Object.freeze({
    projectionName: "inventory_movement_explorer_v1",
    projectionVersion: 1,
    stockScope,
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as StockMovementProjection["freshness"],
    partial: raw.partial,
    movements,
  });
}

export async function queryStockMovements(
  value: unknown,
  ports: StockMovementPorts,
): Promise<StockMovementProjection> {
  const query = parseStockMovementQuery(value);
  await authorize(
    {
      tenantReference: query.tenantReference,
      brandReference: query.brandReference,
      actorReference: query.actorReference,
      purpose: query.purpose,
      permission: query.permission,
      action: query.movementReference ? "Detail" : "List",
    },
    ports,
  );
  try {
    return validateProjection(await ports.projection.query(query), query);
  } catch (error) {
    if (error instanceof StockMovementError) throw error;
    return fail("STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE");
  }
}

function validateReplay(
  prior: StockMovementCorrectionRecord,
  command: CorrectStockMovementCommand,
  intentHash: string,
  ports: StockMovementPorts,
): StockMovementCorrectionRecord {
  if (
    prior.operationReference !== command.operationReference ||
    prior.command.tenantReference !== command.tenantReference ||
    prior.command.brandReference !== command.brandReference ||
    prior.command.actorReference !== command.actorReference ||
    prior.command.movementReference !== command.movementReference ||
    prior.command.expectedBalanceVersion !== command.expectedBalanceVersion ||
    prior.command.reasonCode !== command.reasonCode ||
    prior.command.stockScope.scopeType !== command.stockScope.scopeType ||
    prior.command.stockScope.scopeReference !== command.stockScope.scopeReference ||
    !hashPattern.test(prior.intentHash) ||
    !ports.references.equals(prior.intentHash, intentHash)
  )
    return fail("STOCK_MOVEMENT_IDEMPOTENCY_CONFLICT");
  const original = parseStockMovementFact(prior.original);
  if (
    original.movementReference !== command.movementReference ||
    original.tenantReference !== command.tenantReference ||
    original.brandReference !== command.brandReference ||
    !scopeMatches(original, command.stockScope)
  )
    return fail("STOCK_MOVEMENT_IDEMPOTENCY_CONFLICT");
  return validateCorrectionRecord(prior, command, original, intentHash, ports);
}

function validateCorrectionRecord(
  record: StockMovementCorrectionRecord,
  command: CorrectStockMovementCommand,
  original: StockMovementFact,
  intentHash: string,
  ports: StockMovementPorts,
): StockMovementCorrectionRecord {
  const correction = parseStockMovementFact(record.correction);
  if (
    record.operationReference !== command.operationReference ||
    !ports.references.equals(record.intentHash, intentHash) ||
    record.original.movementReference !== original.movementReference ||
    correction.movementType !== "Correction" ||
    correction.correctsMovementReference !== original.movementReference ||
    correction.tenantReference !== command.tenantReference ||
    correction.brandReference !== command.brandReference ||
    correction.itemReference !== original.itemReference ||
    correction.quantityDelta !== negateInventoryDecimal(original.quantityDelta) ||
    correction.baseQuantityDelta !== negateInventoryDecimal(original.baseQuantityDelta) ||
    correction.unitCode !== original.unitCode ||
    correction.baseUnitCode !== original.baseUnitCode ||
    correction.conversionMultiplier !== original.conversionMultiplier ||
    correction.performedBy !== command.actorReference ||
    correction.occurredAt !== command.occurredAt ||
    correction.reasonCode !== command.reasonCode ||
    correction.businessSourceType !== "CORRECTION" ||
    correction.businessSourceReference !== original.movementReference ||
    correction.auditReference !== record.audit.auditId ||
    !scopeMatches(correction, command.stockScope) ||
    !sameScope(correction.sourceScope, original.destinationScope) ||
    !sameScope(correction.destinationScope, original.sourceScope) ||
    correction.before.ledgerVersion !== command.expectedBalanceVersion ||
    record.command.operationReference !== command.operationReference ||
    record.command.movementReference !== command.movementReference ||
    record.command.reasonCode !== command.reasonCode ||
    !["Applied", "AlreadyApplied"].includes(record.outcome)
  )
    return fail("STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({ ...record, original, correction });
}

export async function correctStockMovement(
  value: unknown,
  ports: StockMovementPorts,
): Promise<StockMovementCorrectionRecord> {
  const command = parseCorrectStockMovementCommand(value);
  await authorize(
    {
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      purpose: command.purpose,
      permission: command.permission,
      action: "Correct",
    },
    ports,
  );
  try {
    const intentHash = ports.references.hashIntent(
      `StockMovementCorrection:v1:${JSON.stringify(command)}`,
    );
    if (!hashPattern.test(intentHash)) return fail("STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE");
    const prior = await ports.ledger.resolveOperation(command.operationReference);
    if (prior) return validateReplay(prior, command, intentHash, ports);
    const loaded = await ports.ledger.load(command.movementReference);
    if (!loaded) return fail("STOCK_MOVEMENT_NOT_FOUND");
    const original = parseStockMovementFact(loaded);
    if (
      original.tenantReference !== command.tenantReference ||
      original.brandReference !== command.brandReference ||
      !scopeMatches(original, command.stockScope)
    )
      return fail("STOCK_MOVEMENT_PERMISSION_DENIED");
    if (
      !correctableTypes.includes(original.movementType) ||
      original.correctsMovementReference !== null
    )
      return fail("STOCK_MOVEMENT_NOT_CORRECTABLE");
    if (await ports.ledger.findCorrection(original.movementReference))
      return fail("STOCK_MOVEMENT_ALREADY_CORRECTED");
    if (
      (await ports.ledger.currentBalanceVersion({ original, command })) !==
      command.expectedBalanceVersion
    )
      return fail("STOCK_MOVEMENT_NOT_CORRECTABLE");
    const audit = await ports.audit.create({ command, original });
    const record = await ports.ledger.commitCorrection({ command, original, intentHash, audit });
    return validateCorrectionRecord(record, command, original, intentHash, ports);
  } catch (error) {
    if (error instanceof StockMovementError) throw error;
    return fail("STOCK_MOVEMENT_DEPENDENCY_UNAVAILABLE");
  }
}
