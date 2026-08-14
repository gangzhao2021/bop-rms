import type {
  StockWasteAction,
  StockWasteCommand,
  StockWasteCommandRecord,
  StockWastePermission,
  StockWasteProjection,
  StockWasteQuery,
} from "../contracts/stock-waste.js";
import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryReference,
  type NegativeStockPolicy,
} from "../domain/inventory-item.js";
import {
  cancelStockWaste,
  createValidatedStockWaste,
  decideStockWaste,
  markStockWastePosted,
  StockWasteError,
  submitStockWaste,
  type StockWasteAggregate,
} from "../domain/stock-waste.js";
import {
  parseSignedInventoryDecimal,
  parseStockMovementFact,
  parseStockScope,
  StockMovementError,
  type MovementStockScope,
} from "../domain/stock-movement.js";
import type { StockWastePorts } from "./ports/stock-waste-ports.js";

const actions: readonly StockWasteAction[] = [
  "Validate",
  "Submit",
  "Approve",
  "Reject",
  "Cancel",
  "Post",
];
const permissions: Record<
  StockWasteAction,
  Exclude<StockWastePermission, "inventory.waste.read">
> = {
  Validate: "inventory.waste.record",
  Submit: "inventory.waste.record",
  Approve: "inventory.waste.approve",
  Reject: "inventory.waste.approve",
  Cancel: "inventory.waste.record",
  Post: "inventory.waste.post",
};
const hashPattern = /^sha256:[0-9a-f]{64}$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function fail(code: StockWasteError["code"]): never {
  throw new StockWasteError(code);
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
      return fail("STOCK_WASTE_INVALID");
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("STOCK_WASTE_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof StockWasteError) throw error;
    return fail("STOCK_WASTE_INVALID");
  }
}

function reference(value: unknown) {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_WASTE_INVALID");
    throw error;
  }
}

function instant(value: unknown) {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("STOCK_WASTE_INVALID");
    throw error;
  }
}

function scope(value: unknown): MovementStockScope {
  try {
    return parseStockScope(value);
  } catch (error) {
    if (error instanceof StockMovementError) return fail("STOCK_WASTE_INVALID");
    throw error;
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("STOCK_WASTE_INVALID");
  return value as number;
}

function controlled(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail("STOCK_WASTE_INVALID");
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return fail("STOCK_WASTE_INVALID");
  return value as T;
}

function nullableReference(value: unknown) {
  return value === null ? null : reference(value);
}

function parsePayload(action: StockWasteAction, value: unknown) {
  const fields: Record<StockWasteAction, readonly string[]> = {
    Validate: [
      "stockScope",
      "itemReference",
      "lotReference",
      "locationReference",
      "quantityDelta",
      "unitCode",
      "reasonCode",
      "sourceType",
      "sourceReference",
      "evidenceReferences",
    ],
    Submit: ["stockScope", "wasteReference", "expectedVersion"],
    Approve: ["stockScope", "wasteReference", "expectedVersion", "reasonCode"],
    Reject: ["stockScope", "wasteReference", "expectedVersion", "reasonCode"],
    Cancel: ["stockScope", "wasteReference", "expectedVersion", "reasonCode"],
    Post: ["stockScope", "wasteReference", "expectedVersion"],
  };
  const raw = exact(value, fields[action]);
  if (action === "Validate") {
    scope(raw.stockScope);
    reference(raw.itemReference);
    nullableReference(raw.lotReference);
    reference(raw.locationReference);
    try {
      const quantity = parseInventoryDecimal(raw.quantityDelta);
      if (quantity === "0" || /^0\.0+$/u.test(quantity)) throw new Error("zero quantity");
    } catch {
      return fail("STOCK_WASTE_INVALID");
    }
    controlled(raw.unitCode, unitPattern);
    controlled(raw.reasonCode, codePattern);
    oneOf(raw.sourceType, ["Inventory", "Kitchen", "FoodSafetyIncident"]);
    const sourceReference = nullableReference(raw.sourceReference);
    if ((raw.sourceType === "Inventory") !== (sourceReference === null))
      return fail("STOCK_WASTE_INVALID");
    if (
      !Array.isArray(raw.evidenceReferences) ||
      raw.evidenceReferences.length < 1 ||
      raw.evidenceReferences.length > 20
    )
      return fail("STOCK_WASTE_INVALID");
    const evidence = raw.evidenceReferences.map(reference);
    if (new Set(evidence).size !== evidence.length) return fail("STOCK_WASTE_INVALID");
  } else {
    scope(raw.stockScope);
    reference(raw.wasteReference);
    version(raw.expectedVersion);
    if (["Approve", "Reject", "Cancel"].includes(action)) controlled(raw.reasonCode, codePattern);
  }
  return Object.freeze(raw);
}

export function parseStockWasteCommand(value: unknown): StockWasteCommand {
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
    raw.purpose !== "StockWasteManagement" ||
    typeof raw.action !== "string" ||
    !actions.includes(raw.action as StockWasteAction)
  )
    return fail("STOCK_WASTE_INVALID");
  const action = raw.action as StockWasteAction;
  if (raw.permission !== permissions[action]) return fail("STOCK_WASTE_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "StockWasteManagement",
    permission: permissions[action],
    operationReference: reference(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: parsePayload(action, raw.payload),
  });
}

