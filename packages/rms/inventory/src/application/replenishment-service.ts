import type {
  ReplenishmentCommand,
  ReplenishmentCommandRecord,
  ReplenishmentProjection,
  ReplenishmentQuery,
} from "../contracts/replenishment.js";
import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryReference,
} from "../domain/inventory-item.js";
import {
  acknowledgeReplenishmentNeed,
  dismissReplenishmentNeed,
  linkRequisitionDraft,
  ReplenishmentNeedError,
  type ReplenishmentNeedAggregate,
} from "../domain/replenishment-need.js";
import type { MovementStockScope } from "../domain/stock-movement.js";
import type { ReplenishmentPorts } from "./ports/replenishment-ports.js";

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const safeText = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,200}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function fail(code: ReplenishmentNeedError["code"]): never {
  throw new ReplenishmentNeedError(code);
}
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("REPLENISHMENT_INVALID");
  return value as Record<string, unknown>;
}
function reference(value: unknown): InventoryReference {
  try {
    return parseInventoryReference(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("REPLENISHMENT_INVALID");
    throw error;
  }
}
function nullableReference(value: unknown) {
  return value === null ? null : reference(value);
}
function instant(value: unknown) {
  try {
    return parseInventoryInstant(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("REPLENISHMENT_INVALID");
    throw error;
  }
}
function decimal(value: unknown) {
  try {
    return parseInventoryDecimal(value);
  } catch (error) {
    if (error instanceof InventoryItemError) return fail("REPLENISHMENT_INVALID");
    throw error;
  }
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    return fail("REPLENISHMENT_INVALID");
  return value as T;
}
function version(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail("REPLENISHMENT_INVALID");
  return value as number;
}
function code(value: unknown, pattern = codePattern) {
  if (typeof value !== "string" || !pattern.test(value)) return fail("REPLENISHMENT_INVALID");
  return value;
}
function date(value: unknown) {
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    return fail("REPLENISHMENT_INVALID");
  return value;
}
function scope(value: unknown): MovementStockScope {
  const raw = exact(value, ["scopeType", "scopeReference"]);
  return Object.freeze({
    scopeType: oneOf(raw.scopeType, ["Store", "StockSite", "Location"]),
    scopeReference: reference(raw.scopeReference),
  });
}
const sameScope = (left: MovementStockScope, right: MovementStockScope) =>
  left.scopeType === right.scopeType && left.scopeReference === right.scopeReference;

function query(value: unknown): ReplenishmentQuery {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "search",
    "storeReference",
    "status",
    "urgency",
    "supplier",
    "supplierReference",
    "cursor",
  ]);
  if (
    raw.purpose !== "ReplenishmentRead" ||
    !["inventory.manage", "procurement.requisition.create"].includes(String(raw.permission)) ||
    (raw.search !== null &&
      (typeof raw.search !== "string" ||
        raw.search.trim() !== raw.search ||
        raw.search.length > 100 ||
        (raw.search.length > 0 && !safeText.test(raw.search)))) ||
    (raw.cursor !== null && (typeof raw.cursor !== "string" || !cursorPattern.test(raw.cursor)))
  )
    return fail("REPLENISHMENT_INVALID");
  const supplier = oneOf(raw.supplier, ["All", "Mapped", "Unmapped"]);
  const supplierReference = nullableReference(raw.supplierReference);
  if (
    (supplier === "Unmapped" && supplierReference !== null) ||
    (supplierReference !== null && supplier !== "Mapped")
  )
    return fail("REPLENISHMENT_INVALID");
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "ReplenishmentRead",
    permission: raw.permission as ReplenishmentQuery["permission"],
    stockScope: scope(raw.stockScope),
    search: raw.search as string | null,
    storeReference: nullableReference(raw.storeReference),
    status: oneOf(raw.status, [
      "All",
      "Open",
      "Acknowledged",
      "RequisitionDraftCreated",
      "Dismissed",
    ]),
    urgency: oneOf(raw.urgency, ["All", "Low", "Normal", "High", "Critical"]),
    supplier,
    supplierReference,
    cursor: raw.cursor as string | null,
  });
}

