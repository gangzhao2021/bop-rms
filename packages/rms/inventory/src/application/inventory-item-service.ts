import {
  type InventoryItemAction,
  type InventoryItemCommand,
  type InventoryItemCommandRecord,
} from "../contracts/inventory-item-command.js";
import {
  createInventoryItem,
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  setReorderPolicy,
  transitionInventoryItem,
  updateInventoryItem,
  type InventoryItemAggregate,
  type InventoryReorderPolicy,
} from "../domain/inventory-item.js";
import type { InventoryItemPorts } from "./ports/inventory-item-ports.js";

const actions = [
  "Create",
  "Update",
  "Activate",
  "Deactivate",
  "Archive",
  "Restore",
  "SetReorderPolicy",
] as const;
const hashPattern = /^sha256:[0-9a-f]{64}$/u;

function fail(code: InventoryItemError["code"]): never {
  throw new InventoryItemError(code);
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
      return fail("INVENTORY_ITEM_INVALID");
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        return fail("INVENTORY_ITEM_INVALID");
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof InventoryItemError) throw error;
    return fail("INVENTORY_ITEM_INVALID");
  }
}

function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail("INVENTORY_ITEM_INVALID");
  return value as number;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return fail("INVENTORY_ITEM_INVALID");
  return value;
}

function nullableReference(value: unknown) {
  return value === null ? null : parseInventoryReference(value);
}

function payload(action: InventoryItemAction, value: unknown): Readonly<Record<string, unknown>> {
  const fields: Record<InventoryItemAction, readonly string[]> = {
    Create: ["internalCode", "itemType", "localizedNames", "baseUnit", "trackingPolicy"],
    Update: [
      "itemReference",
      "expectedVersion",
      "localizedNames",
      "baseUnit",
      "trackingPolicy",
      "migrationPlanReference",
    ],
    Activate: ["itemReference", "expectedVersion", "reasonCode"],
    Deactivate: ["itemReference", "expectedVersion", "reasonCode"],
    Archive: ["itemReference", "expectedVersion", "reasonCode", "hasOpenWork", "hasNonZeroStock"],
    Restore: ["itemReference", "expectedVersion", "reasonCode"],
    SetReorderPolicy: [
      "itemReference",
      "expectedVersion",
      "scopeType",
      "scopeReference",
      "reorderPoint",
      "safetyStock",
      "targetStockLevel",
      "minimumOrderQuantityHint",
      "orderMultipleHint",
      "leadTimeDaysHint",
      "preferredSupplierMappingReference",
      "enabled",
      "effectiveFrom",
      "effectiveUntil",
      "overrideSource",
      "reasonCode",
    ],
  };
  const raw = exact(value, fields[action]);
  if (action !== "Create") {
    parseInventoryReference(raw.itemReference);
    version(raw.expectedVersion);
  }
  if (["Activate", "Deactivate", "Archive", "Restore", "SetReorderPolicy"].includes(action)) {
    if (typeof raw.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode))
      return fail("INVENTORY_ITEM_INVALID");
  }
  if (action === "Update") nullableReference(raw.migrationPlanReference);
  if (action === "Archive") {
    boolean(raw.hasOpenWork);
    boolean(raw.hasNonZeroStock);
  }
  if (action === "SetReorderPolicy") {
    if (!["Store", "StockSite", "Location"].includes(String(raw.scopeType)))
      return fail("INVENTORY_ITEM_INVALID");
    parseInventoryReference(raw.scopeReference);
    for (const field of ["reorderPoint", "safetyStock", "targetStockLevel"])
      parseInventoryDecimal(raw[field]);
    for (const field of ["minimumOrderQuantityHint", "orderMultipleHint"])
      if (raw[field] !== null) {
        const value = parseInventoryDecimal(raw[field]);
        if (value === "0" || /^0\.0+$/u.test(value)) return fail("INVENTORY_ITEM_INVALID");
      }
    if (
      raw.leadTimeDaysHint !== null &&
      (!Number.isSafeInteger(raw.leadTimeDaysHint) || (raw.leadTimeDaysHint as number) < 0)
    )
      return fail("INVENTORY_ITEM_INVALID");
    nullableReference(raw.preferredSupplierMappingReference);
    boolean(raw.enabled);
    parseInventoryInstant(raw.effectiveFrom);
    if (raw.effectiveUntil !== null) parseInventoryInstant(raw.effectiveUntil);
    if (!["Brand", "Store", "Site", "Location"].includes(String(raw.overrideSource)))
      return fail("INVENTORY_ITEM_INVALID");
  }
  return Object.freeze(raw);
}

export function parseInventoryItemCommand(value: unknown): InventoryItemCommand {
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
    raw.purpose !== "InventoryItemManagement" ||
    raw.permission !== "inventory.manage" ||
    typeof raw.action !== "string" ||
    !actions.includes(raw.action as InventoryItemAction)
  )
    return fail("INVENTORY_ITEM_INVALID");
  const action = raw.action as InventoryItemAction;
  return Object.freeze({
    tenantReference: parseInventoryReference(raw.tenantReference),
    brandReference: parseInventoryReference(raw.brandReference),
    actorReference: parseInventoryReference(raw.actorReference),
    purpose: "InventoryItemManagement",
    permission: "inventory.manage",
    operationReference: parseInventoryReference(raw.operationReference),
    occurredAt: parseInventoryInstant(raw.occurredAt),
    action,
    payload: payload(action, raw.payload),
  });
}