export function parseStockWasteQuery(value: unknown): StockWasteQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "wasteReference",
  ]);
  if (raw.purpose !== "StockWasteRead" || raw.permission !== "inventory.waste.read")
    return fail("STOCK_WASTE_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "StockWasteRead",
    permission: "inventory.waste.read",
    stockScope: scope(raw.stockScope),
    wasteReference: reference(raw.wasteReference),
  });
}

async function authorize(
  input: StockWasteCommand | StockWasteQuery,
  action: StockWasteAction | "Detail",
  ports: StockWastePorts,
) {
  try {
    const result = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action,
      stockScope: "stockScope" in input ? input.stockScope : scope(input.payload.stockScope),
    });
    if (!result?.authorized) return fail("STOCK_WASTE_PERMISSION_DENIED");
    return result;
  } catch (error) {
    if (error instanceof StockWasteError) throw error;
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  }
}

function sameScope(left: MovementStockScope, right: MovementStockScope): boolean {
  return left.scopeType === right.scopeType && left.scopeReference === right.scopeReference;
}

export async function queryStockWaste(
  value: unknown,
  ports: StockWastePorts,
): Promise<StockWasteProjection> {
  const query = parseStockWasteQuery(value);
  const authorization = await authorize(query, "Detail", ports);
  try {
    const result = await ports.projection.query(query);
    const waste = result.waste;
    if (
      result.projectionName !== "inventory_waste_wizard_v1" ||
      result.projectionVersion !== 1 ||
      !["Current", "Stale", "Rebuilding"].includes(result.freshness) ||
      typeof result.partial !== "boolean" ||
      !sameScope(result.stockScope, query.stockScope) ||
      !sameScope(waste.stockScope, query.stockScope) ||
      waste.wasteReference !== query.wasteReference ||
      waste.tenantReference !== query.tenantReference ||
      waste.brandReference !== query.brandReference
    )
      return fail("STOCK_WASTE_PERMISSION_DENIED");
    return Object.freeze({
      projectionName: "inventory_waste_wizard_v1",
      projectionVersion: 1,
      stockScope: query.stockScope,
      asOfUtc: instant(result.asOfUtc),
      freshness: result.freshness,
      partial: result.partial,
      waste: Object.freeze({
        ...waste,
        evidenceReferences:
          authorization.mayViewEvidence === true ? waste.evidenceReferences : null,
        costSummary: authorization.mayViewCost === true ? waste.costSummary : null,
      }),
    });
  } catch (error) {
    if (error instanceof StockWasteError) throw error;
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  }
}

function parseDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  return value;
}

function parseEvidence(value: unknown, command: StockWasteCommand) {
  const raw = exact(value, ["evidenceReferences"]);
  if (!Array.isArray(raw.evidenceReferences)) return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  const resolved = raw.evidenceReferences.map(reference);
  const requested = (command.payload.evidenceReferences as readonly unknown[]).map(reference);
  if (
    resolved.length !== requested.length ||
    new Set(resolved).size !== resolved.length ||
    resolved.some((entry) => !requested.includes(entry))
  )
    return fail("STOCK_WASTE_PERMISSION_DENIED");
  return Object.freeze(resolved);
}

function parseSource(value: unknown, command: StockWasteCommand) {
  const raw = exact(value, ["sourceType", "sourceReference"]);
  const sourceType = oneOf(raw.sourceType, ["Inventory", "Kitchen", "FoodSafetyIncident"]);
  const sourceReference = nullableReference(raw.sourceReference);
  if (
    sourceType !== command.payload.sourceType ||
    sourceReference !== nullableReference(command.payload.sourceReference) ||
    (sourceType === "Inventory") !== (sourceReference === null)
  )
    return fail("STOCK_WASTE_PERMISSION_DENIED");
  return Object.freeze({ sourceType, sourceReference });
}