function command(value: unknown): ReplenishmentCommand {
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
  const action = oneOf(raw.action, ["Acknowledge", "CreateRequisitionDraft", "Dismiss"]);
  const expectedPermission =
    action === "CreateRequisitionDraft" ? "procurement.requisition.create" : "inventory.manage";
  if (raw.purpose !== "ReplenishmentManagement" || raw.permission !== expectedPermission)
    return fail("REPLENISHMENT_INVALID");
  const fields =
    action === "Dismiss"
      ? ["stockScope", "needReference", "expectedVersion", "reasonCode"]
      : ["stockScope", "needReference", "expectedVersion"];
  const payload = exact(raw.payload, fields);
  return Object.freeze({
    tenantReference: reference(raw.tenantReference),
    brandReference: reference(raw.brandReference),
    actorReference: reference(raw.actorReference),
    purpose: "ReplenishmentManagement",
    permission: expectedPermission,
    operationReference: reference(raw.operationReference),
    occurredAt: instant(raw.occurredAt),
    action,
    payload: Object.freeze({
      stockScope: scope(payload.stockScope),
      needReference: reference(payload.needReference),
      expectedVersion: version(payload.expectedVersion),
      ...(action === "Dismiss" ? { reasonCode: code(payload.reasonCode) } : {}),
    }),
  });
}

function validateProjection(
  projection: ReplenishmentProjection,
  input: ReplenishmentQuery,
  supplierVisible: boolean,
) {
  if (
    projection.projectionName !== "inventory_replenishment_v1" ||
    projection.projectionVersion !== 1 ||
    projection.tenantReference !== input.tenantReference ||
    projection.brandReference !== input.brandReference ||
    !sameScope(projection.stockScope, input.stockScope) ||
    !["Current", "Stale", "Rebuilding"].includes(projection.freshness) ||
    typeof projection.partial !== "boolean" ||
    !Array.isArray(projection.rows) ||
    projection.rows.length > 200 ||
    (projection.nextCursor !== null && !cursorPattern.test(projection.nextCursor))
  )
    return fail("REPLENISHMENT_INVALID");
  instant(projection.asOfUtc);
  const seen = new Set<string>();
  for (const row of projection.rows) {
    const needReference = reference(row.needReference);
    if (seen.has(needReference)) return fail("REPLENISHMENT_INVALID");
    seen.add(needReference);
    version(row.needVersion);
    reference(row.itemReference);
    if (
      !safeText.test(row.itemName) ||
      !safeText.test(row.internalCode) ||
      !unitPattern.test(row.baseUnitCode) ||
      !codePattern.test(row.reasonCode)
    )
      return fail("REPLENISHMENT_INVALID");
    decimal(row.available);
    decimal(row.reorderPoint);
    decimal(row.safetyStock);
    decimal(row.forecastQuantity);
    decimal(row.suggestedQuantity);
    reference(row.forecastReference);
    instant(row.forecastAsOfUtc);
    date(row.requiredBy);
    oneOf(row.urgency, ["Low", "Normal", "High", "Critical"]);
    oneOf(row.status, ["Open", "Acknowledged", "RequisitionDraftCreated", "Dismissed"]);
    const mapping = nullableReference(row.preferredSupplierMappingReference);
    const supplier = nullableReference(row.preferredSupplierReference);
    const requisition = nullableReference(row.requisitionReference);
    if (
      (!supplierVisible &&
        (mapping !== null || supplier !== null || row.preferredSupplierSummary !== null)) ||
      (mapping === null) !== (supplier === null) ||
      (supplier === null) !== (row.preferredSupplierSummary === null) ||
      (row.preferredSupplierSummary !== null && !safeText.test(row.preferredSupplierSummary)) ||
      (row.status === "RequisitionDraftCreated") !== (requisition !== null)
    )
      return fail("REPLENISHMENT_INVALID");
  }
}

export async function queryReplenishment(value: unknown, ports: ReplenishmentPorts) {
  const input = query(value);
  let access;
  try {
    access = await ports.authorization.authorize({ ...input, action: "List" });
  } catch {
    return fail("REPLENISHMENT_DEPENDENCY_UNAVAILABLE");
  }
  if (!access?.authorized) return fail("REPLENISHMENT_PERMISSION_DENIED");
  if (
    (input.supplier !== "All" || input.supplierReference !== null) &&
    !access.mayViewSupplierSummary
  )
    return fail("REPLENISHMENT_PERMISSION_DENIED");
  try {
    const projection = await ports.projection.query(input);
    validateProjection(projection, input, access.mayViewSupplierSummary === true);
    return projection;
  } catch (error) {
    if (error instanceof ReplenishmentNeedError) throw error;
    return fail("REPLENISHMENT_DEPENDENCY_UNAVAILABLE");
  }
}