function itemReference(command: InventoryItemCommand) {
  return parseInventoryReference(command.payload.itemReference);
}

async function apply(
  command: InventoryItemCommand,
  before: InventoryItemAggregate | null,
  ports: InventoryItemPorts,
): Promise<InventoryItemAggregate> {
  const payload = command.payload;
  if (command.action === "Create") {
    const normalizedCode = String(payload.internalCode).trim().toUpperCase();
    if (
      await ports.repository.internalCodeExists({
        brandReference: command.brandReference,
        normalizedCode,
        excludingItemReference: null,
      })
    )
      return fail("INVENTORY_ITEM_CONFLICT");
    return createInventoryItem({
      itemReference: ports.references.generate("InventoryItem"),
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      internalCode: normalizedCode,
      itemType: payload.itemType,
      localizedNames: payload.localizedNames,
      baseUnit: payload.baseUnit,
      trackingPolicy: payload.trackingPolicy,
      occurredAt: command.occurredAt,
      actorReference: command.actorReference,
    });
  }
  if (!before) return fail("INVENTORY_ITEM_NOT_FOUND");
  if (
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference ||
    before.itemReference !== itemReference(command)
  )
    return fail("INVENTORY_ITEM_PERMISSION_DENIED");
  if (command.action === "Update")
    return updateInventoryItem(before, {
      expectedVersion: version(payload.expectedVersion),
      localizedNames: payload.localizedNames,
      baseUnit: payload.baseUnit,
      trackingPolicy: payload.trackingPolicy,
      migrationPlanReference: payload.migrationPlanReference,
      occurredAt: command.occurredAt,
      actorReference: command.actorReference,
    });
  if (command.action === "SetReorderPolicy") {
    const policy: InventoryReorderPolicy = Object.freeze({
      policyReference: parseInventoryReference(ports.references.generate("ReorderPolicy")),
      scopeType: payload.scopeType as InventoryReorderPolicy["scopeType"],
      scopeReference: parseInventoryReference(payload.scopeReference),
      reorderPoint: parseInventoryDecimal(payload.reorderPoint),
      safetyStock: parseInventoryDecimal(payload.safetyStock),
      targetStockLevel: parseInventoryDecimal(payload.targetStockLevel),
      minimumOrderQuantityHint:
        payload.minimumOrderQuantityHint === null
          ? null
          : parseInventoryDecimal(payload.minimumOrderQuantityHint),
      orderMultipleHint:
        payload.orderMultipleHint === null
          ? null
          : parseInventoryDecimal(payload.orderMultipleHint),
      leadTimeDaysHint: payload.leadTimeDaysHint as number | null,
      preferredSupplierMappingReference: nullableReference(
        payload.preferredSupplierMappingReference,
      ),
      enabled: boolean(payload.enabled),
      effectiveFrom: parseInventoryInstant(payload.effectiveFrom),
      effectiveUntil:
        payload.effectiveUntil === null ? null : parseInventoryInstant(payload.effectiveUntil),
      overrideSource: payload.overrideSource as InventoryReorderPolicy["overrideSource"],
    });
    return setReorderPolicy(
      before,
      policy,
      version(payload.expectedVersion),
      command.occurredAt,
      command.actorReference,
    );
  }
  const targets = {
    Activate: "Active",
    Deactivate: "Inactive",
    Archive: "Archived",
    Restore: "Inactive",
  } as const;
  return transitionInventoryItem(before, targets[command.action], {
    expectedVersion: version(payload.expectedVersion),
    hasOpenWork: command.action === "Archive" ? boolean(payload.hasOpenWork) : false,
    hasNonZeroStock: command.action === "Archive" ? boolean(payload.hasNonZeroStock) : false,
    occurredAt: command.occurredAt,
    actorReference: command.actorReference,
  });
}

export async function executeInventoryItemCommand(
  value: unknown,
  ports: InventoryItemPorts,
): Promise<InventoryItemCommandRecord> {
  const command = parseInventoryItemCommand(value);
  let authorized;
  try {
    authorized = await ports.authorization.authorize({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      purpose: command.purpose,
      permission: command.permission,
      action: command.action,
    });
  } catch {
    return fail("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
  }
  if (!authorized?.authorized) return fail("INVENTORY_ITEM_PERMISSION_DENIED");
  try {
    const intentHash = ports.references.hashIntent(`InventoryItem:v1:${JSON.stringify(command)}`);
    if (!hashPattern.test(intentHash)) return fail("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
    const prior = await ports.repository.resolveOperation(command.operationReference);
    if (prior) {
      if (
        prior.operationReference !== command.operationReference ||
        prior.action !== command.action ||
        prior.item.tenantReference !== command.tenantReference ||
        prior.item.brandReference !== command.brandReference ||
        !hashPattern.test(prior.intentHash) ||
        !ports.references.equals(prior.intentHash, intentHash)
      )
        return fail("INVENTORY_ITEM_IDEMPOTENCY_CONFLICT");
      return prior;
    }
    const before =
      command.action === "Create" ? null : await ports.repository.load(itemReference(command));
    const after = await apply(command, before, ports);
    const audit = await ports.audit.create({ command, before, after });
    return await ports.repository.commit(
      Object.freeze({
        operationReference: command.operationReference,
        intentHash,
        action: command.action,
        item: after,
        outcome: "Applied",
        audit,
      }),
    );
  } catch (error) {
    if (error instanceof InventoryItemError) throw error;
    return fail("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
  }
}