function parsePolicy(value: unknown) {
  const raw = exact(value, ["approvalRequirement", "approvalPolicyReference"]);
  return Object.freeze({
    approvalRequirement: oneOf(raw.approvalRequirement, ["Required", "NotRequired"]),
    approvalPolicyReference: reference(raw.approvalPolicyReference),
  });
}

function parseValuation(value: unknown) {
  const raw = exact(value, ["costSummary"]);
  if (raw.costSummary === null) return null;
  const cost = exact(raw.costSummary, ["minorUnits", "currencyCode", "valuationReference"]);
  return Object.freeze({
    minorUnits: controlled(cost.minorUnits, /^(?:0|[1-9][0-9]{0,18})$/u),
    currencyCode: controlled(cost.currencyCode, /^[A-Z]{3}$/u),
    valuationReference: reference(cost.valuationReference),
  });
}

function parseSnapshot(value: unknown, command: StockWasteCommand) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockScope",
    "itemReference",
    "lotReference",
    "locationReference",
    "expiryDate",
    "currentOnHand",
    "currentReserved",
    "currentAvailable",
    "currentInTransit",
    "baseUnitCode",
    "conversionMultiplier",
    "balanceVersion",
    "itemLifecycle",
    "negativeStockPolicy",
    "lotRequirement",
  ]);
  const requested = command.payload;
  const resolvedScope = scope(raw.stockScope);
  const lotReference = nullableReference(raw.lotReference);
  const requestedLot = nullableReference(requested.lotReference);
  if (
    raw.tenantReference !== command.tenantReference ||
    raw.brandReference !== command.brandReference ||
    !sameScope(resolvedScope, scope(requested.stockScope)) ||
    reference(raw.itemReference) !== reference(requested.itemReference) ||
    lotReference !== requestedLot ||
    reference(raw.locationReference) !== reference(requested.locationReference) ||
    raw.itemLifecycle === "Archived" ||
    !["Active", "Inactive"].includes(String(raw.itemLifecycle)) ||
    !["NoLot", "LotOptional", "LotRequired", "LotAndExpiryRequired"].includes(
      String(raw.lotRequirement),
    ) ||
    (["LotRequired", "LotAndExpiryRequired"].includes(String(raw.lotRequirement)) &&
      lotReference === null) ||
    (raw.lotRequirement === "LotAndExpiryRequired" && raw.expiryDate === null)
  )
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  try {
    if (raw.currentOnHand !== "0") parseSignedInventoryDecimal(raw.currentOnHand);
    if (raw.currentAvailable !== "0") parseSignedInventoryDecimal(raw.currentAvailable);
    parseInventoryDecimal(raw.currentReserved);
    parseInventoryDecimal(raw.currentInTransit);
    const conversion = parseInventoryDecimal(raw.conversionMultiplier);
    if (conversion === "0" || /^0\.0+$/u.test(conversion)) throw new Error("invalid conversion");
  } catch {
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  }
  return Object.freeze({
    stockScope: resolvedScope,
    itemReference: reference(raw.itemReference),
    lotReference,
    locationReference: reference(raw.locationReference),
    expiryDate: parseDate(raw.expiryDate),
    currentOnHand: raw.currentOnHand,
    currentReserved: raw.currentReserved,
    currentAvailable: raw.currentAvailable,
    currentInTransit: raw.currentInTransit,
    baseUnitCode: controlled(raw.baseUnitCode, unitPattern),
    conversionMultiplier: raw.conversionMultiplier,
    balanceVersion: version(raw.balanceVersion),
    negativeStockPolicy: oneOf(raw.negativeStockPolicy, [
      "Block",
      "ManagerOverride",
      "AllowWithWarning",
    ]) as NegativeStockPolicy,
  });
}

function wasteReference(command: StockWasteCommand): InventoryReference {
  return reference(command.payload.wasteReference);
}

function validateReplay(
  prior: StockWasteCommandRecord,
  command: StockWasteCommand,
  intentHash: string,
  ports: StockWastePorts,
) {
  if (
    prior.operationReference !== command.operationReference ||
    prior.action !== command.action ||
    JSON.stringify(prior.command) !== JSON.stringify(command) ||
    !hashPattern.test(prior.intentHash) ||
    !ports.references.equals(prior.intentHash, intentHash)
  )
    return fail("STOCK_WASTE_IDEMPOTENCY_CONFLICT");
  return prior;
}