interface Payload {
  stockScope: MovementStockScope;
  needReference: InventoryReference;
  expectedVersion: number;
  reasonCode?: string;
}
function validateSnapshot(
  value: unknown,
  input: ReplenishmentCommand,
  before: ReplenishmentNeedAggregate,
) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockScope",
    "needReference",
    "itemReference",
    "available",
    "reorderPoint",
    "safetyStock",
    "forecastQuantity",
    "suggestedQuantity",
    "baseUnitCode",
    "requiredBy",
    "reasonCode",
    "urgency",
    "policyReference",
    "balanceVersion",
    "forecastReference",
    "forecastAsOfUtc",
    "needVersion",
    "needStatus",
  ]);
  const payload = input.payload as unknown as Payload;
  const parsed = {
    stockScope: scope(raw.stockScope),
    itemReference: reference(raw.itemReference),
    available: decimal(raw.available),
    reorderPoint: decimal(raw.reorderPoint),
    safetyStock: decimal(raw.safetyStock),
    forecastQuantity: decimal(raw.forecastQuantity),
    suggestedQuantity: decimal(raw.suggestedQuantity),
    baseUnitCode: code(raw.baseUnitCode, unitPattern),
    requiredBy: date(raw.requiredBy),
    reasonCode: code(raw.reasonCode),
    urgency: oneOf(raw.urgency, ["Low", "Normal", "High", "Critical"]),
    policyReference: reference(raw.policyReference),
    balanceVersion: version(raw.balanceVersion),
    forecastReference: reference(raw.forecastReference),
    forecastAsOfUtc: instant(raw.forecastAsOfUtc),
    needVersion: version(raw.needVersion),
    needStatus: oneOf(raw.needStatus, [
      "Open",
      "Acknowledged",
      "RequisitionDraftCreated",
      "Dismissed",
    ] as const),
  };
  if (
    raw.tenantReference !== input.tenantReference ||
    raw.brandReference !== input.brandReference ||
    !sameScope(parsed.stockScope, payload.stockScope) ||
    reference(raw.needReference) !== payload.needReference ||
    parsed.needVersion !== before.aggregateVersion ||
    parsed.needStatus !== before.status ||
    parsed.itemReference !== before.itemReference ||
    parsed.available !== before.available ||
    parsed.reorderPoint !== before.reorderPoint ||
    parsed.safetyStock !== before.safetyStock ||
    parsed.forecastQuantity !== before.forecastQuantity ||
    parsed.suggestedQuantity !== before.suggestedQuantity ||
    parsed.baseUnitCode !== before.baseUnitCode ||
    parsed.requiredBy !== before.requiredBy ||
    parsed.reasonCode !== before.reasonCode ||
    parsed.urgency !== before.urgency ||
    parsed.policyReference !== before.policyReference ||
    parsed.balanceVersion !== before.balanceVersion ||
    parsed.forecastReference !== before.forecastReference ||
    parsed.forecastAsOfUtc !== before.forecastAsOfUtc
  )
    return fail("REPLENISHMENT_CONFLICT");
  return parsed;
}

function validateDraft(
  value: unknown,
  input: ReplenishmentCommand,
  before: ReplenishmentNeedAggregate,
) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "stockScope",
    "sourceNeedReference",
    "requisitionReference",
    "workflowStatus",
    "purchaseOrderReference",
  ]);
  if (
    raw.tenantReference !== input.tenantReference ||
    raw.brandReference !== input.brandReference ||
    !sameScope(scope(raw.stockScope), before.stockScope) ||
    reference(raw.sourceNeedReference) !== before.needReference ||
    raw.workflowStatus !== "Draft" ||
    raw.purchaseOrderReference !== null
  )
    return fail("REPLENISHMENT_DEPENDENCY_UNAVAILABLE");
  return reference(raw.requisitionReference);
}