async function apply(
  command: StockWasteCommand,
  before: StockWasteAggregate | null,
  authorization: Awaited<ReturnType<typeof authorize>>,
  ports: StockWastePorts,
): Promise<StockWasteAggregate> {
  if (command.action === "Validate") {
    let snapshot;
    let evidenceReferences;
    let source;
    let policy;
    let costSummary;
    try {
      snapshot = parseSnapshot(await ports.snapshot.inspect(command), command);
      evidenceReferences = parseEvidence(await ports.evidence.resolve(command), command);
      source = parseSource(await ports.source.resolve(command), command);
      policy = parsePolicy(await ports.policy.decide(command));
      costSummary = parseValuation(await ports.valuation.inspect(command));
    } catch (error) {
      if (error instanceof StockWasteError && error.code === "STOCK_WASTE_PERMISSION_DENIED")
        throw error;
      return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
    }
    try {
      return createValidatedStockWaste({
        wasteReference: ports.references.generate("StockWaste"),
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
        stockScope: snapshot.stockScope,
        itemReference: snapshot.itemReference,
        lotReference: snapshot.lotReference,
        expiryDate: snapshot.expiryDate,
        locationReference: snapshot.locationReference,
        quantityDelta: command.payload.quantityDelta,
        unitCode: command.payload.unitCode,
        baseUnitCode: snapshot.baseUnitCode,
        conversionMultiplier: snapshot.conversionMultiplier,
        reasonCode: command.payload.reasonCode,
        sourceType: source.sourceType,
        sourceReference: source.sourceReference,
        evidenceReferences,
        approvalRequirement: policy.approvalRequirement,
        approvalPolicyReference: policy.approvalPolicyReference,
        costSummary,
        currentOnHand: snapshot.currentOnHand,
        currentReserved: snapshot.currentReserved,
        currentAvailable: snapshot.currentAvailable,
        currentInTransit: snapshot.currentInTransit,
        balanceVersion: snapshot.balanceVersion,
        negativeStockPolicy: snapshot.negativeStockPolicy,
        negativeOverrideAuthorized: authorization.negativeOverrideAuthorized === true,
        actorReference: command.actorReference,
        occurredAt: command.occurredAt,
      });
    } catch (error) {
      if (error instanceof StockWasteError && error.code !== "STOCK_WASTE_INVALID") throw error;
      return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
    }
  }
  if (!before) return fail("STOCK_WASTE_NOT_FOUND");
  if (
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference ||
    before.wasteReference !== wasteReference(command)
  )
    return fail("STOCK_WASTE_PERMISSION_DENIED");
  if (!sameScope(before.stockScope, scope(command.payload.stockScope)))
    return fail("STOCK_WASTE_PERMISSION_DENIED");
  const expectedVersion = version(command.payload.expectedVersion);
  if (command.action === "Submit")
    return submitStockWaste(before, expectedVersion, command.actorReference, command.occurredAt);
  if (command.action === "Approve" || command.action === "Reject")
    return decideStockWaste(before, {
      decision: command.action,
      expectedVersion,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
      reasonCode: controlled(command.payload.reasonCode, codePattern),
    });
  if (command.action === "Cancel")
    return cancelStockWaste(
      before,
      expectedVersion,
      command.actorReference,
      command.occurredAt,
      controlled(command.payload.reasonCode, codePattern),
    );
  return before;
}

function validatePostedRecord(
  record: StockWasteCommandRecord,
  before: StockWasteAggregate,
  command: StockWasteCommand,
  intentHash: string,
  audit: StockWasteCommandRecord["audit"],
  ports: StockWastePorts,
): StockWasteCommandRecord {
  if (!record.movement) return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  const movement = parseStockMovementFact(record.movement);
  const positive = !before.baseQuantityDelta.startsWith("-");
  const movementScope = Object.freeze({
    scopeType: "Location" as const,
    scopeReference: before.locationReference,
  });
  if (
    record.operationReference !== command.operationReference ||
    record.action !== "Post" ||
    record.outcome !== "Applied" ||
    JSON.stringify(record.command) !== JSON.stringify(command) ||
    JSON.stringify(record.audit) !== JSON.stringify(audit) ||
    !ports.references.equals(record.intentHash, intentHash) ||
    movement.movementType !== "Waste" ||
    movement.tenantReference !== command.tenantReference ||
    movement.brandReference !== command.brandReference ||
    movement.itemReference !== before.itemReference ||
    movement.quantityDelta !== before.quantityDelta ||
    movement.unitCode !== before.unitCode ||
    movement.baseQuantityDelta !== before.baseQuantityDelta ||
    movement.baseUnitCode !== before.baseUnitCode ||
    movement.conversionMultiplier !== before.conversionMultiplier ||
    movement.lotReference !== before.lotReference ||
    movement.expiryDate !== before.expiryDate ||
    movement.businessSourceType !== "STOCK_WASTE" ||
    movement.businessSourceReference !== before.wasteReference ||
    movement.reasonCode !== before.reasonCode ||
    movement.performedBy !== command.actorReference ||
    movement.occurredAt !== command.occurredAt ||
    movement.before.onHand !== before.currentOnHand ||
    movement.before.reserved !== before.currentReserved ||
    movement.before.available !== before.currentAvailable ||
    movement.before.inTransit !== before.currentInTransit ||
    movement.before.unitCode !== before.baseUnitCode ||
    movement.before.ledgerVersion !== before.balanceVersion ||
    movement.after.onHand !== before.projectedOnHand ||
    movement.after.reserved !== before.currentReserved ||
    movement.after.available !== before.projectedAvailable ||
    movement.after.inTransit !== before.currentInTransit ||
    movement.after.unitCode !== before.baseUnitCode ||
    movement.after.ledgerVersion !== before.balanceVersion + 1 ||
    movement.auditReference !== audit.auditId ||
    movement.correctsMovementReference !== null ||
    (positive
      ? movement.sourceScope !== null ||
        !movement.destinationScope ||
        !sameScope(movement.destinationScope, movementScope)
      : movement.destinationScope !== null ||
        !movement.sourceScope ||
        !sameScope(movement.sourceScope, movementScope))
  )
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  const expected = markStockWastePosted(
    before,
    movement.movementReference,
    version(command.payload.expectedVersion),
    command.actorReference,
    command.occurredAt,
  );
  if (JSON.stringify(record.waste) !== JSON.stringify(expected))
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  return Object.freeze({ ...record, waste: expected, movement });
}

export async function executeStockWasteCommand(
  value: unknown,
  ports: StockWastePorts,
): Promise<StockWasteCommandRecord> {
  const command = parseStockWasteCommand(value);
  const authorization = await authorize(command, command.action, ports);
  try {
    const intentHash = ports.references.hashIntent(`StockWaste:v1:${JSON.stringify(command)}`);
    if (!hashPattern.test(intentHash)) return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
    const prior = await ports.repository.resolveOperation(command.operationReference);
    if (prior) return validateReplay(prior, command, intentHash, ports);
    const before =
      command.action === "Validate" ? null : await ports.repository.load(wasteReference(command));
    if (command.action === "Post") {
      if (!before) return fail("STOCK_WASTE_NOT_FOUND");
      if (
        before.tenantReference !== command.tenantReference ||
        before.brandReference !== command.brandReference ||
        !sameScope(before.stockScope, scope(command.payload.stockScope))
      )
        return fail("STOCK_WASTE_PERMISSION_DENIED");
      if (before.aggregateVersion !== version(command.payload.expectedVersion))
        return fail("STOCK_WASTE_CONFLICT");
      if (before.status !== "Approved") return fail("STOCK_WASTE_STATE_CONFLICT");
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
    const after = await apply(command, before, authorization, ports);
    const audit = await ports.audit.create({ command, before, after });
    const record = await ports.repository.commit(
      Object.freeze({
        operationReference: command.operationReference,
        intentHash,
        action: command.action,
        command,
        waste: after,
        movement: null,
        audit,
        outcome: "Applied",
      }),
    );
    if (
      record.operationReference !== command.operationReference ||
      record.action !== command.action ||
      record.outcome !== "Applied" ||
      !ports.references.equals(record.intentHash, intentHash) ||
      JSON.stringify(record.command) !== JSON.stringify(command) ||
      JSON.stringify(record.waste) !== JSON.stringify(after) ||
      JSON.stringify(record.audit) !== JSON.stringify(audit) ||
      record.movement !== null
    )
      return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
    return record;
  } catch (error) {
    if (error instanceof StockWasteError) throw error;
    return fail("STOCK_WASTE_DEPENDENCY_UNAVAILABLE");
  }
}