const intent = (value: ReplenishmentCommand) => JSON.stringify(value);
export async function executeReplenishment(value: unknown, ports: ReplenishmentPorts) {
  const input = command(value);
  const payload = input.payload as unknown as Payload;
  const hash = ports.references.hashIntent(intent(input));
  let access;
  try {
    access = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: input.purpose,
      permission: input.permission,
      action: input.action,
      stockScope: payload.stockScope,
    });
  } catch {
    return fail("REPLENISHMENT_DEPENDENCY_UNAVAILABLE");
  }
  const allowed =
    input.action === "Acknowledge"
      ? access?.mayAcknowledge
      : input.action === "Dismiss"
        ? access?.mayDismiss
        : access?.mayCreateRequisitionDraft;
  if (!access?.authorized || !allowed) return fail("REPLENISHMENT_PERMISSION_DENIED");
  try {
    const replay = await ports.repository.resolveOperation(input.operationReference);
    if (replay) {
      if (
        !ports.references.equals(replay.intentHash, hash) ||
        intent(replay.command) !== intent(input) ||
        replay.operationReference !== input.operationReference ||
        replay.action !== input.action ||
        replay.need.tenantReference !== input.tenantReference ||
        replay.need.brandReference !== input.brandReference ||
        !sameScope(replay.need.stockScope, payload.stockScope) ||
        replay.need.needReference !== payload.needReference ||
        !["Applied", "AlreadyApplied"].includes(replay.outcome) ||
        (input.action === "CreateRequisitionDraft") !== (replay.requisitionReference !== null) ||
        (input.action === "CreateRequisitionDraft" &&
          replay.need.status !== "RequisitionDraftCreated")
      )
        return fail("REPLENISHMENT_IDEMPOTENCY_CONFLICT");
      return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
    }
    const before = await ports.repository.load({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      stockScope: payload.stockScope,
      needReference: payload.needReference,
    });
    if (
      !before ||
      before.needReference !== payload.needReference ||
      before.tenantReference !== input.tenantReference ||
      before.brandReference !== input.brandReference ||
      !sameScope(before.stockScope, payload.stockScope)
    )
      return fail("REPLENISHMENT_NOT_FOUND");
    if (payload.expectedVersion !== before.aggregateVersion) return fail("REPLENISHMENT_CONFLICT");
    if (
      before.status === "Dismissed" ||
      before.status === "RequisitionDraftCreated" ||
      (input.action === "Acknowledge" && before.status !== "Open")
    )
      return fail("REPLENISHMENT_STATE_CONFLICT");
    const snapshot = validateSnapshot(await ports.snapshot.inspect(input), input, before);
    let requisitionReference: InventoryReference | null = null;
    if (input.action === "CreateRequisitionDraft") {
      const draft = await ports.procurement.createRequisitionDraft({
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        stockScope: before.stockScope,
        sourceNeedReference: before.needReference,
        itemReference: before.itemReference,
        requestedQuantity: before.suggestedQuantity,
        baseUnitCode: before.baseUnitCode,
        requiredBy: before.requiredBy,
        urgency: before.urgency,
        idempotencyReference: before.needReference,
        actorReference: input.actorReference,
        occurredAt: input.occurredAt,
      });
      requisitionReference = validateDraft(draft, input, before);
    }
    const after =
      input.action === "Acknowledge"
        ? acknowledgeReplenishmentNeed(before, {
            expectedVersion: payload.expectedVersion,
            actorReference: input.actorReference,
            occurredAt: input.occurredAt,
          })
        : input.action === "Dismiss"
          ? dismissReplenishmentNeed(before, {
              expectedVersion: payload.expectedVersion,
              reasonCode: payload.reasonCode as string,
              actorReference: input.actorReference,
              occurredAt: input.occurredAt,
            })
          : linkRequisitionDraft(before, {
              expectedVersion: payload.expectedVersion,
              requisitionReference: requisitionReference as InventoryReference,
              actorReference: input.actorReference,
              occurredAt: input.occurredAt,
            });
    void snapshot;
    const audit = await ports.audit.create({ command: input, before, after });
    const record: ReplenishmentCommandRecord = Object.freeze({
      operationReference: input.operationReference,
      intentHash: hash,
      action: input.action,
      command: input,
      need: after,
      requisitionReference,
      audit,
      outcome: "Applied",
    });
    const committed = await ports.repository.commit(record);
    if (
      committed.operationReference !== record.operationReference ||
      committed.intentHash !== hash ||
      committed.need.needReference !== after.needReference ||
      committed.need.tenantReference !== input.tenantReference ||
      committed.need.brandReference !== input.brandReference ||
      !sameScope(committed.need.stockScope, payload.stockScope) ||
      committed.need.aggregateVersion !== after.aggregateVersion ||
      committed.need.status !== after.status ||
      committed.requisitionReference !== requisitionReference
    )
      return fail("REPLENISHMENT_DEPENDENCY_UNAVAILABLE");
    return committed;
  } catch (error) {
    if (error instanceof ReplenishmentNeedError) throw error;
    return fail("REPLENISHMENT_DEPENDENCY_UNAVAILABLE");
  }
}
